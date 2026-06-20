import { AgentClient, DeliverableType } from '@croo-network/sdk';
import { Orchestrator, type HireResult } from '../orchestrator.js';
import { getDataAgent } from '../roster.js';
import { forecast, type DataInput } from './forecast.js';
import { getPersonality, PERSONALITIES, type Personality } from './personalities.js';
import type { CompetitorRequest, CompetitorResponse } from './competitor-contract.js';

/**
 * Runnable TEMPLATE for an open competitor — fork this to join the Arena (see README "Add your agent").
 *
 * It is a dual-role CAP agent: PROVIDER of a forecast service (the Arena hires it) and, optionally,
 * BUYER of data-agents to inform the estimate. On hire it reads {@link CompetitorRequest}, produces
 * a {@link CompetitorResponse}, and delivers it.
 *
 * Two zero-config tiers so your FIRST success is cheap:
 *  - No ANTHROPIC_API_KEY  → a deterministic estimate from recent vol × your risk style. It works,
 *    it competes, and it costs you nothing in sub-hires (the Arena pays YOU).
 *  - With ANTHROPIC_API_KEY → it also hires its persona's data-agents (real multi-hop A2A) and lets
 *    the model read them. Richer forecast; you pay ~0.10 USDC per data-agent per round.
 *
 * Reliability: accept + deliver run by POLLING (listNegotiations/listOrders). CROO WebSocket events
 * are unreliable; the WS connection is kept open only so the service shows ONLINE (= hireable).
 */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

/** Match each data-agent's accepted requirement schema (probed on-chain). */
function buildRequirements(capability: string, asset = 'ETH'): string {
  if (capability === 'token-price') return JSON.stringify({ token: asset, chain: 'base' });
  if (capability === 'gas') return JSON.stringify({ chain: 'base' });
  return '{}';
}

/** Produce a forecast for one round. Override THIS to build your own agent's edge. */
export async function estimate(
  persona: Personality,
  req: Partial<CompetitorRequest>,
  orchestrator: Orchestrator,
): Promise<{ response: CompetitorResponse; hires: HireResult[] }> {
  const spot = Number(req.spot) || 0;
  const horizon = Number(req.deadlineSeconds) || 60;
  // Calibrated baseline: recent real vol × this persona's risk style (falls back to a small % of spot).
  const baseline =
    req.recentVol && req.recentVol > 0
      ? req.recentVol * persona.volMultiplier
      : Math.max(0.5, spot * 0.0004 * persona.volMultiplier);

  // Tier 1 — deterministic, no LLM, no data spend. A valid, distinct, working competitor.
  if (!process.env.ANTHROPIC_API_KEY) {
    const prediction = Math.max(0.01, Number((baseline + 0.01 * persona.volMultiplier).toFixed(2)));
    return {
      response: {
        prediction,
        rationale: `${persona.label}: ~$${prediction.toFixed(2)} from recent ETH vol × my ${persona.volMultiplier}× risk style (deterministic — set ANTHROPIC_API_KEY for a data-driven estimate).`,
      },
      hires: [],
    };
  }

  // Tier 2 — hire the persona's data-agents (real A2A), then let the model read them.
  const hires: HireResult[] = [];
  for (const capability of persona.capabilities) {
    const svc = getDataAgent(capability);
    if (!svc) continue;
    try {
      hires.push(await orchestrator.hireService(svc, buildRequirements(capability, req.asset)));
    } catch (err) {
      console.warn(`[${persona.id}] data hire '${capability}' failed: ${(err as Error).message}`);
    }
  }
  const inputs: DataInput[] = hires.map((h) => ({ label: h.service.label, text: h.deliverable }));
  const draft = await forecast(persona, spot, inputs, horizon, baseline);
  return { response: { prediction: draft.prediction, rationale: draft.rationale }, hires };
}

async function main(): Promise<void> {
  const cfg = { baseURL: requireEnv('CROO_API_URL'), wsURL: requireEnv('CROO_WS_URL') };
  const serviceId = requireEnv('COMPETITOR_SERVICE_ID');
  const personaId = process.env.COMPETITOR_PERSONA ?? PERSONALITIES[0].id;
  const persona = getPersonality(personaId);
  if (!persona) throw new Error(`unknown COMPETITOR_PERSONA '${personaId}' (have: ${PERSONALITIES.map((p) => p.id).join(', ')})`);

  const client = new AgentClient(cfg, requireEnv('COMPETITOR_SDK_KEY'));
  try { await client.connectWebSocket(); } catch { /* WS only keeps the "online" status; we poll for work */ }
  const orchestrator = new Orchestrator(client);

  const done = new Set<string>();    // orders we've delivered (idempotency across ticks)
  const inFlight = new Set<string>(); // orders currently being processed

  const tick = async (): Promise<void> => {
    try {
      // Accept any pending hire for our service.
      const negs = await client.listNegotiations({ role: 'provider', status: 'pending', page: 1, pageSize: 20 });
      for (const n of negs) {
        if (n.serviceId !== serviceId) continue;
        try { await client.acceptNegotiation(n.negotiationId); console.log(`[${persona.id}] accepted hire ${n.negotiationId}`); }
        catch { /* retry next tick */ }
      }
      // Deliver any paid order we haven't answered yet.
      const orders = await client.listOrders({ role: 'provider', status: 'paid', page: 1, pageSize: 20 });
      for (const o of orders) {
        if (o.serviceId !== serviceId || done.has(o.orderId) || inFlight.has(o.orderId)) continue;
        inFlight.add(o.orderId);
        void (async () => {
          try {
            const neg = await client.getNegotiation(o.negotiationId);
            const req = JSON.parse(neg.requirements ?? '{}') as Partial<CompetitorRequest>;
            const { response, hires } = await estimate(persona, req, orchestrator);
            await client.deliverOrder(o.orderId, { deliverableType: DeliverableType.Text, deliverableText: JSON.stringify(response) });
            done.add(o.orderId);
            console.log(`[${persona.id}] delivered $${response.prediction.toFixed(2)} for round ${req.roundId ?? '?'} (${hires.length} data hires)`);
          } catch (err) {
            console.error(`[${persona.id}] estimate/deliver failed:`, (err as Error).message);
          } finally {
            inFlight.delete(o.orderId);
          }
        })();
      }
    } catch { /* transient list error — next tick retries */ }
  };

  setInterval(() => void tick(), 6000);
  console.log(`[${persona.id}] competitor LIVE & hireable on service ${serviceId} (persona: ${persona.label}) — polling for work`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
