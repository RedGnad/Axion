/**
 * Curated roster of hireable CAP services (the SDK has no discovery method — see CLAUDE.md).
 *
 * Each entry is a serviceId registered in the CROO Agent Store that Foreman can hire via
 * `negotiateOrder({ serviceId, requirements })`. Seed this with:
 *   - our own leaf-agents (registered in the Dashboard), and
 *   - real third-party agents from the store we genuinely use.
 *
 * INTEGRITY: only list services Foreman actually calls when it needs that output. Do not pad
 * the roster to inflate the A2A graph — orders must be organic (CROO scores "organic" + feeds
 * aggregated order data to judges).
 */

export interface RosterEntry {
  /** Capability tag the planner routes subtasks to (e.g. "summarize", "price", "format"). */
  capability: string;
  /** CAP serviceId to negotiate against. */
  serviceId: string;
  /** Human label for logs / demo. */
  label: string;
  /** Whether this is one of our own seeded leaf-agents (for transparency in the demo). */
  ours: boolean;
}

// TODO(builder): fill from real registered services. Empty until the first service is registered
// in the Dashboard — do NOT hardcode fake serviceIds.
export const ROSTER: RosterEntry[] = [];

export function pickForCapability(capability: string): RosterEntry | undefined {
  // TODO(builder): reputation(PTS)/price-aware selection. For now, first match.
  return ROSTER.find((e) => e.capability === capability);
}
