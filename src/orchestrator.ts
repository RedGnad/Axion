import { AgentClient, EventType } from '@croo-network/sdk';
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
  constructor(
    private readonly client: AgentClient,
    private readonly bus: EventBus,
  ) {}

  /** Hire one sub-agent end-to-end: negotiate -> OrderCreated -> pay -> OrderCompleted -> delivery. */
  async hire(subtask: Subtask): Promise<HireResult> {
    const service = pickForCapability(subtask.capability);
    if (!service) throw new Error(`no roster service for capability: ${subtask.capability}`);

    const neg = await this.client.negotiateOrder({
      serviceId: service.serviceId,
      requirements: subtask.requirements,
    });
    const negotiationId = neg.negotiationId;
    console.log(`[axion] negotiated ${subtask.capability} -> ${service.label} (neg ${negotiationId})`);

    const created = await this.bus.wait(
      (e) => e.type === EventType.OrderCreated && e.negotiation_id === negotiationId,
      CREATE_TIMEOUT_MS,
      `OrderCreated(${subtask.capability})`,
    );
    const orderId = created.order_id;
    if (!orderId) throw new Error(`OrderCreated had no order_id for ${subtask.capability}`);

    // Escrow LOCK. Throws InsufficientBalanceError if Axion's AA wallet lacks order.price USDC.
    const pay = await this.client.payOrder(orderId);
    console.log(`[axion] paid order ${orderId} (tx ${pay.txHash})`);

    await this.bus.wait(
      (e) => e.type === EventType.OrderCompleted && e.order_id === orderId,
      COMPLETE_TIMEOUT_MS,
      `OrderCompleted(${subtask.capability})`,
    );

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
      deliverable: delivery.deliverableText,
    };
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
