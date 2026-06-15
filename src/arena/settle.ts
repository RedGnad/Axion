import { createHash } from 'node:crypto';
import type { Forecast, RoundOutcome } from './types.js';

/**
 * Round settlement — purely objective, riggable by no one.
 *
 * The winner is whoever's committed forecast is closest to the Chainlink ETH/USD reading at
 * settle time. The settlement price is read from the on-chain feed (see leafs/price.ts) by the
 * caller; this module only does the comparison + the integrity hash. No USDC here.
 */

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
 * Pari-mutuel payout split: winners (bettors who backed the winning competitor) share the whole
 * pool pro-rata to their stake. Returns smallest-unit USDC amounts per bettor (floored), and the
 * dust left over from flooring (kept by the bookmaker, disclosed). Pure math — the actual payout
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
): { payouts: Record<string, number>; pool: number; dust: number } {
  const pool = stakes.reduce((s, b) => s + b.amount, 0);
  const winners = stakes.filter((b) => b.backed === winner);
  const winningStake = winners.reduce((s, b) => s + b.amount, 0);

  const result: Record<string, number> = {};
  if (winningStake === 0) {
    // No one backed the winner → nobody to pay; whole pool is undistributed.
    return { payouts: result, pool, dust: pool };
  }
  let paid = 0;
  for (const b of winners) {
    const share = Math.floor((b.amount * pool) / winningStake);
    result[b.bettor] = (result[b.bettor] ?? 0) + share;
    paid += share;
  }
  return { payouts: result, pool, dust: pool - paid };
}
