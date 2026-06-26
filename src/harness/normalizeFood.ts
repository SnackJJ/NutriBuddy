// normalize_food Tool（issue #13 / PRD v2 §3.3「食物标准化」）。
//
// 将用户的自然语言食物描述标准化为可查询的食物条目：
//   "a bowl of rice" → { food_name: "rice, white, cooked", portion_g: 150 }
//
// 两层处理：
//   1. 确定性份量解析（regex 提取克重 / oz / lb / 碗/片/杯/个 等描述）
//   2. 食物名标准化（别名词典 + Dice 系数模糊匹配）
//
// 低置信度时返回多个候选，供上层（agent / UI）让用户选择。

import type { ToolHandler } from "./types";

// ══════════════════════════════════════════════════════════════════════════════
// 类型定义
// ══════════════════════════════════════════════════════════════════════════════

/** 标准化后的单个食物候选。 */
export interface NormalizedFood {
  /** USDA / 标准食物名（可直接传入 get_food_nutrition）。 */
  readonly food_name: string;
  /** 估计份量（克）。0 表示未能解析份量。 */
  readonly portion_g: number;
  /** 匹配置信度 (0–1)。 */
  readonly confidence: number;
}

/** normalize_food 工具的返回结构。 */
export interface NormalizeFoodResult {
  /** 原始用户输入（回显）。 */
  readonly original_input: string;
  /** 候选列表，按 confidence 降序排列。 */
  readonly candidates: readonly NormalizedFood[];
  /** 错误信息（仅在入参非法时存在）。 */
  readonly error?: string;
}

/** 份量解析结果。 */
export interface PortionInfo {
  /** 估计克重（0 表示未知）。 */
  readonly grams: number;
  /** 份量单位描述（bowl / slice / cup / count / g / oz / ...）。 */
  readonly unit: string;
  /** 数字 count（用于 "two eggs" 场景）。 */
  readonly count: number;
  /** 剥去份量前缀后的基础食物名。 */
  readonly baseFood: string;
}

// ══════════════════════════════════════════════════════════════════════════════
// 份量解析
// ══════════════════════════════════════════════════════════════════════════════

/** 份量单位 → 估计克重。数据来源：USDA 常见份量参考 + FDA 膳食指南。 */
const UNIT_GRAMS: Record<string, number> = {
  bowl: 250,
  cup: 240, // 8 fl oz ≈ 240 ml；适用于液体/半固体
  glass: 240,
  slice: 35,
  piece: 80,
  serving: 150,
  tablespoon: 15,
  tbsp: 15,
  teaspoon: 5,
  tsp: 5,
  oz: 28.35, // 基准克重；"8 oz" 会在匹配后按数量乘算
  ounce: 28.35,
  lb: 453.6,
  pound: 453.6,
  kg: 1000,
};

/** 数字词 → 数值映射。*/
const NUMBER_WORDS: Record<string, number> = {
  one: 1, a: 1, an: 1,
  two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12,
  dozen: 12, "a dozen": 12,
  "a couple of": 2, "a few": 3,
};

/** 食物份量默认克重（来自 USDA 常见份量）。按别名键匹配。 */
const DEFAULT_FOOD_GRAMS: Record<string, number> = {
  egg: 50,
  eggs: 50,
  "chicken breast": 180,
  "chicken thigh": 100,
  "chicken wing": 30,
  banana: 118,
  apple: 182,
  orange: 154,
  potato: 173,
  "slice of bread": 35,
  "slice of pizza": 130,
  "slice of cheese": 20,
  sausage: 50,
  "hot dog": 50,
  "hamburger patty": 113,
  cookie: 15,
  "chocolate bar": 50,
  carrot: 61,
  tomato: 123,
  avocado: 150,
};

/**
 * 解析自然语言中的份量描述。
 * 返回 PortionInfo 或 null（无份量信息）。
 */
export function parsePortion(input: string): PortionInfo | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // ── 模式 1：显式克重 "200g of ..." / "100 g ..." ──
  const gramMatch = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*g(?:rams?)?(?:\s+of\b)?\s*(.*)/i,
  );
  if (gramMatch) {
    const grams = parseFloat(gramMatch[1]);
    const baseFood = gramMatch[2] || "";
    return {
      grams,
      unit: "g",
      count: 1,
      baseFood: baseFood.trim(),
    };
  }

  // ── 模式 2：盎司 "8 oz of ..." ──
  const ozMatch = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*oz(?:unce(?:s)?)?(?:\s+of\b)?\s*(.*)/i,
  );
  if (ozMatch) {
    const grams = Math.round(parseFloat(ozMatch[1]) * UNIT_GRAMS["oz"]);
    const baseFood = ozMatch[2] || "";
    return { grams, unit: "oz", count: 1, baseFood: baseFood.trim() };
  }

  // ── 模式 3：磅 "1 lb of ..." ──
  const lbMatch = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*lb(?:s?|ound(?:s)?)?(?:\s+of\b)?\s*(.*)/i,
  );
  if (lbMatch) {
    const grams = Math.round(parseFloat(lbMatch[1]) * UNIT_GRAMS["lb"]);
    const baseFood = lbMatch[2] || "";
    return { grams, unit: "lb", count: 1, baseFood: baseFood.trim() };
  }

  // ── 模式 4：千克 "0.5 kg of ..." ──
  const kgMatch = trimmed.match(
    /^(\d+(?:\.\d+)?)\s*kg(?:rams?)?(?:\s+of\b)?\s*(.*)/i,
  );
  if (kgMatch) {
    const grams = Math.round(parseFloat(kgMatch[1]) * UNIT_GRAMS["kg"]);
    const baseFood = kgMatch[2] || "";
    return { grams, unit: "kg", count: 1, baseFood: baseFood.trim() };
  }

  // ── 模式 5：描述性单位 "a bowl of / a slice of / a cup of ..." ──
  const descMatch = trimmed.match(
    /^(a|an|one)\s+(bowl|cup|glass|slice|piece|serving|tablespoon|tbsp|teaspoon|tsp)\s+of\s+(.*)/i,
  );
  if (descMatch) {
    const unit = descMatch[2].toLowerCase();
    const baseFood = descMatch[3] || "";
    const grams = UNIT_GRAMS[unit] ?? 0;
    return {
      grams,
      unit,
      count: 1,
      baseFood: baseFood.trim(),
    };
  }

  // ── 模式 6：数字 + 单位 "2 slices of ...", "3 cups of ..." ──
  const pluralMatch = trimmed.match(
    /^(\d+)\s+(bowls|cups|glasses|slices|pieces|servings|tablespoons|tbsp|teaspoons|tsp)\s+of\s+(.*)/i,
  );
  if (pluralMatch) {
    const count = parseInt(pluralMatch[1], 10);
    // 去复数 s → 查 UNIT_GRAMS
    const unitSingular = pluralMatch[2].replace(/s$/i, "").toLowerCase();
    const unitGrams = UNIT_GRAMS[unitSingular] ?? 0;
    const baseFood = pluralMatch[3] || "";
    return {
      grams: unitGrams * count,
      unit: unitSingular,
      count,
      baseFood: baseFood.trim(),
    };
  }

  // ── 模式 7：数字词 + 食物名（不跟单位）"two eggs", "three apples" ──
  // "dozen" / "a dozen" 必须排在 "a" 之前，否则 "a dozen" 会被 "a" 先消费。
  const countMatch = trimmed.match(
    /^(a\s+dozen|dozen|a\s+couple\s+of|a\s+few|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|a|an)\s+(.*)/i,
  );
  if (countMatch) {
    const word = countMatch[1].toLowerCase().trim();
    const count = NUMBER_WORDS[word] ?? 1;
    const rest = countMatch[2] || "";

    // 试从 rest 中匹配单位（"two slices of bread" 已在上面的 pluralMatch 覆盖；
    // 这里处理 "two eggs"、"three apples" 等无单位的数字+食物）
    const subDescMatch = rest.match(
      /^(bowls|cups|glasses|slices|pieces|servings|tablespoons|tbsp|teaspoons|tsp)\s+of\s+(.*)/i,
    );
    if (subDescMatch) {
      const unitSingular = subDescMatch[1].replace(/s$/i, "").toLowerCase();
      const unitGrams = UNIT_GRAMS[unitSingular] ?? 0;
      const baseFood = subDescMatch[2] || "";
      return {
        grams: unitGrams * count,
        unit: unitSingular,
        count,
        baseFood: baseFood.trim(),
      };
    }

    // 数字 + 食物名：用 DEFAULT_FOOD_GRAMS 按食物查单重
    const restLower = rest.toLowerCase().trim();
    let unitGrams = 0;
    for (const [foodKey, grams] of Object.entries(DEFAULT_FOOD_GRAMS)) {
      if (restLower.includes(foodKey)) {
        unitGrams = grams;
        break;
      }
    }

    return {
      grams: unitGrams * count,
      unit: "count",
      count,
      baseFood: rest.trim(),
    };
  }

  // ── 未匹配任何模式 ──
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
// 食物别名词典
// ══════════════════════════════════════════════════════════════════════════════

/** 食物别名条目：将常见口语名映射到 USDA 标准名。 */
export interface FoodAliasEntry {
  /** USDA 风格标准食物名。 */
  readonly standard: string;
  /** 口语别名列表（全部小写，用于匹配）。 */
  readonly aliases: readonly string[];
  /** 稠密度 g/ml（用于从体积推算重量；缺失时用默认 1.0）。 */
  readonly density?: number;
}

/**
 * 食物别名词典。
 * 标准名设计为可直接传入 get_food_nutrition 的格式。
 * 别名覆盖常见口语说法（单数/复数/缩写）。
 */
export const FOOD_ALIASES: readonly FoodAliasEntry[] = [
  // ── 谷物 / 主食 ──
  {
    standard: "rice, white, cooked",
    aliases: ["rice", "white rice", "steamed rice", "cooked rice", "boiled rice"],
  },
  {
    standard: "rice, brown, cooked",
    aliases: ["brown rice", "whole grain rice"],
  },
  {
    standard: "rice, fried",
    aliases: ["fried rice", "egg fried rice"],
  },
  {
    standard: "bread, wheat, sliced",
    aliases: ["bread", "wheat bread", "whole wheat bread", "slice of bread", "toast",
      "wholemeal bread", "brown bread"],
  },
  {
    standard: "bread, white, sliced",
    aliases: ["white bread", "white toast"],
  },
  {
    standard: "pasta, cooked",
    aliases: ["pasta", "spaghetti", "noodles", "macaroni", "penne", "fettuccine",
      "linguine", "cooked pasta", "boiled pasta"],
  },
  {
    standard: "oatmeal, cooked",
    aliases: ["oatmeal", "porridge", "oats", "rolled oats", "cooked oats"],
  },
  {
    standard: "tortilla, flour",
    aliases: ["tortilla", "flour tortilla", "wrap"],
  },
  {
    standard: "bagel, plain",
    aliases: ["bagel"],
  },

  // ── 蛋白质 / 肉类 ──
  {
    standard: "chicken, breast, roasted",
    aliases: ["chicken breast", "chicken", "roast chicken breast", "grilled chicken breast",
      "chicken fillet"],
  },
  {
    standard: "chicken, thigh, roasted",
    aliases: ["chicken thigh"],
  },
  {
    standard: "chicken, wing, roasted",
    aliases: ["chicken wing", "chicken wings", "wings"],
  },
  {
    standard: "beef, ground, 80% lean, cooked",
    aliases: ["ground beef", "minced beef", "beef mince", "hamburger meat"],
  },
  {
    standard: "beef, steak, grilled",
    aliases: ["steak", "beef steak", "grilled steak", "sirloin", "ribeye"],
  },
  {
    standard: "pork, chop, cooked",
    aliases: ["pork chop", "pork", "pork chops"],
  },
  {
    standard: "bacon, cooked",
    aliases: ["bacon", "bacon strips"],
  },
  {
    standard: "sausage, pork, cooked",
    aliases: ["sausage", "sausages", "pork sausage", "breakfast sausage"],
  },
  {
    standard: "turkey, breast, roasted",
    aliases: ["turkey", "turkey breast", "roast turkey"],
  },
  {
    standard: "salmon, atlantic, cooked",
    aliases: ["salmon", "atlantic salmon", "cooked salmon", "grilled salmon",
      "baked salmon"],
  },
  {
    standard: "tuna, canned, in water",
    aliases: ["tuna", "canned tuna", "tuna fish"],
  },
  {
    standard: "shrimp, cooked",
    aliases: ["shrimp", "shrimps", "prawn", "prawns"],
  },
  {
    standard: "cod, cooked",
    aliases: ["cod", "cod fish", "white fish"],
  },
  {
    standard: "tofu, firm",
    aliases: ["tofu", "firm tofu", "bean curd"],
  },

  // ── 蛋 / 奶 ──
  {
    standard: "egg, whole, cooked",
    aliases: ["egg", "eggs", "boiled egg", "fried egg", "scrambled egg",
      "scrambled eggs", "cooked egg", "whole egg"],
  },
  {
    standard: "egg, white only, cooked",
    aliases: ["egg white", "egg whites"],
  },
  {
    standard: "milk, whole, 3.25%",
    aliases: ["milk", "whole milk", "full fat milk", "full cream milk"],
    density: 1.03,
  },
  {
    standard: "milk, reduced fat, 2%",
    aliases: ["2% milk", "semi skimmed milk", "reduced fat milk",
      "low fat milk"],
    density: 1.03,
  },
  {
    standard: "milk, skim",
    aliases: ["skim milk", "skimmed milk", "nonfat milk", "fat free milk"],
    density: 1.03,
  },
  {
    standard: "cheese, cheddar",
    aliases: ["cheese", "cheddar", "cheddar cheese", "hard cheese"],
  },
  {
    standard: "cheese, mozzarella",
    aliases: ["mozzarella", "mozzarella cheese", "fresh mozzarella"],
  },
  {
    standard: "yogurt, plain, whole milk",
    aliases: ["yogurt", "yoghurt", "plain yogurt", "natural yogurt",
      "greek yogurt", "greek yoghurt"],
  },
  {
    standard: "butter, salted",
    aliases: ["butter"],
  },

  // ── 水果 ──
  {
    standard: "apple, raw",
    aliases: ["apple", "apples", "raw apple", "fresh apple"],
  },
  {
    standard: "banana, raw",
    aliases: ["banana", "bananas", "raw banana"],
  },
  {
    standard: "orange, raw",
    aliases: ["orange", "oranges", "raw orange"],
  },
  {
    standard: "grape, raw",
    aliases: ["grape", "grapes"],
  },
  {
    standard: "strawberry, raw",
    aliases: ["strawberry", "strawberries"],
  },
  {
    standard: "blueberry, raw",
    aliases: ["blueberry", "blueberries"],
  },
  {
    standard: "avocado, raw",
    aliases: ["avocado", "avocados", "avocado pear"],
  },
  {
    standard: "watermelon, raw",
    aliases: ["watermelon"],
  },
  {
    standard: "pineapple, raw",
    aliases: ["pineapple"],
  },
  {
    standard: "mango, raw",
    aliases: ["mango", "mangoes"],
  },
  {
    standard: "pear, raw",
    aliases: ["pear", "pears"],
  },
  {
    standard: "peach, raw",
    aliases: ["peach", "peaches"],
  },

  // ── 蔬菜 ──
  {
    standard: "potato, baked, flesh and skin",
    aliases: ["potato", "potatoes", "baked potato", "jacket potato"],
  },
  {
    standard: "potato, french fried",
    aliases: ["fries", "french fries", "chips", "fried potatoes"],
  },
  {
    standard: "sweet potato, baked",
    aliases: ["sweet potato", "sweet potatoes", "yam"],
  },
  {
    standard: "broccoli, cooked",
    aliases: ["broccoli", "cooked broccoli", "steamed broccoli"],
  },
  {
    standard: "spinach, raw",
    aliases: ["spinach", "raw spinach", "baby spinach"],
  },
  {
    standard: "spinach, cooked",
    aliases: ["cooked spinach", "sauteed spinach"],
  },
  {
    standard: "lettuce, romaine, raw",
    aliases: ["lettuce", "romaine", "romaine lettuce", "salad", "salad greens"],
  },
  {
    standard: "tomato, raw",
    aliases: ["tomato", "tomatoes", "raw tomato", "fresh tomato"],
  },
  {
    standard: "carrot, raw",
    aliases: ["carrot", "carrots", "raw carrot"],
  },
  {
    standard: "onion, raw",
    aliases: ["onion", "onions", "raw onion", "brown onion", "red onion"],
  },
  {
    standard: "cucumber, raw",
    aliases: ["cucumber", "cucumbers"],
  },
  {
    standard: "bell pepper, green, raw",
    aliases: ["bell pepper", "green pepper", "capsicum", "bell peppers"],
  },
  {
    standard: "bell pepper, red, raw",
    aliases: ["red pepper", "red bell pepper", "red capsicum"],
  },
  {
    standard: "mushroom, white, raw",
    aliases: ["mushroom", "mushrooms", "white mushroom", "button mushroom"],
  },
  {
    standard: "corn, sweet, cooked",
    aliases: ["corn", "sweet corn", "corn on the cob", "sweetcorn"],
  },
  {
    standard: "green bean, cooked",
    aliases: ["green beans", "string beans", "french beans"],
  },

  // ── 饮品 / 液体 ──
  {
    standard: "coffee, black",
    aliases: ["coffee", "black coffee", "americano", "espresso", "long black"],
    density: 1.0,
  },
  {
    standard: "coffee, latte, whole milk",
    aliases: ["latte", "cafe latte", "caffe latte", "coffee latte"],
    density: 1.03,
  },
  {
    standard: "tea, black, brewed",
    aliases: ["tea", "black tea", "english breakfast tea"],
    density: 1.0,
  },
  {
    standard: "orange juice, fresh",
    aliases: ["orange juice", "oj", "fresh orange juice"],
    density: 1.04,
  },
  {
    standard: "apple juice",
    aliases: ["apple juice"],
    density: 1.04,
  },
  {
    standard: "cola, regular",
    aliases: ["cola", "coke", "coca cola", "pepsi", "soda", "soft drink"],
    density: 1.04,
  },
  {
    standard: "water, tap",
    aliases: ["water", "tap water", "still water"],
    density: 1.0,
  },
  {
    standard: "beer, regular",
    aliases: ["beer", "lager", "ale", "pint of beer"],
    density: 1.01,
  },
  {
    standard: "wine, red",
    aliases: ["red wine", "wine"],
    density: 0.99,
  },
  {
    standard: "wine, white",
    aliases: ["white wine"],
    density: 0.99,
  },

  // ── 酱料 / 调味品 ──
  {
    standard: "olive oil",
    aliases: ["olive oil", "extra virgin olive oil"],
    density: 0.92,
  },
  {
    standard: "soy sauce",
    aliases: ["soy sauce", "soya sauce"],
    density: 1.2,
  },
  {
    standard: "ketchup",
    aliases: ["ketchup", "tomato ketchup", "tomato sauce", "catsup"],
  },
  {
    standard: "mayonnaise",
    aliases: ["mayonnaise", "mayo"],
  },
  {
    standard: "peanut butter",
    aliases: ["peanut butter", "peanut paste"],
  },
  {
    standard: "jam, strawberry",
    aliases: ["jam", "strawberry jam", "jelly", "fruit jam"],
  },
  {
    standard: "honey",
    aliases: ["honey"],
    density: 1.42,
  },
  {
    standard: "sugar, granulated",
    aliases: ["sugar", "white sugar", "granulated sugar", "table sugar"],
  },

  // ── 坚果 / 种子 ──
  {
    standard: "almond, raw",
    aliases: ["almond", "almonds", "raw almonds"],
  },
  {
    standard: "peanut, roasted, salted",
    aliases: ["peanut", "peanuts", "roasted peanuts", "salted peanuts"],
  },
  {
    standard: "walnut, raw",
    aliases: ["walnut", "walnuts", "raw walnuts"],
  },
  {
    standard: "cashew, raw",
    aliases: ["cashew", "cashews"],
  },
  {
    standard: "mixed nuts, roasted, salted",
    aliases: ["mixed nuts", "trail mix"],
  },

  // ── 零食 / 甜点 ──
  {
    standard: "chocolate, dark, 70-85% cocoa",
    aliases: ["dark chocolate", "chocolate", "chocolate bar"],
  },
  {
    standard: "chocolate, milk",
    aliases: ["milk chocolate"],
  },
  {
    standard: "cookie, chocolate chip",
    aliases: ["cookie", "cookies", "chocolate chip cookie", "biscuit"],
  },
  {
    standard: "cake, vanilla",
    aliases: ["cake", "sponge cake", "vanilla cake"],
  },
  {
    standard: "ice cream, vanilla",
    aliases: ["ice cream", "vanilla ice cream", "icecream"],
  },
  {
    standard: "potato chips, salted",
    aliases: ["chips", "potato chips", "crisps", "potato crisps"],
  },
  {
    standard: "popcorn, air-popped",
    aliases: ["popcorn"],
  },
  {
    standard: "cracker, saltine",
    aliases: ["cracker", "crackers", "saltine crackers", "biscuit cracker"],
  },

  // ── 其他 ──
  {
    standard: "pizza, cheese, thin crust",
    aliases: ["pizza", "cheese pizza", "slice of pizza", "margherita pizza"],
  },
  {
    standard: "sandwich, ham and cheese",
    aliases: ["sandwich", "ham sandwich", "ham and cheese sandwich",
      "cheese sandwich"],
  },
  {
    standard: "burger, beef, single patty",
    aliases: ["burger", "hamburger", "beef burger", "cheeseburger"],
  },
  {
    standard: "soup, chicken noodle",
    aliases: ["chicken soup", "chicken noodle soup", "noodle soup"],
  },
  {
    standard: "soup, tomato",
    aliases: ["tomato soup"],
  },
  {
    standard: "salad, caesar, with dressing",
    aliases: ["caesar salad", "ceasar salad", "chicken caesar salad"],
  },
  {
    standard: "sushi, california roll",
    aliases: ["sushi", "california roll", "maki", "sushi roll"],
  },
  {
    standard: "burrito, beef and bean",
    aliases: ["burrito", "beef burrito", "bean burrito", "chicken burrito",
      "mexican burrito"],
  },
];

// ══════════════════════════════════════════════════════════════════════════════
// 食物名标准化
// ══════════════════════════════════════════════════════════════════════════════

/** Dice 系数（2-gram overlap）。0 = 完全不同，1 = 完全相同。 */
function diceCoefficient(a: string, b: string): number {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;

  const bigramsA = new Set<string>();
  for (let i = 0; i < a.length - 1; i++) {
    bigramsA.add(a.slice(i, i + 2));
  }

  let overlap = 0;
  for (let i = 0; i < b.length - 1; i++) {
    if (bigramsA.has(b.slice(i, i + 2))) {
      overlap++;
    }
  }

  const totalPairs = (a.length - 1) + (b.length - 1);
  return totalPairs > 0 ? (2 * overlap) / totalPairs : 0;
}

/**
 * 标准化食物名。
 * 策略：先精确匹配别名 → 再模糊匹配 → 多候选排序返回。
 */
export function normalizeFoodName(
  input: string,
): { candidates: NormalizedFood[] } {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { candidates: [] };

  const lower = trimmed.toLowerCase();

  // ── 第 1 层：精确别名匹配 ──
  for (const entry of FOOD_ALIASES) {
    for (const alias of entry.aliases) {
      if (alias === lower) {
        return {
          candidates: [
            { food_name: entry.standard, portion_g: 0, confidence: 1.0 },
          ],
        };
      }
    }
  }

  // ── 第 2 层：包含匹配（用户输入是某别名的子串 or 别名是输入的子串） ──
  const exactIncludes: NormalizedFood[] = [];
  for (const entry of FOOD_ALIASES) {
    for (const alias of entry.aliases) {
      if (lower.includes(alias) || alias.includes(lower)) {
        // 越长匹配越好
        const overlap = Math.min(lower.length, alias.length);
        const confidence = 0.8 + 0.15 * (overlap / Math.max(lower.length, alias.length));
        exactIncludes.push({
          food_name: entry.standard,
          portion_g: 0,
          confidence: Math.min(confidence, 1.0),
        });
        break; // 每个 entry 只取最高分
      }
    }
  }

  if (exactIncludes.length > 0) {
    // 按 confidence 降序，去重
    const seen = new Set<string>();
    const deduped: NormalizedFood[] = [];
    for (const c of exactIncludes.sort((a, b) => b.confidence - a.confidence)) {
      if (!seen.has(c.food_name)) {
        seen.add(c.food_name);
        deduped.push(c);
      }
    }
    return { candidates: deduped };
  }

  // ── 第 3 层：Dice 系数模糊匹配 ──
  const fuzzyMatches: NormalizedFood[] = [];
  for (const entry of FOOD_ALIASES) {
    let bestScore = 0;
    for (const alias of entry.aliases) {
      const score = diceCoefficient(lower, alias);
      if (score > bestScore) bestScore = score;
    }
    if (bestScore > 0.3) {
      fuzzyMatches.push({
        food_name: entry.standard,
        portion_g: 0,
        confidence: bestScore * 0.7, // 模糊匹配上限 0.7
      });
    }
  }

  if (fuzzyMatches.length > 0) {
    const seen = new Set<string>();
    const deduped: NormalizedFood[] = [];
    for (const c of fuzzyMatches.sort((a, b) => b.confidence - a.confidence)) {
      if (!seen.has(c.food_name)) {
        seen.add(c.food_name);
        deduped.push(c);
      }
    }
    // 最多返回 5 个候选
    return { candidates: deduped.slice(0, 5) };
  }

  // ── 无匹配 ──
  return {
    candidates: [
      {
        food_name: trimmed,
        portion_g: 0,
        confidence: 0.1,
      },
    ],
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 工具处理器
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 创建 normalize_food 工具处理器。
 *
 * 返回的 ToolHandler 可注入 loop 的 tools Map：
 *   tools.set("normalize_food", createNormalizeFoodHandler())
 *
 * 模型调用格式：
 *   { user_input: "a bowl of rice" }
 *
 * 返回 JSON（NormalizeFoodResult）:
 *   {
 *     original_input: "a bowl of rice",
 *     candidates: [
 *       { food_name: "rice, white, cooked", portion_g: 250, confidence: 0.95 }
 *     ]
 *   }
 */
export function createNormalizeFoodHandler(): ToolHandler {
  return async (
    args: Readonly<Record<string, unknown>>,
  ): Promise<string> => {
    try {
      const raw = args.user_input;

      if (typeof raw !== "string") {
        return JSON.stringify({
          original_input: String(raw ?? ""),
          candidates: [],
          error:
            "user_input must be a non-empty string (natural-language food description).",
        });
      }

      const userInput = raw.trim();
      if (userInput.length === 0) {
        return JSON.stringify({
          original_input: raw,
          candidates: [],
          error:
            "user_input must be a non-empty string (natural-language food description).",
        });
      }

      // 1. 解析份量
      const portion = parsePortion(userInput);

      // 2. 提取食物名（剥去份量前缀，如果有的话）
      const foodNameInput = portion ? portion.baseFood : userInput;

      // 3. 标准化食物名
      const { candidates } = normalizeFoodName(foodNameInput);

      // 4. 组装结果：将份量注入每个候选
      const portionGrams = portion?.grams ?? 0;

      let filledCandidates: NormalizedFood[] = candidates.map((c) => ({
        food_name: c.food_name,
        portion_g: c.portion_g > 0 ? c.portion_g : portionGrams,
        confidence: c.confidence,
      }));

      // 5. 如果没匹配到食物，且原始输入可作食物名，追加原输入为低置信候选
      if (filledCandidates.length === 0 && foodNameInput.length > 0) {
        filledCandidates = [
          {
            food_name: foodNameInput,
            portion_g: portionGrams,
            confidence: 0.1,
          },
        ];
      }

      const result: NormalizeFoodResult = {
        original_input: userInput,
        candidates: filledCandidates,
      };

      return JSON.stringify(result);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return JSON.stringify({
        original_input: String(args.user_input ?? ""),
        candidates: [],
        error: message,
      });
    }
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// OpenAI Function-Calling Schema
// ══════════════════════════════════════════════════════════════════════════════

/** normalize_food 的 OpenAI function-calling 工具定义。 */
export const NORMALIZE_FOOD_SCHEMA = {
  type: "function" as const,
  function: {
    name: "normalize_food",
    description:
      "Normalize a natural-language food description (e.g. 'a bowl of rice', " +
      "'two eggs', '200g of chicken breast') into standardized food entries " +
      "with estimated portion grams. Returns one or more candidates ranked by " +
      "confidence. Use this BEFORE get_food_nutrition to ensure accurate food lookup.",
    parameters: {
      type: "object" as const,
      properties: {
        user_input: {
          type: "string",
          description:
            "The user's natural-language food description, including any portion " +
            "information (e.g. 'a bowl of steamed rice', '8 oz salmon fillet').",
        },
      },
      required: ["user_input"],
    },
  },
};
