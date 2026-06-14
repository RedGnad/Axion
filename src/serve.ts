import { AgentClient, EventType, DeliverableType, type Event } from '@croo-network/sdk';
import { EventBus } from './events.js';
import { Orchestrator } from './orchestrator.js';
import { startLeafProvider } from './provider.js';
import { fetchEthUsd } from './leafs/price.js';
import { summarize } from './leafs/summarize.js';
import { getRoster } from './roster.js';
import type { AxionRequest, AxionResult, SubOrderRef } from './contract.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name} (see .env / .env.example)`);
  return v;
}

/**
 * Runs Axion LIVE as a hireable CAP service (its public contract = src/contract.ts).
 *
 * Axion is dual-role on ONE WebSocket: PROVIDER of its own service (gets hired → composes)
 * and BUYER of sub-agents (the orchestrator). The two are separated by serviceId:
 *  - a NegotiationCreated / paid order whose serviceId === AXION_SERVICE_ID is a hire OF Axion;
 *  - everything else is a sub-order Axion placed as buyer (handled by the orchestrator's EventBus).
 * Cashflow: the caller's USDC escrows into Axion's parent order and releases only after Axion
 * delivers — so Axion fronts the sub-hires from its own AA-wallet float during composition.
 */
async function main(): Promise<void> {
  const baseURL = requireEnv('CROO_API_URL');
  const wsURL = requireEnv('CROO_WS_URL');
  const rpcURL = process.env.BASE_RPC_URL;
  const axionKey = requireEnv('CROO_SDK_KEY');
  const axionServiceId = requireEnv('AXION_SERVICE_ID');
  const priceKey = requireEnv('LEAF_PRICE_SDK_KEY');
  const summarizeKey = process.env.LEAF_SUMMARIZE_SDK_KEY;
  const cfg = { baseURL, wsURL, ...(rpcURL ? { rpcURL } : {}) };

  // Leaf providers (each on its own isolated WS).
  await startLeafProvider(new AgentClient(cfg, priceKey), 'price', async () => fetchEthUsd(rpcURL));
  if (summarizeKey && getRoster().some((r) => r.capability === 'summarize')) {
    await startLeafProvider(new AgentClient(cfg, summarizeKey), 'summarize', async (req) => summarize(req));
  }

  // Axion: provider handlers + buyer EventBus share one WS.
  const axion = new AgentClient(cfg, axionKey);
  const ws = await axion.connectWebSocket();
  const bus = new EventBus(ws);
  const orchestrator = new Orchestrator(axion, bus);

  // PROVIDER side: someone hires Axion's service → accept.
  ws.on(EventType.NegotiationCreated, (e: Event) => {
    void (async () => {
      if (e.service_id !== axionServiceId || !e.negotiation_id) return; // only hires OF Axion
      try {
        await axion.acceptNegotiation(e.negotiation_id);
        console.log(`[axion] accepted hire (neg ${e.negotiation_id})`);
      } catch (err) {
        console.error('[axion] acceptNegotiation failed:', (err as Error).message);
      }
    })();
  });

  // PROVIDER side: caller paid → compose and deliver.
  ws.on(EventType.OrderPaid, (e: Event) => {
    void (async () => {
      if (!e.order_id) return;
      const order = await axion.getOrder(e.order_id);
      if (order.serviceId !== axionServiceId) return; // ignore sub-orders Axion paid as buyer
      console.log(`[axion] hired — parent order ${e.order_id} paid; composing...`);
      try {
        const neg = await axion.getNegotiation(order.negotiationId);
        let goal = 'composite task';
        try {
          const req = JSON.parse(neg.requirements) as AxionRequest;
          if (req.goal) goal = req.goal;
          // NOTE: budgetUSDC / constraints are not yet enforced — do not claim they are.
        } catch {
          if (neg.requirements) goal = neg.requirements;
        }
        const { output, hires } = await orchestrator.run(goal);
        const manifest: SubOrderRef[] = hires.map((h) => ({
          capability: h.subtask.capability,
          serviceId: h.service.serviceId,
          orderId: h.orderId,
          payTxHash: h.payTxHash,
          ours: h.service.ours,
        }));
        const result: AxionResult = { output, manifest };
        await axion.deliverOrder(e.order_id, {
          deliverableType: DeliverableType.Text,
          deliverableText: JSON.stringify(result),
        });
        console.log(`[axion] delivered composed result for parent order ${e.order_id}`);
      } catch (err) {
        console.error('[axion] compose/deliver failed:', (err as Error).message);
      }
    })();
  });

  console.log(
    `[axion] LIVE & hireable. serviceId=${axionServiceId}\n` +
      'Any agent: negotiateOrder({ serviceId, requirements: JSON.stringify({ goal, budgetUSDC, deliverable }) })',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
