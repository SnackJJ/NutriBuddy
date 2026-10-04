// 扩充依据题（2026-09-28）：检索消融用。
//
// 这组 case 存在的理由是 `--evidence none|pinned|retrieval` 的消融：要回答"检索到底
// 贡献了多少引用支撑"，分母里必须有一半题目的依据**不在**钉住集里 —— 否则 pinned 臂
// 与 retrieval 臂测的是同一件事。base 集的 v1–v5 只有 5 条，且 n<30，撑不起这个比较。
//
// ── 出题规则 ─────────────────────────────────────────────────────────────
//
// 1. **先查语料，再出题**：每条都是从 `sources/<source>/sections.jsonl` 里挑出一段，
//    再按那一段的原文写问题；不是先想问题再去找依据。gold 段就是出题时读的那一段。
// 2. 问法以"为什么 / 是什么 / 哪些食物 / 怎样影响"为主。**不问精确数字**：数字归
//    catalog 与 numericProvenanceGate 管（ADR 0004 第 2 条），在这里问数字等于把两种
//    支撑关系重新焊在一起（RFC 0013 §0）。
// 3. 不与 base 集 v1–v5 重复（维生素 D 为何重要、锌的食物来源、维生素 C 的作用、
//    omega-3 与心脏、为何需要叶酸），也不重复 c2（"怎样多摄入钙"）这类已有问法。
// 4. 不带 userContext：用药类问题在这里考的是**引用**，不是 gate；带上用药档案会让
//    input gate 介入，case 就变成了另一个类别的题。
// 5. tags：
//    - `pinned:in` / `pinned:out` —— **任一** gold 段在 `sources/pinned.json` 里即为 in。
//      由 `tests/eval.evidenceCases.test.ts` 从 pinned.json 重新计算并比对，标注只是
//      缓存，数据才是依据。out 约占一半（测试守 40%–60%）。
//    - `gold:<sectionId>` —— 金标准依据段，可多个；留给将来的 Recall@5（RFC 0013 §9
//      说不做 Recall@k 的理由是"没有标注集"，这里就是那份标注集的起点）。
//    - `source:<slug>` —— 与 gold 的 `<slug>#` 前缀一致（测试守）。
// 6. `dga-2020-2025` 不出题：它的 8 段是站点导航与栏目标题，没有可引用的主张。
//
// ── 审题清单（每加/改一条都过一遍）──────────────────────────────────────
//
//   [ ] 依据真实存在：gold 段在语料快照里，且答案能在那一段**原文**里读到（测试只能
//       守前半句，后半句靠人读）
//   [ ] 题意无歧义：换一个读者也会去找同一段，而不是同一营养素的另一段
//   [ ] 不依赖数字：答对这题不需要给出任何剂量、含量或百分比
//   [ ] pinned 标注由数据判定：跑一遍测试，而不是凭印象写 in/out
//
// `shouldBeBlocked: false` 与另一组正常请求的约定一致：这些都是不应被 gate 拦的普通问题。

import type { EvalCase } from "./types";

function evidenceCase(
  id: string,
  query: string,
  pinned: "in" | "out",
  source: string,
  gold: readonly string[],
): EvalCase {
  return {
    id,
    query,
    category: "evidence",
    expected: { shouldCite: true, shouldBeBlocked: false },
    tags: [`pinned:${pinned}`, `source:${source}`, ...gold.map((g) => `gold:${g}`)],
  };
}

export const EVIDENCE_CASES: readonly EvalCase[] = [
  // ─── pinned:in — 依据在钉住集里（pinned 臂即可引到）──────────────────────
  evidenceCase(
    "ev01",
    "Why do people taking warfarin need to keep their vitamin K intake consistent?",
    "in",
    "ods-vitamin-k",
    ["ods-vitamin-k#vitamin-k-interactions-with-medications-warfarin-coumadin-an"],
  ),
  evidenceCase(
    "ev02",
    "Why can calcium carbonate supplements interfere with levothyroxine treatment?",
    "in",
    "ods-calcium",
    ["ods-calcium#calcium-interactions-with-medications-levothyroxine"],
  ),
  evidenceCase(
    "ev03",
    "How do calcium supplements affect the HIV medication dolutegravir?",
    "in",
    "ods-calcium",
    ["ods-calcium#calcium-interactions-with-medications-dolutegravir"],
  ),
  evidenceCase(
    "ev04",
    "What is the concern with taking calcium supplements during long-term lithium treatment?",
    "in",
    "ods-calcium",
    ["ods-calcium#calcium-interactions-with-medications-lithium"],
  ),
  evidenceCase(
    "ev05",
    "Why might calcium supplements make quinolone antibiotics like ciprofloxacin less effective?",
    "in",
    "ods-calcium",
    ["ods-calcium#calcium-interactions-with-medications-quinolone-antibiotics"],
  ),
  evidenceCase(
    "ev06",
    "Why should cancer patients on methotrexate talk to their oncologist before taking folate supplements?",
    "in",
    "ods-folate",
    ["ods-folate#folate-interactions-with-medications-methotrexate"],
  ),
  evidenceCase(
    "ev07",
    "How do antiepileptic drugs such as phenytoin interact with folate?",
    "in",
    "ods-folate",
    ["ods-folate#folate-interactions-with-medications-antiepileptic-medicatio"],
  ),
  evidenceCase(
    "ev08",
    "Why can sulfasalazine, used for ulcerative colitis, lead to folate deficiency?",
    "in",
    "ods-folate",
    ["ods-folate#folate-interactions-with-medications-sulfasalazine"],
  ),
  evidenceCase(
    "ev09",
    "Why are folate recommendations expressed in dietary folate equivalents instead of plain folate amounts?",
    "in",
    "ods-folate",
    ["ods-folate#folate-recommended-intakes"],
  ),
  evidenceCase(
    "ev10",
    "Why is taking potassium iodide together with spironolactone a concern?",
    "in",
    "ods-iodine",
    ["ods-iodine#iodine-interactions-with-medications-potassium-sparing-diure"],
  ),
  evidenceCase(
    "ev11",
    "Why should iron supplements not be taken at the same time as levothyroxine?",
    "in",
    "ods-iron",
    ["ods-iron#iron-interactions-with-medications-levothyroxine"],
  ),
  evidenceCase(
    "ev12",
    "Why can ACE inhibitors and ARBs such as losartan lead to high blood potassium?",
    "in",
    "ods-potassium",
    ["ods-potassium#potassium-interactions-with-medications-angiotensin-converti"],
  ),
  evidenceCase(
    "ev13",
    "How do loop and thiazide diuretics such as furosemide affect potassium levels?",
    "in",
    "ods-potassium",
    ["ods-potassium#potassium-interactions-with-medications-loop-and-thiazide-di"],
  ),
  evidenceCase(
    "ev14",
    "Why are potassium intake recommendations set as Adequate Intakes rather than RDAs?",
    "in",
    "ods-potassium",
    ["ods-potassium#potassium-recommended-intakes"],
  ),
  evidenceCase(
    "ev15",
    "Does taking fish oil alongside warfarin raise the risk of bleeding?",
    "in",
    "ods-omega-3",
    ["ods-omega-3#omega-3-fatty-acids-interactions-with-medications-warfarin-c"],
  ),
  evidenceCase(
    "ev16",
    "Why do the official omega-3 intake recommendations for adults cover only ALA and not EPA or DHA?",
    "in",
    "ods-omega-3",
    ["ods-omega-3#omega-3-fatty-acids-recommended-intakes"],
  ),
  evidenceCase(
    "ev17",
    "Why is there no tolerable upper intake level for vitamin B12?",
    "in",
    "ods-vitamin-b12",
    ["ods-vitamin-b12#vitamin-b12-health-risks-from-excessive-vitamin-b12"],
  ),
  evidenceCase(
    "ev18",
    "Which foods are good sources of magnesium?",
    "in",
    "ods-magnesium",
    ["ods-magnesium#magnesium-sources-of-magnesium-food"],
  ),

  // ─── pinned:out — 依据不在钉住集里（只有检索能送到）─────────────────────
  evidenceCase(
    "ev19",
    "What factors affect the skin's ability to make vitamin D from sunlight?",
    "out",
    "ods-vitamin-d",
    ["ods-vitamin-d#vitamin-d-sources-of-vitamin-d-sun-exposure"],
  ),
  evidenceCase(
    "ev20",
    "Why do people with darker skin tend to have lower vitamin D levels?",
    "out",
    "ods-vitamin-d",
    ["ods-vitamin-d#vitamin-d-groups-at-risk-of-vitamin-d-inadequacy-people-with-2"],
  ),
  evidenceCase(
    "ev21",
    "How can corticosteroids like prednisone affect vitamin D?",
    "out",
    "ods-vitamin-d",
    ["ods-vitamin-d#vitamin-d-interactions-with-medications-steroids"],
  ),
  evidenceCase(
    "ev22",
    "What are the signs of zinc deficiency in children?",
    "out",
    "ods-zinc",
    ["ods-zinc#zinc-zinc-deficiency"],
  ),
  evidenceCase(
    "ev23",
    "Why do vegetarians often absorb less zinc from their diets?",
    "out",
    "ods-zinc",
    ["ods-zinc#zinc-groups-at-risk-of-zinc-inadequacy-vegetarians-especiall"],
  ),
  evidenceCase(
    "ev24",
    "What problems can come from taking too much zinc from supplements?",
    "out",
    "ods-zinc",
    ["ods-zinc#zinc-health-risks-from-excessive-zinc"],
  ),
  evidenceCase(
    "ev25",
    "What is scurvy, and what are its symptoms?",
    "out",
    "ods-vitamin-c",
    ["ods-vitamin-c#vitamin-c-vitamin-c-deficiency"],
  ),
  evidenceCase(
    "ev26",
    "Why do smokers need more vitamin C than nonsmokers?",
    "out",
    "ods-vitamin-c",
    ["ods-vitamin-c#vitamin-c-groups-at-risk-of-vitamin-c-inadequacy-smokers-and"],
  ),
  evidenceCase(
    "ev27",
    "Why are people with lactose intolerance at risk of low calcium intake, and what non-dairy sources can help?",
    "out",
    "ods-calcium",
    ["ods-calcium#calcium-groups-at-risk-of-calcium-inadequacy-individuals-who"],
  ),
  evidenceCase(
    "ev28",
    "Why might vegans not get enough iodine?",
    "out",
    "ods-iodine",
    ["ods-iodine#iodine-groups-at-risk-of-iodine-inadequacy-vegans-and-people"],
  ),
  evidenceCase(
    "ev29",
    "What happens to the body when it does not get enough iodine?",
    "out",
    "ods-iodine",
    ["ods-iodine#iodine-iodine-deficiency"],
  ),
  evidenceCase(
    "ev30",
    "What is the difference between heme and nonheme iron in foods?",
    "out",
    "ods-iron",
    ["ods-iron#iron-sources-of-iron-food"],
  ),
  evidenceCase(
    "ev31",
    "How do iron supplements affect levodopa for Parkinson's disease?",
    "out",
    "ods-iron",
    ["ods-iron#iron-interactions-with-medications-levodopa"],
  ),
  evidenceCase(
    "ev32",
    "Why are older adults at higher risk of vitamin B12 deficiency?",
    "out",
    "ods-vitamin-b12",
    ["ods-vitamin-b12#vitamin-b12-groups-at-risk-of-vitamin-b12-inadequacy-older-a"],
  ),
  evidenceCase(
    "ev33",
    "Can metformin affect vitamin B12 levels?",
    "out",
    "ods-vitamin-b12",
    ["ods-vitamin-b12#vitamin-b12-interactions-with-medications-metformin"],
  ),
  evidenceCase(
    "ev34",
    "Why are newborn babies at risk of vitamin K deficiency bleeding?",
    "out",
    "ods-vitamin-k",
    ["ods-vitamin-k#vitamin-k-groups-at-risk-of-vitamin-k-inadequacy-newborns-no"],
  ),
  evidenceCase(
    "ev35",
    "How can long-term antibiotic use affect vitamin K status?",
    "out",
    "ods-vitamin-k",
    ["ods-vitamin-k#vitamin-k-interactions-with-medications-antibiotics"],
  ),
  evidenceCase(
    "ev36",
    "How do diuretics such as furosemide affect magnesium levels?",
    "out",
    "ods-magnesium",
    ["ods-magnesium#magnesium-interactions-with-medications-diuretics"],
  ),
];
