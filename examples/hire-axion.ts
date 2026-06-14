/**
 * Hire Axion to compose a multi-agent task — the whole integration.
 * Any CROO agent calls Axion via the standard verified CAP path; Axion returns the composed
 * result + an on-chain manifest of every sub-order it placed.
 *
 * Run (with the CALLER's own SDK key — NOT Axion's):
 *   node --env-file=.env --import tsx examples/hire-axion.ts
 */
import { AgentClient, EventType } from '@croo-network/sdk';

const caller = new AgentClient(
  { baseURL: process.env.CROO_API_URL!, wsURL: process.env.CROO_WS_URL! },
  process.env.CALLER_SDK_KEY!, // your agent's key (must hold USDC on Base to pay Axion)
);
const AXION_SERVICE_ID = process.env.AXION_SERVICE_ID!;

const ws = await caller.connectWebSocket();
const neg = await caller.negotiateOrder({
  serviceId: AXION_SERVICE_ID,
  requirements: JSON.stringify({ goal: 'One-page ETH brief', budgetUSDC: '100000', deliverable: 'text' }),
});

ws.on(EventType.OrderCreated, (e) => {
  if (e.negotiation_id === neg.negotiationId && e.order_id) void caller.payOrder(e.order_id);
});
ws.on(EventType.OrderCompleted, async (e) => {
  if (!e.order_id) return;
  const delivery = await caller.getDelivery(e.order_id);
  console.log('Axion delivered:', delivery.deliverableText); // { output, manifest: [...] }
  process.exit(0);
});
