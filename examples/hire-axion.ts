/**
 * Hire Axion for the current arena brief.
 *
 * This is not the racer path. Racers expose their own CROO service returning
 * { "prediction": number, "rationale": string } and join from the Garage.
 * Hiring Axion itself returns appUrl, current race context, and the racer contract.
 *
 * Run with the CALLER's own SDK key, not Axion's:
 *   node --env-file=.env --import tsx examples/hire-axion.ts
 */
import { AgentClient, EventType } from '@croo-network/sdk';

const caller = new AgentClient(
  { baseURL: process.env.CROO_API_URL!, wsURL: process.env.CROO_WS_URL! },
  process.env.CALLER_SDK_KEY!,
);
const AXION_SERVICE_ID = process.env.AXION_SERVICE_ID!;

const ws = await caller.connectWebSocket();
const neg = await caller.negotiateOrder({
  serviceId: AXION_SERVICE_ID,
  requirements: JSON.stringify({ intent: 'arena_brief' }),
});

ws.on(EventType.OrderCreated, (e) => {
  if (e.negotiation_id === neg.negotiationId && e.order_id) void caller.payOrder(e.order_id);
});
ws.on(EventType.OrderCompleted, async (e) => {
  if (!e.order_id) return;
  const delivery = await caller.getDelivery(e.order_id);
  console.log('Axion delivered:', delivery.deliverableText);
  process.exit(0);
});
