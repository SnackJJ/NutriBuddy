// USDA FoodData Central ingestion script (issue #42 / ADD §Data Pipeline).
//
// Fetches foods from USDA FoodData Central offline using the UsdaClient,
// maps each result into the canonical CatalogFood shape via mapToCatalogFood,
// and emits a versioned CatalogSnapshot JSON file.
//
// The runtime never calls USDA. This script is the single ingestion path;
// its output becomes the seed catalog the resolver and tool layer consume.
//
// Usage:
//   npx tsx src/ingest/usda.ts --foods "apple,banana,chicken breast" [--output catalog-snapshot.json]
//
// Environment: USDA_API_KEY must be set (or passed via --api-key).

import { UsdaClient, mapToCatalogFood, createCatalogSnapshot } from "../lib/usda";
import type { CatalogFood } from "../catalog/catalog";
import type { CatalogSnapshot } from "../lib/usda";
import * as fs from "node:fs";
import * as path from "node:path";

// ─── core ingestion logic ────────────────────────────────────────────────────

/** Category mapping: assign a category to a food name based on keywords. */
function guessCategory(foodName: string): string {
  const lower = foodName.toLowerCase();
  if (/\b(chicken|beef|pork|turkey|steak|lamb|meat)\b/.test(lower)) return "meat";
  if (/\b(salmon|tuna|shrimp|cod|fish|seafood|prawn)\b/.test(lower))
    return "seafood";
  if (/\b(rice|bread|pasta|oat|cereal|noodle|grain|flour)\b/.test(lower))
    return "grain";
  if (
    /\b(broccoli|spinach|carrot|tomato|potato|lettuce|onion|pepper|vegetable)\b/.test(
      lower,
    )
  )
    return "vegetable";
  if (/\b(milk|cheese|yogurt|egg|butter|cream|dairy)\b/.test(lower))
    return "dairy";
  if (/\b(apple|banana|orange|berry|fruit|grape|melon|peach|pear)\b/.test(lower))
    return "fruit";
  if (/\b(tofu|bean|nut|almond|walnut|peanut|lentil|soy)\b/.test(lower))
    return "legume_nut";
  if (
    /\b(juice|coffee|tea|water|drink|soda|beverage|milk|smoothie)\b/.test(lower)
  )
    return "beverage";
  return "general";
}

/**
 * Ingest foods from USDA — the core ingestion pipeline.
 *
 * Fetches each food name from USDA via the provided client, maps the result
 * into CatalogFood, and returns the collected entries. Unknown foods (where
 * USDA returns null) are logged to stderr and skipped — they do not halt
 * the batch.
 *
 * This function is the testable core; the CLI wrapper handles CLI concerns.
 *
 * @param client - a configured UsdaClient (DI for testing)
 * @param foodNames - food names to search (e.g. from CLI --foods or a JSON list)
 * @param categories - optional per-food category hints; falls back to guessCategory
 */
export async function ingestFoods(
  client: UsdaClient,
  foodNames: readonly string[],
  categories?: Readonly<Record<string, string>>,
): Promise<CatalogFood[]> {
  const results: CatalogFood[] = [];

  for (const name of foodNames) {
    const trimmed = name.trim();
    if (!trimmed) continue;

    try {
      const nutrition = await client.getFoodNutrition(trimmed);
      if (!nutrition) {
        process.stderr.write(`[ingest] USDA returned no results for "${trimmed}" — skipping\n`);
        continue;
      }

      const category =
        categories?.[trimmed] ?? guessCategory(trimmed);
      const entry = mapToCatalogFood(nutrition, results.length, category);
      results.push(entry);
    } catch (err) {
      process.stderr.write(
        `[ingest] Error fetching "${trimmed}": ${err instanceof Error ? err.message : String(err)} — skipping\n`,
      );
    }
  }

  return results;
}

/**
 * Run the ingestion pipeline and write a versioned snapshot to `outputPath`.
 *
 * This is the single function the CLI calls; tests drive ingestFoods directly.
 */
export async function runIngestion(
  client: UsdaClient,
  foodNames: readonly string[],
  outputPath: string,
  categories?: Readonly<Record<string, string>>,
): Promise<CatalogSnapshot> {
  const foods = await ingestFoods(client, foodNames, categories);
  const snapshot = createCatalogSnapshot(foods);

  const dir = path.dirname(outputPath);
  if (dir && dir !== ".") {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputPath, JSON.stringify(snapshot, null, 2), "utf-8");
  process.stderr.write(
    `[ingest] Wrote ${foods.length} foods (v${snapshot.version}) to ${outputPath}\n`,
  );

  return snapshot;
}

// ─── CLI entry point ─────────────────────────────────────────────────────────

interface CliArgs {
  foods: string;
  output?: string;
  apiKey?: string;
  categoriesPath?: string;
}

function parseCliArgs(argv: readonly string[]): CliArgs {
  const args: CliArgs = { foods: "" };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--foods" && i + 1 < argv.length) {
      args.foods = argv[++i];
    } else if (arg === "--output" && i + 1 < argv.length) {
      args.output = argv[++i];
    } else if (arg === "--api-key" && i + 1 < argv.length) {
      args.apiKey = argv[++i];
    } else if (arg === "--categories" && i + 1 < argv.length) {
      args.categoriesPath = argv[++i];
    } else if (arg.startsWith("--foods=")) {
      args.foods = arg.slice("--foods=".length);
    } else if (arg.startsWith("--output=")) {
      args.output = arg.slice("--output=".length);
    } else if (arg.startsWith("--api-key=")) {
      args.apiKey = arg.slice("--api-key=".length);
    } else if (arg.startsWith("--categories=")) {
      args.categoriesPath = arg.slice("--categories=".length);
    }
  }
  return args;
}

async function main(): Promise<void> {
  const cli = parseCliArgs(process.argv);

  if (!cli.foods) {
    process.stderr.write(
      "Usage: npx tsx src/ingest/usda.ts --foods \"apple,banana,chicken breast\" [--output catalog-snapshot.json]\n",
    );
    process.exit(1);
  }

  const client = new UsdaClient({ apiKey: cli.apiKey });
  const foodNames = cli.foods
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  let categories: Record<string, string> | undefined;
  if (cli.categoriesPath) {
    categories = JSON.parse(
      fs.readFileSync(cli.categoriesPath, "utf-8"),
    ) as Record<string, string>;
  }

  await runIngestion(
    client,
    foodNames,
    cli.output ?? "catalog-snapshot.json",
    categories,
  );
}

// Only run main when executed directly (not imported in tests).
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`[ingest] Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  });
}
