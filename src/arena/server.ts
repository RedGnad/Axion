import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AgentClient, EventType, DeliverableType, type Event } from '@croo-network/sdk';
import { loadCompetitors, runRound, createRemoteBuyer, makeRemoteCompetitor, type Competitor } from './loop.js';
import { PERSONALITIES } from './personalities.js';
import { fetchPythPrice } from './oracle.js';
import { loadState, saveState, storeEnabled } from './store.js';
import { candidatesForCapability, discoverProviders } from './discovery.js';
import { houseEnabled, houseAddress, verifyBetTx, recordBet, poolFor, settleHouseBets, MAX_BET_USDC, setAgentPayout, clearAgentPayout, isPayoutAddress } from './housebet.js';
import { validateCompetitorResponse } from './competitor-contract.js';

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
  /** Provider labels this agent hired THIS round (from its edges) — surfaced live so spectators see
   *  which data each persona bought. Empty for remote agents (they source internally). */
  hires?: string[];
  /** Capability/provider labels this agent is sourcing before its estimate lands. */
  targets?: string[];
  /** Whether targets are still desired capabilities or the selected providers being hired. */
  sourcePhase?: 'choosing' | 'hiring';
}
interface RoundView {
  id: string;
  format?: 'blitz' | 'thesis';
  windowSeconds?: number;
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
  capability?: string;
  label: string;
  serviceId?: string;
  ours: boolean;
  payTxHash: string;
  clearTxHash: string;
  latencyMs?: number; // hire latency → provider-speed leaderboard
}
interface HistoryItem {
  id: string;
  format?: 'blitz' | 'thesis';
  windowSeconds?: number;
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
interface WiredProvider {
  competitor?: string;
  capability?: string;
  label: string;
  serviceId: string;
  ours: boolean;
}
interface ArenaState {
  status: 'idle' | 'running' | 'view-only';
  asset: string;
  /** Live ETH/USD from Pyth, streamed every ~2s so the screen is never static. */
  livePrice?: number;
  priceSeries: number[];
  /** When the next scheduled round is due (the heartbeat) → the UI shows a "next MM:SS". */
  nextRoundAtMs?: number;
  round?: RoundView;
  history: HistoryItem[];
  leaderboard: { id: string; label: string; wins: number; rounds: number; sumError: number; avgError: number }[];
  feed: FeedItem[];
  /** The agents that will race next — so visitors can free-predict the NEXT race during the idle gap
   *  (at a low cadence the arena is idle most of the time; this is the main engagement lever). */
  roster?: { id: string; label: string }[];
  /** Free guest-prediction usage (proof of adoption): total calls, correct, unique visitors. */
  predictStats: { total: number; correct: number; visitors: number; pending?: number; resolved?: number };
  /** Custodial-disclosed human USDC betting (off unless the house EOA is configured). */
  usdcBet?: { enabled: boolean; open: boolean; betCutoffAtMs?: number; houseAddress: string; maxBetUSDC: number; multiplier: number; pool: { byAgent: { id: string; amount: string }[]; total: string; bettors: number } };
  /** Bounded daily cold-start subsidy: free races we'll fund today (resets UTC midnight). */
  budget?: { used: number; cap: number; resetsAt: number };
  /** Secondary long-form format: one data-rich thesis event per day by default. */
  thesisRace?: { usedToday: number; capToday: number; resetsAt: number; windowSeconds: number };
  /** Health banner: surfaced (never silent) when data hires fail. Kept user-facing and action-oriented:
   *  funding, delisting, and provider latency are different states. Cleared once a round buys data. */
  notice?: { level: 'warn'; text: string };
  /** Live CROO store data-market (discovery): pool size grows with the store; wired = hired last round. */
  dataMarket?: {
    discovered: number;
    matched: number;
    maxPriceUSDC: number;
    censusAt: number;
    top: { name: string; orders7d: number; priceUSDC: number }[];
    wired: WiredProvider[];
    routing?: { capability: string; candidates: number; top: string[]; selected?: string }[];
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
const THESIS_WINDOW = Number(process.env.ARENA_THESIS_WINDOW_SECONDS ?? '900');
const DAILY_THESIS_RACES = Math.max(0, Number(process.env.ARENA_DAILY_THESIS_RACES ?? '1'));
let HIRING_ETA_MS = 90_000; // estimated hiring time; AUTO-CALIBRATED from each round's real open→betting duration
const AUTO_MS = Number(process.env.ARENA_AUTO_ROUND_MS ?? '0'); // scheduled heartbeat cadence (0 = off)
// Cost ceiling: minimum gap between rounds, so demand triggers can't spam-burn USDC (~0.6/round).
const MIN_ROUND_MS = Number(process.env.ARENA_MIN_ROUND_MS ?? (AUTO_MS ? Math.min(AUTO_MS, 600_000) : 600_000));
// Real-money bets keep their edge only early in reveal; after this fraction the USDC endpoint closes.
// Free picks stay open as a low-stakes spectator action.
const BET_DECAY_FRACTION = Math.min(1, Math.max(0.1, Number(process.env.BET_DECAY_FRACTION ?? '0.45')));
const BET_MIN_MULTIPLIER = Math.min(1.9, Math.max(1.05, Number(process.env.BET_MIN_MULTIPLIER ?? '1.25')));
// Cold-start subsidy is BOUNDED: at most N free races/day from our treasury (each ~0.6 USDC of data
// hires). Beyond it, "start" is paused till tomorrow (UTC) — a bot/spam can never drain us.
const DAILY_RACES = Math.max(1, Number(process.env.ARENA_DAILY_RACES ?? '2'));
const BASESCAN = 'https://basescan.org/tx/';

const state: ArenaState = { status: 'idle', asset: 'ETH', priceSeries: [], history: [], leaderboard: [], feed: [], predictStats: { total: 0, correct: 0, visitors: 0 } };
const clients = new Set<import('node:http').ServerResponse>();
let competitors: Competitor[] = [];
let metaById = new Map<string, { label: string; blurb: string }>();
// Community agents that joined via /api/competitor — PERSISTED (Upstash) so the open roster survives
// restarts/redeploys; re-instantiated as remote competitors at boot.
let joinedRoster: { serviceId: string; label: string; payout?: string }[] = [];
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

type RaceFormat = 'blitz' | 'thesis';
function windowForFormat(format: RaceFormat): number {
  return format === 'thesis' ? THESIS_WINDOW : WINDOW;
}

/** Recent real volatility: average |move| over a round window across the live Pyth series (2s apart). */
function computeRecentVol(windowSeconds = WINDOW): number {
  const s = state.priceSeries;
  const lag = Math.max(1, Math.round(windowSeconds / 2)); // points ~ windowSeconds apart
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
  if (r.includes('invalid response')) return 'invalid response (must return {prediction, rationale})';
  if (r.includes('agent_not_found') || r.includes('requester agent not found')) return 'seed agent no longer registered on CROO';
  if (/insufficient|balance|funds/.test(r)) return 'arena wallet out of USDC';
  if (/timed out|timeout/.test(r)) return 'provider too slow (timeout)';
  if (/create_failed|rejected|reject/.test(r)) return 'provider rejected the order';
  return reason.slice(0, 80);
}
function degradedNotice(why: string): string {
  if (why === 'arena wallet out of USDC') {
    return 'Live data degraded: an agent wallet needs USDC. Races continue with fallback forecasts; see Journal for details.';
  }
  if (why === 'seed agent no longer registered on CROO') {
    return 'Live data degraded: a seed racer was removed from CROO. Restore or redeploy it before claiming full data hires.';
  }
  return `Live data degraded: ${why}. Races continue with fallback forecasts; see Journal for details.`;
}
/** A bad competitor RESPONSE (didn't honor the contract) is the builder's issue, not our infra. It
 *  should be surfaced to them, but must not raise the arena health banner. */
function isInfraFail(reason: string): boolean {
  return /insufficient|balance|funds|timed out|timeout|AGENT_NOT_FOUND|requester agent not found/i.test(reason);
}

function pendingPredictionCount(): number {
  let n = nextPredictPending.length;
  for (const bucket of predictPending.values()) n += bucket.length;
  return n;
}

function refreshPredictStats(): ArenaState['predictStats'] {
  const pending = pendingPredictionCount();
  const resolved = Math.max(0, state.predictStats.total - pending);
  state.predictStats.pending = pending;
  state.predictStats.resolved = resolved;
  return state.predictStats;
}

function broadcast(): void {
  refreshPredictStats();
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
    joinedRoster?: { serviceId: string; label: string; payout?: string }[];
    racesToday?: number; racesDayKey?: string; nextRoundAtMs?: number;
  };
  const restoreMeta = (d: Persisted): void => {
    for (const id of d.knownProviderIds ?? []) knownProviderIds.add(id);
    for (const p of d.seenPairs ?? []) seenPairs.add(p);
    if (d.storeEvents?.length) storeEvents = d.storeEvents.slice(0, 14);
    if (d.joinedRoster?.length) joinedRoster = d.joinedRoster.slice(0, 50);
    // Restore the daily subsidy counter so the cap HOLDS across restarts (else a redeploy/spin-down
    // resets it to 0 and a bot could drain us). refreshBudget() rolls it over if the UTC day changed.
    if (typeof d.racesToday === 'number') racesToday = d.racesToday;
    if (d.racesDayKey) racesDayKey = d.racesDayKey;
    // Restore the scheduled next-race time so the countdown is reliable across restarts.
    if (typeof d.nextRoundAtMs === 'number') state.nextRoundAtMs = d.nextRoundAtMs;
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
      format: last.format,
      windowSeconds: last.windowSeconds,
      phase: 'settled',
      openPrice: last.openPrice,
      closePrice: last.closePrice,
      amplitude: last.amplitude,
      line: last.line,
      settleAtMs: Date.parse(last.settledAt) || Date.now(),
      competitors: last.competitors ?? [],
    };
    for (const e of (last.edges ?? []).slice().reverse()) {
      pushFeed(`${e.label} hired. Round settled`, BASESCAN + e.payTxHash);
    }
    pushFeed(`Last round: amplitude $${last.amplitude.toFixed(2)} vs line $${last.line.toFixed(2)}. Winner(s): ${last.winners.map((w) => personaMeta(w).label).join(', ')}`);
  }
  refreshBudget(); // publish the (restored, rolled-over) daily subsidy so the UI shows it at boot
}

function saveHistory(): void {
  refreshPredictStats();
  const blob = {
    history: state.history, leaderboard: state.leaderboard, predictStats: state.predictStats,
    knownProviderIds: [...knownProviderIds], seenPairs: [...seenPairs], storeEvents,
    joinedRoster, racesToday, racesDayKey, nextRoundAtMs: state.nextRoundAtMs,
  };
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify(blob, null, 2));
  } catch {
    /* best-effort persistence */
  }
  void saveState(blob); // durable (Upstash) — survives Render restarts
}

/** DISPLAY odds multiplier (×N), decaying with INFORMATION — reward strictly drops as you learn more.
 *  Real-money bets close before the odds hit x1, so the UI never invites a "no edge" bet. */
function displayMultNow(): number {
  const r = state.round;
  if (!r) return 4;
  if (r.phase === 'open') return 4; // blind (no line, no move) = max reward
  if (r.phase === 'betting' && r.raceStartMs && r.settleAtMs && r.settleAtMs > r.raceStartMs) {
    const frac = Math.min(1, Math.max(0, (Date.now() - r.raceStartMs) / (r.settleAtMs - r.raceStartMs)));
    const pricedFrac = Math.min(1, frac / BET_DECAY_FRACTION);
    const mult = 2 - pricedFrac * (2 - BET_MIN_MULTIPLIER);
    return Math.round(mult * 100) / 100; // 2.0 at race start → min edge at cutoff, then closed
  }
  return 1;
}
/** Internal pari-mutuel share weight = displayMult / 4 (so ×4→1.0; accepted live bets floor above x1). */
function betWeightNow(): number {
  return displayMultNow() / 4;
}

function betCutoffAtMs(): number | undefined {
  const r = state.round;
  if (!r?.raceStartMs || !r.settleAtMs || r.settleAtMs <= r.raceStartMs) return undefined;
  return r.raceStartMs + Math.round((r.settleAtMs - r.raceStartMs) * BET_DECAY_FRACTION);
}

function realBetOpenNow(): boolean {
  const r = state.round;
  if (!r) return false;
  if (r.phase === 'open') return true;
  if (r.phase !== 'betting') return false;
  const cutoff = betCutoffAtMs();
  return cutoff == null ? true : Date.now() < cutoff;
}

/** Reflect the human-USDC-bet config + current round pool into state (for the UI). */
function refreshUsdcBet(): void {
  const p = poolFor(state.round?.id ?? '');
  let total = 0n;
  const byAgent = Object.entries(p.byAgent).map(([id, amount]) => { total += amount; return { id, amount: (Number(amount) / 1e6).toFixed(2) }; });
  state.usdcBet = {
    enabled: houseEnabled(),
    open: realBetOpenNow(),
    betCutoffAtMs: betCutoffAtMs(),
    houseAddress: houseAddress(),
    maxBetUSDC: MAX_BET_USDC,
    multiplier: displayMultNow(),
    pool: { byAgent, total: (Number(total) / 1e6).toFixed(2), bettors: p.bettors },
  };
}

/** Refresh the live store data-market panel (free, read-only). `wired` = the providers actually
 *  hired in the most recent round (from its edges) so the demo shows real A2A, not just the catalog. */
async function refreshDataMarket(wired?: WiredProvider[]): Promise<void> {
  try {
    const pool = await discoverProviders();
    const capabilities = [...new Set(PERSONALITIES.flatMap((p) => p.capabilities))];
    const selectedByCapability = new Map<string, string>();
    for (const w of wired ?? state.dataMarket?.wired ?? []) {
      if (w.capability && w.label) selectedByCapability.set(w.capability, w.label);
    }
    const matched = new Set<string>();
    const routing = await Promise.all(capabilities.map(async (capability) => {
      const cands = await candidatesForCapability(capability);
      for (const p of cands) matched.add(p.serviceId);
      return {
        capability,
        candidates: cands.length,
        top: cands.slice(0, 3).map((p) => p.name),
        selected: selectedByCapability.get(capability),
      };
    }));
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
        const key = e.serviceId || e.label; // dedupe by serviceId; old rows without ids fall back to label
        const row = stats.get(key) ?? { label: e.label, serviceId: e.serviceId ?? '', hires: 0, latSum: 0, latN: 0 };
        row.hires += 1;
        if (!row.serviceId && e.serviceId) row.serviceId = e.serviceId;
        // Keep the shorter current catalog label when old history had a longer hand label.
        if (e.label.length < row.label.length) row.label = e.label;
        if (typeof e.latencyMs === 'number') { row.latSum += e.latencyMs; row.latN += 1; }
        stats.set(key, row);
      }
    }
    const providerStats = [...stats.values()]
      .map((r) => ({ label: r.label, serviceId: r.serviceId, hires: r.hires, avgMs: r.latN ? Math.round(r.latSum / r.latN) : null, paidUSDC: Math.round(r.hires * PRICE * 100) / 100 }))
      .sort((a, b) => b.hires - a.hires);
    const eventDeny = /subscription|monthly|plan|days|swap|execute|execution|executor|bridge|deploy|mint|airdrop|faucet|pay|payout|split|resolver|ens|logo|design|buyer.?ping|\becho\b|\btest\b|arena|axion|racer|race|forecast/i;
    state.dataMarket = {
      discovered: pool.length,
      matched: matched.size,
      maxPriceUSDC: Number(process.env.DISCOVERY_MAX_PRICE_USDC) || 0.10,
      censusAt: Date.now(),
      top: pool.slice(0, 6).map((p) => ({ name: p.name, orders7d: p.orders7d, priceUSDC: p.priceUSDC })),
      wired: wired ?? state.dataMarket?.wired ?? [],
      routing,
      providerStats,
      events: storeEvents.filter((e) => !eventDeny.test(e.text)).slice(0, 14),
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
    const appUrl = process.env.FRONTEND_URL ?? 'https://axion-fawn.vercel.app';
    return JSON.stringify({
      service: 'Axion Clash arena brief',
      appUrl,
      asset: state.asset,
      status: state.status,
      livePrice: state.livePrice ?? null,
      nextRoundAtMs: state.nextRoundAtMs ?? null,
      topAgent: state.leaderboard[0]?.label ?? null,
      lastRound: last
        ? {
            realizedMoveUSD: last.amplitude,
            lineUSD: last.line,
            winners: last.winners,
            settledAt: last.settledAt,
          }
        : null,
      racerContract: {
        requirements: { spot: 'number', deadlineSeconds: 'number', recentVol: 'number' },
        deliverable: { prediction: 'positive USD move estimate', rationale: 'short string' },
      },
      note: 'To race, deploy a CROO service that returns the racerContract deliverable, then join from the Garage in appUrl.',
    });
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

/** Optional: make the seed racers callable CROO services from the same Render runner.
 * External users can hire Slicer/Tanker/Wizord as generic short-horizon market forecasters, while
 * Axion still uses their SDK keys locally as buyer racers. Set COMPETITOR_BULL_SERVICE_ID etc.
 * or aliases SLICER_SERVICE_ID, TANKER_SERVICE_ID, WIZORD_SERVICE_ID. */
function seedServiceId(persona: (typeof PERSONALITIES)[number]): string {
  const archetype = persona.archetype.toUpperCase();
  return process.env['COMPETITOR_' + archetype + '_SERVICE_ID'] ?? process.env[persona.id.toUpperCase() + '_SERVICE_ID'] ?? '';
}

function seedForecast(persona: (typeof PERSONALITIES)[number], requirements: string): string {
  let req: { spot?: number; deadlineSeconds?: number; recentVol?: number } = {};
  try { req = JSON.parse(requirements || '{}') as typeof req; } catch { /* fallback below */ }
  const spot = Number(req.spot) || state.livePrice || 3000;
  const horizon = Number(req.deadlineSeconds) || WINDOW;
  const recent = Number(req.recentVol) > 0 ? Number(req.recentVol) : Math.max(0.5, spot * 0.0004);
  const prediction = Math.max(0.01, Number((recent * persona.volMultiplier).toFixed(2)));
  const usd = String.fromCharCode(36);
  const rationale = persona.label + ': ' + usd + prediction.toFixed(2) + ' short-horizon move estimate from recent volatility over ~' + horizon + 's.';
  return JSON.stringify({ prediction, rationale });
}

async function startSeedRacerProviders(cfg: { baseURL: string; wsURL: string }): Promise<void> {
  for (const persona of PERSONALITIES) {
    const key = process.env['COMPETITOR_' + persona.archetype.toUpperCase() + '_SDK_KEY'];
    const serviceId = seedServiceId(persona);
    if (!key || !serviceId) continue;
    const client = new AgentClient({ baseURL: cfg.baseURL, wsURL: cfg.wsURL }, key);
    try { await client.connectWebSocket(); } catch { /* WS keeps store online; polling does the work */ }
    const done = new Set<string>();
    const inFlight = new Set<string>();
    console.log('[' + persona.id + '] seed provider online on service ' + serviceId);

    const tick = async (): Promise<void> => {
      try {
        const negs = await client.listNegotiations({ role: 'provider', status: 'pending', page: 1, pageSize: 20 });
        for (const n of negs) {
          if (n.serviceId !== serviceId) continue;
          try { await client.acceptNegotiation(n.negotiationId); console.log('[' + persona.id + '] accepted external hire ' + n.negotiationId); } catch { /* retry next tick */ }
        }
        const orders = await client.listOrders({ role: 'provider', status: 'paid', page: 1, pageSize: 20 });
        for (const o of orders) {
          if (o.serviceId !== serviceId || done.has(o.orderId) || inFlight.has(o.orderId)) continue;
          inFlight.add(o.orderId);
          void (async () => {
            try {
              const neg = await client.getNegotiation(o.negotiationId);
              await client.deliverOrder(o.orderId, {
                deliverableType: DeliverableType.Text,
                deliverableText: seedForecast(persona, neg.requirements ?? '{}'),
              });
              done.add(o.orderId);
              console.log('[' + persona.id + '] delivered external forecast ' + o.orderId);
            } catch (err) {
              console.warn('[' + persona.id + '] external forecast failed: ' + (err as Error).message);
            } finally {
              inFlight.delete(o.orderId);
            }
          })();
        }
      } catch { /* transient */ }
    };
    setInterval(() => void tick(), 3000);
  }
}
function nextUtcMidnightMs(): number {
  const d = new Date();
  d.setUTCHours(24, 0, 0, 0);
  return d.getTime();
}
function thesisUsedToday(): number {
  const today = new Date().toISOString().slice(0, 10);
  let used = state.history.filter((h) => h.format === 'thesis' && h.settledAt.slice(0, 10) === today).length;
  if (state.round?.format === 'thesis' && state.round.phase !== 'settled') used += 1;
  return used;
}
/** Reflect the bounded daily subsidy into state (for the UI), rolling over at UTC midnight. */
function refreshBudget(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== racesDayKey) { racesDayKey = today; racesToday = 0; }
  state.budget = { used: racesToday, cap: DAILY_RACES, resetsAt: nextUtcMidnightMs() };
  state.thesisRace = { usedToday: thesisUsedToday(), capToday: DAILY_THESIS_RACES, resetsAt: nextUtcMidnightMs(), windowSeconds: THESIS_WINDOW };
}

/** Trigger a round respecting the cost ceiling (cooldown) + running guard + bounded daily subsidy. */
function tryRunRound(
  cfg: { baseURL: string; wsURL: string; rpcURL?: string },
  reason: string,
  format: RaceFormat = 'blitz',
): { started: boolean; nextAtMs?: number; reason?: string; format?: RaceFormat; windowSeconds?: number } {
  if (running) return { started: false, reason: 'a race is already running', nextAtMs: state.nextRoundAtMs };
  const since = Date.now() - lastRoundStartMs;
  if (lastRoundStartMs && since < MIN_ROUND_MS) return { started: false, reason: 'cooldown', nextAtMs: lastRoundStartMs + MIN_ROUND_MS };
  refreshBudget();
  if (format === 'thesis' && thesisUsedToday() >= DAILY_THESIS_RACES) {
    return { started: false, reason: 'daily thesis race already used', nextAtMs: nextUtcMidnightMs(), format, windowSeconds: windowForFormat(format) };
  }
  if (format === 'blitz' && racesToday >= DAILY_RACES) return { started: false, reason: `today's free races are used up (${DAILY_RACES}/day). Back at UTC midnight`, nextAtMs: nextUtcMidnightMs() };
  if (format === 'blitz') racesToday++;
  refreshBudget();
  saveHistory(); // persist the subsidy counter immediately so the cap survives a restart mid-round
  const windowSeconds = windowForFormat(format);
  console.log(`[arena-server] round trigger: ${reason}/${format} ${windowSeconds}s (blitz ${racesToday}/${DAILY_RACES}, thesis ${thesisUsedToday()}/${DAILY_THESIS_RACES} today)`);
  void runOneRound(cfg, { format, windowSeconds });
  return { started: true, format, windowSeconds };
}

async function runOneRound(
  cfg: { baseURL: string; wsURL: string; rpcURL?: string },
  opts: { format: RaceFormat; windowSeconds: number } = { format: 'blitz', windowSeconds: WINDOW },
): Promise<void> {
  if (running || competitors.length === 0) return;
  const { format, windowSeconds } = opts;
  running = true;
  lastRoundStartMs = Date.now();
  // Schedule the next AUTOMATIC race and PERSIST it, so the "next" countdown is reliable and
  // SURVIVES restarts (Render redeploy/spin-down) instead of resetting to the full period each boot.
  if (AUTO_MS) { state.nextRoundAtMs = lastRoundStartMs + AUTO_MS; saveHistory(); }
  state.status = 'running';
  try {
    await runRound(competitors, cfg, windowSeconds, {
      onOpen: ({ id, openPrice, dqAtMs }) => {
        roundOpenMs = Date.now();
        state.round = {
          id,
          format,
          windowSeconds,
          phase: 'open',
          openPrice,
          // Calibrated expected race start (descending countdown target), and the DQ cutoff = that + grace
          // (known upfront, computed in loop) → the red grace bar fills over [etaRaceStartMs, dqAtMs].
          etaRaceStartMs: roundOpenMs + HIRING_ETA_MS,
          etaSettleMs: roundOpenMs + HIRING_ETA_MS + windowSeconds * 1000,
          dqAtMs,
          competitors: competitors.map((c) => ({
            id: c.id,
            ...personaMeta(c.id),
            targets: c.kind === 'local' ? c.persona.capabilities : ['arena forecast'],
            sourcePhase: 'choosing',
          })),
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
        pushFeed(`${format === 'thesis' ? '15m thesis' : '60s blitz'} round open. ETH/USD $${openPrice.toFixed(2)}; agents hiring · early bets open at top odds`);
        broadcast();
      },
      onSourcing: ({ competitor, services }) => {
        if (!state.round) return;
        const c = state.round.competitors.find((x) => x.id === competitor);
        if (c) {
          c.targets = services.map((s) => s.label);
          c.sourcePhase = 'hiring';
        }
        broadcast();
      },
      onHireFail: ({ competitor, label, reason }) => {
        // NEVER silent. Distinguish OUR infra (wallet/timeout → raise the funding banner) from a builder's
        // agent returning a bad response (their contract issue → surface it to them, no banner).
        const why = humanizeHireFail(reason);
        if (isInfraFail(reason)) {
          lastHireFailReason = why;
          state.notice = { level: 'warn', text: degradedNotice(why) };
          pushFeed(`${personaMeta(competitor).label} couldn't get ${label}: ${why}`);
        } else {
          pushFeed(`${personaMeta(competitor).label}: ${why}`); // e.g. "PulseBNB: invalid response (must return {prediction, rationale})"
          // AUTO-PURGE a COMMUNITY agent that returns an invalid response (deterministic = wrong contract):
          // remove it from the grid instead of paying to DQ it every round; tell them to fix + re-register.
          if (/invalid response/i.test(reason) && competitors.some((x) => x.id === competitor && x.kind === 'remote')) {
            competitors = competitors.filter((x) => x.id !== competitor);
            joinedRoster = joinedRoster.filter((j) => j.label !== competitor);
            metaById.delete(competitor);
            clearAgentPayout(competitor);
            refreshRoster();
            saveHistory();
            pushFeed(`${competitor} removed from the grid. It must return {prediction, rationale}. Fix the contract and re-register in the Garage.`);
          }
        }
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
          c.hires = edges.map((e) => e.label); // which providers it bought this round (live, per agent)
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
        // SINGLE reveal window: free picks stay simple; real USDC bets close early as odds decay.
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
        pushFeed(`They're off! Line $${line.toFixed(2)}. Real bets close early as the move reveals${dqNote}`);
        broadcast();
      },
      onTick: ({ liveAmplitude }) => {
        if (!state.round) return;
        state.round.liveAmplitude = liveAmplitude;
        refreshUsdcBet(); // recompute decaying odds + early real-bet cutoff every tick
        broadcast();
      },
      onSettled: ({ round, line, edges }) => {
        const o = round.outcome!;
        // Data flowed this round → clear the health banner; none → keep/raise it (A2A is hollow).
        if (edges.length > 0) { state.notice = undefined; lastHireFailReason = ''; }
        else if (!state.notice) state.notice = { level: 'warn', text: 'Live data degraded: no data was purchased this round. Races used fallback forecasts; see Journal for details.' };
        // Accuracy decides the win; SPEED only breaks exact ties — among co-winners, the agent whose
        // data landed first takes it (legitimate edge for choosing fast data-providers).
        let winners = o.winners;
        if (winners.length > 1) {
          const dataMsById = new Map((state.round?.competitors ?? []).map((c) => [c.id, c.dataMs ?? Infinity]));
          winners = [[...winners].sort((a, b) => (dataMsById.get(a) ?? Infinity) - (dataMsById.get(b) ?? Infinity))[0]];
        }
        let settledCompetitors: CompetitorView[] = round.forecasts.map((f) => ({
          id: f.competitor,
          ...personaMeta(f.competitor),
          estimate: f.prediction,
          rationale: f.rationale,
          error: o.errors[f.competitor],
          isWinner: winners.includes(f.competitor),
        }));
        if (state.round) {
          state.round.phase = 'settled';
          state.round.closePrice = round.closePrice;
          state.round.amplitude = o.actual;
          state.round.competitors = state.round.competitors.map((c) => ({
            ...c,
            error: o.errors[c.id],
            isWinner: winners.includes(c.id),
          }));
          settledCompetitors = state.round.competitors;
        }
        const item: HistoryItem = {
          id: round.id,
          format,
          windowSeconds,
          openPrice: round.openPrice,
          closePrice: round.closePrice ?? round.openPrice,
          amplitude: o.actual,
          line,
          winners,
          settledAt: o.settledAt,
          competitors: settledCompetitors,
          edges: edges.map((e) => ({ competitor: e.competitor, capability: e.capability, label: e.label, serviceId: e.serviceId, ours: e.ours, payTxHash: e.payTxHash, clearTxHash: e.clearTxHash, latencyMs: e.latencyMs })),
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
        pushFeed(`Settled. Amplitude $${o.actual.toFixed(2)} (line $${line.toFixed(2)}). Winner: ${winners.map((w) => personaMeta(w).label).join(', ')}`);
        // "Adopted" deltas: any agent→provider pair hired for the first time this round (real new A2A edge).
        detectAdoptions(item.edges.map((e) => ({ competitor: e.competitor, label: e.label, ours: e.ours })), Date.parse(item.settledAt) || Date.now(), true);
        saveHistory();
        // Reflect the providers actually wired this round into the live data-market panel.
        void refreshDataMarket(item.edges.map((e) => ({ competitor: e.competitor, capability: e.capability, label: e.label, serviceId: e.serviceId ?? '', ours: e.ours })));
        broadcast();
      },
    }, { recentVol: computeRecentVol(windowSeconds) });
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
    format: last.format,
    windowSeconds: last.windowSeconds,
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
  const lastEdges = (state.history[0]?.edges ?? []).map((e) => ({ competitor: e.competitor, capability: e.capability, label: e.label, serviceId: e.serviceId ?? '', ours: e.ours }));
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
        if (state.priceSeries.length > 600) state.priceSeries.shift(); // enough context for 15m thesis races
        broadcast();
      } catch {
        /* transient Hermes hiccup */
      }
    })();
  }, 2000);

  // Keep Axion + optional seed services live from this same Render runner (env-gated).
  void startAxionProvider(cfg);
  void startSeedRacerProviders(cfg);

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
        if (j.payout && isPayoutAddress(j.payout)) setAgentPayout(j.label, j.payout); // re-arm winning-purse routing
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
    // Tiny health endpoint for the keep-warm cron + platform health checks (the full /api/state has
    // grown large with history → some pingers abort on the big body). Returns a few bytes.
    if (req.method === 'GET' && (url === '/api/ping' || url === '/healthz')) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify({ ok: true, status: state.status, nextRoundAtMs: state.nextRoundAtMs ?? null }));
      return;
    }
    if (req.method === 'GET' && url === '/api/state') {
      refreshBudget(); // keep the daily-subsidy display current so it rolls over at UTC midnight (never a stale "used up")
      refreshUsdcBet();
      refreshPredictStats();
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(state));
      return;
    }
    // In-product agent check: paste a sample of your agent's output → instant valid/invalid, FREE (no
    // hire). Same function the arena uses, so ✅ here = accepted on-chain. Zero terminal for builders.
    if (req.method === 'POST' && url === '/api/validate') {
      const reply = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 8000) req.destroy(); });
      req.on('end', () => {
        try {
          const { output } = JSON.parse(body || '{}') as { output?: string };
          reply(200, validateCompetitorResponse(String(output ?? '')));
        } catch (e) {
          reply(400, { ok: false, reason: (e as Error).message });
        }
      });
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
      refreshPredictStats();
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 20_000); // heartbeat keeps the stream flushing
      req.on('close', () => { clearInterval(hb); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && url === '/api/round') {
      // Demand trigger (a user predicts/bets) — cooldown-gated so it can't spam-burn USDC.
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 1000) req.destroy(); });
      req.on('end', () => {
        let format: RaceFormat = 'blitz';
        try {
          const j = JSON.parse(body || '{}') as { format?: string };
          if (j.format === 'thesis') format = 'thesis';
        } catch { /* keep default */ }
        const t = tryRunRound(cfg, 'demand', format);
        res.writeHead(t.started ? 202 : 409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(t));
      });
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
            const { serviceId, label, payoutAddress } = JSON.parse(body || '{}') as { serviceId?: string; label?: string; payoutAddress?: string };
            if (!serviceId || !/^[0-9a-f-]{36}$/i.test(serviceId)) return reply(400, { error: 'valid serviceId (uuid) required' });
            if (competitors.some((c) => c.kind === 'remote' && c.serviceId === serviceId)) return reply(409, { error: 'agent already in the arena' });
            const payout = (payoutAddress || '').trim();
            if (payout && !isPayoutAddress(payout)) return reply(400, { error: 'payout address must be a 0x… Base address (40 hex chars)' });
            if (!remoteBuyer) remoteBuyer = await createRemoteBuyer(cfg);
            let name = (label || `agent-${serviceId.slice(0, 4)}`).replace(/[^\w -]/g, '').slice(0, 24) || `agent-${serviceId.slice(0, 4)}`;
            while (metaById.has(name)) name += '*';

            // No paid pre-flight hire here: joining should be fast and free. The first real race validates
            // the deliverable and auto-purges bad community agents that do not return {prediction,rationale}.
            const comp = makeRemoteCompetitor(remoteBuyer, serviceId, name);

            competitors.push(comp);
            metaById.set(name, { label: name, blurb: 'community agent' });
            if (payout) setAgentPayout(name, payout); // route this agent's winning purse on-chain
            joinedRoster.push({ serviceId, label: name, payout: payout || undefined });
            joinedRoster = joinedRoster.slice(-50);
            saveHistory(); // DURABLE: the join survives restarts (re-instantiated at boot)
            if (state.status === 'view-only') state.status = 'idle';
            refreshRoster(); // the new agent is now bettable for the next race (idle predictions)
            pushFeed(`New competitor joined: ${name}`);
            broadcast();
            reply(202, { ok: true, name, payout: !!payout, note: 'joined — first race validates the handler response' });
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
            if (!realBetOpenNow()) return reply(409, { error: 'real bets are closed for this race' });
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

  // Automatic race on a RELIABLE schedule: the UI counts down to state.nextRoundAtMs (persisted), and
  // this loop fires the round when that time arrives. Target-based (not setInterval(AUTO_MS)) so the
  // countdown survives restarts: a redeploy/spin-down resumes the SAME target instead of resetting it.
  if (AUTO_MS >= 60_000 && competitors.length) {
    // Keep a restored future target; only set a fresh one if missing or stale beyond a full period.
    if (!state.nextRoundAtMs || state.nextRoundAtMs < Date.now() - AUTO_MS) state.nextRoundAtMs = Date.now() + AUTO_MS;
    saveHistory();
    console.log(`[arena-server] auto race ~every ${Math.round(AUTO_MS / 60000)}min; next at ${new Date(state.nextRoundAtMs).toISOString()}`);
    setInterval(() => {
      if (running || !state.nextRoundAtMs || Date.now() < state.nextRoundAtMs) return;
      const t = tryRunRound(cfg, 'auto'); // scheduled time reached → run (runOneRound reschedules nextRoundAtMs)
      if (!t.started) { state.nextRoundAtMs = Date.now() + AUTO_MS; saveHistory(); } // skipped (cooldown/budget) → retry next period
    }, 15_000);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
