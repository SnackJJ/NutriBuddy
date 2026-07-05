// CLI：驱动一轮对话。读入一句用户输入 → harness 跑一个 turn → DeepSeek flash
// 生成答复 → 打印答复，并可看到逐步 trace。
//
//   echo "一个鸡蛋多少蛋白质?" | npx tsx src/cli.ts --trace
//   npx tsx src/cli.ts --trace "一个鸡蛋多少蛋白质?"
//
// API key 从环境变量 DEEPSEEK_API_KEY 读取（对齐 .sandcastle/.env）。

import { turn, type TurnResult } from "./harness/turn";
import { Tracer } from "./harness/tracer";
import type { EventLog } from "./harness/eventLog";
import { DeepSeekAdapter } from "./harness/modelAdapter";
import type { ModelAdapter } from "./harness/types";

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
}

export async function main(
  argv: readonly string[],
  deps: CliDeps = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((s) => process.stdout.write(s));
  const stderr = deps.stderr ?? ((s) => process.stderr.write(s));
  const readStdin = deps.readStdin ?? readStdinDefault;

  const showTrace = argv.includes("--trace");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const userInput = positional.join(" ").trim() || (await readStdin()).trim();

  if (!userInput) {
    stderr("用法: cli [--trace] <一句话>  (或经 stdin 传入)\n");
    return 2;
  }

  const tracer = new Tracer();
  // adapter 延迟到确有输入时才构造：缺 key 时真实 adapter 会抛，空输入路径不应触发。
  const adapter = deps.adapter ?? new DeepSeekAdapter();

  const gen = turn(
    { tag: "utterance", content: userInput },
    { adapter, tracer, eventLog: deps.eventLog },
  );

  let next = await gen.next();
  while (!next.done) {
    next = await gen.next();
  }
  const result: TurnResult = next.value;

  stdout(`${result.reply}\n`);

  if (showTrace) {
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
