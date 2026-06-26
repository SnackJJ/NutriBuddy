// Chat UI helpers (issue #17 / PRD v2 §5.1).
// Pure functions shared between the chat page and tests.

/** Extract `[Source: Name]` citations from reply text.
 *  Returns the cleaned text and the list of source names. */
export function extractSources(
  text: string,
): { cleanText: string; sources: string[] } {
  const sources: string[] = [];
  const cleanText = text.replace(
    /\[Source:\s*([^\]]+)\]/gi,
    (_full: string, name: string) => {
      sources.push(name.trim());
      return "";
    },
  );
  return { cleanText: cleanText.trim(), sources };
}

/** Map a tool name to a human-readable description for the UI. */
export function friendlyToolName(name: string): string {
  const known: Record<string, string> = {
    code_act: "Querying nutrition database…",
    search_food: "Searching food database…",
    search_meal: "Looking up meal data…",
    profile_query: "Loading your profile…",
    profile_allergies: "Checking your allergies…",
    profile_nutrition_targets: "Retrieving nutrition targets…",
    drug_interactions_for_medication: "Checking drug interactions…",
    all_drug_interactions: "Checking all known interactions…",
  };
  return known[name] ?? `Running ${name}…`;
}
