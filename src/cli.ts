// CLI：驱动一轮对话。读入一句用户输入 → harness 跑一个 turn → DeepSeek flash
// 生成答复 → 打印答复，并可看到逐步 trace。
//
//   echo "一个鸡蛋多少蛋白质?" | npx tsx src/cli.ts --trace
//   npx tsx src/cli.ts --trace "一个鸡蛋多少蛋白质?"
//
// API key 从环境变量 DEEPSEEK_API_KEY 读取（对齐 .sandcastle/.env）。

import { runTurn } from "./harness/loop";
import { Tracer } from "./harness/tracer";
import { DeepSeekAdapter } from "./harness/modelAdapter";

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return "";
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function main(argv: readonly string[]): Promise<number> {
  const showTrace = argv.includes("--trace");
  const positional = argv.filter((a) => !a.startsWith("--"));
  const userInput = (positional.join(" ").trim() || (await readStdin()).trim());

  if (!userInput) {
    process.stderr.write("用法: cli [--trace] <一句话>  (或经 stdin 传入)\n");
    return 2;
  }

  const tracer = new Tracer();
  const adapter = new DeepSeekAdapter();

  const result = await runTurn({ userInput, adapter, tracer });

  process.stdout.write(`${result.reply}\n`);

  if (showTrace) {
    process.stderr.write("\n--- trace ---\n");
    process.stderr.write(`${tracer.render()}\n`);
  }
  return 0;
}

// 仅在被直接执行时跑，import 时不触发（便于测试）。
const invokedDirectly = process.argv[1]?.endsWith("cli.ts") ?? false;
if (invokedDirectly) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`错误: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exit(1);
    });
}
