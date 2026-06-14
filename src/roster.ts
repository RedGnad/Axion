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

/**
 * Real THIRD-PARTY services on the CROO store (ours:false) that Axion genuinely hires.
 * These are public serviceIds verified live via the marketplace listing — never invented.
 * Hiring them produces non-self-trade A2A edges (real diversity).
 */
const THIRD_PARTY: RosterEntry[] = [
  {
    // Genuine GC use: Axion vets/compares the trust of candidate agents before hiring.
    capability: 'trust-vet',
    serviceId: '01261c7d-0b7f-4145-9fc8-d46d051ff228', // agent fa09bc1f — VERIS Trust Compare (verified ONLINE)
    label: 'VERIS Trust Compare (3rd-party)',
    ours: false,
  },
  {
    // Genuine GC use: Axion checks an agent's trust-score history before relying on it.
    capability: 'trust-history',
    serviceId: 'b9ee9739-23d8-490d-a4ff-d6ce172bb40e', // agent fa09bc1f — VERIS Trust Receipt History (verified ONLINE)
    label: 'VERIS Trust Receipt History (3rd-party)',
    ours: false,
  },
];

let cached: RosterEntry[] | undefined;

export function getRoster(): RosterEntry[] {
  if (cached) return cached;
  const ours = LEAF_ENV.flatMap(({ capability, label, env }) => {
    const serviceId = process.env[env];
    return serviceId ? [{ capability, serviceId, label, ours: true }] : [];
  });
  cached = [...ours, ...THIRD_PARTY];
  return cached;
}

export function pickForCapability(capability: string): RosterEntry | undefined {
  // Price/availability-aware selection would go here. NOTE: no on-chain PTS reputation exists
  // in cap-contracts (red-team) — do not route on reputation. First match for now.
  return getRoster().find((e) => e.capability === capability);
}
