'use client';
import { useEffect, useRef } from 'react';
import type { RoundView } from '@/lib/runner';
import { livery, usd } from '@/lib/utils';

/**
 * The Clash track. Agents (racing liveries) advance left→right; position = race progress (time
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

        // The scored RACE runs during 'betting' (single live window) + 'settled'. Disqualified karts
        // (too slow) are parked at the grid and don't race.
        const racing = (r.phase === 'betting' || r.phase === 'settled') && r.competitors.some((c) => c.estimate != null);
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
          const settled = r.phase === 'settled';
          const t = settled ? 1 : Math.max(0, Math.min(1, (now - (r.raceStartMs || 0)) / ((r.settleAtMs! - r.raceStartMs!) || 60000)));
          for (const c of r.competitors) {
            if (c.dq) { targets[c.id] = A0; continue; } // disqualified → parked at the grid
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
          // Smooth glide everywhere (no teleport). At settle, ease a bit faster + tidy the last fraction
          // so the winner lands exactly on the line without a jarring jump.
          const ease = r.phase === 'settled' ? 0.18 : 0.12;
          pos.current[c.id] += (targets[c.id] - pos.current[c.id]) * ease;
          if (r.phase === 'settled' && Math.abs(targets[c.id] - pos.current[c.id]) < 0.25) pos.current[c.id] = targets[c.id];
          el.style.left = (pos.current[c.id] - halfKartPct).toFixed(2) + '%';
        }
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  if (!round || !round.competitors.length) {
    return <div className="text-dim font-mono text-sm py-12 text-center">no active round. The grid is warming up…</div>;
  }
  const key = round.competitors.map((c) => c.id).join(',');
  if (trackKey.current !== key) { trackKey.current = key; pos.current = {}; }
  // Fastest data this round → ⚡ badge (legitimate edge for picking responsive providers).
  const withData = round.competitors.filter((c) => c.dataMs != null);
  const fastestId = withData.length ? withData.reduce((a, b) => (a.dataMs! <= b.dataMs! ? a : b)).id : null;
  const dqLabel = (reason?: string) => {
    const r = (reason || '').toLowerCase();
    if (/not accept|offline/.test(r)) return 'offline';
    if (/price|cap|minimum/.test(r)) return 'price';
    if (/invalid response|prediction|rationale|contract/.test(r)) return 'format';
    if (/fund|balance|usdc/.test(r)) return 'funds';
    return 'late';
  };
  const dqHelp = (reason?: string) => {
    const tag = dqLabel(reason);
    if (tag === 'offline') return 'CROO refused the order: this agent is offline. It keeps its slot and races again as soon as it answers.';
    if (tag === 'price') return 'Race service price is above Axion cap. Set it to the CROO minimum and re-register.';
    if (tag === 'format') return 'The service did not return the Axion race JSON contract: {prediction, rationale}.';
    if (tag === 'funds') return 'The service could not complete because a wallet needed USDC.';
    return 'No forecast arrived before this round cutoff. The agent can race again if it stays in the roster.';
  };

  // Compact the lanes as the field grows so a big roster doesn't flood the track (keeps the start/
  // finish lines correctly anchored — unlike a scroll container, which would mis-place absolute lines).
  const laneH = round.competitors.length > 10 ? "h-8 sm:h-9" : round.competitors.length > 6 ? "h-9 sm:h-10" : "h-9 sm:h-11";
  return (
    <div ref={wrap} className="relative pr-1 sm:flex sm:h-full sm:flex-1 sm:flex-col sm:pr-2">
      {round.competitors.map((c, idx) => {
        const col = livery(c.id);
        // Open the reasoning tooltip DOWN for top lanes and UP for bottom lanes so it stays inside the
        // grid (never clipped by the header above or the bet cards below).
        const tipUp = idx >= Math.ceil(round.competitors.length / 2);
        // Horizontal anchor so the bubble never overflows the container: a cut kart is parked far left
        // (open right), a winner lands far right (open left), everyone else centers on their kart.
        const tipAlignCls = c.dq ? 'left-0' : c.isWinner ? 'right-0' : 'left-1/2 -translate-x-1/2';
        return (
          <div key={c.id} className={`group relative ${laneH} border-b border-dashed border-white/5 sm:min-h-[2.75rem] sm:flex-1`}>
            <span className="absolute left-0 top-1 z-10 font-display uppercase tracking-wide text-[12px] sm:text-[13px]" style={{ color: c.dq ? 'var(--color-dim)' : col }}>
              {c.label}
              {c.dq ? <span className="ml-1 align-middle font-mono text-[8px] uppercase tracking-wider text-dim" title={dqHelp(c.failReason)}>{dqLabel(c.failReason)}</span> : c.id === fastestId ? <span className="ml-1 align-middle font-mono text-[8px] uppercase tracking-wider text-volt" title="fastest data this round">fast</span> : null}
            </span>
            <div
              data-kart={c.id}
              className="absolute top-2.5 z-20 flex -translate-x-1/2 flex-col items-center gap-0.5 sm:top-4 sm:gap-1"
              style={{ left: A0 + '%', opacity: c.dq ? 0.35 : 1 }}
            >
              {/* Instant reasoning tooltip — hover the lane, appears at the agent's kart with no delay. */}
              {c.dq || c.rationale ? (
                <span className={`pointer-events-none absolute z-40 hidden w-52 max-w-[46vw] rounded-md border border-line bg-panel/95 p-2 text-left font-mono text-[10px] normal-case leading-snug tracking-normal text-ink/90 shadow-lg group-hover:block ${tipAlignCls} ${tipUp ? 'bottom-full mb-2' : 'top-full mt-2'}`}>
                  {c.dq ? dqHelp(c.failReason) : c.rationale}
                </span>
              ) : null}
              {c.isWinner ? (
                <span
                  className="absolute -top-5 left-1/2 -translate-x-1/2 rounded-full border border-gold/45 bg-gold/10 px-1.5 py-0.5 text-[12px] leading-none"
                  aria-label="winner"
                  title="winner"
                >
                  🏆
                </span>
              ) : null}
              <div
                className="h-3 w-7 rounded-[3px] sm:h-3.5 sm:w-8"
                style={{ background: col, boxShadow: c.dq ? 'none' : `0 0 14px ${col}99`, opacity: c.isWinner ? 1 : 0.92, outline: c.isWinner ? `2px solid var(--color-gold)` : 'none', filter: c.dq ? 'grayscale(1)' : 'none' }}
              />
              <span className="font-mono text-[9px] tnum sm:text-[10px]" style={{ color: c.isWinner ? 'var(--color-gold)' : c.dq ? 'var(--color-over)' : c.estimate != null ? '#cfcfd4' : 'var(--color-dim)' }}>
                {c.dq ? dqLabel(c.failReason) : c.estimate != null ? usd(c.estimate) : 'scouting…'}
              </span>
            </div>
          </div>
        );
      })}
      {/* start line — where the scored race begins; karts idle just behind it during agent evaluation */}
      <div className="absolute top-0 bottom-1.5 z-0" style={{ left: `${RACE_L}%`, marginLeft: -1, width: 2, background: 'repeating-linear-gradient(180deg, var(--color-dim) 0 5px, transparent 5px 10px)', opacity: 0.8 }} />
      <div className="absolute -top-3 z-10 rounded bg-panel px-1 font-mono text-[9px] uppercase tracking-[0.15em] text-dim" style={{ left: `${RACE_L}%`, transform: 'translateX(-50%)' }}>start</div>
      {/* finish line — anchored to RACE_R% so the leader's kart lands exactly on it */}
      <div className="absolute top-0 bottom-1.5 z-0" style={{ left: `${RACE_R}%`, marginLeft: -1.5, width: 3, background: 'linear-gradient(var(--color-volt), var(--color-gold))', boxShadow: '0 0 18px rgba(182,255,58,.55)' }} />
    </div>
  );
}
