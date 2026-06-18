import { AgentClient } from '@croo-network/sdk';
import { EventBus } from './events.js';
import { pickForCapability, getRoster, type RosterEntry } from './roster.js';

/** A subtask the (deterministic) planner produced from the incoming goal. */
export interface Subtask {
  capability: string;
  requirements: string; // JSON string passed to negotiateOrder({ requirements })
}

/** Result of hiring one sub-agent (one real on-chain A2A edge). */
export interface HireResult {
  subtask: Subtask;
  service: RosterEntry;
  orderId: string;
  payTxHash: string;
  clearTxHash: string;
  deliverable: string;
}

const CREATE_TIMEOUT_MS = 60_000; // provider must accept → backend creates order on-chain
const COMPLETE_TIMEOUT_MS = 180_000; // pay → provider delivers → CLEAR

/**
 * Axion core loop: plan -> route -> hire (DAG) -> compose.
 * Every hire is one real on-chain CAP order (one A2A edge). See CLAUDE.md for the rubric mapping.
 * The planner is DETERMINISTIC (no LLM) — only the `summarize` leaf spends LLM tokens.
 */
export class Orchestrator {
  // `bus` is optional/unused now that hire() polls (CROO WS events are unreliable). Kept so existing
  // callers that pass an EventBus still compile.
  constructor(
    private readonly client: AgentClient,
    private readonly _bus?: EventBus,
  ) {}

  /** Hire one sub-agent end-to-end: negotiate -> OrderCreated -> pay -> OrderCompleted -> delivery. */
  async hire(subtask: Subtask): Promise<HireResult> {
    const service = pickForCapability(subtask.capability);
    if (!service) throw new Error(`no roster service for capability: ${subtask.capability}`);
    return this.hireService(service, subtask.requirements);
  }

  /** Hire an EXPLICIT service (used by the Arena, the bookmaker, and bettors). `fund` carries an
   *  arbitrary USDC fund-transfer amount for fund-transfer services (bets/payouts). */
  async hireService(
    service: RosterEntry,
    requirements: string,
    fund?: { fundAmount: string; fundToken: string },
  ): Promise<HireResult> {
    const subtask: Subtask = { capability: service.capability, requirements };
    const neg = await this.client.negotiateOrder({
      serviceId: service.serviceId,
      requirements: subtask.requirements,
      ...(fund ? { fundAmount: fund.fundAmount, fundToken: fund.fundToken } : {}),
    });
    const negotiationId = neg.negotiationId;
    console.log(`[axion] negotiated ${subtask.capability} -> ${service.label} (neg ${negotiationId})`);

    // POLL for the order instead of relying on the OrderCreated WS event (CROO WS event delivery is
    // unreliable — the order is created on-chain but the event often never arrives). Robust path.
    const orderId = await this.waitForOrder(negotiationId, CREATE_TIMEOUT_MS, subtask.capability);

    // Escrow LOCK. Throws InsufficientBalanceError if the AA wallet lacks order.price USDC.
    const pay = await this.client.payOrder(orderId);
    console.log(`[axion] paid order ${orderId} (tx ${pay.txHash})`);

    await this.waitForCompletion(orderId, COMPLETE_TIMEOUT_MS, subtask.capability);

    const [delivery, order] = await Promise.all([
      this.client.getDelivery(orderId),
      this.client.getOrder(orderId),
    ]);

    return {
      subtask,
      service,
      orderId,
      payTxHash: order.payTxHash,
      clearTxHash: order.clearTxHash,
      // Many agents deliver structured data in deliverableSchema (type=schema), not text.
      deliverable: delivery.deliverableText || delivery.deliverableSchema || '',
    };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** Poll for the order created from a negotiation (WS OrderCreated events are unreliable). */
  private async waitForOrder(negotiationId: string, timeoutMs: number, label: string): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const orders = await this.client.listOrders({ role: 'buyer', page: 1, pageSize: 25 });
        const o = orders.find((x) => x.negotiationId === negotiationId);
        if (o) {
          if (o.status === 'create_failed') throw new Error(`order create_failed (${label})`);
          if (o.orderId && o.status !== 'creating') return o.orderId;
        }
      } catch (err) {
        if ((err as Error).message.includes('create_failed')) throw err; // terminal; otherwise retry
      }
      await this.sleep(2500);
    }
    throw new Error(`timed out waiting for order creation (${label}) after ${timeoutMs}ms`);
  }

  /** Poll an order until it CLEARs (WS OrderCompleted events are unreliable). */
  private async waitForCompletion(orderId: string, timeoutMs: number, label: string): Promise<void> {
    const terminal = ['rejected', 'expired', 'create_failed', 'pay_failed', 'deliver_failed'];
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const o = await this.client.getOrder(orderId);
      if (o.status === 'completed') return;
      if (terminal.includes(o.status)) throw new Error(`order ${orderId} ended '${o.status}' (${label})`);
      await this.sleep(2500);
    }
    throw new Error(`timed out waiting for completion (${label}) after ${timeoutMs}ms`);
  }

  /** Run a full goal -> composed deliverable as a 2-stage DAG. */
  async run(goal: string): Promise<{ output: string; hires: HireResult[] }> {
    // Stage 1: parallel data leafs — every roster capability except the summarizer.
    const dataCaps = [...new Set(getRoster().map((r) => r.capability))].filter((c) => c !== 'summarize');
    if (dataCaps.length === 0) throw new Error('roster has no data leafs to hire');
    const stage1 = await Promise.all(
      dataCaps.map((c) => this.hire({ capability: c, requirements: JSON.stringify({ ask: goal }) })),
    );

    // Stage 2 (depth): a summarizer consumes stage-1 outputs — only if that leaf is registered.
    const stage2: HireResult[] = [];
    if (pickForCapability('summarize')) {
      const inputs = stage1.map((h) => `## ${h.service.label}\n${h.deliverable}`).join('\n\n');
      stage2.push(
        await this.hire({ capability: 'summarize', requirements: JSON.stringify({ goal, inputs }) }),
      );
    }

    const hires = [...stage1, ...stage2];
    return { output: this.compose(goal, hires), hires };
  }

  /** Assemble verified sub-deliverables into one markdown result. */
  compose(goal: string, hires: HireResult[]): string {
    const summary = hires.find((h) => h.subtask.capability === 'summarize');
    const body = summary
      ? summary.deliverable
      : hires.map((h) => `## ${h.service.label}\n${h.deliverable}`).join('\n\n');
    return `# Brief: ${goal}\n\n${body}`;
  }
}
