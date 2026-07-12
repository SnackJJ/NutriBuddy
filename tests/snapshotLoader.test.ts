import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
  loadCatalogSnapshot,
  loadConfiguredCatalog,
  CATALOG_SNAPSHOT_PATH_ENV,
} from "../src/catalog/snapshotLoader";
import {
  createCatalog,
  CATALOG_SNAPSHOT_VERSION,
  SEED_FOODS,
} from "../src/catalog/catalog";
import { resolveFood } from "../src/catalog/resolver";
import { runIngestion } from "../src/ingest/usda";
import type { FoodNutrition, FoodNutritionLookup } from "../src/lib/usda";

function appleNutrition(): FoodNutrition {
  return {
    food_name: "Apples, raw, with skin",
    portion_g: 100,
    kcal: 52,
    protein_g: 0.3,
    fat_g: 0.2,
    carbs_g: 14,
    fiber_g: 2.4,
    sugars_g: 10,
    saturated_fat_g: 0.03,
    cholesterol_mg: 0,
    sodium_mg: 1,
    calcium_mg: 6,
    iron_mg: 0.1,
    potassium_mg: 107,
    vitamin_c_mg: 4.6,
    vitamin_d_mcg: 0,
  };
}

function makeClient(): FoodNutritionLookup {
  return {
    getFoodNutrition: async () => appleNutrition(),
  };
}

describe("createCatalog version parameter (issue #60)", () => {
  it("defaults to the seed constant", () => {
    expect(createCatalog(SEED_FOODS).snapshot.version).toBe(
      CATALOG_SNAPSHOT_VERSION,
    );
  });

  it("carries a supplied snapshot version as data", () => {
    const catalog = createCatalog(SEED_FOODS, "custom-snapshot-v9");
    expect(catalog.snapshot.version).toBe("custom-snapshot-v9");
  });
});

describe("resolver stamps the catalog's snapshot version (issue #60)", () => {
  it("stamps hits and misses with catalog.snapshot.version, not the constant", () => {
    const catalog = createCatalog(SEED_FOODS, "custom-snapshot-v9");

    const hit = resolveFood(catalog, "shrimp");
    expect(hit.catalogSnapshotId).toBe("custom-snapshot-v9");

    const miss = resolveFood(catalog, "zzzz-not-a-food");
    expect(miss.catalogSnapshotId).toBe("custom-snapshot-v9");
  });
});

describe("loadCatalogSnapshot (issue #60)", () => {
  it("golden round-trip: ingestion output → loader → resolver", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutribuddy-snap-"));
    const snapshotPath = path.join(tmpDir, "catalog-snapshot.json");

    try {
      const snapshot = await runIngestion(
        makeClient(),
        ["apple"],
        snapshotPath,
      );

      const catalog = loadCatalogSnapshot(snapshotPath);

      expect(catalog.snapshot.version).toBe(snapshot.version);
      expect(catalog.snapshot.version).not.toBe(CATALOG_SNAPSHOT_VERSION);
      expect(catalog.snapshot.foodCount).toBe(1);

      // Resolver results reproduce against the loaded snapshot's version
      const result = resolveFood(catalog, "apples, raw, with skin");
      expect(result.matchType).toBe("exact");
      expect(result.catalogSnapshotId).toBe(snapshot.version);
      expect(result.foodRef?.foodId).toBe(snapshot.foods[0].id);

      // Ingested foods stay unreviewed after the round-trip (issue #66):
      // the output entity check fails closed on them
      expect(catalog.allFoods[0].allergenTags).toBeUndefined();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("fails loud on a missing file", () => {
    expect(() => loadCatalogSnapshot("/nonexistent/snapshot.json")).toThrow(
      /Failed to read catalog snapshot/,
    );
  });

  it("fails loud on a malformed snapshot (no version)", () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutribuddy-snap-"));
    const badPath = path.join(tmpDir, "bad.json");

    try {
      fs.writeFileSync(badPath, JSON.stringify({ foods: [] }), "utf-8");
      expect(() => loadCatalogSnapshot(badPath)).toThrow(
        /Malformed catalog snapshot/,
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

describe("loadConfiguredCatalog (issue #60)", () => {
  it("falls back to the seed catalog when the env var is unset", () => {
    const catalog = loadConfiguredCatalog({});
    expect(catalog.snapshot.version).toBe(CATALOG_SNAPSHOT_VERSION);
    expect(catalog.snapshot.foodCount).toBe(SEED_FOODS.length);
  });

  it("loads the snapshot file named by the env var", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "nutribuddy-snap-"));
    const snapshotPath = path.join(tmpDir, "catalog-snapshot.json");

    try {
      const snapshot = await runIngestion(
        makeClient(),
        ["apple"],
        snapshotPath,
      );

      const catalog = loadConfiguredCatalog({
        [CATALOG_SNAPSHOT_PATH_ENV]: snapshotPath,
      });

      expect(catalog.snapshot.version).toBe(snapshot.version);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
