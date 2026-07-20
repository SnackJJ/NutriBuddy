// Catalog package public surface (structural Phase 5).
// Ground truth for foods, resolver, query templates, and in-memory QueryRunner.
// Harness/agent loop imports ground truth from here — not the reverse.

export {
  createCatalog,
  SEED_FOODS,
  nutritionPer100g,
  type Catalog,
  type CatalogFood,
  type FoodRef,
  type ResolveResult,
  type ResolveMissResult,
} from "./catalog";

export { resolveFood } from "./resolver";

export {
  createQueryCatalog,
  executeQuery,
  renderObservationText,
  ALL_QUERY_TEMPLATES,
  FOOD_LOOKUP_TEMPLATE,
  MEAL_SUMMARY_TEMPLATE,
  DAILY_TOTALS_TEMPLATE,
  WEEKLY_TOTALS_TEMPLATE,
  DAILY_AVERAGE_TEMPLATE,
  RANGE_COMPARISON_TEMPLATE,
  TOP_K_BY_NUTRIENT_TEMPLATE,
  type QueryCatalog,
  type QueryRunner,
  type QueryResult,
  type Observation,
  type ObservationRow,
  type ColumnDef,
  type MealRecord,
  type RenderedObservation,
  type QueryTemplate,
} from "./queryCatalog";

export {
  createInMemoryQueryRunner,
  FoodNotFoundError,
} from "./inMemoryQueryRunner";

export { loadConfiguredCatalog } from "./snapshotLoader";
