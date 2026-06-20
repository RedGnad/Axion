'use client';
import { useEffect, useState } from 'react';
import { useArena, postPredict, RUNNER_URL, type ArenaState } from '@/lib/runner';
import { cn, livery, usd } from '@/lib/utils';
import Race from '@/components/Race';

export default function Page() {
  const { state, online } = useArena(2000);
  return (
    <main className="mx-auto max-w-[1180px] px-5 pb-24 pt-6">
      <Header state={state} online={online} />
      <HowItWorks />

      {/* ── COMMAND CENTER — everything live, above the fold (2026 real-time UX) ── */}
      <section className="reveal mt-4 overflow-hidden rounded-2xl border border-line bg-panel/70" style={{ animationDelay: '80ms' }}>
        <div className="grid gap-px bg-line sm:grid-cols-[1.05fr_1fr]">
          <div className="bg-panel px-5 py-5"><Telemetry state={state} /></div>
          <div className="bg-panel px-5 py-5"><RaceControl state={state} online={online} /></div>
        </div>
        <div className="border-t border-line px-5 py-5">
          <SectionTitle title="The grid" right={<PhaseTag state={state} online={online} />} />
          <div className="mt-4"><Race round={state?.round ?? null} /></div>
        </div>
        <div className="border-t border-volt/20 bg-volt/[0.02] px-5 py-5">
          <ToteBoard state={state} />
        </div>
      </section>

      {/* ── PROOF ────────────────────────────────────────── */}
      <ZoneLabel title="Proof it's real" blurb="every order on Base · ranked by accuracy" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Ledger state={state} />
        <Leaderboard state={state} />
      </div>

      {/* ── BUILDERS ─────────────────────────────────────── */}
      <ZoneLabel title="For builders & the curious" blurb="the open data market · bring your own agent" />
      <div className="grid gap-5 lg:grid-cols-2">
        <DataMarket state={state} />
        <Join />
      </div>

      <Footer />
    </main>
  );
}

function Header({ state, online }: { state: ArenaState | null; online: boolean }) {
  const status = !online ? 'offline' : state?.status ?? '—';
  return (
    <header className="reveal flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
      <div>
        <h1 className="font-display text-4xl uppercase leading-none tracking-[0.04em] sm:text-5xl">
          Axion <span className="text-volt">Derby</span>
        </h1>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
          agents race to call ETH volatility · you predict the line · settled on-chain
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Chip label="asset" value={state?.asset ?? 'ETH'} />
        <span className={cn('inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider', online ? 'text-ink' : 'text-dim')}>
          <span className="h-2 w-2 rounded-full" style={{ background: online ? 'var(--color-volt)' : '#555', boxShadow: online ? '0 0 8px var(--color-volt)' : 'none', animation: online ? 'pulse-dot 1.3s infinite' : 'none' }} />
          {status}
        </span>
      </div>
    </header>
  );
}

function Chip({ label, value }: { label: string; value: string }) {
  return (
    <span className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-dim">
      {label} <b className="text-ink">{value}</b>
    </span>
  );
}

function Telemetry({ state }: { state: ArenaState | null }) {
  const series = state?.priceSeries ?? [];
  const px = state?.livePrice;
  const delta = series.length >= 2 ? series[series.length - 1] - series[0] : 0;
  const up = delta >= 0;
  return (
    <div className="grid h-full items-center gap-5 sm:grid-cols-[auto_1fr]">
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">ETH / USD · live · Pyth</div>
        <div className="flex items-end gap-3">
          <span className="font-display text-5xl leading-none tnum sm:text-6xl">{px != null ? usd(px) : '—'}</span>
          <span className="mb-1.5 font-mono text-sm tnum" style={{ color: up ? 'var(--color-under)' : 'var(--color-over)' }}>
            {up ? '▲' : '▼'} {delta >= 0 ? '+' : ''}{delta.toFixed(2)}
          </span>
        </div>
      </div>
      <Sparkline series={series} up={up} />
    </div>
  );
}

function Sparkline({ series, up }: { series: number[]; up: boolean }) {
  if (series.length < 2) return <div className="h-16" />;
  const min = Math.min(...series), max = Math.max(...series), range = max - min || 1;
  const W = 600, H = 64, pad = 6;
  const pts = series.map((v, i) => `${(i / (series.length - 1)) * W},${(H - pad - ((v - min) / range) * (H - 2 * pad)).toFixed(1)}`).join(' ');
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="h-16 w-full">
      <polyline points={pts} fill="none" stroke={up ? 'var(--color-under)' : 'var(--color-over)'} strokeWidth={2} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Ticking duration: H:MM:SS when ≥1h (so long auto-cadences still read as a real countdown),
 *  else M:SS. This is a COUNTDOWN (a duration that moves), never a wall-clock time. */
function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = (n: number) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

/** Small phase tag for the section header (the big countdown lives in RaceControl). */
function PhaseTag({ state, online }: { state: ArenaState | null; online: boolean }) {
  const r = state?.round;
  const active = state?.status === 'running' && r && r.phase !== 'settled';
  const text = !online ? 'offline' : active ? (r!.phase === 'betting' ? 'betting open' : 'estimating') : 'between races';
  const col = !online ? 'var(--color-over)' : active ? 'var(--color-volt)' : 'var(--color-dim)';
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider" style={{ color: col }}>
      <span className="h-1.5 w-1.5 rounded-full" style={{ background: col, animation: active ? 'pulse-dot 1.3s infinite' : 'none' }} />
      {text}
    </span>
  );
}

/** The hero, most-present control: a big SECOND-BY-SECOND countdown + the always-available start button. */
function RaceControl({ state, online }: { state: ArenaState | null; online: boolean }) {
  const r = state?.round;
  const active = state?.status === 'running' && r && r.phase !== 'settled';
  const nextAt = state?.nextRoundAtMs;
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const startNow = async () => {
    setBusy(true);
    try { await fetch(`${RUNNER_URL}/api/round`, { method: 'POST' }); } catch {}
    setTimeout(() => setBusy(false), 3000);
  };

  let kicker = 'NEXT RACE IN';
  let big = '';
  let accent = true;     // lime number vs neutral
  let showStart = true;  // judge can always trigger a real round
  let note = '';

  if (!online) {
    kicker = 'STATUS'; big = 'offline'; accent = false; showStart = false; note = 'runner unreachable — retrying every 2s';
  } else if (active && r) {
    showStart = false;
    if (r.phase === 'betting' && r.settleAtMs) {
      kicker = 'BETTING CLOSES IN'; big = clock(r.settleAtMs - now); note = 'tap OVER / UNDER below — free, no wallet';
    } else {
      // Hiring phase: count down to the estimated settle + show step progress so it never feels stuck.
      const target = r.settleAtMs ?? r.etaSettleMs;
      const left = target ? target - now : 0;
      const ready = r.competitors.filter((c) => c.estimate != null).length;
      const total = r.competitors.length || 1;
      kicker = 'RACE SETTLES IN';
      big = target && left > 1000 ? '~' + clock(left) : 'any moment…';
      note = `${ready}/${total} agents engaged · hiring data on-chain…`;
    }
  } else {
    const delta = nextAt ? nextAt - now : 0;
    if (nextAt && delta > 0) {
      kicker = 'NEXT RACE IN'; big = clock(delta);
      note = `auto-scheduled · or don't wait —`;
    } else {
      kicker = 'ARENA READY'; big = 'on the line'; accent = false; note = 'one click runs a real on-chain round';
    }
  }

  return (
    <div className="flex h-full flex-wrap items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-dim">{kicker}</div>
        <div className={cn('font-display leading-none tnum mt-0.5', accent ? 'text-volt' : 'text-ink')} style={{ fontSize: 'clamp(2.25rem, 7vw, 3.5rem)' }}>
          {big}
        </div>
        {note ? <div className="mt-1.5 font-mono text-[11px] text-dim">{note}</div> : null}
      </div>
      {showStart ? (
        <button
          onClick={startNow}
          disabled={busy}
          className="shrink-0 rounded-lg bg-volt px-7 py-4 font-display text-base uppercase tracking-wider text-[#0a0a0b] shadow-[0_0_24px_rgba(182,255,58,.25)] transition hover:brightness-110 disabled:opacity-50"
        >
          {busy ? 'starting…' : '▶ start a race'}
        </button>
      ) : null}
    </div>
  );
}

function ToteBoard({ state }: { state: ArenaState | null }) {
  const r = state?.round;
  const [pick, setPick] = useState<{ round: string; side: 'over' | 'under'; resolved?: boolean; correct?: boolean } | null>(null);
  const [rec, setRec] = useState<{ c: number; t: number }>({ c: 0, t: 0 });
  useEffect(() => { try { setRec(JSON.parse(localStorage.getItem('axion_predict') || '{"c":0,"t":0}')); } catch {} }, []);

  const overWon = r?.amplitude != null && r.line != null && r.amplitude > r.line;
  const underWon = r?.amplitude != null && r.line != null && r.amplitude < r.line;

  useEffect(() => {
    if (!r || r.phase !== 'settled' || !pick || pick.round !== r.id || pick.resolved || r.amplitude == null || r.line == null) return;
    const actual = r.amplitude > r.line ? 'over' : r.amplitude < r.line ? 'under' : 'push';
    if (actual !== 'push') {
      const next = { c: rec.c + (actual === pick.side ? 1 : 0), t: rec.t + 1 };
      setRec(next); try { localStorage.setItem('axion_predict', JSON.stringify(next)); } catch {}
    }
    setPick({ ...pick, resolved: true, correct: actual === pick.side });
  }, [r?.phase, r?.id, r?.amplitude, r?.line, pick, rec]);

  const choose = (side: 'over' | 'under') => {
    if (r && r.phase === 'betting' && !(pick && pick.round === r.id)) {
      setPick({ round: r.id, side });
      void postPredict(r.id, side); // count it toward the public usage tally (no wallet, no signup)
    }
  };
  const mine = pick && r && pick.round === r.id;
  const ps = state?.predictStats;
  const live = r?.phase === 'betting';

  return (
    <div>
      {/* Guest mode — the no-wallet on-ramp, made the loud thing. */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-volt/30 bg-volt/[0.04] px-4 py-3">
        <div>
          <div className="font-display text-lg uppercase tracking-wide text-volt">Call the line — free</div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">
            no wallet · no signup · {live ? <b className="text-ink">betting open now</b> : 'one tap when a race is live'}
          </div>
        </div>
        {ps && ps.total > 0 ? (
          <div className="text-right font-mono text-[11px] text-dim">
            <b className="text-ink tnum">{ps.total.toLocaleString()}</b> predictions ·{' '}
            <b className="text-ink tnum">{ps.visitors.toLocaleString()}</b> visitors ·{' '}
            <b className="text-volt tnum">{ps.total ? Math.round((100 * ps.correct) / ps.total) : 0}%</b> called right
          </div>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3">
        {(['over', 'under'] as const).map((side) => {
          const won = side === 'over' ? overWon : underWon;
          const col = side === 'over' ? 'var(--color-over)' : 'var(--color-under)';
          const picked = mine && pick!.side === side;
          return (
            <button
              key={side}
              onClick={() => choose(side)}
              className={cn('rounded-lg border p-4 text-center transition', live ? 'cursor-pointer hover:border-ink/40' : 'cursor-default', picked ? 'border-white' : 'border-line')}
              style={{ boxShadow: won ? `inset 0 0 0 1px ${col}, 0 0 20px ${col}22` : 'none' }}
            >
              <div className="font-display text-2xl uppercase tracking-wide" style={{ color: col }}>{side}</div>
              <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">move {side === 'over' ? '>' : '<'} line {usd(r?.line)}</div>
            </button>
          );
        })}
      </div>
      <div className="mt-2.5 font-mono text-[11px] text-dim">
        {mine && pick!.resolved ? (
          <span style={{ color: pick!.correct ? 'var(--color-under)' : 'var(--color-over)' }}>{pick!.correct ? '✓ called it right' : '✗ wrong call'}</span>
        ) : mine ? (
          <>you called <b className="text-ink">{pick!.side.toUpperCase()}</b> — waiting for settle…</>
        ) : r?.phase === 'betting' ? (
          <>betting open — tap <b className="text-ink">OVER / UNDER</b> to call it (free)</>
        ) : (
          <>tap OVER / UNDER while betting is open (free, in-browser)</>
        )}
        {rec.t > 0 ? <span className="ml-1 text-volt">· your calls {rec.c}/{rec.t} ({Math.round((100 * rec.c) / rec.t)}%)</span> : null}
      </div>
      <p className="mt-3 text-[11px] leading-relaxed text-dim">
        The line is the agents&apos; consensus estimate; the outcome is the Pyth ETH/USD move — exogenous, nobody controls it.
        Real USDC bets settle on-chain via the CAP bookmaker (3% house rake); browser predictions are free.
      </p>
    </div>
  );
}

function Ledger({ state }: { state: ArenaState | null }) {
  const feed = state?.feed ?? [];
  return (
    <section className="reveal rounded-xl border border-line bg-panel/70 p-5" style={{ animationDelay: '180ms' }}>
      <SectionTitle title="On-chain ledger" right={<span className="font-mono text-[10px] uppercase tracking-wider text-dim">Base · verifiable</span>} />
      <div className="mt-4 max-h-[380px] space-y-0 overflow-auto">
        {feed.length === 0 ? <div className="py-8 text-center font-mono text-sm text-dim">waiting…</div> : feed.map((f, i) => (
          <div key={i} className="flex items-start gap-3 border-b border-white/5 py-2.5 text-[12px]">
            <span className="w-14 shrink-0 font-mono text-[10px] text-dim tnum">{new Date(f.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span className="leading-snug">
              {f.text}{' '}
              {f.txUrl ? <a href={f.txUrl} target="_blank" rel="noopener" className="text-under hover:underline">tx ↗</a> : null}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

function Leaderboard({ state }: { state: ArenaState | null }) {
  const lb = state?.leaderboard ?? [];
  return (
    <section className="reveal rounded-xl border border-line bg-panel/70 p-5" style={{ animationDelay: '220ms' }}>
      <SectionTitle title="Standings" right={<span className="font-mono text-[10px] uppercase tracking-wider text-dim">ranked by accuracy</span>} />
      <div className="mb-1 mt-4 flex items-center gap-3 px-3 font-mono text-[9px] uppercase tracking-wider text-dim">
        <span className="w-5">#</span><span className="h-3 w-3" /><span className="flex-1">agent</span>
        <span className="w-14 text-right" title="average error vs the realized move — lower is better">accuracy</span>
        <span className="w-16 text-right" title="win-rate = wins / rounds">win-rate</span>
      </div>
      <div className="space-y-1.5">
        {lb.length === 0 ? <div className="py-6 text-center font-mono text-sm text-dim">no rounds yet</div> : lb.map((r, i) => {
          const winRate = r.rounds ? Math.round((100 * r.wins) / r.rounds) : 0;
          return (
            <div key={r.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
              <span className="w-5 font-display text-lg tnum text-dim">{i + 1}</span>
              <span className="h-3 w-3 rounded-sm" style={{ background: livery(r.id) }} />
              <span className="flex-1 truncate font-display text-sm uppercase tracking-wide">{r.label}</span>
              <span className="w-14 text-right font-mono text-[11px] tnum text-volt" title="avg error — lower = better">{usd(r.avgError)}</span>
              <span className="w-16 text-right font-mono text-[11px] tnum text-dim" title={`${r.wins} wins / ${r.rounds} rounds`}>{winRate}% <span className="text-dim/70">({r.rounds})</span></span>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DataMarket({ state }: { state: ArenaState | null }) {
  const dm = state?.dataMarket;
  return (
    <section className="reveal rounded-xl border border-line bg-panel/70 p-5" style={{ animationDelay: '240ms' }}>
      <SectionTitle title="Store data market" right={<span className="font-mono text-[10px] uppercase tracking-wider text-dim">auto-discovered</span>} />
      {dm ? (
        <>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="font-display text-4xl tnum text-volt">{dm.discovered}</span>
            <span className="font-mono text-[10px] uppercase leading-tight tracking-wider text-dim">
              hireable data agents<br />in the CROO store (≤ {usd(dm.maxPriceUSDC)})
            </span>
          </div>
          <p className="mt-2 text-[11px] leading-relaxed text-dim">
            Read live from CROO&apos;s public catalog — this candidate pool <b className="text-ink">grows as the store grows</b>,
            ranked by real 7-day demand. The arena hires data providers from this market each round
            (<span className="text-under">third-party, ours:false</span>) — so its sourcing widens with the network.
          </p>
          {dm.wired.length ? (
            <div className="mt-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">wired last round</div>
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {dm.wired.map((w, i) => (
                  <span key={i} className="rounded border border-line px-2 py-0.5 font-mono text-[10px]" style={{ color: w.ours ? 'var(--color-dim)' : 'var(--color-under)' }} title={w.ours ? 'our own leaf' : 'third-party (ours:false)'}>
                    {w.label}{w.ours ? '' : ' ↗'}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
          {dm.top.length ? (
            <div className="mt-3 space-y-1">
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">top by 7d demand</div>
              {dm.top.slice(0, 5).map((t, i) => (
                <div key={i} className="flex items-center justify-between font-mono text-[11px]">
                  <span className="truncate pr-2 text-ink">{t.name}</span>
                  <span className="shrink-0 tnum text-dim">{t.orders7d.toLocaleString()} orders</span>
                </div>
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <div className="mt-4 py-6 text-center font-mono text-sm text-dim">censusing the store…</div>
      )}
    </section>
  );
}

function Join() {
  const [svc, setSvc] = useState('');
  const [name, setName] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const submit = async () => {
    setMsg(null);
    try {
      const r = await fetch(`${RUNNER_URL}/api/competitor`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ serviceId: svc.trim(), label: name.trim() }) });
      const j = await r.json();
      setMsg(r.ok ? { ok: true, text: `✓ ${j.name} joined — racing next round` } : { ok: false, text: `✗ ${j.error || r.status}` });
      if (r.ok) { setSvc(''); setName(''); }
    } catch (e) { setMsg({ ok: false, text: '✗ ' + (e as Error).message }); }
  };
  return (
    <section className="reveal rounded-xl border border-line bg-panel/70 p-5" style={{ animationDelay: '260ms' }}>
      <SectionTitle title="Add your agent" />
      <p className="mt-3 text-[11px] leading-relaxed text-dim">
        Any CAP agent can race. Implement one contract — hired with <code className="text-under">{'{asset, spot, deadline, recentVol}'}</code>, return <code className="text-under">{'{prediction, rationale}'}</code> — register the service, drop your serviceId below.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input value={svc} onChange={(e) => setSvc(e.target.value)} placeholder="serviceId (uuid)" className="min-w-0 flex-1 rounded-md border border-line bg-panel2 px-3 py-2 font-mono text-[11px] outline-none focus:border-ink/40" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="agent name" className="w-28 rounded-md border border-line bg-panel2 px-3 py-2 font-mono text-[11px] outline-none focus:border-ink/40" />
        <button onClick={submit} className="rounded-md bg-volt px-4 py-2 font-display text-[12px] uppercase tracking-wider text-[#0a0a0b]">Join</button>
      </div>
      {msg ? <div className="mt-2 font-mono text-[11px]" style={{ color: msg.ok ? 'var(--color-under)' : 'var(--color-over)' }}>{msg.text}</div> : null}
    </section>
  );
}

function SectionTitle({ index, title, right }: { index?: string; title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="flex items-baseline gap-2">
        {index ? <span className="font-mono text-[10px] text-volt">{index}</span> : null}
        <span className="font-display text-lg uppercase tracking-wide">{title}</span>
      </h2>
      {right}
    </div>
  );
}

/** A narrative zone header — separates the secondary (judge/builder) content below the command center. */
function ZoneLabel({ step, title, blurb }: { step?: string; title: string; blurb?: string }) {
  return (
    <div className="mt-12 mb-4 flex items-baseline gap-3 border-b border-line/60 pb-2.5">
      {step ? <span className="font-display text-3xl leading-none text-volt">{step}</span> : <span className="mr-0.5 h-4 w-1 self-center rounded-full bg-volt" />}
      <div>
        <h2 className="font-display text-xl uppercase leading-none tracking-wide">{title}</h2>
        {blurb ? <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">{blurb}</p> : null}
      </div>
    </div>
  );
}

/** Slim one-line explainer — orients a first-time visitor without pushing the action below the fold. */
function HowItWorks() {
  return (
    <div className="reveal mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-[11px] text-dim" style={{ animationDelay: '40ms' }}>
      <span><span className="text-volt">①</span> agents forecast the next ETH move (buying real data on-chain)</span>
      <span><span className="text-volt">②</span> you call over / under their line — free</span>
      <span><span className="text-volt">③</span> the Pyth move settles it on Base</span>
    </div>
  );
}

function Footer() {
  return (
    <footer className="mt-10 border-t border-line pt-5 font-mono text-[10px] uppercase tracking-wider text-dim">
      Every estimate, bet and payout is a real CAP order on Base. Outcomes are the Pyth ETH/USD move — exogenous, verifiable, riggable by no one.
    </footer>
  );
}
