'use client';
import { useEffect, useRef } from 'react';
import type { RoundView } from '@/lib/runner';
import { livery, usd } from '@/lib/utils';

/**
 * The Derby track. Agents (racing liveries) advance left→right; position = race progress (time
 * elapsed in the window) × relative standing (how close their estimate is to the LIVE realized move
 * from Pyth). Each kart LAUNCHES from the grid when its real data lands — the fastest data-getter
 * gets a head-start lead that DECAYS to 0 by the buzzer, so accuracy still decides the winner (speed
 * = early lead + tie-break only). Per-frame eased interpolation → no teleports. 100% real data.
 */
const A0 = 4;      // start grid %
const RACE_L = 25; // scored race begins here
const RACE_R = 90; // finish line % — karts AND the line share this coordinate so the leader lands ON it
const HEADSTART = 12; // max % lead for the earliest data-getter; decays to 0 by settle (accuracy wins)

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
        const now = Date.now();
        const openMs = Number((r.id || '').split('-')[1]) || now;
        const span = RACE_R - RACE_L;
        const targets: Record<string, number> = {};

        // Staggered launch: each kart leaves the grid when ITS data lands (real provider speed). The
        // earliest data-getter gets a head-start lead of up to HEADSTART%, which DECAYS to 0 by settle
        // so the WINNER is still decided by accuracy — speed only earns an early lead + tie-break.
        const launches = r.competitors.map((c) => c.launchAtMs).filter((v): v is number => v != null);
        const minL = launches.length ? Math.min(...launches) : 0;
        const maxL = launches.length ? Math.max(...launches) : 0;
        const headStart = (launchAtMs?: number) =>
          launchAtMs == null || maxL === minL ? 0 : ((maxL - launchAtMs) / (maxL - minL)) * HEADSTART;

        const betting = (r.phase === 'betting' || r.phase === 'settled') && r.competitors.some((c) => c.estimate != null);
        if (betting) {
          const truth = r.amplitude != null ? r.amplitude : r.liveAmplitude || 0;
          const ests = r.competitors.map((c) => c.estimate).filter((v): v is number => v != null);
          const scale = Math.max(3, truth, ...(ests.length ? ests : [0])) * 1.15;
          let maxQ = 0;
          const q: Record<string, number> = {};
          for (const c of r.competitors) {
            const qi = c.estimate == null ? 0 : Math.max(0, 1 - Math.abs(c.estimate - truth) / scale);
            q[c.id] = qi; if (qi > maxQ) maxQ = qi;
          }
          const settled = r.phase === 'settled';
          const t = settled ? 1 : Math.max(0, Math.min(1, (now - (r.raceStartMs || 0)) / ((r.settleAtMs! - r.raceStartMs!) || 60000)));
          for (const c of r.competitors) {
            // Standing 0..1; the winner always finishes ON the line (standing 1), regardless of edge cases.
            const standing = settled && c.isWinner ? 1 : maxQ > 0 ? q[c.id] / maxQ : 0;
            const acc = RACE_L + t * standing * span;
            targets[c.id] = Math.min(RACE_R, acc + headStart(c.launchAtMs) * (1 - t)); // lead fades → accuracy wins
          }
        } else {
          // OPEN (hiring): a kart that already has its data pulls up to the START line (fast ones nudged
          // slightly ahead); those still scouting idle in the formation grid behind START.
          const base = A0 + (RACE_L - 3 - A0) * (1 - Math.exp(-(now - openMs) / 22000));
          r.competitors.forEach((c, i) => {
            targets[c.id] = c.estimate != null
              ? Math.min(RACE_R, RACE_L + headStart(c.launchAtMs) * 0.5)
              : base + Math.sin(now / 600 + i * 2.1) * 1.1;
          });
        }
        // Position model = the kart's NOSE (front/right edge). We center the DOM node on `left` via
        // translateX(-50%), so shifting left by half the car width makes its nose sit on the standing
        // position → the winner's nose lands exactly on the finish line at RACE_R.
        const halfKartPct = root.offsetWidth ? (16 / root.offsetWidth) * 100 : 1.4; // car is w-8 = 32px
        for (const c of r.competitors) {
          const el = root.querySelector<HTMLElement>(`[data-kart="${c.id}"]`);
          if (!el) continue;
          if (pos.current[c.id] == null) pos.current[c.id] = A0;
          // Race over → snap to the final standings (so the winner sits exactly on the line, no lerp drift).
          if (r.phase === 'settled') pos.current[c.id] = targets[c.id];
          else pos.current[c.id] += (targets[c.id] - pos.current[c.id]) * 0.12;
          el.style.left = (pos.current[c.id] - halfKartPct).toFixed(2) + '%';
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
  // Fastest data this round → ⚡ badge (legitimate edge for picking responsive providers).
  const withData = round.competitors.filter((c) => c.dataMs != null);
  const fastestId = withData.length ? withData.reduce((a, b) => (a.dataMs! <= b.dataMs! ? a : b)).id : null;

  return (
    <div ref={wrap} className="relative pr-2">
      {round.competitors.map((c) => {
        const col = livery(c.id);
        return (
          <div key={c.id} className="relative h-14 border-b border-dashed border-white/5">
            <span className="absolute left-0 top-1 z-10 font-display uppercase tracking-wide text-[13px]" style={{ color: col }}>
              {c.label}
              {c.id === fastestId ? <span className="ml-1 text-volt" title="fastest data this round">⚡</span> : null}
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
      {/* start line — where the scored race begins; karts idle just behind it during agent evaluation */}
      <div className="absolute top-0 bottom-1.5 z-0" style={{ left: `${RACE_L}%`, marginLeft: -1, width: 2, background: 'repeating-linear-gradient(180deg, var(--color-dim) 0 5px, transparent 5px 10px)', opacity: 0.8 }} />
      <div className="absolute -top-1 z-0 font-mono text-[9px] uppercase tracking-[0.15em] text-dim" style={{ left: `${RACE_L}%`, transform: 'translateX(-50%)' }}>start</div>
      {/* finish line — anchored to RACE_R% so the leader's kart lands exactly on it */}
      <div className="absolute top-0 bottom-1.5 z-0" style={{ left: `${RACE_R}%`, marginLeft: -1.5, width: 3, background: 'linear-gradient(var(--color-volt), var(--color-gold))', boxShadow: '0 0 18px rgba(182,255,58,.55)' }} />
      <div className="absolute -top-1 z-0 text-[15px]" style={{ left: `${RACE_R}%`, transform: 'translateX(-50%)' }}>🏁</div>
      <div className="mt-3 flex justify-between font-mono text-[10px] uppercase tracking-wider text-dim">
        <span>off the mark ⟵ closeness to the real move ⟶ exact</span>
        <span style={{ color: 'var(--color-volt)' }}>real move {usd(truth ?? 0)}</span>
      </div>
    </div>
  );
}
