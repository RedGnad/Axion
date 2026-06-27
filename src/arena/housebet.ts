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
// Rake = 5% total: HOUSE keeps 3% (our revenue), 2% is the WINNING-AGENT purse (bettor-funded, never
// our treasury). The 2% is only withheld from bettors when there is actually a payable winner address
// to send it to — otherwise bettors aren't charged for a purse we can't pay.
const HOUSE_RAKE_BPS = BigInt(process.env.BOOKMAKER_RAKE_BPS ?? '300'); // 3% house revenue
const WINNER_RAKE_BPS = BigInt(process.env.WINNER_RAKE_BPS ?? '200');   // 2% to the winning agent(s)
export const MAX_BET_USDC = Number(process.env.HOUSE_MAX_BET_USDC ?? '1'); // symbolic cap per bet

const PAYOUT_RE = /^0x[0-9a-fA-F]{40}$/;
export function isPayoutAddress(a: string): boolean {
  return PAYOUT_RE.test(a);
}

// COMMUNITY agents register a payout address when they join the Garage, so the winning-agent purse can
// be routed to them too. Kept in memory and repopulated at boot from the durable roster (so it survives
// restarts). Our OWN personas are intentionally NOT in here: rewarding our own agents is a wash, so we
// leave ARENA_PAYOUT_<persona> unset and the 2% stays with the bettors when a persona wins.
const externalPayouts = new Map<string, string>();
export function setAgentPayout(agentId: string, address: string): boolean {
  if (!PAYOUT_RE.test(address)) return false;
  externalPayouts.set(agentId, address);
  return true;
}
export function clearAgentPayout(agentId: string): void {
  externalPayouts.delete(agentId);
}

/** Where an agent's winning purse is sent, or '' if none (then the 2% is NOT withheld from bettors).
 *  Resolution: env ARENA_PAYOUT_<ID> first (our personas, normally unset), then the community registry
 *  (external agents that gave an address at join). We never invent a destination. */
export function agentPayoutAddress(agentId: string): string {
  const v = process.env[`ARENA_PAYOUT_${agentId.toUpperCase()}`];
  if (v && PAYOUT_RE.test(v)) return v;
  return externalPayouts.get(agentId) ?? '';
}

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

export interface SettlementPlan {
  /** All transfers to make (bettor winnings + winning-agent purse + refunds), pre-aggregation. */
  payouts: { to: string; amount: bigint; kind: 'bettor' | 'agent' | 'refund' }[];
  houseRake: bigint;   // smallest-unit USDC the house keeps
  agentPurse: bigint;  // smallest-unit USDC routed to winning agent(s) (subset of the 5% rake)
  refunded: boolean;   // true → no winning backers, everyone refunded, no rake/purse
}

/**
 * PURE settlement math (no I/O) so it can be unit-checked on real money paths.
 * Bets on an agent that did NOT race this round (DQ'd or never showed) are REFUNDED — you can't lose
 * for backing an agent the arena failed to run. The rest is pari-mutuel on bettors who backed a
 * WINNING AGENT (ties = co-winners): house keeps 3%; the winning agent(s) get 2% (only when a payout
 * address exists, else that 2% is NOT withheld). No winning backers among racers → refund those too.
 */
export function planSettlement(
  rb: HouseBet[],
  winnerAgentIds: string[],
  racedAgentIds: string[],
  addrOf: (id: string) => string,
  houseRakeBps = HOUSE_RAKE_BPS,
  winnerRakeBps = WINNER_RAKE_BPS,
): SettlementPlan {
  const raced = new Set(racedAgentIds);
  const payouts: { to: string; amount: bigint; kind: 'bettor' | 'agent' | 'refund' }[] = [];
  // Refund every bet on an agent that didn't actually race (fairness: not the bettor's fault).
  const inPlay: HouseBet[] = [];
  for (const b of rb) {
    if (raced.has(b.agentId)) inPlay.push(b);
    else payouts.push({ to: b.eoa, amount: b.amount, kind: 'refund' });
  }

  const winSet = new Set(winnerAgentIds);
  const winners = inPlay.filter((b) => winSet.has(b.agentId));
  // Weighted stake (decay): a winner's share is proportional to amount × placement-weight, so a
  // last-second winner gets a small slice (its forgone share boosts the early bettors).
  const wstake = (b: HouseBet): bigint => (b.amount * BigInt(Math.round(Math.max(0.01, b.weight) * 1000))) / 1000n;
  const winningWeighted = winners.reduce((s, b) => s + wstake(b), 0n);

  if (winningWeighted === 0n) {
    // No winning backers among the agents that raced → refund their stakes too (no rake, no purse).
    for (const b of inPlay) payouts.push({ to: b.eoa, amount: b.amount, kind: 'refund' });
    return { payouts, houseRake: 0n, agentPurse: 0n, refunded: true };
  }

  const pool = inPlay.reduce((s, b) => s + b.amount, 0n);
  const houseRake = (pool * houseRakeBps) / 10000n;
  // The winning agents we can actually pay (have a configured address). De-dupe ids first.
  const payable = [...new Set(winnerAgentIds)].map((id) => ({ id, addr: addrOf(id) })).filter((x) => !!x.addr);
  const purseTotal = payable.length ? (pool * winnerRakeBps) / 10000n : 0n; // only withheld if payable
  const distributable = pool - houseRake - purseTotal;

  for (const b of winners) payouts.push({ to: b.eoa, amount: (wstake(b) * distributable) / winningWeighted, kind: 'bettor' });
  let agentPurse = 0n;
  if (purseTotal > 0n) {
    const each = purseTotal / BigInt(payable.length);
    if (each > 0n) { for (const w of payable) payouts.push({ to: w.addr, amount: each, kind: 'agent' }); agentPurse = each * BigInt(payable.length); }
  }
  return { payouts, houseRake, agentPurse, refunded: false };
}

/**
 * Settle the human USDC bets for a round and send the real payouts from the house EOA (Base). Reuses
 * the proven transfer path (no escrow touched). Best-effort + logged; a failed payout never throws.
 */
export async function settleHouseBets(
  roundId: string,
  winnerAgentIds: string[],
  racedAgentIds: string[],
): Promise<{ paid: number; total: string; agentPurse: string } | null> {
  const rb = bets.filter((b) => b.roundId === roundId);
  bets = bets.filter((b) => b.roundId !== roundId); // clear this round either way
  if (!rb.length || !houseEnabled()) return null;

  const signer = new ethers.Wallet(process.env.HOUSE_EOA_PRIVATE_KEY as string, provider());
  const usdc = new ethers.Contract(USDC, ERC20, signer);

  const plan = planSettlement(rb, winnerAgentIds, racedAgentIds, agentPayoutAddress);

  // Aggregate by address (one tx per recipient) and pay.
  const byAddr = new Map<string, bigint>();
  for (const p of plan.payouts) byAddr.set(p.to, (byAddr.get(p.to) ?? 0n) + p.amount);
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
  return { paid, total: ethers.formatUnits(total, 6), agentPurse: ethers.formatUnits(plan.agentPurse, 6) };
}
