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
}
export interface RoundView {
  id: string;
  phase: 'open' | 'betting' | 'settled';
  openPrice: number;
  closePrice?: number;
  line?: number;
  amplitude?: number;
  liveAmplitude?: number;
  raceStartMs?: number;
  settleAtMs?: number;
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
