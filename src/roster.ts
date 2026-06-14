/**
 * Curated roster of hireable CAP services (the SDK has no discovery method — see CLAUDE.md).
 *
 * Built lazily from env so .env is loaded first. A leaf appears ONLY if its serviceId env var
 * is set — never hardcode a fake serviceId, and `ours: true` only for agents we registered.
 * As we register more leafs in the Dashboard, add their env var below.
 */

export interface RosterEntry {
  /** Capability tag the planner routes subtasks to (e.g. "price", "summarize"). */
  capability: string;
  /** CAP serviceId to negotiate against. */
  serviceId: string;
  /** Human label for logs / demo. */
  label: string;
  /** Whether this is one of our own seeded leaf-agents (honesty flag for the manifest). */
  ours: boolean;
}

/** Map of capability -> the env var holding its serviceId. Extend as leafs get registered. */
const LEAF_ENV: { capability: string; label: string; env: string }[] = [
  { capability: 'price', label: 'ETH price (Chainlink, Base)', env: 'LEAF_PRICE_SERVICE_ID' },
  { capability: 'onchain-context', label: 'Base on-chain context', env: 'LEAF_CONTEXT_SERVICE_ID' },
  { capability: 'summarize', label: 'Plain-English summarizer', env: 'LEAF_SUMMARIZE_SERVICE_ID' },
];

let cached: RosterEntry[] | undefined;

export function getRoster(): RosterEntry[] {
  if (cached) return cached;
  cached = LEAF_ENV.flatMap(({ capability, label, env }) => {
    const serviceId = process.env[env];
    return serviceId ? [{ capability, serviceId, label, ours: true }] : [];
  });
  return cached;
}

export function pickForCapability(capability: string): RosterEntry | undefined {
  // Price/availability-aware selection would go here. NOTE: no on-chain PTS reputation exists
  // in cap-contracts (red-team) — do not route on reputation. First match for now.
  return getRoster().find((e) => e.capability === capability);
}
