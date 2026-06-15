/**
 * CAP-native betting contract for the Arena (mechanism #1: fund-transfer orders).
 *
 * A bet is a CAP order from a bettor (requester) to the bookmaker (provider) on a
 * require_fund_transfer=true service: the stake is the arbitrary `fundAmount` USDC the pay tx
 * transfers to the bookmaker's fund address (the order's base price is just the minimal CAP fee).
 * Payout reverses the direction: the bookmaker hires the bettor's claim service with
 * fundAmount = winnings. Both legs are real on-chain orders, fully auditable.
 *
 * INTEGRITY: outcome is exogenous Chainlink (settle.ts) committed via reasonHash before bets close;
 * the bookmaker is our open-source agent — "trusted but transparent", disclosed. Stakes symbolic.
 */

/** USDC on Base (6 decimals) — the fund token for stakes and payouts. */
export const USDC_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/**
 * The `requirements` JSON a bettor sends when hiring the bookmaker service.
 *
 * Bets are on the VOL OUTCOME (will realized amplitude be over/under the agents' consensus line),
 * NOT on which agent wins. This is the calibrated design: the vol outcome is genuinely uncertain so
 * there is no soft-exploit (backing the always-conservative agent), and the agents' forecasts become
 * the published line / expert opinion that informs bettors instead of being the bet itself.
 */
export interface BetRequest {
  /** Which round this bet is for. */
  round_id: string;
  /** Side backed: 'over' or 'under' the round's consensus amplitude line. */
  side: 'over' | 'under';
  /**
   * The bettor's own require_fund_transfer service id — the bookmaker hires it to pay winnings.
   * Demo bettors are custodial agents operated by the UI (disclosed); external wallets = v2.
   */
  claim_service_id: string;
}

/** A recorded, paid stake (one on-chain bet order to the bookmaker). */
export interface Bet {
  bettor: string; // requester agent id
  backed: string; // side backed ('over' | 'under')
  amount: number; // smallest-unit USDC staked (the fundAmount)
  claimServiceId: string;
  orderId: string;
  payTxHash: string;
}

/** A recorded payout (one on-chain order from the bookmaker to a winning bettor). */
export interface PayoutRecord {
  bettor: string;
  amount: number; // smallest-unit USDC paid
  orderId: string;
  payTxHash: string;
}
