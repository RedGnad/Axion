import { AgentClient, EventType } from '@croo-network/sdk';
import { pickForCapability, type RosterEntry } from './roster.js';

/** A subtask the planner produced from the incoming goal. */
export interface Subtask {
  capability: string;
  requirements: string; // JSON string passed to negotiateOrder({ requirements })
}

/** Result of hiring one sub-agent (one real A2A edge). */
export interface HireResult {
  subtask: Subtask;
  service: RosterEntry;
  orderId: string;
  payTxHash: string;
  deliverable: string;
}

/**
 * Foreman core loop: plan -> route -> hire (parallel) -> compose.
 * Every hire is one real on-chain CAP order (one A2A edge). See CLAUDE.md for the rubric mapping.
 */
export class Orchestrator {
  constructor(private readonly client: AgentClient) {}

  /** Step 1: decompose a natural-language goal into typed subtasks. */
  async plan(goal: string): Promise<Subtask[]> {
    // TODO(builder): call the LLM (latest Claude) to decompose `goal` into subtasks whose
    // capabilities exist in the roster. Keep it deterministic + bounded.
    throw new Error(`plan() not implemented for goal: ${goal}`);
  }

  /** Step 3: hire one sub-agent end-to-end (negotiate -> pay -> await delivery). */
  async hire(subtask: Subtask): Promise<HireResult> {
    const service = pickForCapability(subtask.capability);
    if (!service) throw new Error(`no roster service for capability: ${subtask.capability}`);

    // Verified SDK path (tier [P]): negotiate -> OrderCreated -> pay -> OrderCompleted -> delivery.
    // TODO(builder): wire via connectWebSocket() events, add escrow scoping + timeout/dispute.
    const neg = await this.client.negotiateOrder({
      serviceId: service.serviceId,
      requirements: subtask.requirements,
    });
    void neg; // wired in the vertical slice
    throw new Error('hire() wiring incomplete — implement the pay/await/getDelivery flow');
  }

  /** Steps 1-4: run a full goal -> composed deliverable. */
  async run(goal: string): Promise<{ result: string; hires: HireResult[] }> {
    const subtasks = await this.plan(goal);
    const hires = await Promise.all(subtasks.map((s) => this.hire(s)));
    const result = this.compose(goal, hires);
    return { result, hires };
  }

  /** Step 4: assemble verified sub-deliverables into one result. */
  compose(goal: string, hires: HireResult[]): string {
    // TODO(builder): real composition. Placeholder keeps the type honest, not a claim of work.
    void goal;
    return hires.map((h) => h.deliverable).join('\n');
  }
}

export { EventType };
