import { AgentClient, EventType, DeliverableType, type Event } from '@croo-network/sdk';
import { EventBus } from '../events.js';
import { Orchestrator, type HireResult } from '../orchestrator.js';
import { getDataAgent } from '../roster.js';
import { forecast, type DataInput } from './forecast.js';
import { getPersonality, PERSONALITIES } from './personalities.js';
import type { CompetitorRequest, CompetitorResponse } from './competitor-contract.js';

/**
 * Runnable TEMPLATE for an open competitor (fork this to join the Arena).
 *
 * It is a dual-role CAP agent on ONE WebSocket: PROVIDER of a forecast service (the Arena hires it)
 * and BUYER of data-agents (to inform the estimate). On hire it reads {@link CompetitorRequest},
 * buys its persona's data capabilities (real A2A sub-orders), runs the volatility estimate, and
 * delivers {@link CompetitorResponse}. Customize: pick/override the persona (its prompt + which
 * data-agents it buys) and register your own CAP service — nothing here is privileged.
 */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

async function main(): Promise<void> {
  const cfg = { baseURL: requireEnv('CROO_API_URL'), wsURL: requireEnv('CROO_WS_URL') };
  const serviceId = requireEnv('COMPETITOR_SERVICE_ID');
  const personaId = process.env.COMPETITOR_PERSONA ?? PERSONALITIES[0].id;
  const persona = getPersonality(personaId);
  if (!persona) throw new Error(`unknown COMPETITOR_PERSONA '${personaId}' (have: ${PERSONALITIES.map((p) => p.id).join(', ')})`);

  const client = new AgentClient(cfg, requireEnv('COMPETITOR_SDK_KEY'));
  const ws = await client.connectWebSocket();
  const bus = new EventBus(ws); // buyer events for the data-agent sub-hires
  const orchestrator = new Orchestrator(client, bus);

  // PROVIDER: the Arena hires this competitor's service → accept.
  ws.on(EventType.NegotiationCreated, (e: Event) => {
    void (async () => {
      if (e.service_id !== serviceId || !e.negotiation_id) return;
      try {
        await client.acceptNegotiation(e.negotiation_id);
        console.log(`[${persona.id}] accepted arena hire (neg ${e.negotiation_id})`);
      } catch (err) {
        console.error(`[${persona.id}] accept failed:`, (err as Error).message);
      }
    })();
  });

  // PROVIDER: paid → buy data, estimate amplitude, deliver CompetitorResponse.
  ws.on(EventType.OrderPaid, (e: Event) => {
    void (async () => {
      if (!e.order_id) return;
      const order = await client.getOrder(e.order_id);
      if (order.serviceId !== serviceId) return; // ignore our own data sub-orders
      try {
        const neg = await client.getNegotiation(order.negotiationId);
        const req = JSON.parse(neg.requirements ?? '{}') as Partial<CompetitorRequest>;
        const spot = Number(req.spot) || 0;
        const horizon = Number(req.deadlineSeconds) || 60;

        const hires: HireResult[] = [];
        for (const capability of persona.capabilities) {
          const svc = getDataAgent(capability);
          if (!svc) continue;
          try {
            hires.push(await orchestrator.hireService(svc, capability === 'token-price' ? JSON.stringify({ token: req.asset ?? 'ETH', chain: 'base' }) : capability === 'gas' ? JSON.stringify({ chain: 'base' }) : '{}'));
          } catch (err) {
            console.warn(`[${persona.id}] data hire '${capability}' failed: ${(err as Error).message}`);
          }
        }
        const inputs: DataInput[] = hires.map((h) => ({ label: h.service.label, text: h.deliverable }));
        const draft = await forecast(persona, spot, inputs, horizon);
        const response: CompetitorResponse = { prediction: draft.prediction, rationale: draft.rationale };

        await client.deliverOrder(e.order_id, {
          deliverableType: DeliverableType.Text,
          deliverableText: JSON.stringify(response),
        });
        console.log(`[${persona.id}] delivered estimate $${draft.prediction.toFixed(2)} for round ${req.roundId} (${hires.length} data hires)`);
      } catch (err) {
        console.error(`[${persona.id}] estimate/deliver failed:`, (err as Error).message);
      }
    })();
  });

  console.log(`[${persona.id}] competitor LIVE & hireable on service ${serviceId} (persona: ${persona.label})`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
