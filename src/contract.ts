/**
 * Axion's public consumable contract — the interface OTHER CAP agents call.
 *
 * Axion registers one CAP service (AXION_SERVICE_ID). A caller hires it with the verified SDK
 * path `negotiateOrder({ serviceId: AXION_SERVICE_ID, requirements })`, where `requirements` is
 * `JSON.stringify(AxionRequest)`. Axion returns `JSON.stringify(AxionResult)` as its
 * deliverable. Keep this stable and tiny — it is the adoption lever (5 lines to integrate).
 */

export interface AxionRequest {
  /** Natural-language composite task to fan out across sub-agents. */
  goal: string;
  /** Max USDC (token smallest unit) Axion may spend across all sub-hires. */
  budgetUSDC: string;
  /** Shape of the composed deliverable returned to the caller.
   *  Note: the CAP SDK's DeliverableType is `text | schema` (no `file`). `file` delivery is a
   *  deferred upside via uploadFile/getDownloadURL (object key), not wired in the floor slice. */
  deliverable: 'text' | 'schema';
  constraints?: {
    /** Upper bound on distinct sub-agents hired (graph breadth). */
    maxSubAgents?: number;
    /** Wall-clock budget for the whole composition. */
    deadlineSeconds?: number;
  };
}

/** One sub-order Axion placed — a single on-chain A2A edge, verifiable on Base. */
export interface SubOrderRef {
  capability: string;
  serviceId: string;
  orderId: string;
  payTxHash: string;
  /** Honesty flag: true if this sub-agent is one of ours (seeded), false if third-party.
   *  Never present a self-seeded graph as organic third-party diversity. */
  ours: boolean;
}

export interface AxionResult {
  /** The composed output (text, or an object key when deliverable === 'file'). */
  output: string;
  /** Proof manifest: every sub-hire so the caller + judges can verify the graph on-chain. */
  manifest: SubOrderRef[];
}
