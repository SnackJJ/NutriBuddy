// Catalog snapshot loader (issue #60 / ADD §Data Pipeline).
//
// Builds a runtime Catalog from an ingestion output file
// (src/ingest/usda.ts → CatalogSnapshot JSON), carrying the file's version
// stamp so resolver results and turn_start events reproduce against the
// data actually loaded.
//
// Server-only: reads the filesystem. Do not import from client components.

import fs from "node:fs";
import { createCatalog, SEED_FOODS, type Catalog } from "./catalog";
import type { CatalogSnapshot } from "../lib/usda";

/** Env var pointing at an ingestion snapshot file; unset → seed catalog. */
export const CATALOG_SNAPSHOT_PATH_ENV = "CATALOG_SNAPSHOT_PATH";

function isSnapshotShape(value: unknown): value is CatalogSnapshot {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as CatalogSnapshot).version === "string" &&
    (value as CatalogSnapshot).version.length > 0 &&
    Array.isArray((value as CatalogSnapshot).foods)
  );
}

/**
 * Load a versioned catalog snapshot file and build a Catalog from it.
 *
 * Fails loud on unreadable files or malformed snapshots — a silently
 * wrong catalog would poison every resolver trace downstream.
 */
export function loadCatalogSnapshot(path: string): Catalog {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(
      `Failed to read catalog snapshot at ${path}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  if (!isSnapshotShape(parsed)) {
    throw new Error(
      `Malformed catalog snapshot at ${path}: expected { version, foods[] }`,
    );
  }

  return createCatalog(parsed.foods, parsed.version);
}

/**
 * Resolve the runtime catalog: a snapshot file when configured via
 * CATALOG_SNAPSHOT_PATH, else the curated seed.
 */
export function loadConfiguredCatalog(
  env: Readonly<Record<string, string | undefined>> = process.env,
): Catalog {
  const path = env[CATALOG_SNAPSHOT_PATH_ENV];
  return path ? loadCatalogSnapshot(path) : createCatalog(SEED_FOODS);
}
