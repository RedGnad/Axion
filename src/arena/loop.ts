import { AgentClient } from '@croo-network/sdk';
import { EventBus } from '../events.js';
import { Orchestrator, type HireResult } from '../orchestrator.js';
import { getDataAgent } from '../roster.js';
import { fetchPythPrice } from './oracle.js';
import { PERSONALITIES, type Personality } from './personalities.js';
import { forecast, type DataInput } from './forecast.js';
import { consensusLine, reasonHash, settle } from './settle.js';
import type { Forecast, Round } from './types.js';
import type { CompetitorRequest, CompetitorResponse } from './competitor-contract.js';

/**
 * One Arena round, end-to-end and verifiable on-chain:
 *   1. open  — read ETH/USD spot from Pyth.
 *   2. play  — each competitor estimates the amplitude. LOCAL competitors (our seeded personas) buy
 *      data-agents directly; REMOTE competitors are open CAP agents the Arena HIRES (Arena → agent →
 *      its data-agents = multi-hop A2A). Both produce a committed estimate + reasonHash.
 *   3. settle — after the window, re-read Pyth; closest amplitude estimate wins (ties = co-winners).
 *
 * Every hire is a real on-chain order; running this spends USDC. Local competitors load from env
 * (one SDK-Key per archetype); remote competitors from COMPETITOR_ROSTER. Betting is layered on top
 * by the bookmaker during the window (bets on the vol line, not the agent).
 */

export type Competitor =
  | { kind: 'local'; id: string; label: string; persona: Personality; orchestrator: Orchestrator }
  | { kind: 'remote'; id: string; label: string; serviceId: string; ours: boolean; orchestrator: Orchestrator };

/** Context passed to each competitor for a round. */
interface PlayCtx {
  roundId: string;
  asset: string;
  spot: number;
  horizonSeconds: number;
  /** Recent real volatility (typical move over the horizon, from Pyth) → calibrates estimates. */
  recentVol: number;
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
  /** The betting line = consensus (median) amplitude estimate. */
  line: number;
}

/** Live phase hooks so a UI/server can stream a round as it happens. */
export interface RoundHooks {
  onOpen?: (info: { id: string; openPrice: number }) => void;
  /** Fires as EACH competitor finishes, so its kart takes position one-by-one (watchable hiring). */
  onEstimate?: (info: { forecast: Forecast; edges: ArenaEdge[] }) => void;
  onEstimates?: (info: { forecasts: Forecast[]; line: number; edges: ArenaEdge[]; settleAtMs: number }) => void;
  /** Fires every ~2s during the betting window with the live realized amplitude from Pyth. */
  onTick?: (info: { liveAmplitude: number; settleAtMs: number }) => void;
  onSettled?: (result: RoundResult) => void;
}

export interface ClientCfg {
  baseURL: string;
  wsURL: string;
  rpcURL?: string;
}

/** Create the Arena's buyer orchestrator for hiring REMOTE (community) competitor services. */
export async function createRemoteBuyer(cfg: ClientCfg): Promise<Orchestrator> {
  const arenaKey = process.env.ARENA_SDK_KEY ?? process.env.CROO_SDK_KEY;
  if (!arenaKey) throw new Error('no ARENA_SDK_KEY/CROO_SDK_KEY to hire remote competitors');
  const clientCfg = { baseURL: cfg.baseURL, wsURL: cfg.wsURL, ...(cfg.rpcURL ? { rpcURL: cfg.rpcURL } : {}) };
  const client = new AgentClient(clientCfg, arenaKey);
  const ws = await client.connectWebSocket();
  return new Orchestrator(client, new EventBus(ws));
}

/** Build a remote (community) competitor that the Arena hires each round. */
export function makeRemoteCompetitor(orchestrator: Orchestrator, serviceId: string, label: string): Competitor {
  return { kind: 'remote', id: label, label, serviceId, ours: false, orchestrator };
}

/** Env var holding a persona's SDK-Key, keyed by archetype (keys are issued per archetype). */
function competitorKeyEnv(p: Personality): string {
  return `COMPETITOR_${p.archetype.toUpperCase()}_SDK_KEY`;
}

/**
 * Build the round's competitors: LOCAL personas (one SDK-Key per archetype) plus optional REMOTE
 * open competitors from `COMPETITOR_ROSTER` (comma-separated `label=serviceId`). Remotes are hired
 * by an Arena buyer client (ARENA_SDK_KEY, else CROO_SDK_KEY) and count as third-party (ours:false).
 */
export async function loadCompetitors(cfg: ClientCfg): Promise<Competitor[]> {
  const clientCfg = { baseURL: cfg.baseURL, wsURL: cfg.wsURL, ...(cfg.rpcURL ? { rpcURL: cfg.rpcURL } : {}) };
  const competitors: Competitor[] = [];

  for (const persona of PERSONALITIES) {
    const key = process.env[competitorKeyEnv(persona)];
    if (!key) continue;
    const client = new AgentClient(clientCfg, key);
    const ws = await client.connectWebSocket();
    const bus = new EventBus(ws);
    competitors.push({ kind: 'local', id: persona.id, label: persona.label, persona, orchestrator: new Orchestrator(client, bus) });
  }

  const roster = (process.env.COMPETITOR_ROSTER ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const arenaKey = process.env.ARENA_SDK_KEY ?? process.env.CROO_SDK_KEY;
  if (roster.length && arenaKey) {
    const arenaClient = new AgentClient(clientCfg, arenaKey);
    const arenaWs = await arenaClient.connectWebSocket();
    const arenaOrch = new Orchestrator(arenaClient, new EventBus(arenaWs));
    for (const entry of roster) {
      const [label, serviceId] = entry.includes('=') ? entry.split('=') : [entry, entry];
      competitors.push({ kind: 'remote', id: label, label, serviceId, ours: false, orchestrator: arenaOrch });
    }
  }

  if (competitors.length === 0) {
    throw new Error(
      `no competitors configured — set at least one of: ${PERSONALITIES.map(competitorKeyEnv).join(', ')} (or COMPETITOR_ROSTER + ARENA_SDK_KEY)`,
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

/** Estimate for one competitor (local persona or remote open agent). */
async function play(c: Competitor, ctx: PlayCtx): Promise<{ forecast: Forecast; edges: ArenaEdge[] }> {
  return c.kind === 'local' ? playLocal(c, ctx) : playRemote(c, ctx);
}

/** Local persona: buy its data-agents directly, then estimate the amplitude. */
async function playLocal(
  c: Extract<Competitor, { kind: 'local' }>,
  ctx: PlayCtx,
): Promise<{ forecast: Forecast; edges: ArenaEdge[] }> {
  // Hire the persona's data-agents IN PARALLEL. (The docs warn against concurrent payOrder from one
  // wallet, but in practice the backend tolerates it and parallel is REQUIRED for acceptable latency:
  // sequential doubled the hiring time and stacked slow-provider timeouts → rounds hung ~4-8min.)
  const services = c.persona.capabilities.map((cap) => getDataAgent(cap)).filter((s): s is NonNullable<typeof s> => !!s);
  const results = await Promise.all(
    services.map(async (service) => {
      try {
        return await c.orchestrator.hireService(service, buildRequirements(service.capability));
      } catch (err) {
        // A third-party provider may be offline despite "online" — degrade, don't crash the round.
        console.warn(`[arena] ${c.id}: hire '${service.capability}' (${service.label}) failed: ${(err as Error).message}`);
        return null;
      }
    }),
  );
  const hires: HireResult[] = results.filter((h): h is HireResult => h !== null);

  const inputs: DataInput[] = hires.map((h) => ({ label: h.service.label, text: h.deliverable }));
  const baseline = ctx.recentVol * c.persona.volMultiplier; // calibrated, persona-distinct
  const draft = await forecast(c.persona, ctx.spot, inputs, ctx.horizonSeconds, baseline);

  const f: Forecast = {
    competitor: c.id,
    prediction: draft.prediction,
    rationale: draft.rationale,
    hiredServiceIds: hires.map((h) => h.service.serviceId),
    reasonHash: reasonHash({ competitor: c.id, prediction: draft.prediction, rationale: draft.rationale, inputs: JSON.stringify(inputs) }),
  };
  const edges: ArenaEdge[] = hires.map((h) => ({
    competitor: c.id,
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

/** Remote open competitor: the Arena HIRES its CAP service (one A2A edge); the agent's own data
 *  sub-hires happen inside it (multi-hop, on-chain, not in our manifest). */
async function playRemote(
  c: Extract<Competitor, { kind: 'remote' }>,
  ctx: PlayCtx,
): Promise<{ forecast: Forecast; edges: ArenaEdge[] }> {
  const request: CompetitorRequest = { roundId: ctx.roundId, asset: ctx.asset, spot: ctx.spot, deadlineSeconds: ctx.horizonSeconds, recentVol: ctx.recentVol };
  const service = { capability: 'competitor', serviceId: c.serviceId, label: c.label, ours: c.ours };
  const hire = await c.orchestrator.hireService(service, JSON.stringify(request));

  let prediction = 0;
  let rationale = '(no response)';
  try {
    const resp = JSON.parse(hire.deliverable) as Partial<CompetitorResponse>;
    prediction = Math.abs(Number(resp.prediction)) || 0;
    if (typeof resp.rationale === 'string' && resp.rationale.trim()) rationale = resp.rationale.trim();
  } catch {
    /* malformed competitor response → counts as a 0 estimate */
  }

  const f: Forecast = {
    competitor: c.id,
    prediction,
    rationale,
    hiredServiceIds: [c.serviceId],
    reasonHash: reasonHash({ competitor: c.id, prediction, rationale, inputs: `remote:${c.serviceId}` }),
  };
  const edges: ArenaEdge[] = [{
    competitor: c.id,
    capability: 'competitor',
    serviceId: c.serviceId,
    label: c.label,
    orderId: hire.orderId,
    payTxHash: hire.payTxHash,
    clearTxHash: hire.clearTxHash,
    ours: c.ours,
  }];
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
  hooks: RoundHooks = {},
  opts: { recentVol?: number } = {},
): Promise<RoundResult> {
  const id = `round-${Date.now()}`;
  const open = await fetchPythPrice();
  // Recent real volatility (typical move over the window). Falls back to ~0.05% of spot if unknown.
  const recentVol = opts.recentVol && opts.recentVol > 0 ? opts.recentVol : open.price * 0.0005;
  console.log(`[arena] ${id} open — ETH/USD $${open.price.toFixed(2)} (Pyth ${open.publishTime}); recentVol ~$${recentVol.toFixed(2)}; agents estimating…`);
  hooks.onOpen?.({ id, openPrice: open.price });

  // Each competitor estimates in parallel (local + remote); every hire is a real CAP order.
  // The game: estimate the AMPLITUDE |close - open| over the window (not the level/direction).
  const ctx: PlayCtx = { roundId: id, asset: 'ETH', spot: open.price, horizonSeconds: windowSeconds, recentVol };
  // Stream each competitor's estimate as soon as it lands → karts take position one-by-one.
  const played = await Promise.all(
    competitors.map(async (c) => {
      const r = await play(c, ctx);
      hooks.onEstimate?.({ forecast: r.forecast, edges: r.edges });
      return r;
    }),
  );
  const forecasts = played.map((p) => p.forecast);
  const edges = played.flatMap((p) => p.edges);
  const line = consensusLine(forecasts);
  for (const f of forecasts) {
    console.log(`[arena] ${f.competitor} estimates amplitude $${f.prediction.toFixed(2)} — "${f.rationale}"`);
  }
  // Betting window starts NOW (after estimates) so the race is watchable: a clean window during
  // which the live realized amplitude accumulates from Pyth toward the agents' guesses.
  const settleAtMs = Date.now() + windowSeconds * 1000;
  hooks.onEstimates?.({ forecasts, line, edges, settleAtMs });

  while (Date.now() < settleAtMs) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const live = await fetchPythPrice();
      hooks.onTick?.({ liveAmplitude: Math.abs(live.price - open.price), settleAtMs });
    } catch {
      /* transient Hermes hiccup — keep ticking */
    }
  }

  const close = await fetchPythPrice();
  const actualAmplitude = Math.abs(close.price - open.price);
  const outcome = settle(forecasts, actualAmplitude, new Date(close.publishTime * 1000));
  console.log(
    `[arena] ${id} settled — open $${open.price.toFixed(2)} → close $${close.price.toFixed(2)} → ` +
      `amplitude $${actualAmplitude.toFixed(2)}; winner(s): ${outcome.winners.join(', ')}`,
  );

  const round: Round = { id, phase: 'settled', openPrice: open.price, closePrice: close.price, settleAtMs, forecasts, outcome };
  const result: RoundResult = { round, edges, line };
  hooks.onSettled?.(result);
  return result;
}
