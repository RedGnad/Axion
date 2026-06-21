import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AgentClient, EventType, DeliverableType, type Event } from '@croo-network/sdk';
import { loadCompetitors, runRound, createRemoteBuyer, makeRemoteCompetitor, type Competitor } from './loop.js';
import { PERSONALITIES } from './personalities.js';
import { fetchPythPrice } from './oracle.js';
import { loadState, saveState, storeEnabled } from './store.js';
import { discoverProviders } from './discovery.js';
import { houseEnabled, houseAddress, verifyBetTx, recordBet, poolFor, settleHouseBets, MAX_BET_USDC } from './housebet.js';

/**
 * The Arena live server: one long-running process that runs real on-chain rounds and serves the
 * live "race to the price" UI. Everything shown is driven by real state (Pyth + CAP orders) — no
 * cosmetic data. Rounds cost USDC, so they run on demand (POST /api/round) unless ARENA_AUTORUN=1.
 *
 *   GET /            → the UI
 *   GET /api/state   → current ArenaState snapshot (JSON)
 *   GET /api/stream  → Server-Sent Events: pushes ArenaState on every change
 *   POST /api/round  → run one real round (if competitors are configured)
 */
interface CompetitorView {
  id: string;
  label: string;
  blurb: string;
  estimate?: number;
  rationale?: string;
  error?: number;
  isWinner?: boolean;
  /** When this agent's estimate landed (its data hires finished) — drives the staggered launch. */
  launchAtMs?: number;
  /** Latency from round open to estimate ready (ms) — fast-data head-start + ⚡ + tie-break. */
  dataMs?: number;
  /** Disqualified this round (didn't deliver before the cutoff) — doesn't race or win. */
  dq?: boolean;
}
interface RoundView {
  id: string;
  // open = hiring · betting = COMMIT window (bets open, move not measured) · racing = reveal (bets CLOSED) · settled
  phase: 'open' | 'betting' | 'racing' | 'settled';
  openPrice: number;
  closePrice?: number;
  line?: number;
  amplitude?: number;
  /** Live realized amplitude from Pyth during the reveal window (the moving "current move"). */
  liveAmplitude?: number;
  /** When the race (reveal window) started — the client animates progress between this and settleAtMs. */
  raceStartMs?: number;
  settleAtMs?: number;
  /** When betting closes (= settle, single window). */
  betCloseAtMs?: number;
  /** DQ grace window: starts when the FIRST agent delivers (dqFromMs) and ends at the cutoff (dqAtMs).
   *  The red bar fills over [dqFromMs, dqAtMs]; stragglers not in by dqAtMs are cut. */
  dqFromMs?: number;
  dqAtMs?: number;
  /** Estimated settle time set at round OPEN (hiring is ~incompressible) so the UI shows a descending
   *  countdown from the very start; replaced by the exact settleAtMs once betting opens. */
  etaSettleMs?: number;
  /** Estimated time the RACE starts (hiring done / betting opens). The UI counts down to THIS during
   *  hiring (hiring only, no betting window) so the number is short + honest; no timer during the race. */
  etaRaceStartMs?: number;
  competitors: CompetitorView[];
}
interface HistoryEdge {
  competitor: string;
  label: string;
  serviceId?: string;
  ours: boolean;
  payTxHash: string;
  clearTxHash: string;
}
interface HistoryItem {
  id: string;
  openPrice: number;
  closePrice: number;
  amplitude: number;
  line: number;
  winners: string[];
  settledAt: string;
  /** Final standings + the on-chain A2A edges, so a fresh visit can replay a populated, verifiable round. */
  competitors: CompetitorView[];
  edges: HistoryEdge[];
}
interface FeedItem {
  ts: number;
  text: string;
  txUrl?: string;
}
interface ArenaState {
  status: 'idle' | 'running' | 'view-only';
  asset: string;
  /** Live ETH/USD from Pyth, streamed every ~2s so the screen is never static. */
  livePrice?: number;
  priceSeries: number[];
  /** When the next scheduled round is due (the heartbeat) → the UI shows a "next race in MM:SS". */
  nextRoundAtMs?: number;
  round?: RoundView;
  history: HistoryItem[];
  leaderboard: { id: string; label: string; wins: number; rounds: number; sumError: number; avgError: number }[];
  feed: FeedItem[];
  /** Free guest-prediction usage (proof of adoption): total calls, correct, unique visitors. */
  predictStats: { total: number; correct: number; visitors: number };
  /** Custodial-disclosed human USDC betting (off unless the house EOA is configured). */
  usdcBet?: { enabled: boolean; houseAddress: string; maxBetUSDC: number; multiplier: number; decayFloor: number; pool: { over: string; under: string; bettors: number } };
  /** Live CROO store data-market (discovery): pool size grows with the store; wired = hired last round. */
  dataMarket?: {
    discovered: number;
    maxPriceUSDC: number;
    censusAt: number;
    top: { name: string; orders7d: number; priceUSDC: number }[];
    wired: { label: string; serviceId: string; ours: boolean }[];
    /** Real third-party providers Axion has paid (cumulative hires) — the zero-work earn hook. */
    earners?: { label: string; serviceId: string; hires: number }[];
  };
}

// Long-running server: a stray WebSocket/async error must never take down the HTTP server.
// Log and keep serving (availability over strictness for a live demo endpoint).
process.on('uncaughtException', (e) => console.error('[arena-server] uncaughtException:', (e as Error)?.message ?? e));
process.on('unhandledRejection', (e) => console.error('[arena-server] unhandledRejection:', (e as Error)?.message ?? e));

const PORT = Number(process.env.PORT ?? '8787');
const HISTORY_FILE = process.env.ARENA_HISTORY_FILE ?? 'arena-history.json';
const WINDOW = Number(process.env.ARENA_WINDOW_SECONDS ?? '60');
let HIRING_ETA_MS = 90_000; // estimated hiring time; AUTO-CALIBRATED from each round's real open→betting duration
const AUTO_MS = Number(process.env.ARENA_AUTO_ROUND_MS ?? '0'); // scheduled heartbeat cadence (0 = off)
// Cost ceiling: minimum gap between rounds, so demand triggers can't spam-burn USDC (~0.6/round).
const MIN_ROUND_MS = Number(process.env.ARENA_MIN_ROUND_MS ?? (AUTO_MS ? Math.min(AUTO_MS, 600_000) : 600_000));
const BASESCAN = 'https://basescan.org/tx/';

const state: ArenaState = { status: 'idle', asset: 'ETH', priceSeries: [], history: [], leaderboard: [], feed: [], predictStats: { total: 0, correct: 0, visitors: 0 } };
const clients = new Set<import('node:http').ServerResponse>();
let competitors: Competitor[] = [];
let metaById = new Map<string, { label: string; blurb: string }>();
let running = false;
let lastRoundStartMs = 0;
let roundOpenMs = 0; // when the current round opened (for per-agent data latency + ETA calibration)
// Free guest predictions, kept server-side so the usage counter is real (not localStorage-only).
const predictVisitors = new Set<string>();                       // unique visitor ids seen this instance
const predictPending = new Map<string, { side: 'over' | 'under' }[]>(); // roundId → unresolved guesses
let remoteBuyer: Awaited<ReturnType<typeof createRemoteBuyer>> | null = null;

function personaMeta(id: string): { label: string; blurb: string } {
  return metaById.get(id) ?? { label: id, blurb: '' };
}

/** Recent real volatility: average |move| over WINDOW seconds across the live Pyth series (2s apart). */
function computeRecentVol(): number {
  const s = state.priceSeries;
  const lag = Math.max(1, Math.round(WINDOW / 2)); // points ~ WINDOW seconds apart
  if (s.length <= lag) return 0;
  let sum = 0, n = 0;
  for (let i = lag; i < s.length; i++) { sum += Math.abs(s[i] - s[i - lag]); n++; }
  return n ? sum / n : 0;
}

function pushFeed(text: string, txUrl?: string): void {
  state.feed.unshift({ ts: Date.now(), text, txUrl });
  state.feed = state.feed.slice(0, 40);
}

function broadcast(): void {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
}

function bumpLeaderboard(competitorIds: string[], winners: string[], errors: Record<string, number>): void {
  for (const id of competitorIds) {
    let row = state.leaderboard.find((r) => r.id === id);
    if (!row) {
      row = { id, label: personaMeta(id).label, wins: 0, rounds: 0, sumError: 0, avgError: 0 };
      state.leaderboard.push(row);
    }
    row.rounds += 1;
    if (winners.includes(id)) row.wins += 1;
    row.sumError = (row.sumError || 0) + Number(errors[id] ?? 0);
    row.avgError = row.sumError / row.rounds;
  }
  // Rank by ACCURACY (lowest average error) — rewards genuine calibration, not a constant bias.
  state.leaderboard.sort((a, b) => a.avgError - b.avgError || b.wins - a.wins);
}

const SEED_FILE = process.env.ARENA_SEED_FILE ?? 'arena-seed.json';

async function loadHistory(): Promise<void> {
  // Durable Upstash store first (survives restarts, free); else runtime file; else committed seed so
  // a FRESH deploy still shows a populated, verifiable world (real past rounds) — never a dead arena.
  type Persisted = { history?: HistoryItem[]; leaderboard?: ArenaState['leaderboard']; predictStats?: ArenaState['predictStats'] };
  const fromStore = await loadState<Persisted>();
  if (fromStore) {
    state.history = fromStore.history ?? [];
    state.leaderboard = fromStore.leaderboard ?? [];
    if (fromStore.predictStats) state.predictStats = fromStore.predictStats;
    console.log(`[arena-server] loaded durable state (Upstash): ${state.history.length} rounds`);
  } else {
    const file = existsSync(HISTORY_FILE) ? HISTORY_FILE : existsSync(SEED_FILE) ? SEED_FILE : null;
    if (file) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as Persisted;
        state.history = data.history ?? [];
        state.leaderboard = data.leaderboard ?? [];
        if (data.predictStats) state.predictStats = data.predictStats;
      } catch {
        /* ignore corrupt history */
      }
    }
  }
  // Replay the last settled round so the track + feed are populated on every visit (not "no rounds yet").
  const last = state.history[0];
  if (last) {
    state.round = {
      id: last.id,
      phase: 'settled',
      openPrice: last.openPrice,
      closePrice: last.closePrice,
      amplitude: last.amplitude,
      line: last.line,
      settleAtMs: Date.parse(last.settledAt) || Date.now(),
      competitors: last.competitors ?? [],
    };
    for (const e of (last.edges ?? []).slice().reverse()) {
      pushFeed(`${e.label} hired — round settled`, BASESCAN + e.payTxHash);
    }
    pushFeed(`Last round: amplitude $${last.amplitude.toFixed(2)} vs line $${last.line.toFixed(2)} — winner(s): ${last.winners.map((w) => personaMeta(w).label).join(', ')}`);
  }
}

function saveHistory(): void {
  const blob = { history: state.history, leaderboard: state.leaderboard, predictStats: state.predictStats };
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(blob, null, 2));
  } catch {
    /* best-effort persistence */
  }
  void saveState(blob); // durable (Upstash) — survives Render restarts
}

const BET_DECAY_FLOOR = Math.max(0.1, Math.min(1, Number(process.env.BET_DECAY_FLOOR ?? '0.25')));

/** Current odds-decay weight (1 at race start → BET_DECAY_FLOOR at settle). Bet early = bigger share. */
function betWeightNow(): number {
  const r = state.round;
  if (!r?.raceStartMs || !r.settleAtMs || r.settleAtMs <= r.raceStartMs) return 1;
  const frac = Math.min(1, Math.max(0, (Date.now() - r.raceStartMs) / (r.settleAtMs - r.raceStartMs)));
  return Math.round((1 - (1 - BET_DECAY_FLOOR) * frac) * 100) / 100;
}

/** Reflect the human-USDC-bet config + current round pool into state (for the UI). */
function refreshUsdcBet(): void {
  const p = poolFor(state.round?.id ?? '');
  state.usdcBet = {
    enabled: houseEnabled(),
    houseAddress: houseAddress(),
    maxBetUSDC: MAX_BET_USDC,
    multiplier: betWeightNow(),
    decayFloor: BET_DECAY_FLOOR,
    pool: { over: (Number(p.over) / 1e6).toFixed(2), under: (Number(p.under) / 1e6).toFixed(2), bettors: p.bettors },
  };
}

/** Refresh the live store data-market panel (free, read-only). `wired` = the providers actually
 *  hired in the most recent round (from its edges) so the demo shows real A2A, not just the catalog. */
async function refreshDataMarket(wired?: { label: string; serviceId: string; ours: boolean }[]): Promise<void> {
  try {
    const pool = await discoverProviders();
    // Cumulative third-party providers Axion has paid (real hires from settled history) — zero-work earn hook.
    const counts = new Map<string, { label: string; serviceId: string; hires: number }>();
    for (const h of state.history) {
      for (const e of h.edges ?? []) {
        if (e.ours) continue;
        const key = e.serviceId || e.label;
        const row = counts.get(key) ?? { label: e.label, serviceId: e.serviceId ?? '', hires: 0 };
        row.hires += 1;
        counts.set(key, row);
      }
    }
    const earners = [...counts.values()].sort((a, b) => b.hires - a.hires).slice(0, 8);
    state.dataMarket = {
      discovered: pool.length,
      maxPriceUSDC: Number(process.env.DISCOVERY_MAX_PRICE_USDC) || 0.10,
      censusAt: Date.now(),
      top: pool.slice(0, 6).map((p) => ({ name: p.name, orders7d: p.orders7d, priceUSDC: p.priceUSDC })),
      wired: wired ?? state.dataMarket?.wired ?? [],
      earners,
    };
    broadcast();
  } catch {
    /* discovery is best-effort; the curated roster still drives real hires */
  }
}

/** Keep Axion live & hireable from the SAME service (no extra Render instance, no USDC). WS connection
 *  = "online" in the store; accept/deliver via POLLING (CROO WS events are unreliable). On hire it
 *  delivers a real arena brief (no sub-hires). Needs CROO_SDK_KEY + AXION_SERVICE_ID in env. */
async function startAxionProvider(cfg: { baseURL: string; wsURL: string }): Promise<void> {
  const key = process.env.CROO_SDK_KEY;
  const serviceId = process.env.AXION_SERVICE_ID;
  if (!key || !serviceId) return;
  const client = new AgentClient({ baseURL: cfg.baseURL, wsURL: cfg.wsURL }, key);
  try { await client.connectWebSocket(); } catch { /* WS just keeps "online" status */ }
  console.log(`[axion] provider online (arena brief) on service ${serviceId}`);
  const brief = (): string => {
    const last = state.history[0];
    return `Axion Arena live brief — ETH/USD $${(state.livePrice ?? 0).toFixed(2)}.` +
      (last ? ` Last round: realized move $${last.amplitude.toFixed(2)} vs line $${last.line.toFixed(2)}, winner ${last.winners.join(', ')}.` : '') +
      ` Top agent: ${state.leaderboard[0]?.label ?? 'n/a'}. Live: https://axion-arena.onrender.com`;
  };
  const tick = async (): Promise<void> => {
    try {
      const negs = await client.listNegotiations({ role: 'provider', status: 'pending', page: 1, pageSize: 20 });
      for (const n of negs) if (n.serviceId === serviceId) { try { await client.acceptNegotiation(n.negotiationId); console.log(`[axion] accepted hire ${n.negotiationId}`); } catch { /* retry next tick */ } }
      const orders = await client.listOrders({ role: 'provider', status: 'paid', page: 1, pageSize: 20 });
      for (const o of orders) if (o.serviceId === serviceId) { try { await client.deliverOrder(o.orderId, { deliverableType: DeliverableType.Text, deliverableText: brief() }); console.log(`[axion] delivered brief ${o.orderId}`); } catch { /* retry next tick */ } }
    } catch { /* transient */ }
  };
  setInterval(() => void tick(), 6000);
}

/** Trigger a round respecting the cost ceiling (cooldown) + the running guard. Returns why/when. */
function tryRunRound(cfg: { baseURL: string; wsURL: string; rpcURL?: string }, reason: string): { started: boolean; nextAtMs?: number } {
  if (running) return { started: false, nextAtMs: state.nextRoundAtMs };
  const since = Date.now() - lastRoundStartMs;
  if (lastRoundStartMs && since < MIN_ROUND_MS) return { started: false, nextAtMs: lastRoundStartMs + MIN_ROUND_MS };
  console.log(`[arena-server] round trigger: ${reason}`);
  void runOneRound(cfg);
  return { started: true };
}

async function runOneRound(cfg: { baseURL: string; wsURL: string; rpcURL?: string }): Promise<void> {
  if (running || competitors.length === 0) return;
  running = true;
  lastRoundStartMs = Date.now();
  if (AUTO_MS) state.nextRoundAtMs = lastRoundStartMs + AUTO_MS; // next heartbeat after this round
  state.status = 'running';
  try {
    await runRound(competitors, cfg, WINDOW, {
      onOpen: ({ id, openPrice }) => {
        roundOpenMs = Date.now();
        state.round = {
          id,
          phase: 'open',
          openPrice,
          // Hiring N data-agents is ~incompressible → estimate when the RACE starts (hiring done),
          // calibrated from past rounds, so the UI counts down to the START (no betting window in it).
          etaRaceStartMs: roundOpenMs + HIRING_ETA_MS,
          etaSettleMs: roundOpenMs + HIRING_ETA_MS + WINDOW * 1000,
          competitors: competitors.map((c) => ({ id: c.id, ...personaMeta(c.id) })),
        };
        pushFeed(`Round open — ETH/USD $${openPrice.toFixed(2)}; agents hiring data & estimating…`);
        broadcast();
      },
      onEstimate: ({ forecast, edges }) => {
        if (!state.round) return;
        const c = state.round.competitors.find((x) => x.id === forecast.competitor);
        if (c) {
          c.estimate = forecast.prediction;
          c.rationale = forecast.rationale;
          // This agent's data is in → it launches NOW; record its latency (fast = head-start + ⚡).
          c.launchAtMs = Date.now();
          c.dataMs = roundOpenMs ? Date.now() - roundOpenMs : undefined;
        }
        for (const e of edges) {
          pushFeed(`${personaMeta(e.competitor).label} hired ${e.label} [${e.ours ? 'ours' : '3rd-party'}]`, BASESCAN + e.payTxHash);
        }
        pushFeed(`${personaMeta(forecast.competitor).label} estimates $${forecast.prediction.toFixed(2)}`);
        broadcast();
      },
      onFirstEstimate: ({ dqAtMs }) => {
        // The DQ grace clock starts now (first agent in) — the red bar fills over [dqFromMs, dqAtMs].
        if (state.round) { state.round.dqFromMs = Date.now(); state.round.dqAtMs = dqAtMs; broadcast(); }
      },
      onEstimates: ({ line, betCloseAtMs, dqIds }) => {
        if (!state.round) return;
        // Auto-calibrate the hiring ETA from this round's real open→race duration (EMA) so the
        // next round's countdown is honest and doesn't sit on "any moment…".
        if (roundOpenMs) {
          const hiringMs = Date.now() - roundOpenMs;
          HIRING_ETA_MS = Math.max(45_000, Math.min(150_000, Math.round(HIRING_ETA_MS * 0.5 + hiringMs * 0.5)));
        }
        // SINGLE window: the race is on AND betting is OPEN throughout (odds decay over time → no cheat).
        state.round.phase = 'betting';
        state.round.line = line;
        state.round.settleAtMs = betCloseAtMs; // race + betting both end here
        state.round.betCloseAtMs = betCloseAtMs;
        state.round.raceStartMs = Date.now();
        state.round.liveAmplitude = 0;
        // Mark disqualified (too-slow) competitors so the UI shows them out (they don't race/win).
        for (const c of state.round.competitors) if (dqIds.includes(c.id)) c.dq = true;
        refreshUsdcBet(); // new round → fresh (empty) USDC pool
        const dqNote = dqIds.length ? ` · ${dqIds.length} agent(s) cut (too slow)` : '';
        pushFeed(`They're off! Betting open at line $${line.toFixed(2)} — odds drop as the move reveals${dqNote}`);
        broadcast();
      },
      onTick: ({ liveAmplitude }) => {
        if (!state.round) return;
        state.round.liveAmplitude = liveAmplitude;
        broadcast();
      },
      onSettled: ({ round, line, edges }) => {
        const o = round.outcome!;
        // Accuracy decides the win; SPEED only breaks exact ties — among co-winners, the agent whose
        // data landed first takes it (legitimate edge for choosing fast data-providers).
        let winners = o.winners;
        if (winners.length > 1) {
          const dataMsById = new Map((state.round?.competitors ?? []).map((c) => [c.id, c.dataMs ?? Infinity]));
          winners = [[...winners].sort((a, b) => (dataMsById.get(a) ?? Infinity) - (dataMsById.get(b) ?? Infinity))[0]];
        }
        if (state.round) {
          state.round.phase = 'settled';
          state.round.closePrice = round.closePrice;
          state.round.amplitude = o.actual;
          state.round.competitors = state.round.competitors.map((c) => ({
            ...c,
            error: o.errors[c.id],
            isWinner: winners.includes(c.id),
          }));
        }
        const item: HistoryItem = {
          id: round.id,
          openPrice: round.openPrice,
          closePrice: round.closePrice ?? round.openPrice,
          amplitude: o.actual,
          line,
          winners,
          settledAt: o.settledAt,
          competitors: round.forecasts.map((f) => ({
            id: f.competitor,
            ...personaMeta(f.competitor),
            estimate: f.prediction,
            rationale: f.rationale,
            error: o.errors[f.competitor],
            isWinner: winners.includes(f.competitor),
          })),
          edges: edges.map((e) => ({ competitor: e.competitor, label: e.label, serviceId: e.serviceId, ours: e.ours, payTxHash: e.payTxHash, clearTxHash: e.clearTxHash })),
        };
        state.history.unshift(item);
        state.history = state.history.slice(0, 50);
        bumpLeaderboard(round.forecasts.map((f) => f.competitor), winners, o.errors);
        const side = o.actual > line ? 'over' : o.actual < line ? 'under' : 'push';
        // Resolve free guest predictions for this round (push = void, doesn't count against accuracy).
        const guesses = predictPending.get(round.id);
        if (guesses && side !== 'push') {
          for (const g of guesses) if (g.side === side) state.predictStats.correct++;
        }
        predictPending.delete(round.id);
        // Settle human USDC bets (custodial house EOA pays winners; no-op unless configured).
        void (async () => {
          const res = await settleHouseBets(round.id, side).catch(() => null);
          if (res && res.paid > 0) pushFeed(`USDC bets settled — paid ${res.total} USDC to ${res.paid} winner(s)`);
          refreshUsdcBet();
        })();
        pushFeed(`Settled — amplitude $${o.actual.toFixed(2)} vs line $${line.toFixed(2)} → ${side}. Winner: ${winners.map((w) => personaMeta(w).label).join(', ')}`);
        saveHistory();
        // Reflect the providers actually wired this round into the live data-market panel.
        void refreshDataMarket(item.edges.map((e) => ({ label: e.label, serviceId: e.serviceId ?? '', ours: e.ours })));
        broadcast();
      },
    }, { recentVol: computeRecentVol() });
  } catch (err) {
    pushFeed(`Round error: ${(err as Error).message}`);
    broadcast();
  } finally {
    running = false;
    state.status = competitors.length ? 'idle' : 'view-only';
    // Never leave an orphaned non-settled round on screen (it would look like a frozen race when idle).
    if (state.round && state.round.phase !== 'settled') showLastSettledRound();
    broadcast();
  }
}

/** Set state.round to the last SETTLED round (the "between races" view), or clear it if none. */
function showLastSettledRound(): void {
  const last = state.history[0];
  if (!last) { state.round = undefined; return; }
  state.round = {
    id: last.id,
    phase: 'settled',
    openPrice: last.openPrice,
    closePrice: last.closePrice,
    amplitude: last.amplitude,
    line: last.line,
    settleAtMs: Date.parse(last.settledAt) || Date.now(),
    competitors: last.competitors ?? [],
  };
}

async function main(): Promise<void> {
  await loadHistory();
  console.log(`[arena-server] durable store: ${storeEnabled() ? 'Upstash (on)' : 'off (seed/file fallback)'}`);

  // Live store data-market: census at boot (seed `wired` from the last replayed round) + every 10min.
  const lastEdges = (state.history[0]?.edges ?? []).map((e) => ({ label: e.label, serviceId: e.serviceId ?? '', ours: e.ours }));
  void refreshDataMarket(lastEdges.length ? lastEdges : undefined);
  setInterval(() => void refreshDataMarket(), 10 * 60_000);
  refreshUsdcBet();
  if (houseEnabled()) console.log(`[arena-server] human USDC betting ON (house ${houseAddress()}, max ${MAX_BET_USDC} USDC/bet)`);

  const cfg = {
    baseURL: process.env.CROO_API_URL ?? '',
    wsURL: process.env.CROO_WS_URL ?? '',
    rpcURL: process.env.BASE_RPC_URL,
  };

  // Always-on live ETH price stream (real Pyth, every 2s) → the screen is never static.
  setInterval(() => {
    void (async () => {
      try {
        const p = await fetchPythPrice();
        state.livePrice = p.price;
        state.priceSeries.push(Number(p.price.toFixed(2)));
        if (state.priceSeries.length > 90) state.priceSeries.shift();
        broadcast();
      } catch {
        /* transient Hermes hiccup */
      }
    })();
  }, 2000);

  // Keep Axion live & hireable from this same service (free; only runs if its env keys are set).
  void startAxionProvider(cfg);

  // Try to wire live competitors; if none are configured, serve in view-only mode (history + UI).
  try {
    competitors = await loadCompetitors(cfg);
    metaById = new Map(competitors.map((c) => [c.id, c.kind === 'local' ? { label: c.persona.label, blurb: c.persona.blurb } : { label: c.label, blurb: 'open third-party competitor' }]));
    state.status = 'idle';
    console.log(`[arena-server] ${competitors.length} competitors live: ${competitors.map((c) => c.id).join(', ')}`);
  } catch (err) {
    metaById = new Map(PERSONALITIES.map((p) => [p.id, { label: p.label, blurb: p.blurb }]));
    state.status = 'view-only';
    console.warn(`[arena-server] view-only (no competitors configured): ${(err as Error).message}`);
  }

  // The runner is API-only now: ONE interface = the Vercel front. Redirect / there (no 2nd site).
  const FRONTEND_URL = process.env.FRONTEND_URL ?? 'https://axion-fawn.vercel.app';

  createServer((req, res) => {
    const url = req.url ?? '/';
    // CORS so the Vercel frontend can call this runner cross-origin (state/round/competitor).
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }
    if (req.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
      res.writeHead(302, { Location: FRONTEND_URL });
      res.end();
      return;
    }
    if (req.method === 'GET' && url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(state));
      return;
    }
    if (req.method === 'GET' && url === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no', // tell proxies (Render/Cloudflare) not to buffer the stream
      });
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 20_000); // heartbeat keeps the stream flushing
      req.on('close', () => { clearInterval(hb); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && url === '/api/round') {
      // Demand trigger (a user predicts/bets) — cooldown-gated so it can't spam-burn USDC.
      const t = tryRunRound(cfg, 'demand');
      res.writeHead(t.started ? 202 : 409, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(t));
      return;
    }
    if (req.method === 'POST' && url === '/api/competitor') {
      const reply = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (process.env.ALLOW_AGENT_SUBMIT !== '1') return reply(403, { error: 'agent submission disabled (set ALLOW_AGENT_SUBMIT=1)' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
      req.on('end', () => {
        void (async () => {
          try {
            const { serviceId, label } = JSON.parse(body || '{}') as { serviceId?: string; label?: string };
            if (!serviceId || !/^[0-9a-f-]{36}$/i.test(serviceId)) return reply(400, { error: 'valid serviceId (uuid) required' });
            if (competitors.some((c) => c.kind === 'remote' && c.serviceId === serviceId)) return reply(409, { error: 'agent already in the arena' });
            if (!remoteBuyer) remoteBuyer = await createRemoteBuyer(cfg);
            let name = (label || `agent-${serviceId.slice(0, 4)}`).replace(/[^\w -]/g, '').slice(0, 24) || `agent-${serviceId.slice(0, 4)}`;
            while (metaById.has(name)) name += '*';
            competitors.push(makeRemoteCompetitor(remoteBuyer, serviceId, name));
            metaById.set(name, { label: name, blurb: 'community agent' });
            if (state.status === 'view-only') state.status = 'idle';
            pushFeed(`New competitor joined the arena: ${name}`);
            broadcast();
            const wr = tryRunRound(cfg, `welcome:${name}`); // demand trigger: a new agent → a welcome round
            reply(202, { ok: true, name, welcomeRound: wr.started, nextAtMs: wr.nextAtMs });
          } catch (e) {
            reply(400, { error: (e as Error).message });
          }
        })();
      });
      return;
    }
    if (req.method === 'POST' && url === '/api/predict') {
      // Free, no-wallet guest prediction. Counts toward the public usage tally; resolved at settle.
      const reply = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        try {
          const { roundId, side, visitorId } = JSON.parse(body || '{}') as { roundId?: string; side?: string; visitorId?: string };
          if (side !== 'over' && side !== 'under') return reply(400, { error: 'side must be over|under' });
          if (!visitorId || typeof visitorId !== 'string' || visitorId.length > 64) return reply(400, { error: 'visitorId required' });
          if (!roundId || roundId !== state.round?.id || state.round?.phase !== 'betting') return reply(409, { error: 'betting is closed for this round' });
          const arr = predictPending.get(roundId) ?? [];
          arr.push({ side });
          predictPending.set(roundId, arr);
          if (!predictVisitors.has(visitorId)) { predictVisitors.add(visitorId); state.predictStats.visitors++; }
          state.predictStats.total++;
          saveHistory(); // persist the tally (history blob carries predictStats)
          broadcast();
          reply(202, { ok: true, predictStats: state.predictStats });
        } catch (e) {
          reply(400, { error: (e as Error).message });
        }
      });
      return;
    }
    if (req.method === 'POST' && url === '/api/bet') {
      // Custodial-disclosed human USDC bet. The tx is VERIFIED on-chain before it counts (no fake bets).
      const reply = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (!houseEnabled()) return reply(403, { error: 'USDC betting disabled (house EOA not configured)' });
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
      req.on('end', () => {
        void (async () => {
          try {
            const { roundId, side, amountUSDC, eoa, txHash } = JSON.parse(body || '{}') as
              { roundId?: string; side?: string; amountUSDC?: number; eoa?: string; txHash?: string };
            if (side !== 'over' && side !== 'under') return reply(400, { error: 'side must be over|under' });
            if (!eoa || !/^0x[0-9a-fA-F]{40}$/.test(eoa)) return reply(400, { error: 'valid eoa required' });
            if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return reply(400, { error: 'valid txHash required' });
            const amt = Number(amountUSDC);
            if (!(amt > 0) || amt > MAX_BET_USDC) return reply(400, { error: `amount must be 0 < x ≤ ${MAX_BET_USDC} USDC` });
            if (!roundId || roundId !== state.round?.id || state.round?.phase !== 'betting') return reply(409, { error: 'no live betting round' });
            const amount = BigInt(Math.round(amt * 1e6));
            const ok = await verifyBetTx(txHash, eoa, amount).catch(() => false);
            if (!ok) return reply(400, { error: 'bet tx not verified on-chain (USDC transfer to house not found)' });
            const weight = betWeightNow(); // odds decay: earlier = bigger share of the pool
            recordBet({ roundId, side, amount, eoa, txHash, weight });
            refreshUsdcBet();
            pushFeed(`USDC bet: ${amt} on ${side} ×${weight.toFixed(2)} (${eoa.slice(0, 6)}…)`, BASESCAN + txHash);
            broadcast();
            reply(202, { ok: true, pool: state.usdcBet?.pool });
          } catch (e) {
            reply(400, { error: (e as Error).message });
          }
        })();
      });
      return;
    }
    res.writeHead(404);
    res.end('not found');
  }).listen(PORT, () => console.log(`[arena-server] http://localhost:${PORT}  (status: ${state.status})`));

  if (process.env.ARENA_AUTORUN === '1') void runOneRound(cfg);

  // Heartbeat: a scheduled round every AUTO_MS gives a predictable "next race in MM:SS" countdown
  // (UI shows nextRoundAtMs). Cost is bounded by the cadence + the cooldown; demand (predict/bet,
  // new agent) can advance it via tryRunRound. Off unless ARENA_AUTO_ROUND_MS is set.
  if (AUTO_MS >= 60_000 && competitors.length) {
    state.nextRoundAtMs = Date.now() + AUTO_MS;
    console.log(`[arena-server] heartbeat: a round every ${Math.round(AUTO_MS / 60000)}min (cooldown ${Math.round(MIN_ROUND_MS / 60000)}min)`);
    setInterval(() => tryRunRound(cfg, 'heartbeat'), AUTO_MS);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
