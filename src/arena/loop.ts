import { AgentClient } from '@croo-network/sdk';
import { EventBus } from '../events.js';
import { Orchestrator, type HireResult } from '../orchestrator.js';
import { getDataAgent, DATA_AGENTS, type RosterEntry } from '../roster.js';
import { candidatesForCapability, markProviderFailed, markProviderTried, isProviderUntried } from './discovery.js';
import { fetchPythPrice } from './oracle.js';
import { PERSONALITIES, type Personality } from './personalities.js';
import { forecast, type DataInput } from './forecast.js';
import { consensusLine, reasonHash, settle } from './settle.js';
import type { Forecast, Round } from './types.js';
import { validateCompetitorResponse, type CompetitorRequest } from './competitor-contract.js';

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
  /** Wall-clock latency of this hire (ms) — the provider-speed signal for the ecosystem leaderboard. */
  latencyMs?: number;
}

export interface RoundResult {
  round: Round;
  edges: ArenaEdge[];
  /** The betting line = consensus (median) amplitude estimate. */
  line: number;
}

/** A data/competitor hire that FAILED this round (surfaced, never swallowed — silent failure makes
 *  the A2A look hollow when really it's infra/funding). reason is the underlying error, human-ish. */
export interface HireFail {
  competitor: string;
  label: string;
  reason: string;
}

/** Live phase hooks so a UI/server can stream a round as it happens. */
export interface RoundHooks {
  /** Round opens. `dqAtMs` = backstop cutoff (refined to first-agent + grace once the fastest lands). */
  onOpen?: (info: { id: string; openPrice: number; dqAtMs: number }) => void;
  /** Fires when a local racer has selected the providers it is about to hire. */
  onSourcing?: (info: { competitor: string; services: { capability: string; serviceId: string; label: string }[] }) => void;
  /** Fires as EACH competitor finishes, so its kart takes position one-by-one (watchable hiring). */
  onEstimate?: (info: { forecast: Forecast; edges: ArenaEdge[] }) => void;
  /** A data/competitor hire FAILED — surfaced so the failure is never silent (see HireFail). */
  onHireFail?: (info: HireFail) => void;
  /** The FASTEST agent landed → the grace window opens: [dqFromMs, dqAtMs]. Stragglers cut at dqAtMs. */
  onFirstEstimate?: (info: { dqFromMs: number; dqAtMs: number }) => void;
  /** Betting OPENS (commit window) — the outcome is NOT being measured yet, so a late bet can't cheat.
   *  `dqIds` = competitors disqualified this round for not delivering before the cutoff. */
  onEstimates?: (info: { forecasts: Forecast[]; line: number; edges: ArenaEdge[]; betCloseAtMs: number; dqIds: string[] }) => void;
  /** Fires every ~2s during the race window with the live realized amplitude from Pyth. */
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

// LIVE SOURCING (env-gated): agents pick their data providers from the EVOLVING store instead of a
// frozen list. OFF by default (curated seeds). On, it sources the top-demand provider per capability
// from the live catalog, with light exploration to qualify new high-demand providers on-chain.
const LIVE_SOURCING = process.env.ARENA_LIVE_SOURCING === '1';
const isCuratedSeed = (serviceId: string): boolean => DATA_AGENTS.some((e) => e.serviceId === serviceId);

/** Choose the data provider for a capability: curated seed by default; with live sourcing on, the best
 *  store provider by real 7d demand, occasionally an untried high-demand newcomer (to qualify it). */
async function chooseProvider(capability: string): Promise<RosterEntry | null> {
  const seed = getDataAgent(capability) ?? null;
  if (!LIVE_SOURCING) return seed;
  const cands = await candidatesForCapability(capability); // ranked desc by orders7d, minus blacklisted
  if (!cands.length) return seed;
  // ROTATE so WHICH provider is hired varies round to round (real store dynamism), demand-weighted so
  // high-demand providers show up more often but never EXCLUSIVELY (previously it always took the
  // single #1 → looked frozen on the same handful). Occasionally probe an untried newcomer to qualify
  // it on-chain; a dud just fails once, gets blacklisted, and drops out of future pools.
  const pool = cands.slice(0, 6);
  const untried = cands.filter((c) => isProviderUntried(c.serviceId) && c.orders7d >= 5);
  let pick: (typeof cands)[number];
  if (untried.length && Math.random() < 0.2) {
    pick = untried[Math.floor(Math.random() * Math.min(untried.length, 5))];
  } else {
    // sqrt-dampened demand weighting: still favors high-demand providers, but not so overwhelmingly
    // that the single #1 is picked every round (raw orders7d gaps are ~100:1 → it looked frozen).
    // Dampened, comparable-demand candidates actually alternate round to round → visible variety.
    const w = (c: (typeof cands)[number]) => Math.sqrt(Math.max(1, c.orders7d));
    const total = pool.reduce((s, c) => s + w(c), 0);
    let r = Math.random() * total;
    pick = pool[pool.length - 1];
    for (const c of pool) { r -= w(c); if (r <= 0) { pick = c; break; } }
  }
  markProviderTried(pick.serviceId);
  return { capability, serviceId: pick.serviceId, label: pick.name, ours: false };
}

/** Estimate for one competitor (local persona or remote open agent). */
async function play(c: Competitor, ctx: PlayCtx, hooks: RoundHooks): Promise<{ forecast: Forecast; edges: ArenaEdge[]; fails: HireFail[] }> {
  return c.kind === 'local' ? playLocal(c, ctx, hooks) : playRemote(c, ctx);
}

/** Local persona: buy its data-agents directly, then estimate the amplitude. */
async function playLocal(
  c: Extract<Competitor, { kind: 'local' }>,
  ctx: PlayCtx,
  hooks: RoundHooks,
): Promise<{ forecast: Forecast; edges: ArenaEdge[]; fails: HireFail[] }> {
  // Hire the persona's data-agents IN PARALLEL. (The docs warn against concurrent payOrder from one
  // wallet, but in practice the backend tolerates it and parallel is REQUIRED for acceptable latency:
  // sequential doubled the hiring time and stacked slow-provider timeouts → rounds hung ~4-8min.)
  // Source one provider per capability: curated seed by default, or live from the evolving store.
  const chosen = await Promise.all(c.persona.capabilities.map((cap) => chooseProvider(cap)));
  const services = chosen.filter((s): s is RosterEntry => !!s);
  hooks.onSourcing?.({
    competitor: c.id,
    services: services.map((s) => ({ capability: s.capability, serviceId: s.serviceId, label: s.label })),
  });
  const fails: HireFail[] = [];
  const results = await Promise.all(
    services.map(async (service) => {
      const t0 = Date.now();
      // Known curated seeds use their verified schema; dynamically-sourced agents get zero-input ({}),
      // which the read-only data feeds accept. A dud just fails (surfaced) and is blacklisted below.
      const requirements = isCuratedSeed(service.serviceId) ? buildRequirements(service.capability) : '{}';
      try {
        const hr = await c.orchestrator.hireService(service, requirements);
        return { hr, latencyMs: Date.now() - t0 }; // time the hire → provider-speed signal
      } catch (err) {
        // A hire can fail because the wallet is out of USDC, a provider is offline/slow, or it rejects
        // the schema. Degrade the round, SURFACE the reason, and (for non-seed dynamic picks) blacklist
        // it so we don't waste USDC retrying a dud — the arena learns which store agents actually work.
        const reason = (err as Error).message || 'unknown error';
        console.warn(`[arena] ${c.id}: hire '${service.capability}' (${service.label}) failed: ${reason}`);
        if (!isCuratedSeed(service.serviceId)) markProviderFailed(service.serviceId);
        fails.push({ competitor: c.id, label: service.label, reason });
        return null;
      }
    }),
  );
  const ok = results.filter((r): r is { hr: HireResult; latencyMs: number } => r !== null);
  const hires: HireResult[] = ok.map((r) => r.hr);
  const latencyByService = new Map(ok.map((r) => [r.hr.service.serviceId, r.latencyMs]));

  // Truncate each deliverable so a dynamically-sourced agent can't flood the forecast LLM with junk.
  const inputs: DataInput[] = hires.map((h) => ({ label: h.service.label, text: (h.deliverable || '').slice(0, 1200) }));
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
    latencyMs: latencyByService.get(h.service.serviceId),
  }));
  return { forecast: f, edges, fails };
}

/** Remote open competitor: the Arena HIRES its CAP service (one A2A edge); the agent's own data
 *  sub-hires happen inside it (multi-hop, on-chain, not in our manifest). */
async function playRemote(
  c: Extract<Competitor, { kind: 'remote' }>,
  ctx: PlayCtx,
): Promise<{ forecast: Forecast; edges: ArenaEdge[]; fails: HireFail[] }> {
  const request: CompetitorRequest = { roundId: ctx.roundId, asset: ctx.asset, spot: ctx.spot, deadlineSeconds: ctx.horizonSeconds, recentVol: ctx.recentVol };
  const service = { capability: 'competitor', serviceId: c.serviceId, label: c.label, ours: c.ours };
  // Cost cap: don't pay an open racer more than ARENA_MAX_RACER_PRICE_USDC (default 0.20) for its forecast.
  const capUSDC = Number(process.env.ARENA_MAX_RACER_PRICE_USDC ?? '0.20');
  const maxPriceSmallestUnit = Number.isFinite(capUSDC) && capUSDC > 0 ? Math.round(capUSDC * 1e6) : undefined;
  const hire = await c.orchestrator.hireService(service, JSON.stringify(request), undefined, { maxPriceSmallestUnit });

  // CONTRACT CHECK (same function the local validator uses → ✅ there == accepted here). A remote that
  // doesn't return {"prediction": >0, "rationale"} is DQ'd, not raced with a junk 0-estimate; the
  // builder sees exactly why in the feed.
  const v = validateCompetitorResponse(hire.deliverable || '');
  if (!v.ok) throw new Error(`invalid response — return {"prediction": <usd number>, "rationale": <text>} (${v.reason})`);
  const { prediction, rationale } = v;

  const f: Forecast = {
    competitor: c.id,
    prediction,
    rationale,
    hiredServiceIds: [c.serviceId],
    reasonHash: reasonHash({ competitor: c.id, prediction, rationale, inputs: `remote:${c.serviceId}` }),
  };
  // A remote composes its data INTERNALLY (multi-hop, not in our manifest), so there is no "who it paid"
  // edge to show — emitting one rendered the confusing self-hire "X hired X". The arena→remote order is
  // real on-chain, but it's the race entry, not a data hire, so it doesn't belong in the agent's hires.
  return { forecast: f, edges: [], fails: [] as HireFail[] };
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

  // DQ CUTOFF, RELATIVE to the fastest agent = first-estimate + grace. Anyone finishing within `grace`
  // of the fastest is safe → healthy providers (which cluster together) are NEVER cut; only a real
  // outlier (>grace slower than its peers) is. Hard ceiling = backstop for total provider failure.
  const grace = Math.max(5, Number(process.env.ARENA_ESTIMATE_GRACE_SECONDS ?? '45')) * 1000;
  const hardCap = Math.max(grace + 60_000, Number(process.env.ARENA_ESTIMATE_HARDCAP_SECONDS ?? '300') * 1000);
  const hiringStart = Date.now();
  let firstAt = 0;
  let dqAtMs = hiringStart + hardCap; // backstop until the fastest agent lands

  console.log(`[arena] ${id} open — ETH/USD $${open.price.toFixed(2)} (Pyth ${open.publishTime}); recentVol ~$${recentVol.toFixed(2)}; agents estimating…`);
  hooks.onOpen?.({ id, openPrice: open.price, dqAtMs });

  // Each competitor estimates in parallel (local + remote); every hire is a real CAP order.
  const ctx: PlayCtx = { roundId: id, asset: 'ETH', spot: open.price, horizonSeconds: windowSeconds, recentVol };
  const done = new Map<string, { forecast: Forecast; edges: ArenaEdge[] }>();
  const playP = competitors.map((c) =>
    play(c, ctx, hooks)
      .then((r) => {
        if (!firstAt) {
          firstAt = Date.now();
          dqAtMs = Math.min(hiringStart + hardCap, firstAt + grace); // grace relative to the fastest
          hooks.onFirstEstimate?.({ dqFromMs: firstAt, dqAtMs });
        }
        done.set(c.id, r);
        for (const f of r.fails) hooks.onHireFail?.(f); // surface swallowed data-hire failures
        hooks.onEstimate?.({ forecast: r.forecast, edges: r.edges });
      })
      .catch((e) => {
        const reason = (e as Error).message;
        console.warn(`[arena] ${c.id} estimate failed: ${reason}`);
        hooks.onHireFail?.({ competitor: c.id, label: c.label, reason });
      }),
  );
  await new Promise<void>((resolve) => {
    let fin = false;
    const end = () => { if (!fin) { fin = true; clearInterval(iv); resolve(); } };
    const iv = setInterval(() => {
      if (done.size === competitors.length) return end();       // everyone in
      if (Date.now() >= dqAtMs && done.size >= 1) return end();  // cutoff reached + ≥1 racer
      if (Date.now() >= hiringStart + hardCap) return end();     // hard ceiling
    }, 500);
    void Promise.allSettled(playP).then(end);
  });
  const dqIds = competitors.filter((c) => !done.has(c.id)).map((c) => c.id);
  if (dqIds.length) console.log(`[arena] DQ this round (too slow): ${dqIds.join(', ')}`);
  const played = competitors.filter((c) => done.has(c.id)).map((c) => done.get(c.id)!);
  const forecasts = played.map((p) => p.forecast);
  const edges = played.flatMap((p) => p.edges);
  if (!forecasts.length) throw new Error('no agent delivered before the cutoff');
  const line = consensusLine(forecasts);
  for (const f of forecasts) {
    console.log(`[arena] ${f.competitor} estimates amplitude $${f.prediction.toFixed(2)} — "${f.rationale}"`);
  }
  // COMMIT window: betting OPENS now, but the outcome is NOT measured yet (the move starts only after
  // betting closes) → a last-second bet cannot cheat. This is the deadline the UI counts down to.
  // SINGLE window (sports-book style): the race runs AND betting stays OPEN throughout. A late bet is
  // not a cheat because the payout multiplier DECAYS over the window (applied at settle) → no extra
  // "closing" timer = fast + compulsive. Amplitude is measured from the round-open price.
  const settleAtMs = Date.now() + windowSeconds * 1000;
  hooks.onEstimates?.({ forecasts, line, edges, betCloseAtMs: settleAtMs, dqIds });

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
