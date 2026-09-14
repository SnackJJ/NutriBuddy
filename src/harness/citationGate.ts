// Citation provenance check (S4 / RFC 0011 §3.5, issue #109).
//
// Four conditions, all deterministic, all about the citation rather than about
// the answer's content:
//
//   1. the section exists in the registry;
//   2. its document's status is `active` — citing a superseded clause is a new
//      failure mode, not a milder version of a good one;
//   3. the version the model quoted matches the registry's current version;
//   4. the section is in *this turn's* evidence set, so a citation cannot cite
//      something the turn was never allowed to see.
//
// Two properties matter more than the conditions themselves:
//
//   * **fail-closed.** No registry, no evidence set, or a registry that cannot be
//     read means *no citation survives*. An answer is allowed to make no evidence
//     claim; it is never allowed to make an unverifiable one.
//   * **tier-1 is not a refusal.** Invalid citations are stripped deterministically
//     and reported with a `block` verdict that is explicitly not `terminal`, so
//     the answer's numbers, entities and allergies keep their own verdicts and the
//     shared regenerate budget is untouched (ADR 0004: the evidence layer carries
//     no safety property). Only "claims authority without citing anything" — the
//     lexical backstop — reaches the regenerate path.

import type { CitationRef, TypedOutput } from "./types";
import type { TurnEvidenceSet } from "./turn";

/**
 * The registry as the gate needs it.
 *
 * A port, so the gate stays a pure function of (output, evidence set, entries) —
 * including the case where there is no registry at all, which is a state the gate
 * has to handle rather than an error it can assume away.
 */
export interface CitationRegistry {
  entries(sectionIds: readonly string[]): Promise<readonly CitationRegistryEntry[]>;
}

/** What the registry knows about one section. */
export interface CitationRegistryEntry {
  readonly sectionId: string;
  /** Document identity, e.g. `ods-vitamind` — the version lives in its own field. */
  readonly sourceId: string;
  readonly docVersion: string;
  readonly status: "active" | "superseded" | "archived";
}

export interface CitationCheckInput {
  readonly output: TypedOutput | undefined;
  /** The sections this turn was allowed to cite; absent means "not recorded". */
  readonly evidenceSet: TurnEvidenceSet | undefined;
  /** Registry rows for the cited sections, or undefined when unavailable. */
  readonly entries: readonly CitationRegistryEntry[] | undefined;
  /** Why the registry is unavailable, when it is. */
  readonly unavailableReason?: string;
}

export interface StrippedCitation {
  readonly citation: CitationRef;
  readonly reason: string;
}

export interface CitationCheckResult {
  /** True when every citation the answer made survived. */
  readonly passed: boolean;
  /** Kept citations, in the order the model gave them. */
  readonly kept: readonly CitationRef[];
  readonly stripped: readonly StrippedCitation[];
  /** One line per distinct problem, for the verdict's evidence. */
  readonly reasons: readonly string[];
}

function stripAll(output: TypedOutput | undefined, reason: string): CitationCheckResult {
  const citations = output?.citations ?? [];
  return {
    passed: citations.length === 0,
    kept: [],
    stripped: citations.map((citation) => ({ citation, reason })),
    reasons: citations.length > 0 ? [reason] : [],
  };
}

/**
 * Judge every citation independently.
 *
 * Independently rather than all-or-nothing: one unresolvable citation does not
 * make the other three false, and stripping the good ones alongside the bad would
 * destroy evidence the answer legitimately used.
 */
export function checkCitations(input: CitationCheckInput): CitationCheckResult {
  const citations = input.output?.citations ?? [];
  if (citations.length === 0) {
    return { passed: true, kept: [], stripped: [], reasons: [] };
  }

  // Both fail-closed paths are checked before anything is judged, because "the
  // registry said no" and "nobody could ask the registry" must not be confused in
  // the verdict's evidence.
  if (!input.evidenceSet) {
    return stripAll(input.output, "no evidence set was recorded for this turn");
  }
  if (!input.entries) {
    return stripAll(
      input.output,
      `evidence registry unavailable: ${input.unavailableReason ?? "unknown reason"}`,
    );
  }

  const bySectionId = new Map(input.entries.map((entry) => [entry.sectionId, entry]));
  const allowed = new Set(input.evidenceSet.sectionIds);
  const kept: CitationRef[] = [];
  const stripped: StrippedCitation[] = [];

  for (const citation of citations) {
    const entry = bySectionId.get(citation.sectionId);
    if (!entry) {
      stripped.push({ citation, reason: `unknown section ${citation.sectionId}` });
      continue;
    }
    if (entry.status !== "active") {
      stripped.push({
        citation,
        reason: `section ${citation.sectionId} belongs to a ${entry.status} document`,
      });
      continue;
    }
    if (entry.docVersion !== citation.docVersion) {
      stripped.push({
        citation,
        reason:
          `version mismatch for ${citation.sectionId}: ` +
          `cited ${citation.docVersion}, registry has ${entry.docVersion}`,
      });
      continue;
    }
    if (entry.sourceId !== citation.sourceId) {
      stripped.push({
        citation,
        reason:
          `document mismatch for ${citation.sectionId}: ` +
          `cited ${citation.sourceId}, registry has ${entry.sourceId}`,
      });
      continue;
    }
    if (!allowed.has(citation.sectionId)) {
      stripped.push({
        citation,
        reason: `section ${citation.sectionId} was not in this turn's evidence set`,
      });
      continue;
    }
    kept.push(citation);
  }

  return {
    passed: stripped.length === 0,
    kept,
    stripped,
    reasons: [...new Set(stripped.map((entry) => entry.reason))],
  };
}

/**
 * The answer without its invalid citations.
 *
 * Returns the output unchanged when nothing was stripped, and drops the field
 * entirely when nothing survives — an empty `citations: []` would be a claim
 * ("I checked, there is nothing to cite") that a stripped answer has not earned.
 */
export function stripInvalidCitations(
  output: TypedOutput | undefined,
  result: CitationCheckResult,
): TypedOutput | undefined {
  if (!output || result.stripped.length === 0) return output;
  if (result.kept.length === 0) {
    const { citations: _dropped, ...rest } = output;
    return rest;
  }
  return { ...output, citations: result.kept };
}

/** The verdict evidence for a stripped batch: what went, and why. */
export function citationEvidence(result: CitationCheckResult): string {
  if (result.stripped.length === 0) {
    return `${result.kept.length} citation(s) verified against the registry and this turn's evidence set`;
  }
  const detail = result.reasons.map((reason) => `  - ${reason}`).join("\n");
  return (
    `Stripped ${result.stripped.length} citation(s); kept ${result.kept.length}.\n${detail}\n` +
    `Citations that cannot be resolved are removed rather than answered with — the prose stands on its own.`
  );
}
