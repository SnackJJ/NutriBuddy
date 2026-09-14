# 依据语料（sources/）

本目录是依据层的**输入**：`scripts/fetch-sources.mts` 抓取并规范化，`scripts/ingest-sources.mts`（S4 T3）把它们写进 `sources` / `source_sections` 两张表（迁移 0013）。

- `catalog.json` —— 要抓哪些页（id / URL / publisher / 权威级别 / license 归属）
- `pinned.json` —— 钉住集（V1.0 运行时实际进 context 的 ≤40 段）
- `<source-id>/manifest.json` + `<source-id>/sections.jsonl` —— 抓取产物，进 git（可复现凭据）

## License 判定（已定，不再逐条挂起）

**只收美国联邦政府作品**，依据 17 U.S.C. §105 —— 美国联邦政府的作品不受版权保护，属公有领域。这条判定是**类的判定**（federal work），不是逐页的法律意见；每个源的 `manifest.json` 都记 `license`、`licenseEvidence`（支持该判定的官方页面 URL）与 `licenseCheckedAt`，`README` 里逐 host 说明依据。

| host | 归属 | 判定 | 依据 |
| --- | --- | --- | --- |
| `ods.od.nih.gov`（NIH 膳食补充剂办公室 fact sheets） | 美国联邦（NIH/ODS） | 公有领域 | NIH 网站政策：NIH 站点内容为美国政府作品；页面若含第三方素材会单独标注（抓取时按下面的规则剔除） |
| `health.gov`（ODPHP/Dietary Guidelines for Americans） | 美国联邦（HHS/ODPHP） | 公有领域 | HHS 网站政策；DGA 是 HHS/USDA 联合出版物 |
| `fda.gov`（过敏原标签与消费者信息） | 美国联邦（FDA） | 公有领域 | FDA 网站政策：联邦政府作品 |

抓取时对每页正文做**版权标记扫描**：出现 `©` / `copyright` / `all rights reserved` 的页面会在 manifest 里标 `licenseFlags` 并把命中的那段文本排除出钉住集，人复核后再决定是否整体剔除。这条是"宁可少收"的方向：依据层的价值是能引用权威原文，收到一段来路不明的第三方文字恰恰会破坏它。

**不在范围**（V1.0）：National Academies / IOM 的 DRI 报告（虽托管在 NCBI Bookshelf，但版权归 National Academies，非联邦作品）、WHO、期刊论文（多为 CC BY，署名义务与本项目的引用模型不同）、任何商业站点。

## 抓取可达性（2026-09-14 实测，值得记住）

| 目标 | 结果 |
| --- | --- |
| `ods.od.nih.gov` / `www.nih.gov` / `www.cdc.gov` | **403 Cloudflare 挑战页**：直接用脚本抓会被挡（返回 "Just a moment..."），不能用 |
| `www.usda.gov` | **403**（WAF） |
| `www.fda.gov` | **404 + 10 字节**（WAF 拦截，非真实 404） |
| `www.dietaryguidelines.gov` | 连接失败（000） |
| `health.gov` | **200**，正常 HTML |
| `web.archive.org/web/<ts>id_/<url>` | **200**，拿到原始 HTML |

因此 `catalog.json` 里的 ODS 条目走 **Wayback Machine**：作品本身仍是美国联邦政府作品（公有领域），archive.org 只是复本通道；manifest 同时记录**原始 URL** 与**快照时间戳**，可回溯到具体抓取到的版本。这是被 bot 防护逼出来的取法，不是偏好 —— 若将来 ODS 放开直连，只需改 `catalog.json` 的 URL 字段。

一个后果值得写明：**语料的"版本"是快照的版本，不是发布方的版本**。`docVersion` 因此写成 `ods-vitamind@<snapshot-date>`，而不是猜一个官方版本号。
