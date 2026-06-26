// Pre-gate + Post-gate: 确定性安全闸（issue #10 / PRD v2 §2.1 拓扑）。
//
// Pre-gate：每个请求开始时，确定性查询用户过敏/用药/药物-营养素相互作用，
// 注入 ContextAssembler 的 pinned region（代码断言，零 LLM 依赖）。
//
// Post-gate：Agent 产出回复后，用字符串匹配 + 同义词扩展检查输出是否违反
// 过敏或药物-营养素冲突等硬约束。违规时硬拦，最多重试 2 次。
//
// 用户上下文（过敏 + 用药）由调用方注入，未来由 issue #8（User Profile）供给。

import {
  getInteractions,
  type DrugNutrientInteraction,
  type InteractionStore,
} from "../lib/drugInteractions";

/** 用户安全上下文：过敏 + 用药列表（由调用方注入，最终由 User Profile 供给）。 */
export interface UserContext {
  readonly allergies: readonly string[];
  readonly medications: readonly string[];
}

/** Pre-gate 产物：注入系统提示词的 pinned region。 */
export interface PreGateContext {
  readonly pinnedRegion: string;
}

/** Post-gate 检查结果。 */
export interface PostGateResult {
  readonly passed: boolean;
  readonly reasons: readonly string[];
}

// ─── 过敏原同义词扩展 ──────────────────────────────────────────────────
//
// 每个过敏原对应一组可匹配关键词：除过敏原本身外还包含替代表述、衍生词、
// 常见食物形态。匹配时用 \b 词边界防止 substring false-positive
//（如 "eggplant" 不应命中 "egg" 过敏）。

const ALLERGEN_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
  milk: [
    "milk",
    "dairy",
    "cheese",
    "yogurt",
    "butter",
    "cream",
    "whey",
    "casein",
    "lactose",
    "ghee",
    "curd",
    "paneer",
    "ricotta",
    "mozzarella",
    "cheddar",
    "parmesan",
    "brie",
    "camembert",
  ],
  egg: [
    "egg",
    "eggs",
    "mayonnaise",
    "meringue",
    "albumin",
    "custard",
    "quiche",
    "frittata",
    "omelette",
    "omelet",
  ],
  peanut: [
    "peanut",
    "peanuts",
    "groundnut",
    "groundnuts",
    "arachis",
    "goober",
  ],
  tree_nut: [
    "almond",
    "almonds",
    "walnut",
    "walnuts",
    "cashew",
    "cashews",
    "pistachio",
    "pistachios",
    "hazelnut",
    "hazelnuts",
    "pecan",
    "pecans",
    "macadamia",
    "brazil nut",
    "brazil nuts",
    "pine nut",
    "pine nuts",
    "chestnut",
    "chestnuts",
  ],
  soy: [
    "soy",
    "soya",
    "soybean",
    "soybeans",
    "tofu",
    "edamame",
    "tempeh",
    "miso",
    "soy sauce",
    "soy milk",
    "soy protein",
    "soy lecithin",
  ],
  wheat: [
    "wheat",
    "bread",
    "pasta",
    "flour",
    "gluten",
    "seitan",
    "semolina",
    "couscous",
    "farro",
    "spelt",
    "bulgur",
    "cracker",
    "crackers",
    "noodle",
    "noodles",
    "pastry",
    "pastries",
    "bagel",
    "bagels",
  ],
  fish: [
    "fish",
    "salmon",
    "tuna",
    "cod",
    "tilapia",
    "trout",
    "sardine",
    "sardines",
    "mackerel",
    "anchovy",
    "anchovies",
    "haddock",
    "halibut",
    "bass",
    "catfish",
    "pollock",
  ],
  shellfish: [
    "shellfish",
    "shrimp",
    "shrimps",
    "prawn",
    "prawns",
    "crab",
    "crabs",
    "lobster",
    "lobsters",
    "mussel",
    "mussels",
    "oyster",
    "oysters",
    "clam",
    "clams",
    "scallop",
    "scallops",
    "squid",
    "octopus",
    "calamari",
  ],
  sesame: [
    "sesame",
    "tahini",
    "sesame seed",
    "sesame seeds",
    "sesame oil",
    "gomasio",
  ],
};

/** 展开过敏原为待匹配关键词列表（含同义词扩展）。 */
function expandAllergenTerms(allergen: string): string[] {
  const key = allergen.toLowerCase().replace(/[^a-z_]/g, "");
  const synonyms = ALLERGEN_SYNONYMS[key];
  if (synonyms) return [...synonyms];
  return [allergen.toLowerCase()];
}

/**
 * 在文本中检测任一关键词的出现。用 \b 词边界防止 substring false-positive：
 * "eggplant" 不含 \begg\b 所以不命中 egg 过敏。
 */
function containsAnyTerm(text: string, terms: readonly string[]): string | null {
  for (const term of terms) {
    // 对含空格的多词术语（如 "soy sauce"），用转义后的字面量匹配。
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const regex = new RegExp(`\\b${escaped}\\b`, "i");
    if (regex.test(text)) return term;
  }
  return null;
}

// ─── Pre-gate ──────────────────────────────────────────────────────────

/**
 * 构建注入系统提示词的 pinned region。
 * 零语义检索：所有数据来自确定性 SQL（drug_nutrient_interactions 表）。
 * 用户过敏/用药由调用方注入（未来由 User Profile 模块供给）。
 */
export async function buildPreGateContext(
  user: UserContext,
  store: InteractionStore,
): Promise<PreGateContext> {
  const interactions =
    user.medications.length > 0
      ? await getInteractions([...user.medications], store)
      : [];

  const sections: string[] = [];

  // 过敏约束
  if (user.allergies.length > 0) {
    const list = user.allergies.join(", ");
    sections.push(
      `[SAFETY CONSTRAINT — ALLERGIES]\n` +
        `The user has the following food allergies: ${list}.\n` +
        `ABSOLUTELY DO NOT recommend, suggest, or mention any foods containing these allergens ` +
        `or their derivatives. This is a hard safety rule. Violating it could harm the user.`,
    );
  }

  // 用药约束（含药物-营养素相互作用）
  if (user.medications.length > 0) {
    const medList = user.medications.join(", ");
    let medSection = `[SAFETY CONSTRAINT — MEDICATIONS]\n` +
      `The user is currently taking: ${medList}.`;

    if (interactions.length > 0) {
      const conflictLines = interactions.map(
        (i) =>
          `  • ${i.drugName} + ${i.nutrient}: avoid foods like ${i.foodExamples.join(", ")} ` +
          `[severity: ${i.severity}, source: ${i.source}]`,
      );
      medSection += `\n\nKnown drug-nutrient interactions. NEVER recommend foods that conflict:\n${conflictLines.join("\n")}`;
    }

    sections.push(medSection);
  }

  return { pinnedRegion: sections.join("\n\n") };
}

// ─── Post-gate ─────────────────────────────────────────────────────────

/**
 * 检查 agent 输出是否违反硬约束。
 *
 * 检查项：
 * 1. 过敏原字符串匹配 + 同义词扩展（\b 词边界，防止 substring false-positive）
 * 2. 药物-营养素冲突（仅 high severity = 硬拦；moderate/low 不触发拦阻）
 *
 * 返回 { passed, reasons }：passed=false 时 reasons 列出所有违规项。
 */
export function checkPostGate(
  output: string,
  user: UserContext,
  interactions: readonly DrugNutrientInteraction[],
): PostGateResult {
  const reasons: string[] = [];
  const lowerOutput = output.toLowerCase();

  // 1. 过敏原检查（含同义词扩展）
  for (const allergen of user.allergies) {
    const terms = expandAllergenTerms(allergen);
    const hit = containsAnyTerm(lowerOutput, terms);
    if (hit) {
      reasons.push(
        `Allergen mention: "${hit}" matches allergy "${allergen}"`,
      );
    }
  }

  // 2. 药物-营养素冲突检查（仅 high severity 硬拦）
  for (const interaction of interactions) {
    if (interaction.severity !== "high") continue;
    for (const food of interaction.foodExamples) {
      // 对食物示例也用词边界匹配，避免 "potato" 命中 "potato chips" 以外等
      const escaped = food.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(`\\b${escaped}\\b`, "i");
      if (regex.test(lowerOutput)) {
        reasons.push(
          `Drug-nutrient conflict: "${food}" conflicts with ${interaction.drugName} ` +
            `(${interaction.nutrient}, severity: ${interaction.severity})`,
        );
      }
    }
  }

  return { passed: reasons.length === 0, reasons };
}
