import { describe, expect, it } from "vitest";
import * as catalog from "../src/catalog";
import { createQueryCatalogHandler } from "../src/harness/queryCatalog";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("catalog package boundary (Phase 5)", () => {
  it("exports ground-truth surface from package root", () => {
    expect(typeof catalog.createCatalog).toBe("function");
    expect(typeof catalog.resolveFood).toBe("function");
    expect(typeof catalog.createQueryCatalog).toBe("function");
    expect(typeof catalog.createInMemoryQueryRunner).toBe("function");
    expect(typeof catalog.executeQuery).toBe("function");
    expect(catalog.ALL_QUERY_TEMPLATES.length).toBeGreaterThan(0);
    expect(catalog.SEED_FOODS.length).toBeGreaterThan(0);
  });

  it("in-memory runner lives under catalog and runs food_lookup", async () => {
    const cat = catalog.createCatalog(catalog.SEED_FOODS);
    const runner = catalog.createInMemoryQueryRunner(cat);
    const food = cat.allFoods[0];
    const obs = await runner(
      catalog.FOOD_LOOKUP_TEMPLATE.id,
      { food_id: food.id, portion_g: 100 },
      "user-1",
    );
    expect(obs.templateId).toBe(catalog.FOOD_LOOKUP_TEMPLATE.id);
    expect(obs.rowCount).toBe(1);
  });

  it("catalog modules do not import harness (no reverse ownership)", () => {
    const catalogDir = join(process.cwd(), "src/catalog");
    for (const file of [
      "catalog.ts",
      "queryCatalog.ts",
      "resolver.ts",
      "snapshotLoader.ts",
      "inMemoryQueryRunner.ts",
      "index.ts",
    ]) {
      const text = readFileSync(join(catalogDir, file), "utf8");
      expect(text).not.toMatch(/from ["']\.\.\/harness/);
      expect(text).not.toMatch(/from ["']@\/harness/);
    }
  });

  it("harness query handler consumes catalog runner without owning templates", async () => {
    const cat = catalog.createCatalog(catalog.SEED_FOODS);
    const qc = catalog.createQueryCatalog(catalog.ALL_QUERY_TEMPLATES);
    const handler = createQueryCatalogHandler({
      queryCatalog: qc,
      runner: catalog.createInMemoryQueryRunner(cat),
      userId: "u1",
    });
    const outcome = await handler({
      template_id: catalog.FOOD_LOOKUP_TEMPLATE.id,
      food_id: cat.allFoods[0].id,
      portion_g: 100,
    });
    expect(typeof outcome).toBe("object");
    expect(outcome).toHaveProperty("kind");
  });
});
