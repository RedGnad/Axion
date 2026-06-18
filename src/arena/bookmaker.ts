import { AgentClient, DeliverableType } from '@croo-network/sdk';
import { EventBus } from '../events.js';
import { Orchestrator } from '../orchestrator.js';
import { payouts, volOutcome, type Stake } from './settle.js';
import { USDC_BASE, type Bet, type BetRequest, type PayoutRecord } from './bet.js';

/**
 * CAP-native bookmaker (mechanism #1, fund-transfer). Dual-role:
 *  - PROVIDER of the bet service: accepts bet negotiations (declaring its fund address), records the
 *    staked fundAmount on pay, delivers a receipt.
 *  - REQUESTER at settlement: hires each winning bettor's claim service with fundAmount = winnings,
 *    keeping a house RAKE (the real economic loop).
 *
 * All flows POLL (listNegotiations/listOrders) instead of WS events — CROO WS event delivery is
 * unreliable (orders settle on-chain but events often never arrive). Proven on-chain via bet-slice.
 */
export interface BookmakerConfig {
  client: AgentClient;
  serviceId: string;
  /** Address that receives staked USDC (the bookmaker's fund/AA address). */
  fundAddress: string;
  /** Optional event bus (unused; hireService polls). Kept for back-compat. */
  bus?: EventBus;
  /** House rake in basis points (e.g. 300 = 3%) kept from each pool → sustainability. */
  rakeBps?: number;
}

export class Bookmaker {
  private readonly book = new Map<string, Bet[]>();
  private readonly recorded = new Set<string>(); // bet orderIds already booked
  private readonly orch: Orchestrator;

  constructor(private readonly cfg: BookmakerConfig) {
    this.orch = new Orchestrator(cfg.client, cfg.bus);
  }

  /** Start the provider: a live WS connection marks it "accepting orders" (CROO gates negotiation on
   *  this), while a polling loop does the actual accept/record/deliver (WS events are unreliable). */
  async start(): Promise<void> {
    try { await this.cfg.client.connectWebSocket(); } catch { /* connection = "accepting"; events unused */ }
    const tick = async (): Promise<void> => {
      try {
        const negs = await this.cfg.client.listNegotiations({ role: 'provider', status: 'pending', page: 1, pageSize: 25 });
        for (const n of negs) {
          if (n.serviceId !== this.cfg.serviceId) continue;
          try { await this.cfg.client.acceptNegotiationWithFundAddress(n.negotiationId, this.cfg.fundAddress); console.log(`[bookmaker] accepted bet ${n.negotiationId}`); } catch { /* already accepted / retry */ }
        }
        const orders = await this.cfg.client.listOrders({ role: 'provider', status: 'paid', page: 1, pageSize: 25 });
        for (const o of orders) {
          if (o.serviceId !== this.cfg.serviceId || this.recorded.has(o.orderId)) continue;
          try {
            const neg = await this.cfg.client.getNegotiation(o.negotiationId);
            const req = JSON.parse(neg.requirements ?? '{}') as Partial<BetRequest>;
            if (!req.round_id || (req.side !== 'over' && req.side !== 'under') || !req.claim_service_id) throw new Error('bad bet requirements');
            const bet: Bet = { bettor: o.requesterAgentId, backed: req.side, amount: Number(o.fundAmount ?? '0'), claimServiceId: req.claim_service_id, orderId: o.orderId, payTxHash: o.payTxHash };
            this.record(req.round_id, bet);
            this.recorded.add(o.orderId);
            await this.cfg.client.deliverOrder(o.orderId, { deliverableType: DeliverableType.Text, deliverableText: JSON.stringify({ receipt: 'bet-accepted', round: req.round_id, side: req.side, amount: bet.amount }) });
            console.log(`[bookmaker] booked ${bet.amount} on '${bet.backed}' (round ${req.round_id})`);
          } catch (err) { console.error('[bookmaker] book/deliver failed:', (err as Error).message); }
        }
      } catch { /* transient */ }
    };
    setInterval(() => void tick(), 4000);
    console.log(`[bookmaker] live (polling) on service ${this.cfg.serviceId}, fund ${this.cfg.fundAddress}`);
  }

  private record(roundId: string, bet: Bet): void {
    const list = this.book.get(roundId) ?? [];
    list.push(bet);
    this.book.set(roundId, list);
  }

  betsFor(roundId: string): Bet[] {
    return this.book.get(roundId) ?? [];
  }

  /**
   * Settle on the VOL OUTCOME (realized amplitude vs the agents' consensus `line`). Pari-mutuel: the
   * house keeps `rakeBps`, winners split the rest, paid as CAP fund-transfer orders. Push → refund.
   */
  async settleRound(
    roundId: string,
    line: number,
    actualAmplitude: number,
  ): Promise<{ side: string; paid: PayoutRecord[]; pool: number; rake: number; dust: number }> {
    const bets = this.betsFor(roundId);
    const side = volOutcome(actualAmplitude, line);
    const pool = bets.reduce((s, b) => s + b.amount, 0);
    const claimByBettor = new Map(bets.map((b) => [b.bettor, b.claimServiceId]));
    const paid: PayoutRecord[] = [];

    if (side === 'push') {
      for (const b of bets) {
        const rec = await this.payWinner(b.claimServiceId, b.amount, roundId);
        paid.push({ bettor: b.bettor, amount: b.amount, orderId: rec.orderId, payTxHash: rec.payTxHash });
      }
      return { side, paid, pool, rake: 0, dust: 0 };
    }

    const rakeBps = this.cfg.rakeBps ?? 0;
    const stakes: Stake[] = bets.map((b) => ({ bettor: b.bettor, backed: b.backed, amount: b.amount }));
    const { payouts: due, rake, dust } = payouts(stakes, side, rakeBps);
    for (const [bettor, amount] of Object.entries(due)) {
      const claimServiceId = claimByBettor.get(bettor);
      if (!claimServiceId || amount <= 0) continue;
      const rec = await this.payWinner(claimServiceId, amount, roundId);
      paid.push({ bettor, amount, orderId: rec.orderId, payTxHash: rec.payTxHash });
      console.log(`[bookmaker] paid ${amount} to ${bettor} (order ${rec.orderId})`);
    }
    // rake + dust stay in the bookmaker's wallet (received all stakes, paid out only the shares).
    console.log(`[bookmaker] round ${roundId} → '${side}' | pool ${pool} | rake ${rake} (${(rakeBps / 100).toFixed(1)}%) kept by house`);
    return { side, paid, pool, rake, dust };
  }

  /** Pay one winner via a CAP fund-transfer hire (polling under the hood). */
  private async payWinner(claimServiceId: string, amount: number, roundId: string): Promise<{ orderId: string; payTxHash: string }> {
    const hire = await this.orch.hireService(
      { capability: 'claim', serviceId: claimServiceId, label: 'claim', ours: false },
      JSON.stringify({ payout: true, round_id: roundId }),
      { fundAmount: String(amount), fundToken: USDC_BASE },
    );
    return { orderId: hire.orderId, payTxHash: hire.payTxHash };
  }
}
