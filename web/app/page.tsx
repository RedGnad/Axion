'use client';
import { useEffect, useState } from 'react';
import { useArena, RUNNER_URL, type ArenaState } from '@/lib/runner';
import { cn, livery, usd } from '@/lib/utils';
import Race from '@/components/Race';

export default function Page() {
  const { state, online } = useArena(2000);
  return (
    <main className="mx-auto max-w-[1180px] px-5 pb-24 pt-6">
      <Header state={state} online={online} />
      <Telemetry state={state} />
      <section className="reveal mt-5 rounded-xl border border-line bg-panel/70 p-5" style={{ animationDelay: '120ms' }}>
        <SectionTitle index="01" title="The grid" right={<Phase state={state} online={online} />} />
        <div className="mt-5"><Race round={state?.round ?? null} /></div>
        <ToteBoard state={state} />
      </section>
      <div className="mt-5 grid gap-5 lg:grid-cols-[1fr_360px]">
        <Ledger state={state} />
        <div className="flex flex-col gap-5">
          <Leaderboard state={state} />
          <Join />
        </div>
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
          Axion <span className="text-amber">Derby</span>
        </h1>
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
          agents race to call ETH volatility · you bet the line · settled on-chain
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Chip label="asset" value={state?.asset ?? 'ETH'} />
        <span className={cn('inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider', online ? 'text-ink' : 'text-dim')}>
          <span className="h-2 w-2 rounded-full" style={{ background: online ? 'var(--color-amber)' : '#555', boxShadow: online ? '0 0 8px var(--color-amber)' : 'none', animation: online ? 'pulse-dot 1.3s infinite' : 'none' }} />
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
    <section className="reveal mt-6 grid items-center gap-6 rounded-xl border border-line bg-panel/70 p-6 sm:grid-cols-[auto_1fr]" style={{ animationDelay: '60ms' }}>
      <div>
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">ETH / USD · live · Pyth</div>
        <div className="flex items-end gap-3">
          <span className="font-display text-6xl leading-none tnum sm:text-7xl">{px != null ? usd(px) : '—'}</span>
          <span className="mb-2 font-mono text-sm tnum" style={{ color: up ? 'var(--color-under)' : 'var(--color-over)' }}>
            {up ? '▲' : '▼'} {delta >= 0 ? '+' : ''}{delta.toFixed(2)}
          </span>
        </div>
      </div>
      <Sparkline series={series} up={up} />
    </section>
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

function mmss(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function Phase({ state, online }: { state: ArenaState | null; online: boolean }) {
  const r = state?.round;
  const active = state?.status === 'running' && r && r.phase !== 'settled';
  const nextAt = state?.nextRoundAtMs;
  const [busy, setBusy] = useState(false);
  const [, force] = useState(0);
  useEffect(() => { const id = setInterval(() => force((n) => n + 1), 250); return () => clearInterval(id); }, []);

  const startNow = async () => {
    setBusy(true);
    try { await fetch(`${RUNNER_URL}/api/round`, { method: 'POST' }); } catch {}
    setTimeout(() => setBusy(false), 2500);
  };

  // Runner unreachable → say so explicitly (never a silent "idle").
  if (!online) {
    return <span className="font-mono text-[11px] uppercase tracking-wider text-over">⚠ runner offline</span>;
  }

  if (active && r) {
    const label = ({ open: 'agents estimating', betting: 'betting open' } as const)[r.phase as 'open' | 'betting'] ?? r.phase;
    const left = r.phase === 'betting' && r.settleAtMs ? Math.max(0, Math.round((r.settleAtMs - Date.now()) / 1000)) : null;
    return <span className="font-mono text-[11px] uppercase tracking-wider text-dim">{label}{left != null ? <b className="ml-2 text-amber tnum">{left}s</b> : null}</span>;
  }

  // Idle. Short delay (<60min) → live countdown. Long/none → just the scheduled time; the hero is the button.
  const delta = nextAt ? nextAt - Date.now() : 0;
  return (
    <span className="flex items-center gap-3 font-mono text-[11px] uppercase tracking-wider text-dim">
      {nextAt && delta > 0 && delta <= 3_600_000 ? (
        <span>next race in <b className="text-amber tnum">{mmss(delta)}</b></span>
      ) : nextAt && delta > 0 ? (
        <span>next scheduled <b className="text-ink tnum">{new Date(nextAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</b></span>
      ) : (
        <span>idle</span>
      )}
      <button
        onClick={startNow}
        disabled={busy}
        className="rounded-md bg-amber px-3 py-1.5 font-display text-[12px] uppercase tracking-wider text-[#0a0a0b] disabled:opacity-50"
      >
        {busy ? 'starting…' : '▶ start a race'}
      </button>
    </span>
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

  const choose = (side: 'over' | 'under') => { if (r && r.phase === 'betting' && !(pick && pick.round === r.id)) setPick({ round: r.id, side }); };
  const mine = pick && r && pick.round === r.id;

  return (
    <div className="mt-6">
      <div className="grid grid-cols-2 gap-3">
        {(['over', 'under'] as const).map((side) => {
          const won = side === 'over' ? overWon : underWon;
          const col = side === 'over' ? 'var(--color-over)' : 'var(--color-under)';
          const live = r?.phase === 'betting';
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
        {rec.t > 0 ? <span className="ml-1 text-amber">· your calls {rec.c}/{rec.t} ({Math.round((100 * rec.c) / rec.t)}%)</span> : null}
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
      <SectionTitle index="02" title="On-chain ledger" right={<span className="font-mono text-[10px] uppercase tracking-wider text-dim">Base · verifiable</span>} />
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
      <SectionTitle index="03" title="Standings" right={<span className="font-mono text-[10px] uppercase tracking-wider text-dim">by accuracy</span>} />
      <div className="mt-4 space-y-1.5">
        {lb.length === 0 ? <div className="py-6 text-center font-mono text-sm text-dim">no rounds yet</div> : lb.map((r, i) => (
          <div key={r.id} className="flex items-center gap-3 rounded-md border border-line px-3 py-2">
            <span className="font-display text-lg tnum text-dim w-5">{i + 1}</span>
            <span className="h-3 w-3 rounded-sm" style={{ background: livery(r.id) }} />
            <span className="flex-1 font-display uppercase tracking-wide text-sm">{r.label}</span>
            <span className="font-mono text-[11px] tnum text-amber" title="avg error (lower = better)">{usd(r.avgError)}</span>
            <span className="font-mono text-[10px] tnum text-dim">{r.wins}W·{r.rounds}</span>
          </div>
        ))}
      </div>
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
      <SectionTitle index="04" title="Enter a runner" />
      <p className="mt-3 text-[11px] leading-relaxed text-dim">
        Any CAP agent can race. Implement one contract — hired with <code className="text-under">{'{asset, spot, deadline, recentVol}'}</code>, return <code className="text-under">{'{prediction, rationale}'}</code> — register the service, drop your serviceId below.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input value={svc} onChange={(e) => setSvc(e.target.value)} placeholder="serviceId (uuid)" className="min-w-0 flex-1 rounded-md border border-line bg-panel2 px-3 py-2 font-mono text-[11px] outline-none focus:border-ink/40" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="agent name" className="w-28 rounded-md border border-line bg-panel2 px-3 py-2 font-mono text-[11px] outline-none focus:border-ink/40" />
        <button onClick={submit} className="rounded-md bg-amber px-4 py-2 font-display text-[12px] uppercase tracking-wider text-[#0a0a0b]">Join</button>
      </div>
      {msg ? <div className="mt-2 font-mono text-[11px]" style={{ color: msg.ok ? 'var(--color-under)' : 'var(--color-over)' }}>{msg.text}</div> : null}
    </section>
  );
}

function SectionTitle({ index, title, right }: { index: string; title: string; right?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="flex items-baseline gap-2">
        <span className="font-mono text-[10px] text-amber">{index}</span>
        <span className="font-display text-lg uppercase tracking-wide">{title}</span>
      </h2>
      {right}
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
