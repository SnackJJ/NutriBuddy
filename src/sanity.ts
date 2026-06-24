// 脚手架冒烟模块：仅用于让 tsc / vitest 有真实代码可校验。
// 实现 PRD 八模块时删除本文件，换成真正的模块测试。

/** 把字符串按非空白切分成 token，过滤空项。 */
export function tokenize(input: string): string[] {
  return input.split(/\s+/).filter((t) => t.length > 0);
}
