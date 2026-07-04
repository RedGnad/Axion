import { ethers } from 'ethers';

/**
 * Signed accuracy scorecard: the inviolable, publicly verifiable track-record primitive.
 *
 * What is truly hard to fake here (the innovation moat, per the brief): a forecast is PRE-COMMITTED
 * (reasonHash, before the outcome exists), graded against an exogenous oracle (Pyth), and the graded
 * result is SIGNED by the arena's published key. Anyone can recompute the EIP-712 digest and recover
 * the signer, so the arena cannot silently rewrite an agent's history. The economic settlement (the
 * USDC CAP orders) is on-chain; the scorecard is pre-committed + signed + verifiable off-chain by
 * anyone (and by a contract later, since it is EIP-712). We do NOT claim the score is "written to a
 * contract" unless it actually is.
 *
 * We sign only OBJECTIVE FACTS (prediction, realized move, absolute error, rank, field size, the
 * pre-commit hash, settlement time). Any "correctness %" shown in the UI is DERIVED from these signed
 * facts (e.g. rank / field), so it needs no separate trust.
 */
export interface Scorecard {
  agent: string; // agent id or label graded this round
  roundId: string; // the arena round it was graded in
  reasonHash: string; // sha256 pre-commit of the forecast, set before settle (see settle.ts)
  prediction: number; // the agent's forecast: |close - open| over the window, in USD
  actual: number; // the realized Pyth move over the window, in USD
  errorUsd: number; // |prediction - actual|, in USD
  rank: number; // 1-based rank among graded agents this round (1 = closest)
  field: number; // number of graded agents this round
  settledAtSec: number; // unix seconds at settlement
}

export interface SignedScorecard extends Scorecard {
  signer: string; // the EOA address that signed (publish this so anyone can verify)
  signature: string; // EIP-712 signature over the scorecard
}

// Base mainnet. version bumps if the signed schema ever changes (old signatures stay verifiable).
const DOMAIN = { name: 'Axion Clash', version: '1', chainId: 8453 } as const;
const TYPES = {
  Scorecard: [
    { name: 'agent', type: 'string' },
    { name: 'roundId', type: 'string' },
    { name: 'reasonHash', type: 'string' },
    { name: 'predictionMicro', type: 'uint256' },
    { name: 'actualMicro', type: 'uint256' },
    { name: 'errorMicro', type: 'uint256' },
    { name: 'rank', type: 'uint256' },
    { name: 'field', type: 'uint256' },
    { name: 'settledAtSec', type: 'uint256' },
  ],
} as const;

const micro = (usd: number): bigint => BigInt(Math.round(Math.max(0, usd) * 1_000_000));

/** The exact EIP-712 value that gets signed/verified (USD amounts scaled to integer micro-USD). */
function toTypedValue(c: Scorecard): Record<string, string | bigint> {
  return {
    agent: c.agent,
    roundId: c.roundId,
    reasonHash: c.reasonHash,
    predictionMicro: micro(c.prediction),
    actualMicro: micro(c.actual),
    errorMicro: micro(c.errorUsd),
    rank: BigInt(Math.max(0, Math.trunc(c.rank))),
    field: BigInt(Math.max(0, Math.trunc(c.field))),
    settledAtSec: BigInt(Math.max(0, Math.trunc(c.settledAtSec))),
  };
}

/** Sign a graded scorecard with the arena's EOA (HOUSE_EOA_PRIVATE_KEY). */
export async function signScorecard(card: Scorecard, privateKey: string): Promise<SignedScorecard> {
  const wallet = new ethers.Wallet(privateKey);
  const signature = await wallet.signTypedData(DOMAIN, TYPES as unknown as Record<string, ethers.TypedDataField[]>, toTypedValue(card));
  return { ...card, signer: wallet.address, signature };
}

/** Recover the signer and check it matches the claimed `signer`. Pure, no network. */
export function verifyScorecard(signed: SignedScorecard): { valid: boolean; recovered: string } {
  let recovered = '';
  try {
    recovered = ethers.verifyTypedData(
      DOMAIN,
      TYPES as unknown as Record<string, ethers.TypedDataField[]>,
      toTypedValue(signed),
      signed.signature,
    );
  } catch {
    return { valid: false, recovered: '' };
  }
  return { valid: recovered.toLowerCase() === signed.signer.toLowerCase(), recovered };
}
