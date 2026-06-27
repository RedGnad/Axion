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
  /** DQ grace window = [dqFromMs (fastest agent landed) → dqAtMs (cutoff)]. Red bar fills over it. */
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
  latencyMs?: number; // hire latency → provider-speed leaderboard
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
  /** The agents that will race next — so visitors can free-predict the NEXT race during the idle gap
   *  (at a low cadence the arena is idle most of the time; this is the main engagement lever). */
  roster?: { id: string; label: string }[];
  /** Free guest-prediction usage (proof of adoption): total calls, correct, unique visitors. */
  predictStats: { total: number; correct: number; visitors: number };
  /** Custodial-disclosed human USDC betting (off unless the house EOA is configured). */
  usdcBet?: { enabled: boolean; houseAddress: string; maxBetUSDC: number; multiplier: number; pool: { byAgent: { id: string; amount: string }[]; total: string; bettors: number } };
  /** Bounded daily cold-start subsidy: free races we'll fund today (resets UTC midnight). */
  budget?: { used: number; cap: number; resetsAt: number };
  /** Health banner: surfaced (never silent) when data hires fail — e.g. the arena AA wallet is out of
   *  USDC so agents couldn't buy data and forecast on baseline only. Cleared once a round buys data. */
  notice?: { level: 'warn'; text: string };
  /** Live CROO store data-market (discovery): pool size grows with the store; wired = hired last round. */
  dataMarket?: {
    discovered: number;
    maxPriceUSDC: number;
    censusAt: number;
    top: { name: string; orders7d: number; priceUSDC: number }[];
    wired: { label: string; serviceId: string; ours: boolean }[];
    /** Structured per-provider stats from real hires: count, avg latency (ms), USDC paid. */
    providerStats?: { label: string; serviceId: string; hires: number; avgMs: number | null; paidUSDC: number }[];
    /** "The store evolves" timeline — REAL deltas only: a provider newly appearing in the public CROO
     *  catalog ('joined'), or an agent hiring a provider for the first time ('adopted'). No causation
     *  claimed, no fabricated entries; backfilled from real history at boot so the view is never empty. */
    events?: { ts: number; kind: 'joined' | 'adopted'; text: string }[];
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
// Cold-start subsidy is BOUNDED: at most N free races/day from our treasury (each ~0.6 USDC of data
// hires). Beyond it, "start" is paused till tomorrow (UTC) — a bot/spam can never drain us.
const DAILY_RACES = Math.max(1, Number(process.env.ARENA_DAILY_RACES ?? '12'));
const BASESCAN = 'https://basescan.org/tx/';

const state: ArenaState = { status: 'idle', asset: 'ETH', priceSeries: [], history: [], leaderboard: [], feed: [], predictStats: { total: 0, correct: 0, visitors: 0 } };
const clients = new Set<import('node:http').ServerResponse>();
let competitors: Competitor[] = [];
let metaById = new Map<string, { label: string; blurb: string }>();
// Community agents that joined via /api/competitor — PERSISTED (Upstash) so the open roster survives
// restarts/redeploys; re-instantiated as remote competitors at boot.
let joinedRoster: { serviceId: string; label: string }[] = [];
let running = false;
let lastRoundStartMs = 0;
let roundOpenMs = 0; // when the current round opened (for per-agent data latency + ETA calibration)
let racesToday = 0;  // bounded daily subsidy counter (resets at UTC midnight)
let racesDayKey = '';
// Free guest predictions, kept server-side so the usage counter is real (not localStorage-only).
const predictVisitors = new Set<string>();                       // unique visitor ids seen this instance
const predictPending = new Map<string, { agentId: string; visitorId: string }[]>(); // roundId → unresolved guesses
// Free predictions placed during the IDLE gap, for the NEXT race. Migrated into the round at open.
// Deduped by visitorId so one visitor = one prediction per race (honest stats, no inflation).
let nextPredictPending: { agentId: string; visitorId: string }[] = [];
let remoteBuyer: Awaited<ReturnType<typeof createRemoteBuyer>> | null = null;

// "The store evolves" tracking (§ data-market). Persisted so a restart never re-emits the whole
// catalog as "new". knownProviderIds = serviceIds seen in past censuses; seenPairs = (agent|provider)
// hires we've already counted; storeEvents = the readable evolution timeline (real deltas only).
const knownProviderIds = new Set<string>();
const seenPairs = new Set<string>();
let storeEvents: { ts: number; kind: 'joined' | 'adopted'; text: string }[] = [];

function personaMeta(id: string): { label: string; blurb: string } {
  return metaById.get(id) ?? { label: id, blurb: '' };
}

/** Publish the upcoming racers so the UI can let visitors free-predict the NEXT race while idle. */
function refreshRoster(): void {
  state.roster = competitors.map((c) => ({ id: c.id, label: personaMeta(c.id).label }));
}

/** Append a real store-evolution event (newest first, capped). No causation, no fabrication. */
function pushStoreEvent(kind: 'joined' | 'adopted', text: string, ts = Date.now()): void {
  storeEvents.unshift({ ts, kind, text });
  storeEvents = storeEvents.slice(0, 14);
  if (state.dataMarket) state.dataMarket.events = storeEvents;
}

/** Record first-time (agent → provider) hires from a settled round as 'adopted' events (third
 *  parties only — adopting our own seed agents isn't ecosystem motion). Honest: only genuinely
 *  new pairs emit; the pair set is persisted + baseline-seeded so nothing double-counts. */
function detectAdoptions(edges: { competitor: string; label: string; ours: boolean }[], ts: number, emit: boolean): void {
  for (const e of edges) {
    if (e.ours) continue;
    const pair = `${e.competitor}|${e.label}`;
    if (seenPairs.has(pair)) continue;
    seenPairs.add(pair);
    if (emit) pushStoreEvent('adopted', `${personaMeta(e.competitor).label} hired ${e.label} for the first time`, ts);
  }
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

let lastHireFailReason = ''; // most recent data-hire failure (human-ish), for the health banner
/** Turn a raw hire error into a short, honest human cause for the feed + banner. */
function humanizeHireFail(reason: string): string {
  const r = reason.toLowerCase();
  if (/insufficient|balance|funds/.test(r)) return 'arena wallet out of USDC';
  if (/timed out|timeout/.test(r)) return 'provider too slow (timeout)';
  if (/create_failed|rejected|reject/.test(r)) return 'provider rejected the order';
  return reason.slice(0, 80);
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
  type Persisted = {
    history?: HistoryItem[]; leaderboard?: ArenaState['leaderboard']; predictStats?: ArenaState['predictStats'];
    knownProviderIds?: string[]; seenPairs?: string[]; storeEvents?: typeof storeEvents;
    joinedRoster?: { serviceId: string; label: string }[];
  };
  const restoreMeta = (d: Persisted): void => {
    for (const id of d.knownProviderIds ?? []) knownProviderIds.add(id);
    for (const p of d.seenPairs ?? []) seenPairs.add(p);
    if (d.storeEvents?.length) storeEvents = d.storeEvents.slice(0, 14);
    if (d.joinedRoster?.length) joinedRoster = d.joinedRoster.slice(0, 50);
  };
  const fromStore = await loadState<Persisted>();
  if (fromStore) {
    state.history = fromStore.history ?? [];
    state.leaderboard = fromStore.leaderboard ?? [];
    if (fromStore.predictStats) state.predictStats = fromStore.predictStats;
    restoreMeta(fromStore);
    console.log(`[arena-server] loaded durable state (Upstash): ${state.history.length} rounds`);
  } else {
    const file = existsSync(HISTORY_FILE) ? HISTORY_FILE : existsSync(SEED_FILE) ? SEED_FILE : null;
    if (file) {
      try {
        const data = JSON.parse(readFileSync(file, 'utf8')) as Persisted;
        state.history = data.history ?? [];
        state.leaderboard = data.leaderboard ?? [];
        if (data.predictStats) state.predictStats = data.predictStats;
        restoreMeta(data);
      } catch {
        /* ignore corrupt history */
      }
    }
  }
  // First ever run (no persisted timeline): backfill the evolution view from REAL history — the
  // chronological first hire of each third-party provider by each agent. Oldest→newest so the
  // newest adoptions sort to the top. Not fabricated: every entry is a real settled on-chain hire.
  if (!storeEvents.length && seenPairs.size === 0) {
    for (const h of [...state.history].sort((a, b) => Date.parse(a.settledAt) - Date.parse(b.settledAt))) {
      detectAdoptions((h.edges ?? []).map((e) => ({ competitor: e.competitor, label: e.label, ours: e.ours })), Date.parse(h.settledAt) || Date.now(), true);
    }
  } else {
    // Ensure every historical pair is marked seen (so we never re-emit an old adoption as "new").
    for (const h of state.history) detectAdoptions((h.edges ?? []).map((e) => ({ competitor: e.competitor, label: e.label, ours: e.ours })), 0, false);
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
  const blob = {
    history: state.history, leaderboard: state.leaderboard, predictStats: state.predictStats,
    knownProviderIds: [...knownProviderIds], seenPairs: [...seenPairs], storeEvents,
    joinedRoster,
  };
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(blob, null, 2));
  } catch {
    /* best-effort persistence */
  }
  void saveState(blob); // durable (Upstash) — survives Render restarts
}

/** DISPLAY odds multiplier (×N), decaying with INFORMATION — reward strictly drops as you learn more,
 *  so betting is fair + non-farmable: blind during hiring = ×4, line set (race start) = ×2, → ×1 at settle. */
function displayMultNow(): number {
  const r = state.round;
  if (!r) return 4;
  if (r.phase === 'open') return 4; // blind (no line, no move) = max reward
  if (r.phase === 'betting' && r.raceStartMs && r.settleAtMs && r.settleAtMs > r.raceStartMs) {
    const frac = Math.min(1, Math.max(0, (Date.now() - r.raceStartMs) / (r.settleAtMs - r.raceStartMs)));
    return Math.round((2 - 1 * frac) * 100) / 100; // 2.0 at race start → 1.0 at settle
  }
  return 1;
}
/** Internal pari-mutuel share weight = displayMult / 4 (so ×4→1.0 … ×1→0.25). */
function betWeightNow(): number {
  return displayMultNow() / 4;
}

/** Reflect the human-USDC-bet config + current round pool into state (for the UI). */
function refreshUsdcBet(): void {
  const p = poolFor(state.round?.id ?? '');
  let total = 0n;
  const byAgent = Object.entries(p.byAgent).map(([id, amount]) => { total += amount; return { id, amount: (Number(amount) / 1e6).toFixed(2) }; });
  state.usdcBet = {
    enabled: houseEnabled(),
    houseAddress: houseAddress(),
    maxBetUSDC: MAX_BET_USDC,
    multiplier: displayMultNow(),
    pool: { byAgent, total: (Number(total) / 1e6).toFixed(2), bettors: p.bettors },
  };
}

/** Refresh the live store data-market panel (free, read-only). `wired` = the providers actually
 *  hired in the most recent round (from its edges) so the demo shows real A2A, not just the catalog. */
async function refreshDataMarket(wired?: { label: string; serviceId: string; ours: boolean }[]): Promise<void> {
  try {
    const pool = await discoverProviders();
    // "Joined the store" deltas — REAL: a serviceId now in the public CROO catalog that wasn't before.
    // First census ever seeds the baseline SILENTLY (no 32-event spam); after that, only true newcomers
    // emit. The known set is persisted so a restart never re-floods the timeline.
    let newJoins = 0;
    if (knownProviderIds.size === 0) {
      for (const p of pool) knownProviderIds.add(p.serviceId);
    } else {
      for (const p of pool) {
        if (knownProviderIds.has(p.serviceId)) continue;
        knownProviderIds.add(p.serviceId);
        if (newJoins < 6) pushStoreEvent('joined', `${p.name || 'New data agent'} listed in the CROO store (${p.orders7d} orders in 7d)`);
        newJoins++;
      }
    }
    // Per-provider stats from real settled history (third parties only): hires, avg latency, USDC paid.
    // ONE structured table the UI can rank by any column — the ecosystem-quality signal.
    const PRICE = Number(process.env.DISCOVERY_MAX_PRICE_USDC) || 0.10; // per-hire order price (USDC)
    const stats = new Map<string, { label: string; serviceId: string; hires: number; latSum: number; latN: number }>();
    for (const h of state.history) {
      for (const e of h.edges ?? []) {
        if (e.ours) continue;
        const key = e.label; // dedupe by label (older seed edges have no serviceId → would double-count)
        const row = stats.get(key) ?? { label: e.label, serviceId: e.serviceId ?? '', hires: 0, latSum: 0, latN: 0 };
        row.hires += 1;
        if (!row.serviceId && e.serviceId) row.serviceId = e.serviceId;
        if (typeof e.latencyMs === 'number') { row.latSum += e.latencyMs; row.latN += 1; }
        stats.set(key, row);
      }
    }
    const providerStats = [...stats.values()]
      .map((r) => ({ label: r.label, serviceId: r.serviceId, hires: r.hires, avgMs: r.latN ? Math.round(r.latSum / r.latN) : null, paidUSDC: Math.round(r.hires * PRICE * 100) / 100 }))
      .sort((a, b) => b.hires - a.hires)
      .slice(0, 8);
    state.dataMarket = {
      discovered: pool.length,
      maxPriceUSDC: Number(process.env.DISCOVERY_MAX_PRICE_USDC) || 0.10,
      censusAt: Date.now(),
      top: pool.slice(0, 6).map((p) => ({ name: p.name, orders7d: p.orders7d, priceUSDC: p.priceUSDC })),
      wired: wired ?? state.dataMarket?.wired ?? [],
      providerStats,
      events: storeEvents,
    };
    if (newJoins > 0) saveHistory(); // persist the grown known-set + new timeline entries
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

function nextUtcMidnightMs(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}
/** Reflect the bounded daily subsidy into state (for the UI), rolling over at UTC midnight. */
function refreshBudget(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== racesDayKey) { racesDayKey = today; racesToday = 0; }
  state.budget = { used: racesToday, cap: DAILY_RACES, resetsAt: nextUtcMidnightMs() };
}

/** Trigger a round respecting the cost ceiling (cooldown) + running guard + bounded daily subsidy. */
function tryRunRound(cfg: { baseURL: string; wsURL: string; rpcURL?: string }, reason: string): { started: boolean; nextAtMs?: number; reason?: string } {
  if (running) return { started: false, reason: 'a race is already running', nextAtMs: state.nextRoundAtMs };
  const since = Date.now() - lastRoundStartMs;
  if (lastRoundStartMs && since < MIN_ROUND_MS) return { started: false, reason: 'cooldown', nextAtMs: lastRoundStartMs + MIN_ROUND_MS };
  refreshBudget();
  if (racesToday >= DAILY_RACES) return { started: false, reason: `today's free races are used up (${DAILY_RACES}/day) — back at UTC midnight`, nextAtMs: nextUtcMidnightMs() };
  racesToday++;
  refreshBudget();
  console.log(`[arena-server] round trigger: ${reason} (${racesToday}/${DAILY_RACES} today)`);
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
      onOpen: ({ id, openPrice, dqAtMs }) => {
        roundOpenMs = Date.now();
        state.round = {
          id,
          phase: 'open',
          openPrice,
          // Calibrated expected race start (descending countdown target), and the DQ cutoff = that + grace
          // (known upfront, computed in loop) → the red grace bar fills over [etaRaceStartMs, dqAtMs].
          etaRaceStartMs: roundOpenMs + HIRING_ETA_MS,
          etaSettleMs: roundOpenMs + HIRING_ETA_MS + WINDOW * 1000,
          dqAtMs,
          competitors: competitors.map((c) => ({ id: c.id, ...personaMeta(c.id) })),
        };
        lastHireFailReason = ''; // fresh round; failures (if any) will re-arm the banner
        // Carry over predictions placed during the idle gap (on the now-racing roster), deduped.
        if (nextPredictPending.length) {
          const racing = new Set(competitors.map((c) => c.id));
          const carried = nextPredictPending.filter((g) => racing.has(g.agentId)); // drop picks on agents not racing
          predictPending.set(id, carried);
          nextPredictPending = [];
        }
        refreshUsdcBet(); // betting opens NOW (early, highest odds) → fresh pool from the hiring phase
        pushFeed(`Round open — ETH/USD $${openPrice.toFixed(2)}; agents hiring · early bets open at top odds`);
        broadcast();
      },
      onHireFail: ({ competitor, label, reason }) => {
        // NEVER silent: surface the real cause in the feed + a health banner (most commonly the arena
        // AA wallet is out of USDC, so agents can't buy data and forecast on baseline only).
        const why = humanizeHireFail(reason);
        lastHireFailReason = why;
        state.notice = { level: 'warn', text: `Data hires are failing: ${why}. Agents are forecasting on baseline only. Fund the arena wallet to restore real data.` };
        pushFeed(`Data hire failed: ${personaMeta(competitor).label} could not hire ${label} (${why})`);
        broadcast();
      },
      onFirstEstimate: ({ dqFromMs, dqAtMs }) => {
        // Fastest agent landed → the grace window opens; the red bar fills over [dqFromMs, dqAtMs].
        if (state.round) { state.round.dqFromMs = dqFromMs; state.round.dqAtMs = dqAtMs; broadcast(); }
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
        // Data flowed this round → clear the health banner; none → keep/raise it (A2A is hollow).
        if (edges.length > 0) { state.notice = undefined; lastHireFailReason = ''; }
        else if (!state.notice) state.notice = { level: 'warn', text: 'No data was purchased this round. Agents forecast on baseline only. Fund the arena wallet to restore real data.' };
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
          edges: edges.map((e) => ({ competitor: e.competitor, label: e.label, serviceId: e.serviceId, ours: e.ours, payTxHash: e.payTxHash, clearTxHash: e.clearTxHash, latencyMs: e.latencyMs })),
        };
        state.history.unshift(item);
        state.history = state.history.slice(0, 50);
        bumpLeaderboard(round.forecasts.map((f) => f.competitor), winners, o.errors);
        // Resolve free guest predictions: a guess is correct if it backed a winning agent (ties = co-winners).
        const winSet = new Set(winners);
        const guesses = predictPending.get(round.id);
        if (guesses) {
          for (const g of guesses) if (winSet.has(g.agentId)) state.predictStats.correct++;
        }
        predictPending.delete(round.id);
        // Settle human USDC bets: bettors who backed a winning agent split the pool (custodial house EOA; no-op unless configured).
        void (async () => {
          const racedAgentIds = round.forecasts.map((f) => f.competitor); // agents that delivered (DQ'd/absent → bets refunded)
          const res = await settleHouseBets(round.id, winners, racedAgentIds).catch(() => null);
          if (res && res.paid > 0) pushFeed(`USDC bets settled: ${res.total} USDC to ${res.paid} backer(s)${Number(res.agentPurse) > 0 ? `, ${res.agentPurse} to the winning agent` : ''}`);
          refreshUsdcBet();
        })();
        pushFeed(`Settled — amplitude $${o.actual.toFixed(2)} (line $${line.toFixed(2)}). Winner: ${winners.map((w) => personaMeta(w).label).join(', ')}`);
        // "Adopted" deltas: any agent→provider pair hired for the first time this round (real new A2A edge).
        detectAdoptions(item.edges.map((e) => ({ competitor: e.competitor, label: e.label, ours: e.ours })), Date.parse(item.settledAt) || Date.now(), true);
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
  refreshBudget();
  console.log(`[arena-server] bounded subsidy: ${DAILY_RACES} free races/day`);
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

  // Re-instantiate the DURABLE community roster (joins persisted in Upstash) so the open roster
  // survives restarts/redeploys. Needs ARENA_SDK_KEY (the arena buyer that hires remotes).
  if (joinedRoster.length) {
    try {
      if (!remoteBuyer) remoteBuyer = await createRemoteBuyer(cfg);
      let restored = 0;
      for (const j of joinedRoster) {
        if (competitors.some((c) => c.kind === 'remote' && c.serviceId === j.serviceId)) continue;
        competitors.push(makeRemoteCompetitor(remoteBuyer, j.serviceId, j.label));
        metaById.set(j.label, { label: j.label, blurb: 'community agent' });
        restored++;
      }
      if (competitors.length && state.status === 'view-only') state.status = 'idle';
      console.log(`[arena-server] restored ${restored} community competitor(s) from durable roster`);
    } catch (err) {
      console.warn(`[arena-server] could not restore community roster: ${(err as Error).message}`);
    }
  }
  refreshRoster(); // publish the upcoming racers (for idle free-prediction)

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
            joinedRoster.push({ serviceId, label: name });
            joinedRoster = joinedRoster.slice(-50);
            saveHistory(); // DURABLE: the join survives restarts (re-instantiated at boot)
            if (state.status === 'view-only') state.status = 'idle';
            refreshRoster(); // the new agent is now bettable for the next race (idle predictions)
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
          const { agentId, visitorId, cancel } = JSON.parse(body || '{}') as { agentId?: string; visitorId?: string; cancel?: boolean };
          if (!visitorId || typeof visitorId !== 'string' || visitorId.length > 64) return reply(400, { error: 'visitorId required' });
          const r = state.round;
          const live = !!r && (r.phase === 'open' || r.phase === 'betting');
          // The bucket for this race: the live round's, or the next-race bucket while idle.
          let bucket: { agentId: string; visitorId: string }[];
          if (live) { bucket = predictPending.get(r!.id) ?? []; predictPending.set(r!.id, bucket); }
          else bucket = nextPredictPending;
          const idx = bucket.findIndex((g) => g.visitorId === visitorId);
          if (cancel) {
            // Cancel my vote (free prediction only; never touches a placed USDC bet).
            if (idx >= 0) { bucket.splice(idx, 1); state.predictStats.total = Math.max(0, state.predictStats.total - 1); }
            saveHistory(); broadcast();
            return reply(202, { ok: true, predictStats: state.predictStats });
          }
          if (!agentId) return reply(400, { error: 'agentId required' });
          const validIds = live ? r!.competitors.map((c) => c.id) : (state.roster ?? []).map((a) => a.id);
          if (!validIds.includes(agentId)) return reply(400, { error: 'agentId not in the race' });
          if (idx >= 0) {
            bucket[idx].agentId = agentId; // CHANGE my pick (one prediction per visitor; no double-count)
          } else {
            bucket.push({ agentId, visitorId });
            state.predictStats.total++;
          }
          if (!predictVisitors.has(visitorId)) { predictVisitors.add(visitorId); state.predictStats.visitors++; }
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
            const { roundId, agentId, amountUSDC, eoa, txHash } = JSON.parse(body || '{}') as
              { roundId?: string; agentId?: string; amountUSDC?: number; eoa?: string; txHash?: string };
            if (!eoa || !/^0x[0-9a-fA-F]{40}$/.test(eoa)) return reply(400, { error: 'valid eoa required' });
            if (!txHash || !/^0x[0-9a-fA-F]{64}$/.test(txHash)) return reply(400, { error: 'valid txHash required' });
            const amt = Number(amountUSDC);
            if (!(amt > 0) || amt > MAX_BET_USDC) return reply(400, { error: `amount must be 0 < x ≤ ${MAX_BET_USDC} USDC` });
            if (!roundId || roundId !== state.round?.id || (state.round?.phase !== 'open' && state.round?.phase !== 'betting')) return reply(409, { error: 'no live betting round' });
            if (!agentId || !state.round.competitors.some((c) => c.id === agentId)) return reply(400, { error: 'agentId must be a racer in this round' });
            const amount = BigInt(Math.round(amt * 1e6));
            const ok = await verifyBetTx(txHash, eoa, amount).catch(() => false);
            if (!ok) return reply(400, { error: 'bet tx not verified on-chain (USDC transfer to house not found)' });
            const weight = betWeightNow(); // odds decay: earlier = bigger share of the pool
            recordBet({ roundId, agentId, amount, eoa, txHash, weight });
            refreshUsdcBet();
            pushFeed(`USDC bet: ${amt} on ${personaMeta(agentId).label} ×${weight.toFixed(2)} (${eoa.slice(0, 6)}…)`, BASESCAN + txHash);
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
