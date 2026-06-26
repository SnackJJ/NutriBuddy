import type { EventLogDeps } from "../../src/harness/eventLog";

/** 内存版 append sink：收集 JSONL 写入便于断言，不碰真实文件系统。 */
export function memSink() {
  const writes: { path: string; line: string }[] = [];
  return {
    writes,
    append: (path: string, line: string) => writes.push({ path, line }),
  };
}

/** 固定时钟 + 计数 id，供单测确定性断言。 */
export function fixedDeps(sink = memSink()) {
  let n = 0;
  return {
    sink,
    deps: {
      append: sink.append,
      now: () => new Date("2026-06-26T00:00:00.000Z"),
      nextId: () => `evt_${n++}`,
    } satisfies EventLogDeps,
  };
}
