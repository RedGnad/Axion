import { AgentClient, EventType, DeliverableType, type Event } from '@croo-network/sdk';
import { EventBus } from '../events.js';
import { payouts, volOutcome, type Stake } from './settle.js';
import { USDC_BASE, type Bet, type BetRequest, type PayoutRecord } from './bet.js';

/**
 * CAP-native bookmaker (mechanism #1, fund-transfer). Dual-role on one WebSocket:
 *  - PROVIDER of the bet service: accepts bet negotiations (declaring its fund address), records
 *    the staked fundAmount on pay, delivers a receipt.
 *  - REQUESTER at settlement: hires each winning bettor's claim service with fundAmount = winnings.
 *
 * ⚠️ NOT YET PROVEN ON-CHAIN. This is the fail-fast scaffold for milestone 2. The exact
 * fund-transfer pay batch (and whether payOrder routes via x402) must be validated with real USDC
 * before any README claim. #2 (direct AA transfer) / #3 (EOA) remain fallbacks to test if #1 fails.
 */

const CREATE_TIMEOUT_MS = 60_000;
const COMPLETE_TIMEOUT_MS = 180_000;

export interface BookmakerConfig {
  /** Bookmaker agent SDK client (its own funded AA wallet). */
  client: AgentClient;
  /** The bookmaker's bet service id (require_fund_transfer=true). */
  serviceId: string;
  /** Address that receives staked USDC (the bookmaker's fund/AA address). */
  fundAddress: string;
  /** Shared buyer event bus on the bookmaker's WS (for the payout leg). */
  bus: EventBus;
}

export class Bookmaker {
  /** roundId -> recorded paid bets. */
  private readonly book = new Map<string, Bet[]>();

  constructor(private readonly cfg: BookmakerConfig) {}

  /** Attach provider handlers to the bookmaker's WS: accept bets + record stakes. */
  async start(): Promise<void> {
    const ws = await this.cfg.client.connectWebSocket();

    ws.on(EventType.NegotiationCreated, (e: Event) => {
      void (async () => {
        if (e.service_id !== this.cfg.serviceId || !e.negotiation_id) return; // only bets on us
        try {
          await this.cfg.client.acceptNegotiationWithFundAddress(e.negotiation_id, this.cfg.fundAddress);
          console.log(`[bookmaker] accepted bet negotiation ${e.negotiation_id}`);
        } catch (err) {
          console.error('[bookmaker] accept failed:', (err as Error).message);
        }
      })();
    });

    ws.on(EventType.OrderPaid, (e: Event) => {
      void (async () => {
        if (!e.order_id) return;
        const order = await this.cfg.client.getOrder(e.order_id);
        if (order.serviceId !== this.cfg.serviceId) return; // ignore our own payout orders
        try {
          const neg = await this.cfg.client.getNegotiation(order.negotiationId);
          const req = JSON.parse(neg.requirements ?? '{}') as Partial<BetRequest>;
          if (!req.round_id || (req.side !== 'over' && req.side !== 'under') || !req.claim_service_id) {
            throw new Error("bet requirements missing round_id / side('over'|'under') / claim_service_id");
          }
          const bet: Bet = {
            bettor: order.requesterAgentId,
            backed: req.side,
            amount: Number(order.fundAmount ?? '0'),
            claimServiceId: req.claim_service_id,
            orderId: order.orderId,
            payTxHash: order.payTxHash,
          };
          this.record(req.round_id, bet);
          await this.cfg.client.deliverOrder(e.order_id, {
            deliverableType: DeliverableType.Text,
            deliverableText: JSON.stringify({ receipt: 'bet-accepted', round: req.round_id, side: req.side, amount: bet.amount }),
          });
          console.log(`[bookmaker] booked ${bet.amount} on '${bet.backed}' (round ${req.round_id}) from ${bet.bettor}`);
        } catch (err) {
          console.error('[bookmaker] record/deliver bet failed:', (err as Error).message);
        }
      })();
    });

    console.log(`[bookmaker] live on service ${this.cfg.serviceId}, fund address ${this.cfg.fundAddress}`);
  }

  private record(roundId: string, bet: Bet): void {
    const list = this.book.get(roundId) ?? [];
    list.push(bet);
    this.book.set(roundId, list);
  }

  /** Bets recorded for a round (empty if none). */
  betsFor(roundId: string): Bet[] {
    return this.book.get(roundId) ?? [];
  }

  /**
   * Settle a round on the VOL OUTCOME: realized amplitude vs the agents' consensus `line`.
   * Pari-mutuel split of the pool to bettors on the winning side, paid as CAP fund-transfer orders.
   * On a 'push' (amplitude exactly == line, rare) every bettor is refunded their own stake.
   * Returns executed payouts + leftover dust (kept by the bookmaker, disclosed).
   */
  async settleRound(
    roundId: string,
    line: number,
    actualAmplitude: number,
  ): Promise<{ side: string; paid: PayoutRecord[]; pool: number; dust: number }> {
    const bets = this.betsFor(roundId);
    const side = volOutcome(actualAmplitude, line);
    const pool = bets.reduce((s, b) => s + b.amount, 0);
    const claimByBettor = new Map(bets.map((b) => [b.bettor, b.claimServiceId]));
    const paid: PayoutRecord[] = [];

    // Push → refund every bettor their own stake.
    if (side === 'push') {
      for (const b of bets) {
        const rec = await this.payWinner(b.claimServiceId, b.amount, roundId);
        paid.push({ bettor: b.bettor, amount: b.amount, orderId: rec.orderId, payTxHash: rec.payTxHash });
      }
      return { side, paid, pool, dust: 0 };
    }

    const stakes: Stake[] = bets.map((b) => ({ bettor: b.bettor, backed: b.backed, amount: b.amount }));
    const { payouts: due, dust } = payouts(stakes, side);
    for (const [bettor, amount] of Object.entries(due)) {
      const claimServiceId = claimByBettor.get(bettor);
      if (!claimServiceId || amount <= 0) continue;
      const rec = await this.payWinner(claimServiceId, amount, roundId);
      paid.push({ bettor, amount, orderId: rec.orderId, payTxHash: rec.payTxHash });
      console.log(`[bookmaker] paid ${amount} to ${bettor} (order ${rec.orderId})`);
    }
    console.log(`[bookmaker] round ${roundId} settled: amplitude ${actualAmplitude.toFixed(2)} vs line ${line.toFixed(2)} → '${side}'`);
    return { side, paid, pool, dust };
  }

  /** Pay one winner via a CAP fund-transfer order (bookmaker = requester). */
  private async payWinner(claimServiceId: string, amount: number, roundId: string): Promise<{ orderId: string; payTxHash: string }> {
    const neg = await this.cfg.client.negotiateOrder({
      serviceId: claimServiceId,
      requirements: JSON.stringify({ payout: true, round_id: roundId }),
      fundAmount: String(amount),
      fundToken: USDC_BASE,
    });
    const created = await this.cfg.bus.wait(
      (ev) => ev.type === EventType.OrderCreated && ev.negotiation_id === neg.negotiationId,
      CREATE_TIMEOUT_MS,
      'OrderCreated(payout)',
    );
    if (!created.order_id) throw new Error('payout OrderCreated had no order_id');
    const pay = await this.cfg.client.payOrder(created.order_id);
    await this.cfg.bus.wait(
      (ev) => ev.type === EventType.OrderCompleted && ev.order_id === created.order_id,
      COMPLETE_TIMEOUT_MS,
      'OrderCompleted(payout)',
    );
    return { orderId: created.order_id, payTxHash: pay.txHash };
  }
}
