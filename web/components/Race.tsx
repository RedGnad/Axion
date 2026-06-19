'use client';
import { useEffect, useRef } from 'react';
import type { RoundView } from '@/lib/runner';
import { livery, usd } from '@/lib/utils';

/**
 * The Derby track. Agents (racing liveries) advance left→right; position = race progress (time
 * elapsed in the window) × relative standing (how close their estimate is to the LIVE realized move
 * from Pyth). The leader rides the pace line and crosses the finish at the buzzer; standings shift as
 * the move unfolds → real overtakes. During hiring it's a neutral formation lap. Per-frame eased
 * interpolation → no teleports. 100% driven by real data.
 */
const A0 = 4;      // start grid %
const RACE_L = 25; // scored race begins here
const RACE_R = 93; // finish line %

export default function Race({ round }: { round: RoundView | null }) {
  const roundRef = useRef<RoundView | null>(round);
  roundRef.current = round;
  const pos = useRef<Record<string, number>>({});
  const trackKey = useRef('');
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      const r = roundRef.current;
      const root = wrap.current;
      if (r && root && r.competitors.length) {
        const racing = (r.phase === 'betting' || r.phase === 'settled') && r.competitors.some((c) => c.estimate != null);
        const openMs = Number((r.id || '').split('-')[1]) || Date.now();
        const targets: Record<string, number> = {};
        if (racing) {
          const truth = r.amplitude != null ? r.amplitude : r.liveAmplitude || 0;
          const ests = r.competitors.map((c) => c.estimate).filter((v): v is number => v != null);
          const scale = Math.max(3, truth, ...(ests.length ? ests : [0])) * 1.15;
          let maxQ = 0;
          const q: Record<string, number> = {};
          for (const c of r.competitors) {
            const qi = c.estimate == null ? 0 : Math.max(0, 1 - Math.abs(c.estimate - truth) / scale);
            q[c.id] = qi; if (qi > maxQ) maxQ = qi;
          }
          const t = r.phase === 'settled' ? 1 : Math.max(0, Math.min(1, (Date.now() - (r.raceStartMs || 0)) / ((r.settleAtMs! - r.raceStartMs!) || 60000)));
          for (const c of r.competitors) targets[c.id] = RACE_L + t * (maxQ > 0 ? q[c.id] / maxQ : 0) * (RACE_R - RACE_L);
        } else {
          const base = A0 + (RACE_L - 1 - A0) * (1 - Math.exp(-(Date.now() - openMs) / 22000));
          r.competitors.forEach((c, i) => (targets[c.id] = base + Math.sin(Date.now() / 600 + i * 2.1) * 1.1));
        }
        for (const c of r.competitors) {
          const el = root.querySelector<HTMLElement>(`[data-kart="${c.id}"]`);
          if (!el) continue;
          if (pos.current[c.id] == null) pos.current[c.id] = A0;
          pos.current[c.id] += (targets[c.id] - pos.current[c.id]) * 0.12;
          el.style.left = pos.current[c.id].toFixed(2) + '%';
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!round || !round.competitors.length) {
    return <div className="text-dim font-mono text-sm py-12 text-center">no active round — the grid is warming up…</div>;
  }
  const key = round.competitors.map((c) => c.id).join(',');
  if (trackKey.current !== key) { trackKey.current = key; pos.current = {}; }
  const truth = round.amplitude != null ? round.amplitude : round.liveAmplitude;

  return (
    <div ref={wrap} className="relative pr-10">
      {round.competitors.map((c) => {
        const col = livery(c.id);
        return (
          <div key={c.id} className="relative h-14 border-b border-dashed border-white/5">
            <span className="absolute left-0 top-1 z-10 font-display uppercase tracking-wide text-[13px]" style={{ color: col }}>
              {c.label}
            </span>
            <div
              data-kart={c.id}
              className="absolute top-4 -translate-x-1/2 flex flex-col items-center gap-1 z-20"
              style={{ left: A0 + '%' }}
              title={c.rationale || ''}
            >
              <div
                className="h-3.5 w-8 rounded-[3px]"
                style={{ background: col, boxShadow: `0 0 14px ${col}99`, opacity: c.isWinner ? 1 : 0.92, outline: c.isWinner ? `2px solid var(--color-gold)` : 'none' }}
              />
              <span className="font-mono text-[10px] tnum" style={{ color: c.isWinner ? 'var(--color-gold)' : c.estimate != null ? '#cfcfd4' : 'var(--color-dim)' }}>
                {c.estimate != null ? usd(c.estimate) : 'scouting…'}
              </span>
            </div>
          </div>
        );
      })}
      {/* finish line */}
      <div className="absolute top-0 bottom-1.5 z-0" style={{ right: '36px', width: 3, background: 'linear-gradient(var(--color-amber), var(--color-gold))', boxShadow: '0 0 18px rgba(255,106,26,.55)' }} />
      <div className="absolute -top-1 right-2 z-0 text-[15px]">🏁</div>
      <div className="mt-3 flex justify-between font-mono text-[10px] uppercase tracking-wider text-dim">
        <span>off the mark ⟵ closeness to the real move ⟶ exact</span>
        <span style={{ color: 'var(--color-amber)' }}>real move {usd(truth ?? 0)}</span>
      </div>
    </div>
  );
}
