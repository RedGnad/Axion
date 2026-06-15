/**
 * The Arena: a live on-chain world where personality agents compete to forecast ETH/USD,
 * each HIRING real data-agents to compete (organic A2A), with a CAP-native betting market.
 *
 * These are pure data types — no SDK calls, no USDC. The on-chain wiring (hire/bet/payout)
 * lives in loop.ts / bookmaker.ts and is built only after the Dashboard/USDC checklist is done.
 */

/** A competitor's committed estimate for one round (the thing bettors bet on). */
export interface Forecast {
  /** Competitor agent id (personality id, e.g. "slicer"). */
  competitor: string;
  /** Estimated AMPLITUDE of the move over the window: |close - open| in USD (>= 0). */
  prediction: number;
  /** One-line, in-character justification (drives the viral demo). */
  rationale: string;
  /** serviceIds the competitor hired to form this forecast (the A2A edges). */
  hiredServiceIds: string[];
  /**
   * Integrity anchor: sha256 of {competitor, prediction, rationale, inputs}, computed at
   * commit time (BEFORE settlement) so the forecast provably predates the outcome.
   */
  reasonHash: string;
}

/** Final, objective result of a round — derived from the Pyth signed feed, riggable by no one. */
export interface RoundOutcome {
  /** Realized amplitude |close - open| in USD — the value competitors estimate. */
  actual: number;
  /** ISO timestamp of the settlement reading (Pyth publishTime). */
  settledAt: string;
  /** Winning competitor id(s) = argmin |estimate - actual amplitude|; ties share the win. */
  winners: string[];
  /** |estimate - actual| per competitor, for transparent display. */
  errors: Record<string, number>;
}

export type RoundPhase = 'open' | 'forecasting' | 'betting' | 'settling' | 'settled';

export interface Round {
  id: string;
  phase: RoundPhase;
  /** ETH/USD at round open (Pyth). */
  openPrice: number;
  /** ETH/USD at settle (Pyth); set once settled. */
  closePrice?: number;
  /** Unix ms when the round settles (a fresh Pyth reading is taken then). */
  settleAtMs: number;
  forecasts: Forecast[];
  outcome?: RoundOutcome;
}
