import { createHash } from 'node:crypto';
import type { Forecast, RoundOutcome } from './types.js';

/**
 * Round settlement — purely objective, riggable by no one.
 *
 * The winner is whoever's committed forecast is closest to the realized Pyth ETH/USD move at
 * settle time. The settlement price is read from the signed feed (see oracle.ts) by the caller;
 * this module only does the comparison + the integrity hash. No USDC here.
 */

/** The betting line = the agents' consensus (median) amplitude estimate. Bettors bet over/under it. */
export function consensusLine(forecasts: Forecast[]): number {
  if (forecasts.length === 0) throw new Error('no forecasts to form a line');
  const xs = forecasts.map((f) => f.prediction).sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

export type VolSide = 'over' | 'under' | 'push';

/** Resolve the vol bet: realized amplitude vs the line. Exact tie (rare) = push → refund. */
export function volOutcome(actualAmplitude: number, line: number): VolSide {
  if (actualAmplitude > line) return 'over';
  if (actualAmplitude < line) return 'under';
  return 'push';
}

/** Commit-time integrity anchor: proves a forecast predates the outcome. */
export function reasonHash(parts: {
  competitor: string;
  prediction: number;
  rationale: string;
  inputs: string;
}): string {
  return (
    '0x' +
    createHash('sha256')
      .update(JSON.stringify(parts))
      .digest('hex')
  );
}

/** Co-winners = argmin |estimate - actual| (ties share the win; never break a tie arbitrarily). */
export function settle(forecasts: Forecast[], actual: number, settledAt = new Date()): RoundOutcome {
  if (forecasts.length === 0) throw new Error('cannot settle a round with no forecasts');

  const errors: Record<string, number> = {};
  let best = Infinity;
  for (const f of forecasts) {
    const err = Math.abs(f.prediction - actual);
    errors[f.competitor] = err;
    if (err < best) best = err;
  }
  const EPS = 1e-9;
  const winners = forecasts.filter((f) => errors[f.competitor] - best <= EPS).map((f) => f.competitor);

  return { actual, settledAt: settledAt.toISOString(), winners, errors };
}

/**
 * Pari-mutuel payout split with a bookmaker RAKE (the real economic loop): the house keeps
 * `rakeBps` (basis points) of the pool; winners share the rest pro-rata to their stake. The rake +
 * flooring dust stay in the bookmaker's wallet = its revenue. Pure math — the actual on-chain payout
 * is a CAP order bookmaker->bettor in bookmaker.ts.
 */
export interface Stake {
  bettor: string; // bettor agent id
  backed: string; // competitor id they bet on
  amount: number; // smallest-unit USDC staked
}

export function payouts(
  stakes: Stake[],
  winner: string,
  rakeBps = 0,
): { payouts: Record<string, number>; pool: number; rake: number; dust: number } {
  const pool = stakes.reduce((s, b) => s + b.amount, 0);
  const winners = stakes.filter((b) => b.backed === winner);
  const winningStake = winners.reduce((s, b) => s + b.amount, 0);

  const result: Record<string, number> = {};
  if (winningStake === 0) {
    // No one backed the winner → nobody to pay; no rake taken; whole pool undistributed.
    return { payouts: result, pool, rake: 0, dust: pool };
  }
  const rake = Math.floor((pool * rakeBps) / 10_000); // house cut → sustainability
  const distributable = pool - rake;
  let paid = 0;
  for (const b of winners) {
    const share = Math.floor((b.amount * distributable) / winningStake);
    result[b.bettor] = (result[b.bettor] ?? 0) + share;
    paid += share;
  }
  return { payouts: result, pool, rake, dust: distributable - paid };
}
