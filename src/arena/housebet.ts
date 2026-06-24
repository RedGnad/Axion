import { ethers } from 'ethers';

/**
 * Custodial-but-disclosed USDC betting for HUMAN EOAs (not CAP agents).
 *
 * A human can't enter the CAP escrow (that's agent↔agent), so real-USDC human bets ride a plain
 * "house" EOA: the bettor sends USDC to HOUSE_EOA_ADDRESS (one wallet tx), the server VERIFIES that
 * transfer on-chain before counting it, and on settle the house EOA pays winners back (pari-mutuel,
 * minus the same house rake). Funds sit with the house between bet and settle → CUSTODIAL; this is
 * DISCLOSED in the UI and meant for SMALL, symbolic stakes only.
 *
 * OFF unless HOUSE_EOA_PRIVATE_KEY + HOUSE_EOA_ADDRESS (+ BASE_RPC_URL) are set. The CAP agent↔agent
 * bookmaker (bet-slice) is untouched; this is a separate, additive path.
 */
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // Base mainnet USDC (6 decimals)
const ERC20 = [
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];
const RAKE_BPS = BigInt(process.env.BOOKMAKER_RAKE_BPS ?? '300'); // 3% house rake (same as CAP bookmaker)
export const MAX_BET_USDC = Number(process.env.HOUSE_MAX_BET_USDC ?? '1'); // symbolic cap per bet

export interface HouseBet {
  roundId: string;
  agentId: string; // the RACER this bet backs (parimutuel on the agents, not over/under)
  amount: bigint; // smallest-unit USDC (6 dec)
  eoa: string;
  txHash: string;
  /** Odds-decay weight at placement (1 early → BET_DECAY_FLOOR late). Late winners get a smaller share
   *  of the pool → last-second betting isn't profitable, so betting can stay OPEN during the race. */
  weight: number;
}

let bets: HouseBet[] = [];

export function houseEnabled(): boolean {
  return !!process.env.HOUSE_EOA_PRIVATE_KEY && !!process.env.HOUSE_EOA_ADDRESS && !!process.env.BASE_RPC_URL;
}
export function houseAddress(): string {
  return process.env.HOUSE_EOA_ADDRESS ?? '';
}

function provider(): ethers.JsonRpcProvider {
  return new ethers.JsonRpcProvider(process.env.BASE_RPC_URL);
}

/** Verify on-chain that `txHash` is a successful USDC transfer of ≥amount from `eoa` to the house. */
export async function verifyBetTx(txHash: string, eoa: string, amount: bigint): Promise<boolean> {
  const receipt = await provider().getTransactionReceipt(txHash);
  if (!receipt || receipt.status !== 1) return false;
  const iface = new ethers.Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const house = houseAddress().toLowerCase();
  for (const log of receipt.logs) {
    if (log.address.toLowerCase() !== USDC.toLowerCase()) continue;
    try {
      const p = iface.parseLog({ topics: [...log.topics], data: log.data });
      if (
        p &&
        p.args.to.toLowerCase() === house &&
        p.args.from.toLowerCase() === eoa.toLowerCase() &&
        (p.args.value as bigint) >= amount
      ) return true;
    } catch { /* not a Transfer log */ }
  }
  return false;
}

export function recordBet(b: HouseBet): void {
  bets.push(b);
}

/** Current pool (smallest-unit USDC) per AGENT for a round, plus the unique-bettor count. */
export function poolFor(roundId: string): { byAgent: Record<string, bigint>; bettors: number } {
  const byAgent: Record<string, bigint> = {};
  let n = 0;
  for (const b of bets) {
    if (b.roundId !== roundId) continue;
    n++;
    byAgent[b.agentId] = (byAgent[b.agentId] ?? 0n) + b.amount;
  }
  return { byAgent, bettors: n };
}

/**
 * Settle the human USDC bets for a round: pari-mutuel on the bettors who backed a WINNING AGENT
 * (ties = co-winners, so a bet on any winning agent pays), minus rake; no winning backers → refund
 * every stake. The house EOA sends the payouts (real USDC tx on Base). Best-effort + logged; a
 * failed payout never throws into the round loop.
 */
export async function settleHouseBets(
  roundId: string,
  winnerAgentIds: string[],
): Promise<{ paid: number; total: string } | null> {
  const rb = bets.filter((b) => b.roundId === roundId);
  bets = bets.filter((b) => b.roundId !== roundId); // clear this round either way
  if (!rb.length || !houseEnabled()) return null;

  const signer = new ethers.Wallet(process.env.HOUSE_EOA_PRIVATE_KEY as string, provider());
  const usdc = new ethers.Contract(USDC, ERC20, signer);

  const winSet = new Set(winnerAgentIds);
  const winners = rb.filter((b) => winSet.has(b.agentId));
  // Weighted stake (decay): a winner's share is proportional to amount × placement-weight, so a
  // last-second winner gets a small slice (its forgone share boosts the early bettors).
  const wstake = (b: HouseBet): bigint => (b.amount * BigInt(Math.round(Math.max(0.01, b.weight) * 1000))) / 1000n;
  const winningWeighted = winners.reduce((s, b) => s + wstake(b), 0n);

  // Build a payout list. No one backed a winning agent → refund all stakes (no rake taken).
  const payouts: { to: string; amount: bigint }[] = [];
  if (winningWeighted === 0n) {
    for (const b of rb) payouts.push({ to: b.eoa, amount: b.amount });
  } else {
    const pool = rb.reduce((s, b) => s + b.amount, 0n);
    const rake = (pool * RAKE_BPS) / 10000n;
    const distributable = pool - rake;
    for (const b of winners) payouts.push({ to: b.eoa, amount: (wstake(b) * distributable) / winningWeighted });
  }

  // Aggregate by address (one tx per winner) and pay.
  const byAddr = new Map<string, bigint>();
  for (const p of payouts) byAddr.set(p.to, (byAddr.get(p.to) ?? 0n) + p.amount);
  let paid = 0, total = 0n;
  for (const [to, amount] of byAddr) {
    if (amount <= 0n) continue;
    try {
      const tx = await usdc.transfer(to, amount);
      await tx.wait();
      paid++; total += amount;
      console.log(`[housebet] paid ${ethers.formatUnits(amount, 6)} USDC → ${to} (${tx.hash})`);
    } catch (err) {
      console.error(`[housebet] payout FAILED → ${to}:`, (err as Error).message);
    }
  }
  return { paid, total: ethers.formatUnits(total, 6) };
}
