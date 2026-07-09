import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { AgentClient, EventType, DeliverableType, type Event } from '@croo-network/sdk';
import { ethers } from 'ethers';
import { loadCompetitors, runRound, createRemoteBuyer, makeRemoteCompetitor, type Competitor } from './loop.js';
import { PERSONALITIES } from './personalities.js';
import { fetchPythPrice } from './oracle.js';
import { loadState, saveState, storeEnabled } from './store.js';
import { candidatesForCapability, discoverProviders, markProviderSucceeded } from './discovery.js';
import { houseEnabled, houseAddress, verifyBetTx, recordBet, poolFor, settleHouseBets, MAX_BET_USDC, setAgentPayout, clearAgentPayout, isPayoutAddress } from './housebet.js';
import { validateCompetitorResponse } from './competitor-contract.js';
import { signCredential, signScorecard, type Credential, type SignedScorecard } from './scorecard.js';
import { reasonHash } from './settle.js';

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
  /** Terminal failure reason when the agent failed before the cutoff (distinct from being slow). */
  failReason?: string;
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
  /** When the hiring phase opened; clients use it for honest progress feedback while agents source. */
  openAtMs?: number;
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
  raceEntry?: boolean; // arena -> racer order (real tx, not a data-provider purchase)
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
  /** Tamper-proof signed accuracy scorecards (one per graded agent), attached shortly after settle. */
  scorecards?: SignedScorecard[];
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
interface LeaderRow {
  id: string;
  label: string;
  wins: number;
  rounds: number;
  sumError: number;
  avgError: number;
  /** Confidence-adjusted score used for ranking. Lower is better. */
  trustedScore?: number;
  /** Recent, recency-weighted average error from retained history. */
  recentAvgError?: number;
  /** Recency-weighted retained rounds. Total rounds remains the canonical sample size. */
  effectiveRounds?: number;
  /** 0..1 evidence confidence from total graded rounds. */
  confidence?: number;
  /** The explicit uncertainty add-on inside trustedScore. */
  uncertainty?: number;
}
interface JoinedRacer {
  serviceId: string;
  label: string;
  payout?: string;
  /** Optional authenticated owner. When present, grid results build the same wallet-bound record
   *  that the paid CROO credential service certifies. */
  ownerWallet?: string;
  /** True when ownerWallet matched CROO's public wallet for this service at join/update time. */
  ownerVerified?: boolean;
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
  leaderboard: LeaderRow[];
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
  /** Honest unit-economics: what the arena SPENDS on hires vs REVENUE from external agents paying to be
   *  scored. Kept separate so spend is never presented as traction; revenue is real external orders only. */
  economics?: { spendUSDC: number; revenueUSDC: number; benchmarkOrders: number; rounds: number };
  /** External agents' accumulated (free-submitted, Pyth-graded) track records: the field a paid
   *  credential is minted from. Free intake in, paid mint out. */
  externalBoard?: {
    agent: string;
    wallet: string;
    serviceId?: string;
    label: string;
    rounds: number;
    effectiveRounds: number;
    avgError: number;
    trustedError: number;
    bestRank: number;
    wins: number;
    confidence: number;
    cardClass: string;
    scoreVersion: string;
    certifiedAtSec?: number;
    certificationOrderId?: string;
    certificationTxHash?: string;
    fromRound?: string;
    toRound?: string;
  }[];
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
const BET_DECAY_FRACTION = Math.min(1, Math.max(0.1, Number(process.env.BET_DECAY_FRACTION ?? '0.78')));
const BET_MIN_MULTIPLIER = Math.min(1.9, Math.max(1.05, Number(process.env.BET_MIN_MULTIPLIER ?? '1.25')));
// Cold-start subsidy is BOUNDED: at most N free races/day from our treasury (each ~0.6 USDC of data
// hires). Beyond it, "start" is paused till tomorrow (UTC) — a bot/spam can never drain us.
const DAILY_RACES = Math.max(1, Number(process.env.ARENA_DAILY_RACES ?? '2'));
// Bounded field: at most this many agents race per round (0 = no cap). Personas always race; the
// remaining slots rotate through community agents by "least-recently-raced" so the treasury cost is
// fixed regardless of how many agents join, and every agent still races within a bounded window.
const MAX_RACERS = Math.max(0, Number(process.env.ARENA_MAX_RACERS_PER_ROUND ?? '8'));
const RACER_PRICE_CAP_SERVICE_IDS = new Set(
  (process.env.ARENA_RACER_PRICE_CAPS ?? '')
    .split(',')
    .map((x) => x.split('=')[0]?.trim().toLowerCase() ?? '')
    .filter(Boolean),
);
const DISABLED_RACER_SERVICE_IDS = new Set(
  (process.env.ARENA_DISABLED_RACER_SERVICE_IDS ?? '')
    .split(',')
    .map((x) => x.trim().toLowerCase())
    .filter((x) => x && !RACER_PRICE_CAP_SERVICE_IDS.has(x)),
);
const BASESCAN = 'https://basescan.org/tx/';

const state: ArenaState = { status: 'idle', asset: 'ETH', priceSeries: [], history: [], leaderboard: [], feed: [], predictStats: { total: 0, correct: 0, visitors: 0 } };
const clients = new Set<import('node:http').ServerResponse>();
let competitors: Competitor[] = [];
let metaById = new Map<string, { label: string; blurb: string }>();
// Rotation for the bounded field: a FIFO queue of community agent ids (front = highest priority to
// race next). Each round takes from the front; the ones that raced go to the back, the benched stay
// at the front → strict round-robin, so over a cycle every agent races the same number of times.
let rotationQueue: string[] = [];

// Benchmark service: external agents PAY to MINT a signed credential over the ACCUMULATED record they
// built via the free /api/submit intake. This is the only paid credential path; no more one-round mint.
let benchmarkRevenueUSDC = 0;
let benchmarkOrders = 0;

/** Pure: grade one external prediction against the realized move, ranked among the round field + itself. */
function benchmarkRank(prediction: number, actual: number, fieldErrors: number[]): { errorUsd: number; rank: number; field: number } {
  const errorUsd = Math.abs(prediction - actual);
  const better = fieldErrors.filter((e) => e < errorUsd).length; // strictly-closer agents rank ahead
  return { errorUsd, rank: better + 1, field: fieldErrors.length + 1 };
}

/** Publish honest unit-economics: our SPEND on hires (data + racer, plus ~10% on-chain escrow fee) vs
 *  REVENUE from external agents paying to be scored. Revenue is real delivered orders only; never faked. */
function refreshEconomics(): void {
  const PRICE = Number(process.env.DISCOVERY_MAX_PRICE_USDC) || 0.1;
  // SPEND = only the data hires our personas buy (the real input cost). Minimum-price race-entry orders
  // are onboarding friction, not the revenue model, so they stay out of data spend. Revenue is paid scorecards.
  let hires = 0;
  for (const h of state.history) for (const e of h.edges ?? []) if (!e.ours && !e.raceEntry) hires += 1;
  const spendUSDC = Math.round(hires * PRICE * 1.1 * 100) / 100; // data-hire notional + ~10% escrow fee
  state.economics = {
    spendUSDC,
    revenueUSDC: Math.round(benchmarkRevenueUSDC * 100) / 100,
    benchmarkOrders,
    rounds: state.history.length,
  };
}
// Community agents that joined via /api/competitor — PERSISTED (Upstash) so the open roster survives
// restarts/redeploys; re-instantiated as remote competitors at boot.
let joinedRoster: JoinedRacer[] = [];
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

function isDisabledRacerService(serviceId: string): boolean {
  return DISABLED_RACER_SERVICE_IDS.has(serviceId.trim().toLowerCase());
}

function cleanRacerLabel(raw: string | undefined, serviceId: string): string {
  const fallback = `agent-${serviceId.slice(0, 4)}`;
  const cleaned = String(raw || fallback)
    .replace(/[^\w -]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\*+$/g, '')
    .trim()
    .slice(0, 24)
    .trim();
  return cleaned || fallback;
}

function racerLabelKey(label: string): string {
  return label.replace(/\*+$/g, '').trim().toLowerCase();
}

function racerOwnerKey(ownerWallet?: string): string {
  if (!ownerWallet) return '';
  try {
    return normalizeWallet(ownerWallet).toLowerCase();
  } catch {
    return ownerWallet.trim().toLowerCase();
  }
}

function dedupeJoinedRoster(): boolean {
  if (!joinedRoster.length) return false;
  const seenKeys = new Set<string>();
  const seenServices = new Set<string>();
  const next: JoinedRacer[] = [];
  let changed = false;

  for (let i = joinedRoster.length - 1; i >= 0; i--) {
    const row = { ...joinedRoster[i] };
    const cleanLabel = cleanRacerLabel(row.label, row.serviceId);
    if (cleanLabel !== row.label) {
      row.label = cleanLabel;
      changed = true;
    }
    const serviceKey = row.serviceId.toLowerCase();
    const ownerKey = racerOwnerKey(row.ownerWallet);
    const identityKey = ownerKey ? `wallet:${ownerKey}` : `label:${racerLabelKey(row.label)}`;
    if (seenServices.has(serviceKey) || seenKeys.has(identityKey)) {
      changed = true;
      continue;
    }
    seenServices.add(serviceKey);
    seenKeys.add(identityKey);
    next.unshift(row);
  }

  if (next.length !== joinedRoster.length) changed = true;
  joinedRoster = next.slice(-50);
  return changed;
}

function visibleCompetitorsForRound(comps: CompetitorView[] = []): CompetitorView[] {
  const byKey = new Map<string, CompetitorView>();
  const order: string[] = [];
  for (const c of comps) {
    const key = racerLabelKey(c.id || c.label);
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, {
      ...c,
      id: c.id.replace(/\*+$/g, ''),
      label: c.label.replace(/\*+$/g, ''),
    });
  }
  return order.map((key) => byKey.get(key)!);
}

function removeCommunityCompetitor(idOrServiceId: string, reason: string, opts: { persist?: boolean } = {}): boolean {
  const remote = competitors.find((c): c is Extract<Competitor, { kind: 'remote' }> =>
    c.kind === 'remote' && (c.id === idOrServiceId || c.serviceId.toLowerCase() === idOrServiceId.toLowerCase())
  );
  const serviceId = remote?.serviceId ?? idOrServiceId;
  const removedLabels = new Set<string>();
  for (const j of joinedRoster) {
    if (j.label === idOrServiceId || j.serviceId.toLowerCase() === serviceId.toLowerCase()) removedLabels.add(j.label);
  }
  if (remote) removedLabels.add(remote.id);

  const beforeRoster = joinedRoster.length;
  const beforeCompetitors = competitors.length;
  joinedRoster = joinedRoster.filter((j) => j.label !== idOrServiceId && j.serviceId.toLowerCase() !== serviceId.toLowerCase());
  competitors = competitors.filter((c) =>
    !(c.kind === 'remote' && (c.id === idOrServiceId || c.serviceId.toLowerCase() === serviceId.toLowerCase()))
  );
  rotationQueue = rotationQueue.filter((id) => id !== idOrServiceId && !removedLabels.has(id));
  for (const label of removedLabels) {
    metaById.delete(label);
    clearAgentPayout(label);
  }
  const removed = beforeRoster !== joinedRoster.length || beforeCompetitors !== competitors.length || removedLabels.size > 0;
  if (removed) {
    refreshRoster();
    pushFeed(`${[...removedLabels][0] ?? idOrServiceId} removed from the grid. ${reason}`);
    if (opts.persist !== false) saveHistory();
  }
  return removed;
}

function pruneDisabledCommunityRacers(opts: { persist?: boolean } = {}): number {
  let removed = 0;
  for (const j of [...joinedRoster]) {
    if (!isDisabledRacerService(j.serviceId)) continue;
    if (removeCommunityCompetitor(j.serviceId, 'Race service is disabled until it is compatible again.', opts)) removed++;
  }
  return removed;
}
let remoteBuyer: Awaited<ReturnType<typeof createRemoteBuyer>> | null = null;

// FREE external intake (the product intake): an external agent PUSHES its prediction each round for
// free (no payment, no CAP order), gets graded vs Pyth, and accumulates a track record under an
// authenticated wallet. The paid MINT (a real CAP order) later certifies that wallet-bound record.
interface FreeSubmission { wallet: string; label: string; prediction: number; reasonHash: string; submitMs: number; nonce: string; }
let freeSubmissions: FreeSubmission[] = [];
interface RecordEntry { roundId: string; label?: string; prediction: number; actual: number; errorUsd: number; rank: number; field: number; settledAtSec: number; }
interface CertifiedCard {
  wallet: string;
  serviceId: string;
  label: string;
  cardClass: string;
  rounds: number;
  trustedErrorUsd: number;
  certifiedAtSec: number;
  orderId: string;
  txHash?: string;
}
const externalRecords = new Map<string, RecordEntry[]>();
const certifiedCards = new Map<string, CertifiedCard>();
const SCORE_VERSION = '2026-07-v1';

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function latestCertification(wallet: string): CertifiedCard | undefined {
  return certifiedCards.get(normalizeWallet(wallet).toLowerCase());
}

function credentialIdentityForWallet(wallet: string, recs: RecordEntry[], serviceIdHint = ''): { serviceId: string; label: string } {
  const addr = normalizeWallet(wallet);
  const hint = serviceIdHint.trim();
  const linked = joinedRoster.find((j) =>
    hint
      ? j.serviceId.toLowerCase() === hint.toLowerCase()
      : j.ownerWallet?.toLowerCase() === addr.toLowerCase()
  );
  const latestLabel = [...recs].reverse().find((r) => r.label)?.label;
  return {
    serviceId: linked?.serviceId ?? hint,
    label: linked?.label || latestLabel || `${addr.slice(0, 6)}…${addr.slice(-4)}`,
  };
}

function credentialScore(recs: RecordEntry[]): Pick<Credential, 'effectiveRounds' | 'trustedErrorUsd' | 'confidence' | 'cardClass'> {
  const rounds = recs.length;
  if (!rounds) return { effectiveRounds: 0, trustedErrorUsd: 0, confidence: 0, cardClass: 'D' };
  const avgErrorUsd = recs.reduce((s, r) => s + r.errorUsd, 0) / rounds;
  const effectiveRounds = rounds;
  // Small-sample penalty: a 3-round streak should look promising, not proven.
  const uncertaintyPenalty = 1.25 / Math.sqrt(rounds);
  const trustedErrorUsd = avgErrorUsd + uncertaintyPenalty;
  const evidenceConfidence = 100 * (1 - Math.exp(-rounds / 45));
  const confidence = Math.round(clamp(evidenceConfidence, rounds >= 1 ? 8 : 0, 95));
  const accuracyScore = clamp(1 - trustedErrorUsd / 3, 0, 1) * 100;
  const composite = confidence * 0.58 + accuracyScore * 0.42;
  let cardClass = 'D';
  if (rounds >= 150 && composite >= 86) cardClass = 'S';
  else if (rounds >= 50 && composite >= 70) cardClass = 'A';
  else if (rounds >= 15 && composite >= 52) cardClass = 'B';
  else if (rounds >= 5) cardClass = 'C';
  return {
    effectiveRounds,
    trustedErrorUsd: Math.round(trustedErrorUsd * 1_000_000) / 1_000_000,
    confidence,
    cardClass,
  };
}

/** Publish the accumulated external track records (the field a credential is minted from). */
function refreshExternalBoard(): void {
  state.externalBoard = [...externalRecords.entries()]
    .map(([wallet, recs]) => {
      const n = recs.length;
      const avgError = n ? recs.reduce((s, r) => s + r.errorUsd, 0) / n : 0;
      const wins = recs.filter((r) => r.rank === 1).length;
      const identity = credentialIdentityForWallet(wallet, recs);
      const score = credentialScore(recs);
      const cert = latestCertification(wallet);
      return {
        agent: wallet,
        wallet,
        serviceId: identity.serviceId || undefined,
        label: identity.label,
        rounds: n,
        effectiveRounds: score.effectiveRounds,
        avgError: round2(avgError),
        trustedError: round2(score.trustedErrorUsd),
        bestRank: n ? Math.min(...recs.map((r) => r.rank)) : 0,
        wins,
        confidence: score.confidence,
        cardClass: score.cardClass,
        scoreVersion: SCORE_VERSION,
        certifiedAtSec: cert?.certifiedAtSec,
        certificationOrderId: cert?.orderId,
        certificationTxHash: cert?.txHash,
        fromRound: recs[0]?.roundId,
        toRound: recs[n - 1]?.roundId,
      };
    })
    .sort((a, b) => a.trustedError - b.trustedError || b.confidence - a.confidence);
}

function normalizeWallet(raw: string): string {
  return ethers.getAddress(String(raw || '').trim());
}

function submitMessage(input: { wallet: string; label: string; prediction: number; nonce: string }): string {
  return [
    'Axion Clash free forecast',
    `wallet:${normalizeWallet(input.wallet)}`,
    `label:${input.label}`,
    `prediction:${input.prediction.toFixed(6)}`,
    `nonce:${input.nonce}`,
  ].join('\n');
}

function mintMessage(input: { wallet: string; nonce: string; serviceId?: string }): string {
  return [
    'Axion Clash credential mint',
    `wallet:${normalizeWallet(input.wallet)}`,
    `serviceId:${input.serviceId?.trim() || ''}`,
    `nonce:${input.nonce}`,
  ].join('\n');
}

type CredentialMintCheck =
  | { ok: true; wallet: string; serviceId: string; credential: Credential }
  | { ok: false; error: string; messageToSign?: string; expectedWallet?: string; receivedWallet?: string };

function racerJoinMessage(input: { wallet: string; serviceId: string; nonce: string }): string {
  return [
    'Axion Clash racer wallet',
    `wallet:${normalizeWallet(input.wallet)}`,
    `serviceId:${input.serviceId}`,
    `nonce:${input.nonce}`,
  ].join('\n');
}

interface PublicServiceItem {
  serviceId?: string;
  agentId?: string;
}

interface PublicAgentResponse {
  agent?: {
    walletAddress?: string;
  };
}

const CROO_PUBLIC_API = 'https://api.croo.network/backend/v1';
const CROO_PUBLIC_ORIGIN = 'https://agent.croo.network';
const CROO_OWNER_CACHE_MS = 10 * 60_000;
const publicOwnerCache = new Map<string, { at: number; wallet: string | null }>();

async function crooPublicOwnerWalletForService(serviceId: string): Promise<string | null> {
  const key = serviceId.toLowerCase();
  const cached = publicOwnerCache.get(key);
  if (cached && Date.now() - cached.at < CROO_OWNER_CACHE_MS) return cached.wallet;

  let agentId = '';
  for (let page = 1; page <= 50 && !agentId; page++) {
    const r = await fetch(`${CROO_PUBLIC_API}/public/services?page=${page}`, {
      headers: { Origin: CROO_PUBLIC_ORIGIN },
    });
    if (!r.ok) break;
    const json = (await r.json()) as { items?: PublicServiceItem[]; total?: string | number };
    const items = json.items ?? [];
    const hit = items.find((i) => i.serviceId?.toLowerCase() === key);
    if (hit?.agentId) {
      agentId = hit.agentId;
      break;
    }
    if (!items.length) break;
    const total = Number(json.total);
    if (Number.isFinite(total) && total > 0 && page >= Math.ceil(total / items.length)) break;
  }

  let wallet: string | null = null;
  if (agentId) {
    const r = await fetch(`${CROO_PUBLIC_API}/public/agents/${agentId}`, {
      headers: { Origin: CROO_PUBLIC_ORIGIN },
    });
    if (r.ok) {
      const json = (await r.json()) as PublicAgentResponse;
      const raw = json.agent?.walletAddress;
      if (raw) {
        try { wallet = normalizeWallet(raw); } catch { wallet = null; }
      }
    }
  }

  publicOwnerCache.set(key, { at: Date.now(), wallet });
  return wallet;
}

function buildCredential(wallet: string, serviceIdHint = ''): Credential | null {
  const addr = normalizeWallet(wallet);
  const recs = externalRecords.get(addr.toLowerCase()) ?? [];
  if (!recs.length) return null;
  const avgErrorUsd = recs.reduce((s, r) => s + r.errorUsd, 0) / recs.length;
  const identity = credentialIdentityForWallet(addr, recs, serviceIdHint);
  const score = credentialScore(recs);
  return {
    agent: addr,
    serviceId: identity.serviceId,
    label: identity.label,
    scoreVersion: SCORE_VERSION,
    rounds: recs.length,
    effectiveRounds: score.effectiveRounds,
    avgErrorUsd: Math.round(avgErrorUsd * 1_000_000) / 1_000_000,
    trustedErrorUsd: score.trustedErrorUsd,
    bestRank: Math.min(...recs.map((r) => r.rank)),
    wins: recs.filter((r) => r.rank === 1).length,
    confidence: score.confidence,
    cardClass: score.cardClass,
    fromRound: recs[0].roundId,
    toRound: recs[recs.length - 1].roundId,
    issuedAtSec: Math.round(Date.now() / 1000),
  };
}

async function validateCredentialMintRequirements(raw: string): Promise<CredentialMintCheck> {
  let req: { wallet?: string; address?: string; agent?: string; serviceId?: string; prediction?: number; nonce?: string; signature?: string } = {};
  try {
    req = JSON.parse(raw || '{}');
  } catch {
    return { ok: false, error: 'requirements must be valid JSON' };
  }
  if (req.prediction != null) {
    return {
      ok: false,
      error: 'one-round benchmark is deprecated. First POST /api/submit for free with a wallet signature, then certify with requirements {"wallet":"0x...","serviceId":"","nonce":"...","signature":"..."}',
    };
  }
  const walletRaw = req.wallet || req.address || (/^0x[0-9a-fA-F]{40}$/.test(String(req.agent || '')) ? req.agent : '');
  let wallet = '';
  try {
    wallet = normalizeWallet(String(walletRaw || ''));
  } catch {
    return { ok: false, error: 'requirements must include {"wallet":"0x..."} for the record owner' };
  }
  if (!wallet) return { ok: false, error: 'requirements must include {"wallet":"0x..."} for the record owner' };

  const nonce = String(req.nonce || '').slice(0, 96);
  if (!nonce) return { ok: false, error: 'requirements must include nonce + wallet signature for the card owner' };

  const serviceId = String(req.serviceId || '').trim();
  if (serviceId && !/^[0-9a-f-]{36}$/i.test(serviceId)) {
    return { ok: false, error: 'serviceId must be a CROO service UUID when provided' };
  }

  const msg = mintMessage({ wallet, nonce, serviceId });
  let recovered = '';
  try {
    recovered = ethers.verifyMessage(msg, String(req.signature || ''));
  } catch {
    return { ok: false, error: 'invalid wallet signature for credential mint', messageToSign: msg };
  }
  if (recovered.toLowerCase() !== wallet.toLowerCase()) {
    return { ok: false, error: 'invalid wallet signature for credential mint', messageToSign: msg };
  }

  if (serviceId) {
    const publicOwner = await crooPublicOwnerWalletForService(serviceId);
    const linked = joinedRoster.find((j) => j.serviceId.toLowerCase() === serviceId.toLowerCase());
    if (publicOwner && publicOwner.toLowerCase() !== wallet.toLowerCase()) {
      return {
        ok: false,
        error: 'serviceId owner does not match the signed wallet',
        expectedWallet: publicOwner,
        receivedWallet: wallet,
      };
    }
    if (!publicOwner && linked?.ownerWallet && linked.ownerWallet.toLowerCase() !== wallet.toLowerCase()) {
      return {
        ok: false,
        error: 'serviceId is already linked to a different Axion card wallet',
        expectedWallet: linked.ownerWallet,
        receivedWallet: wallet,
      };
    }
  }

  const credential = buildCredential(wallet, serviceId);
  if (!credential) {
    return { ok: false, error: 'no graded Axion record for this wallet yet. Submit forecasts free via POST /api/submit first.' };
  }
  if (!process.env.HOUSE_EOA_PRIVATE_KEY) return { ok: false, error: 'credential signer is not configured' };
  return { ok: true, wallet, serviceId, credential };
}

function ownerWalletForRacer(competitorId: string): string | undefined {
  return joinedRoster.find((j) => j.label === competitorId)?.ownerWallet;
}

function appendExternalRecord(wallet: string, entry: RecordEntry): boolean {
  const key = normalizeWallet(wallet).toLowerCase();
  const rec = externalRecords.get(key) ?? [];
  if (rec.some((r) => r.roundId === entry.roundId)) return false;
  rec.push(entry);
  externalRecords.set(key, rec.slice(-100));
  return true;
}

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

/**
 * Pick who races THIS round under the bounded-field cap, and advance the rotation. Personas (kind
 * 'local') always race — they are the arena's own show. The remaining slots (MAX_RACERS - personas) go
 * to the front of a FIFO queue of community agents; the ones that race move to the back and the benched
 * stay in front, so it is a strict round-robin: over a cycle every agent races the same number of times,
 * no one is permanently benched, and it is deterministic. With the cap off (MAX_RACERS = 0) or a field
 * that already fits, everyone races. This keeps the per-round hire cost fixed no matter how many join.
 * MUTATES rotationQueue (call once per round).
 */
function pickRacers(all: Competitor[]): Competitor[] {
  const personas = all.filter((c) => c.kind === 'local');
  const remotes = all.filter((c) => c.kind === 'remote');
  const remoteById = new Map(remotes.map((c) => [c.id, c] as const));
  // Sync the queue with the live roster: drop departed agents, and add newcomers at the FRONT so a
  // freshly joined agent races on the very next round (fast first race).
  rotationQueue = rotationQueue.filter((id) => remoteById.has(id));
  for (const c of remotes) if (!rotationQueue.includes(c.id)) rotationQueue.unshift(c.id);

  const remoteSlots = MAX_RACERS > 0 ? Math.max(0, MAX_RACERS - personas.length) : remotes.length;
  if (remotes.length <= remoteSlots) return [...personas, ...remotes]; // whole field fits — everyone races

  const racingIds = rotationQueue.slice(0, remoteSlots);
  rotationQueue = [...rotationQueue.slice(remoteSlots), ...racingIds]; // benched stay front, racers to back
  return [...personas, ...racingIds.map((id) => remoteById.get(id)!)];
}

/** Append a real store-evolution event (newest first, capped). No causation, no fabrication. */
function pushStoreEvent(kind: 'joined' | 'adopted', text: string, ts = Date.now()): void {
  storeEvents.unshift({ ts, kind, text });
  storeEvents = storeEvents.slice(0, 14);
  if (state.dataMarket) state.dataMarket.events = storeEvents;
}

function primeProviderHealth(): void {
  const rows = [...state.history].sort((a, b) => Date.parse(a.settledAt) - Date.parse(b.settledAt));
  for (const h of rows) {
    const at = Date.parse(h.settledAt) || Date.now();
    for (const e of h.edges ?? []) {
      if (!e.ours && e.serviceId && typeof e.latencyMs === 'number') {
        markProviderSucceeded(e.serviceId, e.latencyMs, at);
      }
    }
  }
}

/** Record first-time (agent → provider) hires from a settled round as 'adopted' events (third
 *  parties only — adopting our own seed agents isn't ecosystem motion). Honest: only genuinely
 *  new pairs emit; the pair set is persisted + baseline-seeded so nothing double-counts. */
function detectAdoptions(edges: { competitor: string; label: string; ours: boolean; raceEntry?: boolean }[], ts: number, emit: boolean): void {
  for (const e of edges) {
    if (e.ours || e.raceEntry) continue; // race-entry orders aren't data-agent adoptions
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
  // Only OUR actionable problems raise the user-facing health banner: an agent wallet out of USDC, or
  // a seed agent removed from CROO. A third-party provider being slow/rejecting is normal flakiness
  // (the round falls back gracefully) and must NOT alarm spectators; it is surfaced in the feed only.
  return /insufficient|balance|funds|AGENT_NOT_FOUND|requester agent not found/i.test(reason);
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
  refreshTrustedLeaderboard();
  refreshPredictStats();
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
}

function refreshTrustedLeaderboard(): void {
  if (!state.leaderboard.length) return;
  const now = Date.now();
  const halfLifeMs = 14 * 24 * 60 * 60 * 1000;
  const priorRounds = 12;

  const observedErrors: number[] = [];
  const recent = new Map<string, { weightedError: number; weight: number }>();
  for (const h of state.history) {
    const ageMs = Math.max(0, now - (Date.parse(h.settledAt) || now));
    const w = Math.pow(0.5, ageMs / halfLifeMs);
    for (const c of h.competitors ?? []) {
      if (!c.id || !Number.isFinite(c.error)) continue;
      const err = Number(c.error);
      observedErrors.push(err);
      const row = recent.get(c.id) ?? { weightedError: 0, weight: 0 };
      row.weightedError += err * w;
      row.weight += w;
      recent.set(c.id, row);
    }
  }

  const globalMean = observedErrors.length
    ? observedErrors.reduce((s, x) => s + x, 0) / observedErrors.length
    : state.leaderboard.reduce((s, r) => s + (Number(r.avgError) || 0), 0) / Math.max(1, state.leaderboard.length);
  const variance = observedErrors.length > 1
    ? observedErrors.reduce((s, x) => s + Math.pow(x - globalMean, 2), 0) / (observedErrors.length - 1)
    : Math.max(0.25, globalMean * 0.5);
  const globalStd = Math.max(0.25, Math.sqrt(variance));

  for (const row of state.leaderboard) {
    const r = recent.get(row.id);
    const effectiveRounds = r?.weight ?? 0;
    const recentAvgError = r && r.weight > 0 ? r.weightedError / r.weight : row.avgError;
    const evidence = Math.max(0, Number(row.rounds) || 0);
    const confidence = evidence / (evidence + priorRounds);
    const blendedAvg = effectiveRounds > 0
      ? row.avgError * 0.65 + recentAvgError * 0.35
      : row.avgError;
    const uncertainty = 1.28 * globalStd / Math.sqrt(evidence + 1);
    row.recentAvgError = Math.round(recentAvgError * 1000) / 1000;
    row.effectiveRounds = Math.round(effectiveRounds * 10) / 10;
    row.confidence = Math.round(confidence * 1000) / 1000;
    row.uncertainty = Math.round(uncertainty * 1000) / 1000;
    row.trustedScore = Math.round((blendedAvg + uncertainty) * 1000) / 1000;
  }

  // Rank by confidence-adjusted accuracy, not raw avgError. This prevents tiny samples from looking
  // stronger than long records unless their edge is large enough to overcome uncertainty.
  state.leaderboard.sort((a, b) =>
    (a.trustedScore ?? a.avgError) - (b.trustedScore ?? b.avgError) ||
    b.rounds - a.rounds ||
    b.wins - a.wins,
  );
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
  refreshTrustedLeaderboard();
}

function rebuildLeaderboardFromHistory(): void {
  const rows = new Map<string, { id: string; label: string; wins: number; rounds: number; sumError: number; avgError: number }>();
  for (const h of state.history) {
    for (const c of h.competitors ?? []) {
      if (!c.id || !Number.isFinite(c.error)) continue;
      const row = rows.get(c.id) ?? {
        id: c.id,
        label: c.label || personaMeta(c.id).label,
        wins: 0,
        rounds: 0,
        sumError: 0,
        avgError: 0,
      };
      row.rounds += 1;
      row.wins += c.isWinner ? 1 : 0;
      row.sumError += Number(c.error);
      row.avgError = row.sumError / row.rounds;
      rows.set(c.id, row);
    }
  }
  if (!rows.size) return;
  state.leaderboard = [...rows.values()];
  refreshTrustedLeaderboard();
}

const SEED_FILE = process.env.ARENA_SEED_FILE ?? 'arena-seed.json';

async function loadHistory(): Promise<void> {
  // Durable Upstash store first (survives restarts, free); else runtime file; else committed seed so
  // a FRESH deploy still shows a populated, verifiable world (real past rounds) — never a dead arena.
  type Persisted = {
    history?: HistoryItem[]; leaderboard?: ArenaState['leaderboard']; predictStats?: ArenaState['predictStats'];
    knownProviderIds?: string[]; seenPairs?: string[]; storeEvents?: typeof storeEvents;
    joinedRoster?: JoinedRacer[];
    racesToday?: number; racesDayKey?: string; nextRoundAtMs?: number;
    externalRecords?: [string, RecordEntry[]][];
    certifiedCards?: [string, CertifiedCard][];
  };
  const restoreMeta = (d: Persisted): void => {
    for (const id of d.knownProviderIds ?? []) knownProviderIds.add(id);
    for (const p of d.seenPairs ?? []) seenPairs.add(p);
    for (const [agent, recs] of d.externalRecords ?? []) externalRecords.set(agent, recs); // durable track records
    for (const [wallet, cert] of d.certifiedCards ?? []) certifiedCards.set(wallet, cert);
    if (d.storeEvents?.length) storeEvents = d.storeEvents.slice(0, 14);
    if (d.joinedRoster?.length) joinedRoster = d.joinedRoster.slice(0, 50);
    refreshExternalBoard();
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
  // The leaderboard is a derived credential surface, not source state. Rebuild it from verified round
  // history so past pruning bugs cannot erase an agent's earned record (e.g. agent-b525).
  rebuildLeaderboardFromHistory();
  const deduped = dedupeJoinedRoster();
  const disabled = pruneDisabledCommunityRacers({ persist: false });
  if (deduped || disabled) {
    if (deduped) console.log('[arena-server] deduped durable community roster');
    if (disabled) console.log(`[arena-server] pruned ${disabled} disabled community racer(s) from durable roster`);
    saveHistory();
  }
  // First ever run (no persisted timeline): backfill the evolution view from REAL history — the
  // chronological first hire of each third-party provider by each agent. Oldest→newest so the
  // newest adoptions sort to the top. Not fabricated: every entry is a real settled on-chain hire.
  if (!storeEvents.length && seenPairs.size === 0) {
    for (const h of [...state.history].sort((a, b) => Date.parse(a.settledAt) - Date.parse(b.settledAt))) {
      detectAdoptions((h.edges ?? []).map((e) => ({ competitor: e.competitor, label: e.label, ours: e.ours, raceEntry: e.raceEntry })), Date.parse(h.settledAt) || Date.now(), true);
    }
  } else {
    // Ensure every historical pair is marked seen (so we never re-emit an old adoption as "new").
    for (const h of state.history) detectAdoptions((h.edges ?? []).map((e) => ({ competitor: e.competitor, label: e.label, ours: e.ours, raceEntry: e.raceEntry })), 0, false);
  }
  primeProviderHealth();
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
      competitors: visibleCompetitorsForRound(last.competitors ?? []),
    };
    for (const e of (last.edges ?? []).slice().reverse()) {
      pushFeed(e.raceEntry ? `Arena hired ${e.label} to race. Round settled` : `${e.label} hired. Round settled`, BASESCAN + e.payTxHash);
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
    externalRecords: [...externalRecords.entries()], // durable track records (the credential base)
    certifiedCards: [...certifiedCards.entries()],
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
        if (e.ours || e.raceEntry) continue; // data providers only, not race-entry orders
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
  const benchmarkId = process.env.AXION_BENCHMARK_SERVICE_ID; // pay-to-be-scored service (optional)
  const raceEngineId = process.env.AXION_RACE_ENGINE_SERVICE_ID; // free builder onboarding kit (optional)
  if (!key || (!serviceId && !benchmarkId && !raceEngineId)) return;
  const client = new AgentClient({ baseURL: cfg.baseURL, wsURL: cfg.wsURL }, key);
  try { await client.connectWebSocket(); } catch { /* WS just keeps "online" status */ }
  if (serviceId) console.log(`[axion] forecast provider online on service ${serviceId}`);
  if (benchmarkId) console.log(`[axion] benchmark provider online on service ${benchmarkId}`);
  if (raceEngineId) console.log(`[axion] race-engine kit provider online on service ${raceEngineId}`);
  const done = new Set<string>();
  const inFlight = new Set<string>();
  const tick = async (): Promise<void> => {
    try {
      const negs = await client.listNegotiations({ role: 'provider', status: 'pending', page: 1, pageSize: 20 });
      for (const n of negs) {
        if (n.serviceId !== serviceId && n.serviceId !== benchmarkId && n.serviceId !== raceEngineId) continue;
        try {
          if (n.serviceId === benchmarkId) {
            const neg = await client.getNegotiation(n.negotiationId);
            const checked = await validateCredentialMintRequirements(neg.requirements ?? '{}');
            if (!checked.ok) {
              await client.rejectNegotiation(n.negotiationId, checked.error);
              console.warn(`[credential] rejected negotiation ${n.negotiationId}: ${checked.error}`);
              continue;
            }
          }
          await client.acceptNegotiation(n.negotiationId);
          const kind = n.serviceId === benchmarkId ? 'benchmark' : n.serviceId === raceEngineId ? 'race-engine' : 'hire';
          console.log(`[axion] accepted ${kind} ${n.negotiationId}`);
        } catch { /* retry next tick */ }
      }
      const orders = await client.listOrders({ role: 'provider', status: 'paid', page: 1, pageSize: 20 });
      for (const o of orders) {
        // ---- Flagship forecast service: deliver the consensus forecast immediately ----
        if (o.serviceId === serviceId) {
          if (done.has(o.orderId) || inFlight.has(o.orderId)) continue;
          inFlight.add(o.orderId);
          void (async () => {
            try {
              const neg = await client.getNegotiation(o.negotiationId);
              await client.deliverOrder(o.orderId, { deliverableType: DeliverableType.Text, deliverableText: consensusForecast(neg.requirements ?? '{}') });
              done.add(o.orderId);
              console.log(`[axion] delivered consensus forecast ${o.orderId}`);
            } catch (err) {
              console.warn('[axion] forecast delivery failed: ' + (err as Error).message);
            } finally { inFlight.delete(o.orderId); }
          })();
          continue;
        }
        // ---- Free Race Engine Kit: store-native onboarding funnel. It does not mutate the builder's
        // backend; it delivers the exact handler contract, prompt, and registration payload.
        if (o.serviceId === raceEngineId) {
          if (done.has(o.orderId) || inFlight.has(o.orderId)) continue;
          inFlight.add(o.orderId);
          void (async () => {
            try {
              const neg = await client.getNegotiation(o.negotiationId);
              await client.deliverOrder(o.orderId, {
                deliverableType: DeliverableType.Text,
                deliverableText: raceEngineKit(neg.requirements ?? '{}'),
              });
              done.add(o.orderId);
              console.log(`[axion] delivered race-engine kit ${o.orderId}`);
            } catch (err) {
              console.warn('[axion] race-engine kit delivery failed: ' + (err as Error).message);
            } finally { inFlight.delete(o.orderId); }
          })();
          continue;
        }
        // ---- Benchmark service: MINT the accumulated, wallet-bound signed credential now.
        // The track record is built for free via /api/submit; this paid CAP order certifies it.
        if (o.serviceId === benchmarkId) {
          if (done.has(o.orderId) || inFlight.has(o.orderId)) continue;
          inFlight.add(o.orderId);
          void (async () => {
            try {
              const neg = await client.getNegotiation(o.negotiationId);
              const checked = await validateCredentialMintRequirements(neg.requirements ?? '{}');
              if (!checked.ok) {
                await client.deliverOrder(o.orderId, {
                  deliverableType: DeliverableType.Text,
                  deliverableText: JSON.stringify({
                    error: checked.error,
                    ...(checked.messageToSign ? { messageToSign: checked.messageToSign } : {}),
                    ...(checked.expectedWallet ? { expectedWallet: checked.expectedWallet } : {}),
                    ...(checked.receivedWallet ? { receivedWallet: checked.receivedWallet } : {}),
                  }),
                });
                done.add(o.orderId);
                console.warn(`[credential] rejected paid order ${o.orderId}: ${checked.error}`);
                return;
              }
              const scoreKey = process.env.HOUSE_EOA_PRIVATE_KEY;
              if (!scoreKey) throw new Error('HOUSE_EOA_PRIVATE_KEY required to sign credentials');
              const signed = await signCredential(checked.credential, scoreKey);
              const delivered = await client.deliverOrder(o.orderId, {
                deliverableType: DeliverableType.Text,
                deliverableText: JSON.stringify({ type: 'axion.accuracyCredential.v1', credential: signed }),
              });
              done.add(o.orderId);
              const certifiedAtSec = Math.round(Date.now() / 1000);
              certifiedCards.set(checked.wallet.toLowerCase(), {
                wallet: checked.wallet,
                serviceId: signed.serviceId,
                label: signed.label,
                cardClass: signed.cardClass,
                rounds: signed.rounds,
                trustedErrorUsd: signed.trustedErrorUsd,
                certifiedAtSec,
                orderId: o.orderId,
                txHash: delivered.txHash || o.deliverTxHash || o.payTxHash || undefined,
              });
              const priceUSDC = Number(o.price) / 1_000_000 || 0;
              benchmarkRevenueUSDC += priceUSDC;
              benchmarkOrders += 1;
              refreshEconomics();
              refreshExternalBoard();
              saveHistory();
              pushFeed(`Card certified: ${signed.label} · class ${signed.cardClass} · ${signed.rounds} runs · trusted miss $${signed.trustedErrorUsd.toFixed(2)}`);
              console.log(`[credential] delivered accumulated credential ${o.orderId} (+${priceUSDC} USDC revenue)`);
              broadcast();
            } catch (err) {
              console.warn('[credential] delivery failed: ' + (err as Error).message);
            } finally { inFlight.delete(o.orderId); }
          })();
        }
      }
    } catch { /* transient */ }
  };
  setInterval(() => void tick(), 4000);
}

function raceEngineKit(requirements: string): string {
  let req: { serviceId?: string; label?: string; stack?: string; ownerWallet?: string; payoutAddress?: string } = {};
  try { req = JSON.parse(requirements || '{}') as typeof req; } catch { /* optional input */ }
  const serviceId = String(req.serviceId || '').trim();
  const label = String(req.label || (serviceId ? `agent-${serviceId.slice(0, 4)}` : 'my-agent')).replace(/[^\w -]/g, '').slice(0, 32);
  const stack = String(req.stack || 'typescript').slice(0, 48);
  const payout = String(req.payoutAddress || '').trim();
  const ownerWallet = String(req.ownerWallet || '').trim();
  const runnerUrl = process.env.RUNNER_URL || process.env.NEXT_PUBLIC_RUNNER_URL || 'https://axion-arena.onrender.com';
  const appUrl = process.env.FRONTEND_URL || 'https://axion-fawn.vercel.app';
  const contract = [
    'Axion hires a CROO serviceId, not an agent profile. Use a dedicated Axion Race Forecast service. If your current service sells another product, create a new service under the same agent.',
    'When Axion hires that race service, read requirements JSON:',
    '{ roundId, asset, spot, deadlineSeconds, recentVol }',
    'Deliver a JSON string with exactly:',
    '{ "prediction": <positive USD move amplitude>, "rationale": "<one short sentence>" }',
    'Set this race service to the CROO minimum price. Reply fast with a recentVol baseline; paid/internal data is optional.',
  ].join('\n');
  const patchPrompt = [
    'Patch my existing CROO agent so it can race in Axion Clash.',
    `Stack: ${stack}. Keep my existing non-race services unchanged.`,
    'If I already have an Axion race service, reuse that serviceId. If my current service is a different product, create a new CROO service under the same agent called "Axion Race Forecast" and use that new serviceId.',
    'Race service settings: price = CROO minimum, SLA = 5 minutes, requirements = { roundId, asset, spot, deadlineSeconds, recentVol }, deliverable = { prediction, rationale } JSON string.',
    'Add one handler for Axion race orders. On paid order, parse requirements JSON:',
    '{ roundId, asset, spot, deadlineSeconds, recentVol }.',
    'Return immediately with a baseline prediction from recentVol if slower data/LLM calls are not ready.',
    'Deliver exactly JSON.stringify({ prediction, rationale }) where prediction is a positive USD amplitude, not a price and not a direction.',
    'Set the CROO race service to the minimum price. The paid product is the Axion certified scorecard, not race entry.',
  ].join('\n');
  const registration = serviceId
    ? {
        method: 'POST',
        url: `${runnerUrl}/api/competitor`,
        body: { serviceId, label, ...(payout ? { payoutAddress: payout } : {}) },
        scorecardWallet: ownerWallet
          ? {
              wallet: ownerWallet,
              note: 'Use the CROO public wallet shown on this agent/service. Axion rejects arbitrary wallets for scorecard binding.',
              message: 'Sign: Axion Clash racer wallet\\nwallet:<croo-public-wallet>\\nserviceId:<serviceId>\\nnonce:<unique>',
              addToBody: { ownerWallet, nonce: '<unique>', signature: '<wallet-signature>' },
            }
          : 'Optional: connect/sign the CROO public wallet in the Axion Garage so grid results feed your certifiable scorecard.',
      }
    : {
        note: 'Create or provide a CROO serviceId, deploy the race handler at the CROO minimum price, then POST it to /api/competitor.',
      };
  return JSON.stringify({
    type: 'axion.raceEngineKit.v1',
    appUrl,
    autoRegisters: false,
    note: 'This kit cannot modify a third-party backend by itself. Apply the patch, deploy the provider, then register the serviceId in Axion.',
    contract,
    patchPrompt,
    serviceSettings: {
      name: 'Axion Race Forecast',
      priceUSDC: Number(process.env.ARENA_MAX_RACER_PRICE_USDC ?? '0.01'),
      requireFundTransfer: false,
      sla: '5 min',
      deliverable: '{ prediction, rationale } JSON string',
    },
    registration,
    ownerWallet: ownerWallet || undefined,
    nextSteps: [
      'Create or reuse a dedicated Axion Race Forecast service on your CROO agent.',
      'Add the handler for that race serviceId to your existing CROO provider.',
      'Set the race service to the CROO minimum price.',
      'Deploy/keep the provider online.',
      serviceId ? 'POST the registration payload above, or paste the race serviceId in the Axion Garage.' : 'Register the race serviceId from the Axion Garage.',
      'Race results build reputation; mint the paid credential after you have a record.',
    ],
  });
}

/** Axion's flagship buyable service: the ARENA CONSENSUS ETH move forecast. Averages the three theses
 *  (momentum / value / microstructure) into one {prediction, rationale} — the same contract racers
 *  answer — so any agent can hire "an ETH short-horizon move forecast" and get a call backed by the
 *  arena's public, on-chain-graded track record. Honest: an estimate from live volatility, not alpha. */
function consensusForecast(requirements: string): string {
  let req: { spot?: number; deadlineSeconds?: number; recentVol?: number } = {};
  try { req = JSON.parse(requirements || '{}') as typeof req; } catch { /* fallback below */ }
  const spot = Number(req.spot) || state.livePrice || 3000;
  const horizon = Number(req.deadlineSeconds) || WINDOW;
  const recent = Number(req.recentVol) > 0 ? Number(req.recentVol) : Math.max(0.5, spot * 0.0004);
  const avgMult = PERSONALITIES.reduce((s, p) => s + p.volMultiplier, 0) / PERSONALITIES.length;
  // Scale a ~60s baseline to the requested horizon (vol grows ~sqrt(time)); bounded and honest.
  const scaled = recent * avgMult * Math.sqrt(Math.max(1, horizon) / WINDOW);
  const prediction = Math.max(0.01, Number(scaled.toFixed(2)));
  const top = state.leaderboard[0];
  const record = top && top.rounds > 0 ? ` Arena best: ${top.label} at ${usdStr(top.avgError)} avg error over ${top.rounds} graded rounds.` : '';
  const usd = String.fromCharCode(36);
  const rationale = `Axion consensus: ~${usd}${prediction.toFixed(2)} expected ETH move over ~${horizon}s, from live volatility across momentum, value and microstructure theses, graded on-chain vs Pyth each round.${record}`;
  return JSON.stringify({ prediction, rationale });
}
function usdStr(n: number): string { return String.fromCharCode(36) + (Number(n) || 0).toFixed(2); }

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
  // Bounded field: pick who races this round (personas + the next community agents in the rotation) and
  // advance the round-robin. Everyone races when the field fits under the cap.
  const racers = pickRacers(competitors);
  if (racers.length < competitors.length) {
    pushFeed(`Field rotated: ${racers.length} of ${competitors.length} agents race this round (bounded field)`);
  }
  lastRoundStartMs = Date.now();
  // Schedule the next AUTOMATIC race and PERSIST it, so the "next" countdown is reliable and
  // SURVIVES restarts (Render redeploy/spin-down) instead of resetting to the full period each boot.
  if (AUTO_MS) { state.nextRoundAtMs = lastRoundStartMs + AUTO_MS; saveHistory(); }
  state.status = 'running';
  try {
    await runRound(racers, cfg, windowSeconds, {
      onOpen: ({ id, openPrice, dqAtMs }) => {
        roundOpenMs = Date.now();
        state.round = {
          id,
          format,
          windowSeconds,
          phase: 'open',
          openPrice,
          openAtMs: roundOpenMs,
          // Calibrated expected race start (descending countdown target), and the DQ cutoff = that + grace
          // (known upfront, computed in loop) → the red grace bar fills over [etaRaceStartMs, dqAtMs].
          etaRaceStartMs: roundOpenMs + HIRING_ETA_MS,
          etaSettleMs: roundOpenMs + HIRING_ETA_MS + windowSeconds * 1000,
          dqAtMs,
          competitors: racers.map((c) => ({
            id: c.id,
            ...personaMeta(c.id),
            targets: c.kind === 'local' ? c.persona.capabilities : ['arena forecast'],
            sourcePhase: 'choosing',
          })),
        };
        lastHireFailReason = ''; // fresh round; failures (if any) will re-arm the banner
        // Carry over predictions placed during the idle gap (on the now-racing roster), deduped.
        if (nextPredictPending.length) {
          const racing = new Set(racers.map((c) => c.id));
          const carried = nextPredictPending.filter((g) => racing.has(g.agentId)); // drop picks on agents not racing this round
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
          // AUTO-PURGE deterministic community-agent contract failures. A racer can be paid elsewhere,
          // but the Axion race handler itself must stay at the CROO minimum price and return {prediction,rationale}.
          const isRemote = competitors.some((x) => x.id === competitor && x.kind === 'remote');
          const badContract = /invalid response/i.test(reason);
          const paidRacer = /minimum price|price.*cap|price\s.*>\scap/i.test(reason);
          const missingService = /SERVICE_NOT_FOUND|service not found/i.test(reason);
          const offlineProvider = /PROVIDER_NOT_ACCEPTING_ORDERS|provider is not accept|not accepting orders/i.test(reason);
          if (isRemote && (badContract || paidRacer || missingService || offlineProvider)) {
            const fix = missingService
              ? 'Use the CROO serviceId from the live race service, then re-register from the Garage.'
              : offlineProvider
              ? 'Provider is offline/not accepting orders. Deploy it live, then re-register from the Garage.'
              : paidRacer
              ? 'Set the CROO race service to the minimum price, then re-register from the Garage.'
              : 'Return valid {prediction, rationale}, then re-register from the Garage.';
            removeCommunityCompetitor(competitor, fix);
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
          c.hires = edges.filter((e) => !e.raceEntry).map((e) => e.label); // data providers it bought this round (live, per agent)
        }
        for (const e of edges) {
          pushFeed(
            e.raceEntry
              ? `Arena hired ${e.label} to race [3rd-party]`
              : `${personaMeta(e.competitor).label} hired ${e.label} [${e.ours ? 'ours' : '3rd-party'}]`,
            BASESCAN + e.payTxHash,
          );
        }
        pushFeed(`${personaMeta(forecast.competitor).label} estimates $${forecast.prediction.toFixed(2)}`);
        broadcast();
      },
      onEstimates: ({ line, betCloseAtMs, dqIds, failures = [] }) => {
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
        // Mark cut competitors. A terminal service/contract/funding failure is different from a
        // still-pending late agent, so preserve the reason for the UI and post-race diagnosis.
        const failureById = new Map(failures.map((f) => [f.id, humanizeHireFail(f.reason)]));
        for (const c of state.round.competitors) {
          if (!dqIds.includes(c.id)) continue;
          c.dq = true;
          const reason = failureById.get(c.id);
          if (reason) c.failReason = reason;
        }
        refreshUsdcBet(); // new round → fresh (empty) USDC pool
        const failedCount = failures.length;
        const lateCount = Math.max(0, dqIds.length - failedCount);
        const dqParts = [
          failedCount ? `${failedCount} failed` : '',
          lateCount ? `${lateCount} late` : '',
        ].filter(Boolean);
        const dqNote = dqParts.length ? ` · ${dqParts.join(', ')}` : '';
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
        // Data flowed this round → clear the health banner. If none flowed, keep an existing funding
        // banner (set by onHireFail) but do NOT raise a generic one: a round can fall back to baseline
        // for benign reasons (slow providers), which shouldn't alarm spectators.
        if (edges.length > 0) { state.notice = undefined; lastHireFailReason = ''; }
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
          edges: edges.map((e) => ({ competitor: e.competitor, capability: e.capability, label: e.label, serviceId: e.serviceId, ours: e.ours, payTxHash: e.payTxHash, clearTxHash: e.clearTxHash, latencyMs: e.latencyMs, raceEntry: e.raceEntry })),
        };
        state.history.unshift(item);
        state.history = state.history.slice(0, 50);
        rebuildLeaderboardFromHistory();
        const graded = round.forecasts.filter((f) => Number.isFinite(o.errors[f.competitor]));
        const ranked = [...graded].sort((a, b) => o.errors[a.competitor] - o.errors[b.competitor]);
        const rankOf = new Map(ranked.map((f, i) => [f.competitor, i + 1]));
        const settledAtSec = Math.round((Date.parse(o.settledAt) || Date.now()) / 1000);
        // Sign each graded forecast into a tamper-proof accuracy scorecard (the verifiable track record).
        // Pre-committed (reasonHash) + graded vs Pyth + signed by our published EOA → an agent's record
        // cannot be silently rewritten. Async + best-effort: absent key or failure just skips it, no break.
        const scoreKey = process.env.HOUSE_EOA_PRIVATE_KEY;
        if (scoreKey) {
          void (async () => {
            try {
              const cards = await Promise.all(
                graded.map((f) =>
                  signScorecard(
                    {
                      agent: f.competitor,
                      roundId: round.id,
                      reasonHash: f.reasonHash,
                      prediction: f.prediction,
                      actual: o.actual,
                      errorUsd: o.errors[f.competitor],
                      rank: rankOf.get(f.competitor) ?? 0,
                      field: graded.length,
                      settledAtSec,
                    },
                    scoreKey,
                  ),
                ),
              );
              item.scorecards = cards;
              saveHistory();
              broadcast();
              console.log(`[scorecard] signed ${cards.length} scorecard(s) for ${round.id}`);
            } catch (err) {
              console.warn('[scorecard] signing failed: ' + (err as Error).message);
            }
          })();
        }
        // If a community racer linked an owner wallet at join, its actual grid performance feeds the
        // same accumulated record that the paid CROO credential service certifies. This unifies the
        // consumer grid and the store product without inventing a second reputation system.
        let linkedGridRecords = 0;
        for (const f of graded) {
          const wallet = ownerWalletForRacer(f.competitor);
          if (!wallet) continue;
          const added = appendExternalRecord(wallet, {
            roundId: round.id,
            label: personaMeta(f.competitor).label,
            prediction: f.prediction,
            actual: o.actual,
            errorUsd: o.errors[f.competitor],
            rank: rankOf.get(f.competitor) ?? 0,
            field: graded.length,
            settledAtSec,
          });
          if (added) linkedGridRecords++;
        }
        if (linkedGridRecords) {
          refreshExternalBoard();
          pushFeed(`${linkedGridRecords} racer scorecard record${linkedGridRecords > 1 ? 's' : ''} updated from the grid`);
          saveHistory();
        }
        // Grade FREE external submissions committed before this round opened, into each agent's track
        // record (the field a paid credential is minted from). No key needed, these are just the facts.
        if (freeSubmissions.length) {
          const openMs = Number(round.id.split('-')[1]) || 0;
          const gradedForecasts = round.forecasts.filter((f) => Number.isFinite(o.errors[f.competitor]));
          const fieldErrors = gradedForecasts.map((f) => o.errors[f.competitor]);
          const settledAtSec = Math.round((Date.parse(o.settledAt) || Date.now()) / 1000);
          const kept: FreeSubmission[] = [];
          for (const s of freeSubmissions) {
            if (s.submitMs >= openMs) { kept.push(s); continue; } // not a fresh round yet, keep for the next
            const g = benchmarkRank(s.prediction, o.actual, fieldErrors);
            const rec = externalRecords.get(s.wallet) ?? [];
            rec.push({ roundId: round.id, label: s.label, prediction: s.prediction, actual: o.actual, errorUsd: g.errorUsd, rank: g.rank, field: g.field, settledAtSec });
            externalRecords.set(s.wallet, rec.slice(-100));
            pushFeed(`${s.label} graded: $${g.errorUsd.toFixed(2)} error, rank #${g.rank}/${g.field} (${rec.length} rounds on record)`);
          }
          freeSubmissions = kept;
          refreshExternalBoard();
          saveHistory();
        }
        refreshEconomics();
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
        detectAdoptions(item.edges.map((e) => ({ competitor: e.competitor, label: e.label, ours: e.ours, raceEntry: e.raceEntry })), Date.parse(item.settledAt) || Date.now(), true);
        saveHistory();
        // Reflect the providers actually wired this round into the live data-market panel (data hires only, not race-entry orders).
        void refreshDataMarket(item.edges.filter((e) => !e.raceEntry).map((e) => ({ competitor: e.competitor, capability: e.capability, label: e.label, serviceId: e.serviceId ?? '', ours: e.ours })));
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
    competitors: visibleCompetitorsForRound(last.competitors ?? []),
  };
}

async function main(): Promise<void> {
  await loadHistory();
  console.log(`[arena-server] durable store: ${storeEnabled() ? 'Upstash (on)' : 'off (seed/file fallback)'}`);

  // Live store data-market: census at boot (seed `wired` from the last replayed round) + every 10min.
  const lastEdges = (state.history[0]?.edges ?? []).filter((e) => !e.raceEntry).map((e) => ({ competitor: e.competitor, capability: e.capability, label: e.label, serviceId: e.serviceId ?? '', ours: e.ours }));
  void refreshDataMarket(lastEdges.length ? lastEdges : undefined);
  setInterval(() => void refreshDataMarket(), 10 * 60_000);
  refreshEconomics(); // publish spend-vs-revenue at boot (revenue 0 until a real external payer)
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

  // Standings are historical credentials. A community racer can leave or be disabled from the live
  // grid, but its successfully graded record stays visible and confidence-adjusted.

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
            const { serviceId, label, payoutAddress, ownerWallet, wallet, address, signature, nonce } = JSON.parse(body || '{}') as {
              serviceId?: string;
              label?: string;
              payoutAddress?: string;
              ownerWallet?: string;
              wallet?: string;
              address?: string;
              signature?: string;
              nonce?: string;
            };
            if (!serviceId || !/^[0-9a-f-]{36}$/i.test(serviceId)) return reply(400, { error: 'valid serviceId (uuid) required' });
            if (isDisabledRacerService(serviceId)) return reply(409, { error: 'this serviceId is disabled in Axion until the race service is fixed and re-registered' });
            const payout = (payoutAddress || '').trim();
            if (payout && !isPayoutAddress(payout)) return reply(400, { error: 'payout address must be a 0x… Base address (40 hex chars)' });
            const ownerRaw = ownerWallet || wallet || address || '';
            let verifiedOwner = '';
            let ownerVerified = false;
            if (ownerRaw || signature || nonce) {
              const nonceText = String(nonce || '').slice(0, 96);
              if (!ownerRaw || !signature || !nonceText) return reply(400, { error: 'wallet binding requires ownerWallet, nonce and signature' });
              try { verifiedOwner = normalizeWallet(String(ownerRaw)); } catch { return reply(400, { error: 'ownerWallet must be a 0x… address' }); }
              const msg = racerJoinMessage({ wallet: verifiedOwner, serviceId, nonce: nonceText });
              let recovered = '';
              try { recovered = ethers.verifyMessage(msg, String(signature)); } catch { /* invalid below */ }
              if (recovered.toLowerCase() !== verifiedOwner.toLowerCase()) {
                return reply(401, { error: 'invalid owner signature for racer wallet', messageToSign: msg });
              }
              const publicOwner = await crooPublicOwnerWalletForService(serviceId);
              if (publicOwner && publicOwner.toLowerCase() !== verifiedOwner.toLowerCase()) {
                return reply(401, {
                  error: 'scorecard wallet must match the CROO public wallet for this service',
                  expectedWallet: publicOwner,
                  receivedWallet: verifiedOwner,
                });
              }
              ownerVerified = !!publicOwner;
            }
            const desiredName = cleanRacerLabel(label, serviceId);
            const verifiedOwnerKey = racerOwnerKey(verifiedOwner);
            if (verifiedOwnerKey) {
              for (const row of [...joinedRoster]) {
                if (row.serviceId.toLowerCase() === serviceId.toLowerCase()) continue;
                if (racerOwnerKey(row.ownerWallet) !== verifiedOwnerKey) continue;
                removeCommunityCompetitor(row.serviceId, 'Replaced by the updated race service.', { persist: false });
              }
            }
            const duplicateLabel = competitors.find((c): c is Extract<Competitor, { kind: 'remote' }> =>
              c.kind === 'remote' &&
              racerLabelKey(c.id) === racerLabelKey(desiredName) &&
              c.serviceId.toLowerCase() !== serviceId.toLowerCase()
            );
            if (duplicateLabel) {
              const row = joinedRoster.find((j) => j.serviceId.toLowerCase() === duplicateLabel.serviceId.toLowerCase());
              if (verifiedOwnerKey && racerOwnerKey(row?.ownerWallet) === verifiedOwnerKey) {
                removeCommunityCompetitor(duplicateLabel.serviceId, 'Replaced by the updated race service.', { persist: false });
              } else {
                return reply(409, { error: 'racer label already exists. Connect its scorecard wallet to replace it, or choose another label.' });
              }
            }
            const durable = joinedRoster.find((j) => j.serviceId.toLowerCase() === serviceId.toLowerCase());
            if (verifiedOwner && durable?.ownerWallet && durable.ownerWallet.toLowerCase() !== verifiedOwner.toLowerCase()) {
              return reply(409, { error: 'this service already has a different scorecard wallet linked. Re-register it as a new CROO service or ask Axion to rotate it manually.' });
            }
            let existing = competitors.find((c): c is Extract<Competitor, { kind: 'remote' }> =>
              c.kind === 'remote' && c.serviceId === serviceId
            );
            if (existing && existing.id !== desiredName) {
              if (!verifiedOwnerKey) return reply(409, { error: 'connect the scorecard wallet to rename this racer' });
              if (metaById.has(desiredName)) return reply(409, { error: 'racer label already exists. Choose another label.' });
              removeCommunityCompetitor(serviceId, 'Updated racer label.', { persist: false });
              existing = undefined;
            }
            if (existing) {
              if (!verifiedOwner && !payout) return reply(409, { error: 'agent already in the arena' });
              const name = existing.id;
              const row = joinedRoster.find((j) => j.serviceId === serviceId);
              if (row) {
                if (verifiedOwner) row.ownerWallet = verifiedOwner;
                if (verifiedOwner) row.ownerVerified = ownerVerified;
                if (payout) row.payout = payout;
              } else {
                joinedRoster.push({ serviceId, label: name, payout: payout || undefined, ownerWallet: verifiedOwner || undefined, ownerVerified: ownerVerified || undefined });
                joinedRoster = joinedRoster.slice(-50);
              }
              if (payout) setAgentPayout(name, payout);
              saveHistory();
              refreshRoster();
              pushFeed(`${name} updated${verifiedOwner ? ' · scorecard wallet linked' : ''}${payout ? ' · payout wallet linked' : ''}`);
              broadcast();
              return reply(200, { ok: true, name, payout: !!payout, recordWallet: verifiedOwner || row?.ownerWallet || null, recordWalletVerified: ownerVerified || row?.ownerVerified || false, note: verifiedOwner ? 'wallet linked — future grid results build this scorecard' : 'agent settings updated' });
            }
            if (!remoteBuyer) remoteBuyer = await createRemoteBuyer(cfg);
            const name = desiredName;
            if (metaById.has(name)) return reply(409, { error: 'racer label already exists. Connect its scorecard wallet to replace it, or choose another label.' });

            // No paid pre-flight hire here: joining should be fast and free. The first real race validates
            // the deliverable and auto-purges bad community agents that do not return {prediction,rationale}.
            const comp = makeRemoteCompetitor(remoteBuyer, serviceId, name);

            competitors.push(comp);
            metaById.set(name, { label: name, blurb: 'community agent' });
            if (payout) setAgentPayout(name, payout); // route this agent's winning purse on-chain
            joinedRoster.push({ serviceId, label: name, payout: payout || undefined, ownerWallet: verifiedOwner || undefined, ownerVerified: ownerVerified || undefined });
            joinedRoster = joinedRoster.slice(-50);
            saveHistory(); // DURABLE: the join survives restarts (re-instantiated at boot)
            if (state.status === 'view-only') state.status = 'idle';
            refreshRoster(); // the new agent is now bettable for the next race (idle predictions)
            pushFeed(`New competitor joined: ${name}${verifiedOwner ? ' · scorecard wallet linked' : ''}`);
            broadcast();
            reply(202, { ok: true, name, payout: !!payout, recordWallet: verifiedOwner || null, recordWalletVerified: ownerVerified, note: verifiedOwner ? 'joined — grid results will build this wallet-bound scorecard' : 'joined — first race validates the handler response' });
          } catch (e) {
            reply(400, { error: (e as Error).message });
          }
        })();
      });
      return;
    }
    if (req.method === 'POST' && url === '/api/submit') {
      // FREE external intake: an agent PUSHES its forecast (no payment). The submission is tied to a
      // wallet signature, so the accumulated record is non-spoofable and only that wallet can mint it.
      const reply = (code: number, obj: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' }); res.end(JSON.stringify(obj)); };
      let body = '';
      req.on('data', (c) => { body += c; if (body.length > 4000) req.destroy(); });
      req.on('end', () => {
        try {
          const { agent, prediction, wallet, address, signature, nonce } = JSON.parse(body || '{}') as { agent?: string; prediction?: number; wallet?: string; address?: string; signature?: string; nonce?: string };
          const label = String(agent || '').replace(/[^\w -]/g, '').slice(0, 24);
          const p = Number(prediction);
          if (!label) return reply(400, { error: 'agent label required' });
          if (!Number.isFinite(p) || p <= 0) return reply(400, { error: 'prediction must be a number > 0 (USD amplitude of the next ~60s ETH move)' });
          const nonceText = String(nonce || '').slice(0, 96);
          if (!nonceText) return reply(400, { error: 'nonce required (unique string signed with the forecast)' });
          let owner = '';
          try { owner = normalizeWallet(String(wallet || address || '')); } catch { /* invalid below */ }
          if (!owner) return reply(400, { error: 'wallet/address required (0x...)' });
          const msg = submitMessage({ wallet: owner, label, prediction: p, nonce: nonceText });
          let recovered = '';
          try { recovered = ethers.verifyMessage(msg, String(signature || '')); } catch { /* invalid below */ }
          if (recovered.toLowerCase() !== owner.toLowerCase()) return reply(401, { error: 'invalid wallet signature', messageToSign: msg });
          const key = owner.toLowerCase();
          const sub: FreeSubmission = { wallet: key, label, prediction: p, reasonHash: reasonHash({ competitor: owner, prediction: p, rationale: 'submit', inputs: `submit:${key}:${nonceText}` }), submitMs: Date.now(), nonce: nonceText };
          const i = freeSubmissions.findIndex((s) => s.wallet === key);
          if (i >= 0) freeSubmissions[i] = sub; else freeSubmissions.push(sub); // one pending per agent
          pushFeed(`${label} submitted a signed forecast ($${p.toFixed(2)}), grading next round`);
          broadcast();
          reply(202, { ok: true, wallet: owner, message: msg, note: 'wallet-authenticated forecast committed before the outcome; graded next round for free. Certify your card to publish the accumulated record.' });
        } catch (e) {
          reply(400, { error: (e as Error).message });
        }
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
