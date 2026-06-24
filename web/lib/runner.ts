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
}
export interface RoundView {
  id: string;
  phase: 'open' | 'betting' | 'racing' | 'settled';
  openPrice: number;
  closePrice?: number;
  line?: number;
  amplitude?: number;
  liveAmplitude?: number;
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
  label: string;
  ours: boolean;
  payTxHash: string;
  clearTxHash: string;
}
export interface HistoryItem {
  id: string;
  openPrice: number;
  closePrice: number;
  amplitude: number;
  line: number;
  winners: string[];
  settledAt: string;
  competitors?: CompetitorView[];
  edges?: HistoryEdge[];
}
export interface LeaderRow {
  id: string;
  label: string;
  wins: number;
  rounds: number;
  avgError: number;
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
  predictStats?: { total: number; correct: number; visitors: number };
  usdcBet?: { enabled: boolean; houseAddress: string; maxBetUSDC: number; multiplier: number; pool: { byAgent: { id: string; amount: string }[]; total: string; bettors: number } };
  budget?: { used: number; cap: number; resetsAt: number };
  dataMarket?: {
    discovered: number;
    maxPriceUSDC: number;
    censusAt: number;
    top: { name: string; orders7d: number; priceUSDC: number }[];
    wired: { label: string; serviceId: string; ours: boolean }[];
    providerStats?: { label: string; serviceId: string; hires: number; avgMs: number | null; paidUSDC: number }[];
    events?: { ts: number; kind: 'joined' | 'adopted'; text: string }[];
  };
}

/** Stable per-browser id so the runner can count UNIQUE guest visitors (no signup, no wallet). */
export function visitorId(): string {
  if (typeof window === 'undefined') return 'ssr';
  let id = localStorage.getItem('axion_vid');
  if (!id) { id = (crypto.randomUUID?.() ?? String(Math.random()).slice(2)); localStorage.setItem('axion_vid', id); }
  return id;
}

/** Record a free guest prediction on the runner (counts toward the public usage tally). */
export async function postPredict(roundId: string, agentId: string): Promise<boolean> {
  try {
    const r = await fetch(`${RUNNER_URL}/api/predict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roundId, agentId, visitorId: visitorId() }),
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
