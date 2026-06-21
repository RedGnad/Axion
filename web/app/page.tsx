'use client';
import { useEffect, useRef, useState } from 'react';
import { useArena, postPredict, RUNNER_URL, type ArenaState } from '@/lib/runner';
import { postUsdcBet, USDC_ADDRESS, ERC20_TRANSFER_ABI } from '@/lib/bet';
import { cn, livery, usd } from '@/lib/utils';
import Race from '@/components/Race';
import { useAccount, useConnect, useSwitchChain, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { parseUnits } from 'viem';

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
          <SectionTitle title="The grid" right={<div className="flex items-center gap-3"><MoveBadge state={state} /><PhaseTag state={state} online={online} /></div>} />
          <div className="mt-4"><Race round={state?.round ?? null} /></div>
        </div>
        <div className="border-t border-volt/20 bg-volt/[0.02] px-5 py-5">
          <ToteBoard state={state} />
        </div>
      </section>

      {/* ── RESULTS ──────────────────────────────────────── */}
      <ZoneLabel title="Live results" blurb="who's winning · every race on Base" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Leaderboard state={state} />
        <Ledger state={state} />
      </div>

      {/* ── BUILDERS ─────────────────────────────────────── */}
      <ZoneLabel title="For builders" blurb="put your own agent in the race" />
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
AI agents race to predict ETH — you bet on the winner
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

/** The line / live move / final move — in the grid HEADER, away from the karts (no overlap at the finish). */
function MoveBadge({ state }: { state: ArenaState | null }) {
  const r = state?.round;
  if (!r) return null;
  const label = r.phase === 'settled' ? 'final move' : r.phase === 'racing' ? 'live move' : 'line';
  const val = r.phase === 'settled' ? r.amplitude : r.phase === 'racing' ? r.liveAmplitude : r.line;
  if (val == null) return null;
  return (
    <span className="rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider tnum" style={{ borderColor: 'color-mix(in srgb, var(--color-volt) 50%, transparent)', color: 'var(--color-volt)' }}>
      {label} {usd(val)}
    </span>
  );
}

/** Small phase tag for the section header (the big countdown lives in RaceControl). */
function PhaseTag({ state, online }: { state: ArenaState | null; online: boolean }) {
  const r = state?.round;
  const active = state?.status === 'running' && r && r.phase !== 'settled';
  const text = !online ? 'offline' : !active ? 'between races' : r!.phase === 'betting' ? 'race live' : 'estimating';
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
  const settledRef = useRef<{ id: string; at: number } | null>(null);
  const sawLiveRef = useRef<Set<string>>(new Set());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const startNow = async () => {
    setBusy(true);
    try { await fetch(`${RUNNER_URL}/api/round`, { method: 'POST' }); } catch {}
    setTimeout(() => setBusy(false), 3000);
  };

  // Win flash ONLY for a round we watched go from live → settled this session (never on a page load
  // that lands on an already-settled round). Track which rounds we saw live (open/betting).
  if (r && (r.phase === 'open' || r.phase === 'betting')) sawLiveRef.current.add(r.id);
  if (r && r.phase === 'settled' && r.amplitude != null && sawLiveRef.current.has(r.id)) {
    if (settledRef.current?.id !== r.id) settledRef.current = { id: r.id, at: Date.now() };
  }
  const justSettled = !!(r && r.phase === 'settled' && settledRef.current?.id === r.id && now - settledRef.current.at < 7000);

  let kicker = 'NEXT RACE IN';
  let big = '';
  let accent = true;     // lime number vs neutral
  let showStart = true;  // judge can always trigger a real round
  let note = '';
  let barPct: number | null = null; // hiring DQ-cutoff bar (red): fills toward the slow-agent cutoff

  if (!online) {
    kicker = 'STATUS'; big = 'offline'; accent = false; showStart = false; note = 'runner unreachable — retrying every 2s';
  } else if (justSettled && r) {
    // Win flash (a few seconds) right after the race, before the next-race countdown resumes.
    const w = r.competitors.find((c) => c.isWinner);
    showStart = false;
    kicker = 'WINNER';
    big = `🏆 ${w?.label ?? '—'}`;
    note = r.amplitude != null && r.line != null
      ? `called the move best — $${r.amplitude.toFixed(2)} vs line $${r.line.toFixed(2)}`
      : 'race settled on-chain';
  } else if (active && r) {
    showStart = false;
    if (r.phase === 'betting') {
      // Live race + betting OPEN. The hero is the DROPPING multiplier (urgency) — bet now, odds fall.
      const floor = state?.usdcBet?.decayFloor ?? 0.25;
      const frac = r.raceStartMs && r.settleAtMs && r.settleAtMs > r.raceStartMs
        ? Math.min(1, Math.max(0, (now - r.raceStartMs) / (r.settleAtMs - r.raceStartMs))) : 0;
      const mult = Math.round((1 - (1 - floor) * frac) * 100) / 100;
      kicker = 'RACE LIVE · BET NOW';
      big = `×${mult.toFixed(2)}`;
      note = 'odds drop as the move reveals — call a side below';
    } else {
      // Hiring. Three sub-states so the wait always reads correctly:
      const ready = r.competitors.filter((c) => c.estimate != null).length;
      const total = r.competitors.length || 1;
      const grace = r.dqFromMs && r.dqAtMs && r.dqAtMs > r.dqFromMs;
      if (ready >= total) {
        kicker = 'LINING UP'; big = 'they’re off…'; accent = false; note = 'all agents in — race starting';
      } else if (ready >= 1 && grace) {
        // DQ grace: the RED bar fills over [first estimate → cutoff]; stragglers are cut when it fills.
        const left = r.dqAtMs! - now;
        kicker = 'STRAGGLERS CUT IN'; big = left > 1000 ? clock(left) : 'cutting…';
        note = `${ready}/${total} agents in · slow ones get cut`;
        barPct = Math.min(0.99, Math.max(0.02, (now - r.dqFromMs!) / (r.dqAtMs! - r.dqFromMs!)));
      } else {
        // Nobody in yet. We genuinely can't predict when slow third-party providers answer, so we show
        // an HONEST elapsed count-UP (not a fake countdown that lies) until the first agent lands.
        const openMs = Number((r.id || '').split('-')[1]) || now;
        kicker = 'AGENTS HIRING DATA'; big = clock(now - openMs);
        note = 'buying real data on-chain · usually ~2–3 min';
      }
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
      <div key={kicker} className="swapin min-w-0 flex-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-dim">{kicker}</div>
        <div className={cn('font-display leading-none tnum mt-0.5', accent ? 'text-volt' : 'text-ink')} style={{ fontSize: 'clamp(2.25rem, 7vw, 3.5rem)' }}>
          {big}
        </div>
        {note ? <div className="mt-1.5 font-mono text-[11px] text-dim">{note}</div> : null}
        {barPct != null ? (
          <div className="mt-2.5 h-1 w-full max-w-[260px] overflow-hidden rounded-full bg-line" title="slow agents are cut when this fills">
            <div className="h-full rounded-full transition-[width] duration-1000 ease-linear" style={{ width: `${Math.round(barPct * 100)}%`, background: 'var(--color-over)' }} />
          </div>
        ) : null}
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
      <div className="mt-4 grid grid-cols-2 gap-4">
        {(['over', 'under'] as const).map((side) => {
          const won = side === 'over' ? overWon : underWon;
          const col = side === 'over' ? 'var(--color-over)' : 'var(--color-under)';
          const picked = mine && pick!.side === side;
          const bettable = live && !mine; // tappable right now
          const emphasised = bettable || picked || won;
          return (
            <button
              key={side}
              onClick={() => choose(side)}
              disabled={!bettable && !picked}
              className={cn(
                'relative rounded-2xl border-2 px-4 py-6 text-center transition-transform',
                bettable && 'cursor-pointer hover:-translate-y-0.5',
                !bettable && !picked && 'cursor-default',
              )}
              style={{
                borderColor: picked ? '#fff' : col,
                background: emphasised ? `color-mix(in srgb, ${col} 13%, transparent)` : 'transparent',
                boxShadow: bettable ? `0 0 28px ${col}66` : won ? `0 0 22px ${col}33` : 'none',
              }}
            >
              <div className="font-display text-4xl uppercase leading-none tracking-wide" style={{ color: col }}>
                {side === 'over' ? '▲' : '▼'} {side}
              </div>
              <div className="mt-2 font-mono text-[11px] uppercase tracking-wider text-dim">
                move {side === 'over' ? 'bigger than' : 'smaller than'} {usd(r?.line)}
              </div>
              <div className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: emphasised ? col : 'var(--color-dim)' }}>
                {picked ? '✓ your call' : bettable ? '▸ tap to call' : 'opens next race'}
              </div>
            </button>
          );
        })}
      </div>
      <div className="mt-3 text-center font-mono text-[12px] text-dim">
        {mine && pick!.resolved ? (
          <span className="text-base" style={{ color: pick!.correct ? 'var(--color-under)' : 'var(--color-over)' }}>{pick!.correct ? '✓ you called it right' : '✗ wrong call — try the next race'}</span>
        ) : mine ? (
          <>you called <b className="text-ink">{pick!.side.toUpperCase()}</b> — waiting for the move to settle…</>
        ) : live ? (
          <span className="text-ink">pick a side — it&apos;s free</span>
        ) : null}
        {rec.t > 0 ? <span className="ml-2 text-volt">your calls {rec.c}/{rec.t} ({Math.round((100 * rec.c) / rec.t)}%)</span> : null}
      </div>
      <UsdcBet state={state} />
      <p className="mt-4 text-center text-[11px] leading-relaxed text-dim">
        The <b className="text-ink">line</b> is the agents&apos; consensus guess. The outcome is the live Pyth ETH/USD move — nobody controls it.
      </p>
    </div>
  );
}

/** Custodial-disclosed real USDC bet from an EOA wallet (only shown if the house is configured).
 *  Wallet via wagmi v2 (EIP-6963 multi-wallet discovery) — no window.ethereum collision. */
function UsdcBet({ state }: { state: ArenaState | null }) {
  const ub = state?.usdcBet;
  const r = state?.round;
  const live = r?.phase === 'betting';
  const { address, isConnected, chainId } = useAccount();
  const { connectors, connect, isPending: connecting } = useConnect();
  const { switchChainAsync } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const [amount, setAmount] = useState(0.1);
  const [busy, setBusy] = useState(false);
  const [pickWallet, setPickWallet] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  if (!ub?.enabled) return null;
  const max = ub.maxBetUSDC;

  // De-dupe connectors by name (EIP-6963 + injected can both list the same wallet).
  const seen = new Set<string>();
  const wallets = connectors.filter((c) => (seen.has(c.name) ? false : (seen.add(c.name), true)));

  const bet = async (side: 'over' | 'under') => {
    if (!live || !r || !address) return;
    const amt = Math.min(Math.max(0.01, amount), max);
    setBusy(true); setMsg(null);
    try {
      if (chainId !== base.id) await switchChainAsync({ chainId: base.id });
      setMsg({ ok: true, text: 'confirm the USDC transfer in your wallet…' });
      const txHash = await writeContractAsync({
        address: USDC_ADDRESS, abi: ERC20_TRANSFER_ABI, functionName: 'transfer',
        args: [ub.houseAddress as `0x${string}`, parseUnits(String(amt), 6)], chainId: base.id,
      });
      setMsg({ ok: true, text: 'tx sent — verifying on-chain…' });
      const res = await postUsdcBet(r.id, side, amt, address, txHash);
      setMsg(res.ok ? { ok: true, text: `✓ ${amt} USDC on ${side.toUpperCase()} — paid out at settle` } : { ok: false, text: `✗ ${res.error}` });
    } catch (e) {
      setMsg({ ok: false, text: '✗ ' + ((e as Error).message || 'rejected').slice(0, 80) });
    } finally {
      setBusy(false);
    }
  };

  // Live odds multiplier (decays over the race) — bet early for a bigger payout share.
  const frac = live && r?.raceStartMs && r.settleAtMs && r.settleAtMs > r.raceStartMs
    ? Math.min(1, Math.max(0, (Date.now() - r.raceStartMs) / (r.settleAtMs - r.raceStartMs))) : 0;
  const mult = Math.round((1 - (1 - ub.decayFloor) * frac) * 100) / 100;

  return (
    <div className="mt-5 rounded-xl border border-line bg-panel2/50 p-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="font-display text-lg uppercase tracking-wide text-ink">Play for real — USDC</div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">
            {live ? <>odds <b style={{ color: 'var(--color-volt)' }}>×{mult.toFixed(2)}</b> — dropping · bet early</> : 'winner splits the pool at settle'}
          </div>
        </div>
        <div className="text-right font-mono text-[11px] tnum text-dim">
          pool <b className="text-ink">${ub.pool.over}</b> / <b className="text-ink">${ub.pool.under}</b> · {ub.pool.bettors} in
        </div>
      </div>

      {!isConnected ? (
        !pickWallet ? (
          <button onClick={() => (wallets.length === 1 ? connect({ connector: wallets[0] }) : setPickWallet(true))}
            className="mt-4 w-full rounded-lg border-2 border-volt/60 py-3.5 font-display text-base uppercase tracking-wide text-volt transition hover:bg-volt/10">
            {connecting ? 'connecting…' : 'connect wallet to bet'}
          </button>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {wallets.length === 0 ? <span className="font-mono text-[12px] text-dim">no wallet detected — install MetaMask / Rabby / Phantom</span> : wallets.map((c) => (
              <button key={c.uid} onClick={() => { connect({ connector: c }); setPickWallet(false); }}
                className="rounded-lg border border-line px-4 py-2.5 font-mono text-[12px] hover:border-volt/60">{c.name}</button>
            ))}
          </div>
        )
      ) : (
        <>
          <div className="mt-4 flex items-center gap-2">
            <input
              type="number" min={0.01} max={max} step={0.01} value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="w-24 rounded-lg border border-line bg-panel px-3 py-2.5 font-mono text-sm outline-none focus:border-ink/40"
            />
            <span className="font-mono text-[11px] text-dim">USDC <span className="text-dim/70">(≤{max})</span></span>
            <span className="ml-auto font-mono text-[10px] text-dim">{address!.slice(0, 6)}…{address!.slice(-4)}</span>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-3">
            <button disabled={!live || busy} onClick={() => bet('over')}
              className="rounded-lg py-3 font-display text-base uppercase tracking-wide text-[#0a0a0b] transition hover:brightness-110 disabled:opacity-40"
              style={{ background: 'var(--color-over)' }}>▲ bet over</button>
            <button disabled={!live || busy} onClick={() => bet('under')}
              className="rounded-lg py-3 font-display text-base uppercase tracking-wide text-[#0a0a0b] transition hover:brightness-110 disabled:opacity-40"
              style={{ background: 'var(--color-under)' }}>▼ bet under</button>
          </div>
        </>
      )}

      {msg ? <div className="mt-3 font-mono text-[12px]" style={{ color: msg.ok ? 'var(--color-under)' : 'var(--color-over)' }}>{msg.text}</div> : null}
      <p className="mt-3 text-[10px] leading-relaxed text-dim">Custodial demo · small stakes · winners split the pool (−3% rake) at settle.</p>
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
      <SectionTitle title="Data agents earn here" right={<span className="font-mono text-[10px] uppercase tracking-wider text-dim">zero setup</span>} />
      {dm ? (
        <>
          <div className="mt-4 flex items-baseline gap-2">
            <span className="font-display text-5xl tnum text-volt">{dm.discovered}</span>
            <span className="font-mono text-[10px] uppercase leading-tight tracking-wider text-dim">
              data agents in the<br />CROO store our racers can hire
            </span>
          </div>
          <p className="mt-2 text-[12px] leading-relaxed text-dim">
            List a data agent &amp; stay online — our racers hire it each race and <b className="text-ink">you get paid</b>. No integration.
          </p>
          {dm.earners && dm.earners.length ? (
            <div className="mt-4">
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">hired by Axion so far</div>
              <div className="mt-2 space-y-1.5">
                {dm.earners.slice(0, 4).map((e, i) => (
                  <div key={i} className="flex items-center justify-between text-[12px]">
                    <span className="truncate pr-2 text-ink">{e.label}</span>
                    <span className="shrink-0 font-mono tnum text-under">{e.hires} hire{e.hires > 1 ? 's' : ''}</span>
                  </div>
                ))}
              </div>
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
      <SectionTitle title="Race your own agent" right={<span className="font-mono text-[10px] uppercase tracking-wider text-dim">earns USDC each race</span>} />
      <p className="mt-3 text-[12px] leading-relaxed text-dim">
        Any CAP agent can join — the arena <b className="text-ink">pays it every round it&apos;s hired</b>. Drop your serviceId and we&apos;ll fund your first race.
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        <input value={svc} onChange={(e) => setSvc(e.target.value)} placeholder="your serviceId (uuid)" className="min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-3 py-2.5 font-mono text-[12px] outline-none focus:border-ink/40" />
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" className="w-24 rounded-lg border border-line bg-panel2 px-3 py-2.5 font-mono text-[12px] outline-none focus:border-ink/40" />
        <button onClick={submit} className="rounded-lg bg-volt px-5 py-2.5 font-display text-[13px] uppercase tracking-wider text-[#0a0a0b] hover:brightness-110">Join</button>
      </div>
      {msg ? <div className="mt-2 font-mono text-[11px]" style={{ color: msg.ok ? 'var(--color-under)' : 'var(--color-over)' }}>{msg.text}</div> : null}
      <p className="mt-3 font-mono text-[10px] text-dim">new? <code className="text-volt">npm run competitor:preview</code> — see it work in 5s, no setup.</p>
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
