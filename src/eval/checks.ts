// 共享的确定性检查断言（issue #27）。
//
// scoreCase (scorer.ts) 和 scoreHarness (metrics.ts) 各自实现了三份并行的
// mustCallTools / shouldAskClarification / shouldBeBlocked 检查，提取为纯函数
// 使两个调用方共用同一份检查逻辑。
//
// 三个函数都是零副作用的纯函数：接受输入，返回布尔或字符串数组。

/**
 * 检查必须调用的工具是否都被调用。
 * @returns 缺失的工具名列表（空数组表示全部通过）。
 */
export function checkMustCallTools(
  expected: readonly string[],
  called: readonly string[],
): string[] {
  return expected.filter((tool) => !called.includes(tool));
}

/**
 * 检查回复是否包含澄清追问（含「?」）。
 * @returns true 如果回复满足追问要求。
 */
export function checkShouldAskClarification(
  reply: string | undefined,
): boolean {
  return reply !== undefined && reply.includes("?");
}

/**
 * 检查 gate 是否执行了拦截。
 * @returns true 如果 gate 确实拦截了。
 */
export function checkShouldBeBlocked(blocked: boolean): boolean {
  return blocked;
}
