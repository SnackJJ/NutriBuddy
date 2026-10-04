# 引用的可引用单元是章节，不是检索切片

> 状态：**Accepted**（2026-09-16）。

## 背景

V1.1 的检索要在章节内部切 chunk（`docs/rfc/0013` §3）：语料 372 段里 108 段 ≥2000 字符，最长 43,076 字符，纯按章节召回会把 token 预算吃光并稀释精度。切了 chunk 之后，"一条引用指向什么"就必须当场回答，因为它决定 registry 的形状、`CitationRef` 的 schema、`citationGate` 的四条检查、trace 的可重放性，以及引用 UI 的锚点。

V1.0 已经把这些钉死了：`CitationRef.sectionId` 的注释写着 `<source_id>#<section slug>`——**the citable unit**；`citationGate` 的第四条检查是拿 `allowed = new Set(evidenceSet.sectionIds)` 去比；`SCHEMA_VERSION` 随 S4 升到 1.10.0。

## 决定

**可引用单元是章节（section），chunk 只是检索期的选择粒度。**

- 引用永远形如 `<sourceId>#<section>`，与 source registry 的行一一对应；chunk 标识（`sectionId#c<n>`）**只存在于检索索引**，不进 `evidenceSet`、不进 `CitationRef`、不进事件流。
- 命中的 chunk 归属回它的父章节；当轮证据集仍是章节 id 的集合，闸的四条检查、trace 重放、UI 锚点全部不变。
- 需要精确到句时用已有的 `quote` 字段（封顶 `CITATION_QUOTE_MAX_CHARS`），而不是把引用的身份下沉到 chunk。

## 为什么

- **可核验性必须与检索实现解耦。** ADR 0004 第 3 条要求引用是结构性可检查的，第 4 条要求检索失败 fail-closed。若引用指向 chunk，那么"这条引用是否成立"就依赖当次检索切了哪一段——一次切片规则的调整（改尺寸、改重叠）会让历史 trace 里的引用失去对应的行。章节是 registry 里的稳定主语，chunk 不是。
- **共享 schema 的代价不对称。** 下沉到 chunk 要新增一级 registry 表、重跑摄入、重算锚点、再 bump 一次 `SCHEMA_VERSION`，并同步改 gate 与重放；而这些代价换来的只是把定位从"章节 + 引文"变成"章节内切片 + 引文"，而后者已经被 `quote` 表达。
- **来源合规的口径会被污染。** 引用一旦指向检索产物，"引用的东西有没有被当轮检索规则改变过"就变成一个每次都要回答的问题；指向章节时它不是一个问题。

## 后果

- `docs/rfc/0013` 的注入逻辑必须允许"注入窗口 ≠ 被引章节"：短章节（≤2000 字符）整段注入，长章节注入命中窗口，而引用仍指向整章。
- 检索命中需要在事件流里留一条**检索来源**的痕迹（哪些 chunk 命中、来自词法还是向量侧），否则重放无法复原当轮的证据集是怎么来的。这条标记是 trace 的，不是引用的。
- 若将来真需要 chunk 级引用，那是一次 registry 迁移加一次 `SCHEMA_VERSION` bump，并且要重写本 ADR。
