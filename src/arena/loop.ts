import { AgentClient } from '@croo-network/sdk';
import { EventBus } from '../events.js';
import { Orchestrator, type HireResult } from '../orchestrator.js';
import { getDataAgent } from '../roster.js';
import { fetchPythPrice } from './oracle.js';
import { PERSONALITIES, type Personality } from './personalities.js';
import { forecast, type DataInput } from './forecast.js';
import { reasonHash, settle } from './settle.js';
import type { Forecast, Round } from './types.js';

/**
 * One Arena round, end-to-end and verifiable on-chain:
 *   1. open  — read ETH/USD spot from Chainlink (context).
 *   2. hire  — each competitor buys its capabilities from real data-agents = real CAP orders (A2A).
 *   3. forecast — each persona turns the data it PAID for into a committed prediction + reasonHash.
 *   4. settle — after the window, re-read Chainlink; closest forecast wins (objective, riggable by none).
 *
 * Every hire is a real on-chain order; running this spends USDC, so competitors are loaded from
 * env (one SDK-Key per personality) and the function fail-fasts if none are configured. Betting is
 * layered on top by the bookmaker (separate process) during the window between step 3 and 4.
 */

export interface Competitor {
  persona: Personality;
  client: AgentClient;
  orchestrator: Orchestrator;
}

/** One on-chain A2A edge produced this round (for the manifest / live feed). */
export interface ArenaEdge {
  competitor: string;
  capability: string;
  serviceId: string;
  label: string;
  orderId: string;
  payTxHash: string;
  clearTxHash: string;
  ours: boolean;
}

export interface RoundResult {
  round: Round;
  edges: ArenaEdge[];
}

interface ClientCfg {
  baseURL: string;
  wsURL: string;
  rpcURL?: string;
}

/** Env var holding a persona's SDK-Key, keyed by archetype (keys are issued per archetype). */
function competitorKeyEnv(p: Personality): string {
  return `COMPETITOR_${p.archetype.toUpperCase()}_SDK_KEY`;
}

/** Build a live competitor (own client + WS + event bus + orchestrator) per configured personality. */
export async function loadCompetitors(cfg: ClientCfg): Promise<Competitor[]> {
  const clientCfg = { baseURL: cfg.baseURL, wsURL: cfg.wsURL, ...(cfg.rpcURL ? { rpcURL: cfg.rpcURL } : {}) };
  const competitors: Competitor[] = [];
  for (const persona of PERSONALITIES) {
    const key = process.env[competitorKeyEnv(persona)];
    if (!key) continue;
    const client = new AgentClient(clientCfg, key);
    const ws = await client.connectWebSocket();
    const bus = new EventBus(ws);
    competitors.push({ persona, client, orchestrator: new Orchestrator(client, bus) });
  }
  if (competitors.length === 0) {
    throw new Error(
      `no competitors configured — set at least one of: ${PERSONALITIES.map(competitorKeyEnv).join(', ')}`,
    );
  }
  return competitors;
}

/**
 * Requirements per capability, matched to each data-agent's accepted schema (probed on-chain
 * 2026-06-15: these agents strict-validate and reject unknown fields like "ask"). Zero-input
 * agents (sentiment/valuation/dca-signal/smart-money) take `{}`.
 */
function buildRequirements(capability: string): string {
  switch (capability) {
    case 'token-price':
      return JSON.stringify({ token: 'ETH', chain: 'base' });
    case 'gas':
      return JSON.stringify({ chain: 'base' });
    default:
      return '{}';
  }
}

/** Have one competitor hire all its capabilities and commit an amplitude estimate. */
async function playCompetitor(c: Competitor, spot: number, horizonSeconds: number): Promise<{ forecast: Forecast; edges: ArenaEdge[] }> {
  const hires: HireResult[] = [];
  for (const capability of c.persona.capabilities) {
    const service = getDataAgent(capability);
    if (!service) {
      console.warn(`[arena] ${c.persona.id}: no data-agent for capability '${capability}' — skipping`);
      continue;
    }
    try {
      hires.push(await c.orchestrator.hireService(service, buildRequirements(capability)));
    } catch (err) {
      // A third-party provider may be offline despite "online" in the catalog — degrade, don't crash.
      console.warn(`[arena] ${c.persona.id}: hire '${capability}' (${service.label}) failed: ${(err as Error).message}`);
    }
  }

  const inputs: DataInput[] = hires.map((h) => ({ label: h.service.label, text: h.deliverable }));
  const draft = await forecast(c.persona, spot, inputs, horizonSeconds);
  const hiredServiceIds = hires.map((h) => h.service.serviceId);

  const f: Forecast = {
    competitor: c.persona.id,
    prediction: draft.prediction,
    rationale: draft.rationale,
    hiredServiceIds,
    reasonHash: reasonHash({
      competitor: c.persona.id,
      prediction: draft.prediction,
      rationale: draft.rationale,
      inputs: JSON.stringify(inputs),
    }),
  };

  const edges: ArenaEdge[] = hires.map((h) => ({
    competitor: c.persona.id,
    capability: h.service.capability,
    serviceId: h.service.serviceId,
    label: h.service.label,
    orderId: h.orderId,
    payTxHash: h.payTxHash,
    clearTxHash: h.clearTxHash,
    ours: h.service.ours,
  }));

  return { forecast: f, edges };
}

/**
 * Run a full round. `windowSeconds` is the time between commit and settlement (also the betting
 * window). Returns the settled round + every on-chain A2A edge.
 */
export async function runRound(
  competitors: Competitor[],
  cfg: ClientCfg,
  windowSeconds = 60,
): Promise<RoundResult> {
  const id = `round-${Date.now()}`;
  const open = await fetchPythPrice();
  const settleAtMs = Date.now() + windowSeconds * 1000;
  console.log(`[arena] ${id} open — ETH/USD $${open.price.toFixed(2)} (Pyth ${open.publishTime}); settles in ${windowSeconds}s`);

  // Each competitor hires + forecasts in parallel (their hires interleave as real CAP orders).
  // The game: estimate the AMPLITUDE |close - open| over the window (not the level/direction).
  const played = await Promise.all(competitors.map((c) => playCompetitor(c, open.price, windowSeconds)));
  const forecasts = played.map((p) => p.forecast);
  const edges = played.flatMap((p) => p.edges);
  for (const f of forecasts) {
    console.log(`[arena] ${f.competitor} estimates amplitude $${f.prediction.toFixed(2)} — "${f.rationale}" (${f.hiredServiceIds.length} hires)`);
  }

  // Betting window: bets are placed against the bookmaker during this wait (separate process).
  const waitMs = settleAtMs - Date.now();
  if (waitMs > 0) await new Promise((r) => setTimeout(r, waitMs));

  const close = await fetchPythPrice();
  const actualAmplitude = Math.abs(close.price - open.price);
  const outcome = settle(forecasts, actualAmplitude, new Date(close.publishTime * 1000));
  console.log(
    `[arena] ${id} settled — open $${open.price.toFixed(2)} → close $${close.price.toFixed(2)} → ` +
      `amplitude $${actualAmplitude.toFixed(2)}; winner(s): ${outcome.winners.join(', ')}`,
  );

  const round: Round = { id, phase: 'settled', openPrice: open.price, closePrice: close.price, settleAtMs, forecasts, outcome };
  return { round, edges };
}
