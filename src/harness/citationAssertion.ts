// Citation assertion backstop (S4 / RFC 0011 §3.6, issue #110).
//
// Tier-2 of the citation path, and the only half that can end a turn. The rule is
// narrow on purpose:
//
//   * citing nothing is **legal** — not every answer makes an evidence claim, and
//     requiring a citation for "you ate 150 g of rice" would be noise;
//   * *claiming authority while citing nothing* is not. "The Dietary Guidelines
//     recommend…" with no citation is an appeal to a source the answer cannot
//     name, which is the failure mode the evidence layer exists to remove.
//
// So the check is lexical and phrase-based, in the same family as the existing
// backstop, and it runs **after** the provenance strip (RFC 0011 §3.5): a citation
// that is about to be removed must not be able to satisfy this check, or an
// answer could earn its authority from evidence that never reaches the user.
//
// What it is not: a claim about whether the cited text supports the sentence. That
// is a semantic judgement, and this gate is deterministic — "does the answer
// claim a source and name one" is the question that can be answered here.

import type { TypedOutput } from "./types";

/**
 * Phrases that assert authority.
 *
 * Kept short and specific: each one is a claim about what a *source says*, not a
 * claim about food. "According to USDA FoodData Central" qualifies on purpose —
 * it names an authority for a number, and numbers have their own provenance gate
 * (the catalog observation), so an answer that wants to attribute them to USDA
 * can cite the evidence layer or drop the attribution.
 */
export const ASSERTION_PHRASES: readonly RegExp[] = [
  /\bguidelines?\s+(recommend|recommends|suggest|suggests|advise|advises|call for)\b/i,
  /\bthe dietary guidelines\b/i,
  /\bdietary guidelines for americans\b/i,
  /\baccording to (the\s+)?(dietary guidelines|usda|nih|ods|fda|cdc|guidance|guidelines|recommendations)\b/i,
  /\brecommendations?\s+(are|is|say|state)\b/i,
  /\bexperts?\s+(recommend|recommends|suggest|suggests|advise|advises)\b/i,
  /\bevidence[- ]based guidance\b/i,
  /\bofficial guidance\b/i,
  /\bhealth authorities\b/i,
  // The same claim in the language the product's prompt is written in.
  /指南(建议|推荐)/,
  /膳食指南/,
  /权威(机构|指南)/,
];

export interface CitationAssertionResult {
  readonly passed: boolean;
  /** The phrases that asserted authority, deduplicated and in match order. */
  readonly matched: readonly string[];
  readonly reasons: readonly string[];
}

/**
 * Check whether the answer claims authority it cannot name.
 *
 * A citation that survived the provenance check satisfies this; the field being
 * absent, empty, or stripped to nothing does not.
 */
export function checkCitationAssertions(
  output: TypedOutput | undefined,
): CitationAssertionResult {
  if (!output) return { passed: true, matched: [], reasons: [] };

  const matched: string[] = [];
  for (const phrase of ASSERTION_PHRASES) {
    const hit = phrase.exec(output.prose);
    if (hit) matched.push(hit[0]);
  }

  if (matched.length === 0) return { passed: true, matched: [], reasons: [] };

  const citations = output.citations ?? [];
  if (citations.length > 0) return { passed: true, matched, reasons: [] };

  return {
    passed: false,
    matched,
    reasons: [
      `The answer claims what guidance says (${matched.map((phrase) => `"${phrase}"`).join(", ")}) ` +
        `but cites no evidence section. Either cite the section the claim comes from, or state it ` +
        `without attributing it to a source.`,
    ],
  };
}
