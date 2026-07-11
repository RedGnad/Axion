'use client';
import { useEffect, useRef, useState } from 'react';

/** The Render runner is the source of truth (real on-chain state). Set NEXT_PUBLIC_RUNNER_URL. */
export const RUNNER_URL =
  process.env.NEXT_PUBLIC_RUNNER_URL?.replace(/\/$/, '') ?? 'https://axion-arena.onrender.com';

export interface CompetitorView {
  id: string;
  label: string;
  blurb?: string;
  estimate?: number;
  rationale?: string;
  error?: number;
  isWinner?: boolean;
  launchAtMs?: number; // when its data landed → staggered launch
  dataMs?: number;     // data latency (ms) → ⚡ fastest-grid badge
  dq?: boolean;        // disqualified this round (too slow) → doesn't race/win
  failReason?: string; // terminal failure reason, when known
  hires?: string[];    // provider labels this agent bought this round (live); empty for remotes
  targets?: string[];  // capability/provider labels it is sourcing while estimating
  sourcePhase?: 'choosing' | 'hiring';
}
export interface RoundView {
  id: string;
  format?: 'blitz' | 'thesis';
  windowSeconds?: number;
  phase: 'open' | 'betting' | 'racing' | 'settled';
  openPrice: number;
  closePrice?: number;
  line?: number;
  amplitude?: number;
  liveAmplitude?: number;
  openAtMs?: number;
  raceStartMs?: number;
  settleAtMs?: number;
  betCloseAtMs?: number;
  dqFromMs?: number;
  dqAtMs?: number;
  etaSettleMs?: number;
  etaRaceStartMs?: number;
  competitors: CompetitorView[];
}
export interface HistoryEdge {
  competitor: string;
  capability?: string;
  label: string;
  serviceId?: string;
  ours: boolean;
  payTxHash: string;
  clearTxHash: string;
  latencyMs?: number;
  raceEntry?: boolean; // arena -> racer order (real tx, not a data-provider purchase)
}
export interface HistoryItem {
  id: string;
  format?: 'blitz' | 'thesis';
  windowSeconds?: number;
  openPrice: number;
  closePrice: number;
  amplitude: number;
  line: number;
  winners: string[];
  settledAt: string;
  competitors?: CompetitorView[];
  edges?: HistoryEdge[];
  scorecards?: SignedScorecard[];
}
/** A graded forecast signed by the arena EOA (EIP-712). Anyone can recover the signer to verify. */
export interface SignedScorecard {
  agent: string;
  roundId: string;
  reasonHash: string;
  prediction: number;
  actual: number;
  errorUsd: number;
  rank: number;
  field: number;
  settledAtSec: number;
  signer: string;
  signature: string;
}
export interface ExternalRecordRow {
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
}
export interface SignedCredential {
  agent: string;
  serviceId: string;
  label: string;
  scoreVersion: string;
  rounds: number;
  effectiveRounds: number;
  avgErrorUsd: number;
  trustedErrorUsd: number;
  bestRank: number;
  wins: number;
  confidence: number;
  cardClass: string;
  fromRound: string;
  toRound: string;
  issuedAtSec: number;
  signer: string;
  signature: string;
}
export interface LeaderRow {
  id: string;
  label: string;
  wins: number;
  rounds: number;
  avgError: number;
  trustedScore?: number;
  recentAvgError?: number;
  effectiveRounds?: number;
  confidence?: number;
  uncertainty?: number;
}
export interface FeedItem {
  ts: number;
  text: string;
  txUrl?: string;
}
export interface ArenaState {
  status: 'idle' | 'running' | 'view-only';
  asset: string;
  livePrice?: number;
  priceSeries: number[];
  nextRoundAtMs?: number;
  round?: RoundView;
  history: HistoryItem[];
  leaderboard: LeaderRow[];
  feed: FeedItem[];
  roster?: { id: string; label: string }[];
  /** CURRENT label -> the first label this racer raced under: a rename never changes its livery. */
  origins?: Record<string, string>;
  predictStats?: { total: number; correct: number; visitors: number; pending?: number; resolved?: number };
  usdcBet?: { enabled: boolean; open?: boolean; betCutoffAtMs?: number; houseAddress: string; maxBetUSDC: number; multiplier: number; pool: { byAgent: { id: string; amount: string }[]; total: string; bettors: number } };
  budget?: { used: number; cap: number; resetsAt: number };
  thesisRace?: { usedToday: number; capToday: number; resetsAt: number; windowSeconds: number };
  notice?: { level: 'warn'; text: string };
  dataMarket?: {
    discovered: number;
    matched?: number;
    maxPriceUSDC: number;
    censusAt: number;
    top: { name: string; orders7d: number; priceUSDC: number }[];
    wired: { competitor?: string; capability?: string; label: string; serviceId: string; ours: boolean }[];
    routing?: { capability: string; candidates: number; top: string[]; selected?: string }[];
    providerStats?: { label: string; serviceId: string; hires: number; avgMs: number | null; paidUSDC: number }[];
    events?: { ts: number; kind: 'joined' | 'adopted'; text: string }[];
  };
  economics?: { spendUSDC: number; revenueUSDC: number; benchmarkOrders: number; rounds: number };
  externalBoard?: ExternalRecordRow[];
}

/** Stable per-browser id so the runner can count UNIQUE guest visitors (no signup, no wallet). */
export function visitorId(): string {
  if (typeof window === 'undefined') return 'ssr';
  let id = localStorage.getItem('axion_vid');
  if (!id) { id = (crypto.randomUUID?.() ?? String(Math.random()).slice(2)); localStorage.setItem('axion_vid', id); }
  return id;
}

/** Set/CHANGE the free guest prediction (current race if live, else the NEXT race). One per visitor:
 *  calling again with a different agent replaces it (the server upserts, no double-count). */
export async function postPredict(agentId: string): Promise<boolean> {
  try {
    const r = await fetch(`${RUNNER_URL}/api/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId, visitorId: visitorId() }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** In-product agent check (free, instant, no hire): does this output fit the contract? Same check the
 *  arena runs, so ✅ here = accepted on-chain. Builders paste a sample of their agent's output. */
export async function validateAgentOutput(
  output: string,
): Promise<{ ok: boolean; prediction?: number; rationale?: string; reason?: string }> {
  try {
    const r = await fetch(`${RUNNER_URL}/api/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ output }),
    });
    return await r.json();
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

/** Cancel my free prediction for the current/next race (never affects a placed USDC bet). */
export async function cancelPredict(): Promise<boolean> {
  try {
    const r = await fetch(`${RUNNER_URL}/api/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cancel: true, visitorId: visitorId() }),
    });
    return r.ok;
  } catch {
    return false;
  }
}

/** Poll the runner's live state (the runner is kept warm by a cron; WS-free, robust). */
export function useArena(intervalMs = 2000): { state: ArenaState | null; online: boolean } {
  const [state, setState] = useState<ArenaState | null>(null);
  const [online, setOnline] = useState(false);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${RUNNER_URL}/api/state`, { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        const s = (await r.json()) as ArenaState;
        if (alive) { setState(s); setOnline(true); }
      } catch (err) {
        if (alive) setOnline(false);
        console.error('[arena] poll failed:', RUNNER_URL, err); // temp diagnostic: surfaces silent fetch/CORS errors
      }
    };
    poll();
    timer.current = setInterval(poll, intervalMs);
    return () => { alive = false; if (timer.current) clearInterval(timer.current); };
  }, [intervalMs]);

  return { state, online };
}
