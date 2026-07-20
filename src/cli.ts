// CLI：驱动一轮对话。读入一句用户输入 → harness 跑一个 turn → DeepSeek flash
// 生成答复 → 打印答复，并可看到逐步 trace。
//
//   echo "一个鸡蛋多少蛋白质?" | npx tsx src/cli.ts --trace
//   npx tsx src/cli.ts --trace "一个鸡蛋多少蛋白质?"
//   npx tsx src/cli.ts "I ate 200g of chicken breast for lunch"   # 提出写提案
//   npx tsx src/cli.ts --confirm <proposalId> --yes               # 确认提案
//   npx tsx src/cli.ts --confirm <proposalId> --no                # 拒绝提案
//
// 工具路径与 web chat 相同（issue #61）：log_meal / query_catalog /
// submit_answer 都经 Turn Seam。提案与 meal ledger 存本地 JSON 状态文件
// （NUTRIBUDDY_STATE_FILE 可覆盖路径），跨进程存活以支持 --confirm。
//
// API key 从环境变量 DEEPSEEK_API_KEY 读取（对齐 .sandcastle/.env）。

import { consumeTurn, turn, type AnyTurnEvent, type TurnInput } from "./harness/turn";
import { buildTurnEventSink, Tracer } from "./harness/tracer";
import {
  createTurnAssembly,
  incompleteAssemblyResult,
} from "./harness/turnAssembly";
import type { EventLog } from "./harness/eventLog";
import { DeepSeekAdapter } from "./harness/modelAdapter";
import type { ModelAdapter, ToolHandler } from "./harness/types";
import { createLogMealHandler, LOG_MEAL_SCHEMA } from "./harness/logMeal";
import {
  createQueryCatalogHandler,
  QUERY_CATALOG_SCHEMA,
} from "./harness/queryCatalog";
import { SUBMIT_ANSWER_SCHEMA } from "./harness/submitAnswer";
import {
  loadConfiguredCatalog,
  createInMemoryQueryRunner,
  createQueryCatalog,
  ALL_QUERY_TEMPLATES,
} from "./catalog";
import { createFileStores } from "./lib/cliStores";

/** 本地单用户 CLI 的固定身份：绑定为 userId 与 sessionUserId。 */
const CLI_USER_ID = "cli-local-user";
const DEFAULT_STATE_FILE = ".nutribuddy/cli-state.json";

async function readStdinDefault(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// 依赖注入：默认接真实 adapter / stdio / stdin，单测可注入 stub 不触网、不读真实 stdin。
export interface CliDeps {
  readonly adapter?: ModelAdapter;
  readonly eventLog?: EventLog;
  readonly stdout?: (s: string) => void;
  readonly stderr?: (s: string) => void;
  readonly readStdin?: () => Promise<string>;
  /** 状态文件路径（提案 + meal ledger）。默认 .nutribuddy/cli-state.json。 */
  readonly stateFilePath?: string;
}

const USAGE =
  "用法: cli [--trace] <一句话>  (或经 stdin 传入)\n" +
  "      cli --confirm <proposalId> --yes|--no\n";

interface ParsedArgs {
  readonly showTrace: boolean;
  readonly confirmId?: string;
  readonly confirmed?: boolean;
  readonly positional: readonly string[];
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = [];
  let showTrace = false;
  let confirmId: string | undefined;
  let confirmed: boolean | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--trace") {
      showTrace = true;
    } else if (arg === "--confirm") {
      confirmId = argv[i + 1];
      i++;
    } else if (arg === "--yes") {
      confirmed = true;
    } else if (arg === "--no") {
      confirmed = false;
    } else if (!arg.startsWith("--")) {
      positional.push(arg);
    }
  }

  return { showTrace, confirmId, confirmed, positional };
}

/** confirm turn 不经过模型；用会 fail loud 的 stub 兜住意外调用。 */
function confirmModeAdapter(): ModelAdapter {
  return {
    generate: async () => {
      throw new Error("proposal_confirm turns never call the model");
    },
  };
}

export async function main(
  argv: readonly string[],
  deps: CliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const readStdin = deps.readStdin ?? readStdinDefault;

  const args = parseArgs(argv);

  // ── Build turn input ──────────────────────────────────────────────
  let turnInput: TurnInput;

  if (args.confirmId !== undefined || args.confirmed !== undefined) {
    if (!args.confirmId || args.confirmed === undefined) {
      stderr(USAGE);
      return 2;
    }
    turnInput = {
      tag: "proposal_confirm",
      proposalId: args.confirmId,
      confirmed: args.confirmed,
    };
  } else {
    const userInput =
      args.positional.join(" ").trim() || (await readStdin()).trim();

    if (!userInput) {
      stderr(USAGE);
      return 2;
    }
    turnInput = { tag: "utterance", content: userInput };
  }

  // ── Build ports (same tool path as web chat — issue #61) ──────────
  const stateFilePath =
    deps.stateFilePath ??
    process.env.NUTRIBUDDY_STATE_FILE ??
    DEFAULT_STATE_FILE;
  const stores = createFileStores(stateFilePath, { userId: CLI_USER_ID });
  const catalog = loadConfiguredCatalog();
  const queryCatalog = createQueryCatalog(ALL_QUERY_TEMPLATES);

  const tracer = new Tracer();
  // adapter 延迟到确有输入时才构造：缺 key 时真实 adapter 会抛，
  // 空输入路径与 confirm 路径都不应触发。
  const adapter =
    deps.adapter ??
    (turnInput.tag === "proposal_confirm"
      ? confirmModeAdapter()
      : new DeepSeekAdapter());

  let tools: ReadonlyMap<string, ToolHandler> | undefined;
  let toolSchemas:
    | readonly (typeof LOG_MEAL_SCHEMA | typeof QUERY_CATALOG_SCHEMA | typeof SUBMIT_ANSWER_SCHEMA)[]
    | undefined;

  if (turnInput.tag === "utterance") {
    tools = new Map<string, ToolHandler>([
      [
        "log_meal",
        createLogMealHandler({
          catalog,
          proposalStore: stores.proposalStore,
          userId: CLI_USER_ID,
        }),
      ],
      [
        "query_catalog",
        createQueryCatalogHandler({
          queryCatalog,
          runner: createInMemoryQueryRunner(catalog, stores.listMealRecords()),
          userId: CLI_USER_ID,
        }),
      ],
    ]);
    toolSchemas = [LOG_MEAL_SCHEMA, QUERY_CATALOG_SCHEMA, SUBMIT_ANSWER_SCHEMA];
  }

  const assembly = createTurnAssembly({
    kind: turnInput.tag,
    adapter,
    tracer,
    eventLog: deps.eventLog,
    userId: CLI_USER_ID,
    sessionUserId: CLI_USER_ID,
    proposalStore: stores.proposalStore,
    mealLogStore: stores.mealLogStore,
    catalog,
    queryCatalog,
    catalogVersion: catalog.snapshot.version,
    tools,
    toolSchemas,
    requireTools: turnInput.tag === "utterance",
  });

  if (!assembly.ok) {
    const fail = incompleteAssemblyResult(
      assembly.reason,
      turnInput.tag === "proposal_confirm" ? turnInput.proposalId : undefined,
    );
    stdout(`${fail.reply}\n`);
    return 1;
  }

  const turnEvents: AnyTurnEvent[] = [];

  const result = await consumeTurn(turn(turnInput, assembly.ports), (event) =>
    turnEvents.push(event),
  );

  tracer.sink(buildTurnEventSink(turnEvents, result.steps));

  stdout(`${result.reply}\n`);

  if (result.stopReason === "write_proposal" && result.proposal) {
    const p = result.proposal;
    stdout(
      `\n[proposal] ${p.proposalId}\n` +
        `  ${p.foodName} — ${p.portionG}g (${p.mealType})\n` +
        `  确认: cli --confirm ${p.proposalId} --yes\n` +
        `  拒绝: cli --confirm ${p.proposalId} --no\n`,
    );
  }

  if (args.showTrace) {
    stderr("\n--- trace ---\n");
    stderr(`${tracer.render()}\n`);
  }
  return 0;
}

// 仅在被直接执行时跑，import 时不触发（便于测试）。
const invokedDirectly = process.argv[1]?.endsWith("cli.ts") ?? false;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(
        `错误: ${err instanceof Error ? err.message : String(err)}\n`,
      );
      process.exit(1);
    });
}
