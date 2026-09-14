// The evidence corpus as committed data (S4 / RFC 0011 §3.2, §3.7).
//
// `sources/` is the input the ingest step reads: a fetch catalogue, one
// directory per source (`manifest.json` + `sections.jsonl`), and the pinned set.
// This module turns those files into typed documents, and — more importantly —
// gives the repository one place to *check* the corpus rather than trust it:
// every section id unique, every pinned id present, and the pinned set inside
// RFC 0011 §3.7's budget.
//
// It is deliberately separate from the fetch script: fetching is an operator
// action against the network, while reading the committed files is what the
// ingest step and the tests do. Only the latter is allowed to be a dependency.

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

export interface CorpusSection {
  readonly id: string;
  readonly sectionPath: string;
  readonly heading: string | null;
  readonly ordinal: number;
  readonly text: string;
  readonly anchor?: string;
  readonly contentHash: string;
  readonly pinned: boolean;
}

export interface CorpusDocument {
  readonly slug: string;
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly license: string;
  readonly licenseEvidence: string;
  readonly licenseFlags: readonly string[];
  readonly authorityLevel: number;
  readonly docVersion: string;
  readonly contentHash: string;
  readonly sections: readonly CorpusSection[];
}

export interface Corpus {
  readonly documents: readonly CorpusDocument[];
  /** The pinned-set budget this corpus declares, from `pinned.json`. */
  readonly pinnedBudget: {
    readonly maxSections: number;
    readonly maxChars: number;
    readonly chars: number;
    readonly sections: number;
    readonly tokenEstimate: string;
  };
}

interface ManifestFile {
  readonly id: string;
  readonly title: string;
  readonly publisher: string;
  readonly url: string;
  readonly license: string;
  readonly licenseEvidence: string;
  readonly licenseFlags?: readonly string[];
  readonly authorityLevel: number;
  readonly docVersion: string;
  readonly sha256: string;
  readonly sectionCount: number;
}

interface PinnedFile {
  readonly _budget: {
    readonly maxSections: number;
    readonly maxChars: number;
    readonly tokenEstimate: string;
  };
  readonly sections: readonly { readonly sectionId: string }[];
}

/**
 * `chars/4` is the estimator both `pinned.json` and this module use.
 *
 * Named and shared on purpose: the ≤6k-token claim has to be checkable without
 * the tokeniser that is not in the loop, and two different estimators would make
 * the claim unfalsifiable.
 */
export function estimateTokens(chars: number): number {
  return Math.ceil(chars / 4);
}

export class CorpusError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`evidence corpus is not usable:\n  - ${problems.join("\n  - ")}`);
    this.name = "CorpusError";
    this.problems = problems;
  }
}

/**
 * Load and check the corpus.
 *
 * Checks that fail here are the ones that would otherwise surface as a citation
 * that cannot be resolved in production, so they fail the load rather than being
 * reported and ignored.
 */
export function loadCorpus(root = "sources"): Corpus {
  const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8")) as {
    sources: readonly { readonly id: string }[];
  };
  const pinnedFile = JSON.parse(
    readFileSync(join(root, "pinned.json"), "utf8"),
  ) as PinnedFile;
  const pinnedIds = new Set(pinnedFile.sections.map((section) => section.sectionId));

  const problems: string[] = [];
  const documents: CorpusDocument[] = [];
  const seenSectionIds = new Set<string>();

  for (const entry of catalog.sources) {
    const dir = join(root, entry.id);
    let manifest: ManifestFile;
    let sections: CorpusSection[];
    try {
      manifest = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")) as ManifestFile;
      sections = readFileSync(join(dir, "sections.jsonl"), "utf8")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => {
          const row = JSON.parse(line) as {
            sectionId: string;
            sectionPath: string;
            heading: string | null;
            ordinal: number;
            text: string;
            contentHash: string;
          };
          return {
            id: row.sectionId,
            sectionPath: row.sectionPath,
            heading: row.heading,
            ordinal: row.ordinal,
            text: row.text,
            contentHash: row.contentHash,
            pinned: pinnedIds.has(row.sectionId),
          };
        });
    } catch (err) {
      problems.push(`${entry.id}: ${(err as Error).message}`);
      continue;
    }

    for (const section of sections) {
      if (seenSectionIds.has(section.id)) {
        problems.push(`${entry.id}: duplicate section id ${section.id}`);
      }
      seenSectionIds.add(section.id);
      if (section.text.trim().length === 0) {
        problems.push(`${entry.id}: empty text in ${section.id}`);
      }
      if (section.contentHash !== hashText(section.text)) {
        // The stored hash is what the ingest step decides "unchanged" on; a
        // mismatch means the file was edited without re-fetching, and skipping
        // the row would then be a silent lie.
        problems.push(`${entry.id}: content hash does not match text in ${section.id}`);
      }
    }

    if (manifest.sectionCount !== sections.length) {
      problems.push(
        `${entry.id}: manifest says ${manifest.sectionCount} sections, file has ${sections.length}`,
      );
    }

    documents.push({
      slug: manifest.id,
      // Version-scoped, matching migration 0013: the old version has to remain a
      // row an old citation can still resolve against.
      id: `${manifest.id}@${manifest.docVersion}`,
      title: manifest.title,
      publisher: manifest.publisher,
      url: manifest.url,
      license: manifest.license,
      licenseEvidence: manifest.licenseEvidence,
      licenseFlags: manifest.licenseFlags ?? [],
      authorityLevel: manifest.authorityLevel,
      docVersion: manifest.docVersion,
      contentHash: manifest.sha256,
      sections,
    });
  }

  for (const sectionId of pinnedIds) {
    if (!seenSectionIds.has(sectionId)) {
      problems.push(`pinned.json names a section the corpus does not have: ${sectionId}`);
    }
  }

  const pinnedSections = documents.flatMap((doc) =>
    doc.sections.filter((section) => section.pinned),
  );
  const pinnedChars = pinnedSections.reduce((total, section) => total + section.text.length, 0);

  if (pinnedSections.length > pinnedFile._budget.maxSections) {
    problems.push(
      `pinned set has ${pinnedSections.length} sections, budget is ${pinnedFile._budget.maxSections}`,
    );
  }
  if (pinnedChars > pinnedFile._budget.maxChars) {
    problems.push(
      `pinned set is ${pinnedChars} chars, budget is ${pinnedFile._budget.maxChars}`,
    );
  }

  if (problems.length > 0) throw new CorpusError(problems);

  return {
    documents,
    pinnedBudget: {
      maxSections: pinnedFile._budget.maxSections,
      maxChars: pinnedFile._budget.maxChars,
      sections: pinnedSections.length,
      chars: pinnedChars,
      tokenEstimate: pinnedFile._budget.tokenEstimate,
    },
  };
}

function hashText(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

/** Every source directory the catalogue expects is present; used by the CLI. */
export function missingSourceDirs(root = "sources"): readonly string[] {
  const catalog = JSON.parse(readFileSync(join(root, "catalog.json"), "utf8")) as {
    sources: readonly { readonly id: string }[];
  };
  const present = new Set(readdirSync(root));
  return catalog.sources.map((entry) => entry.id).filter((id) => !present.has(id));
}
