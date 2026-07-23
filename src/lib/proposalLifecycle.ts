// Proposal lifecycle helpers (RFC 0004 §6.3).

/** Default TTL: 30 minutes (backend commit also enforces this). */
export const PROPOSAL_TTL_MS = 30 * 60 * 1000;

export type ProposalUiStatus =
  | "pending"
  | "committed"
  | "voided"
  | "stale";

export function isProposalStale(
  createdAt: string,
  nowMs: number = Date.now(),
  ttlMs: number = PROPOSAL_TTL_MS,
): boolean {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return false;
  return nowMs - created >= ttlMs;
}

export function proposalAgeMs(
  createdAt: string,
  nowMs: number = Date.now(),
): number {
  const created = Date.parse(createdAt);
  if (!Number.isFinite(created)) return 0;
  return Math.max(0, nowMs - created);
}
