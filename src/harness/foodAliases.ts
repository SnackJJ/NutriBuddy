// 食物别名词典（issue #13 / PRD v2 §3.3）。
//
// 将常见口语食物名映射到 USDA 标准名。
// 标准名设计为可直接传入 get_food_nutrition 的格式。

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
