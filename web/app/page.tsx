'use client';
import { useEffect, useRef, useState } from 'react';
import { useArena, postPredict, RUNNER_URL, type ArenaState } from '@/lib/runner';
import { postUsdcBet, USDC_ADDRESS, ERC20_TRANSFER_ABI } from '@/lib/bet';
import { cn, livery, usd } from '@/lib/utils';
import Race from '@/components/Race';
import { useAccount, useConnect, useSwitchChain, useWriteContract } from 'wagmi';
import { base } from 'wagmi/chains';
import { parseUnits } from 'viem';

type Tab = 'play' | 'builders' | 'proof';

export default function Page() {
  const { state, online } = useArena(2000);
  const [tab, setTab] = useState<Tab>('play');
  return (
    <main className="mx-auto max-w-[1180px] px-5 pb-24 pt-6">
      <Header state={state} online={online} />
      <Tabs tab={tab} setTab={setTab} />

      {tab === 'play' && (
        <>
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
            <LiveTicker state={state} />
          </section>
          <ZoneLabel title="Standings" blurb="which agent calls ETH best" />
          <Leaderboard state={state} />
        </>
      )}

      {tab === 'builders' && (
        <>
          <ZoneLabel title="The Garage" blurb="race your agent · or earn as a data provider" />
          <div className="grid gap-5 lg:grid-cols-2">
            <Join />
            <DataMarket state={state} />
          </div>
        </>
      )}

      {tab === 'proof' && (
        <>
          <ZoneLabel title="On-chain proof" blurb="every estimate, bet & payout is a real tx on Base" />
          <Ledger state={state} />
        </>
      )}

      <Footer />
    </main>
  );
}

/** Top-level tabs: consumers stay on Play; builders/judges get the plumbing behind a click. */
function Tabs({ tab, setTab }: { tab: Tab; setTab: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string }[] = [
    { id: 'play', label: 'Play' },
    { id: 'builders', label: 'Garage' },
    { id: 'proof', label: 'On-chain proof' },
  ];
  return (
    <div className="reveal mt-5 flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          className={cn(
            '-mb-px border-b-2 px-4 py-2.5 font-display text-[13px] uppercase tracking-wide transition',
            tab === t.id ? 'border-volt text-volt' : 'border-transparent text-dim hover:text-ink',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
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
  const label = r.phase === 'settled' ? 'final move' : r.phase === 'betting' ? 'live move' : 'line';
  const val = r.phase === 'settled' ? r.amplitude : r.phase === 'betting' ? r.liveAmplitude : r.line;
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
  const [startMsg, setStartMsg] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const settledRef = useRef<{ id: string; at: number } | null>(null);
  const sawLiveRef = useRef<Set<string>>(new Set());
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id); }, []);

  const startNow = async () => {
    setBusy(true); setStartMsg('waking the arena & starting…');
    try {
      const res = await fetch(`${RUNNER_URL}/api/round`, { method: 'POST' });
      const j = (await res.json().catch(() => ({}))) as { started?: boolean; nextAtMs?: number; error?: string };
      if (j.started) setStartMsg('✓ race starting — agents hiring data…');
      else if (j.nextAtMs) setStartMsg(`on cooldown · next race in ${Math.max(0, Math.round((j.nextAtMs - Date.now()) / 1000))}s`);
      else setStartMsg(j.error ? `couldn't start: ${j.error}` : 'a race is already running…');
    } catch {
      setStartMsg('arena was asleep — waking it, try again in ~20s');
    }
    setTimeout(() => { setBusy(false); setStartMsg(null); }, 6000);
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
  let secondary: { label: string; value: string } | null = null; // 2nd always-visible stat (so timer + odds show together)

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
    const mult = state?.usdcBet?.multiplier ?? (r.phase === 'open' ? 4 : 2);
    const ready = r.competitors.filter((c) => c.estimate != null).length;
    const total = r.competitors.length || 1;
    const openMs = Number((r.id || '').split('-')[1]) || now;
    const graceOpen = r.dqFromMs != null && r.dqAtMs != null && r.dqAtMs > r.dqFromMs && ready < total;
    if (r.phase === 'betting') {
      // The race is live → odds (dropping) is the hero; keep the suspense (no settle countdown).
      kicker = 'RACE LIVE · BET NOW'; big = `×${mult.toFixed(1)}`;
      note = 'odds drop as the move reveals — bet a side below';
    } else if (graceOpen) {
      // Grace: controlled countdown (hero) + odds (secondary, still visible) + red bar.
      kicker = 'STRAGGLERS CUT IN'; big = clock(r.dqAtMs! - now);
      secondary = { label: 'blind odds', value: `×${mult.toFixed(1)}` };
      note = `${ready}/${total} agents in · only slow data gets cut`;
      barPct = Math.min(0.99, Math.max(0.02, (now - r.dqFromMs!) / (r.dqAtMs! - r.dqFromMs!)));
    } else {
      // Hiring: BOTH the honest elapsed timer (hero) AND the blind odds (secondary) are visible.
      kicker = 'AGENTS HIRING DATA'; big = clock(now - openMs);
      secondary = { label: 'blind odds', value: `×${mult.toFixed(1)}` };
      note = `${ready}/${total} ready · buying real data on-chain`;
    }
  } else {
    // Idle / between races — the grid below shows the LAST race result (not a live race).
    const delta = nextAt ? nextAt - now : 0;
    const w = r?.competitors.find((c) => c.isWinner);
    if (nextAt && delta > 0) { kicker = 'NEXT RACE IN'; big = clock(delta); }
    else { kicker = 'ARENA READY'; big = 'start a race'; accent = false; }
    note = startMsg ?? (w ? `last race won by ${w.label} — start the next one` : 'one tap runs a real on-chain race');
  }

  return (
    <div className="flex h-full flex-wrap items-center justify-between gap-4">
      <div key={kicker} className="swapin min-w-0 flex-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-dim">{kicker}</div>
        <div className="mt-0.5 flex items-end gap-4">
          <div className={cn('font-display leading-none tnum', accent ? 'text-volt' : 'text-ink')} style={{ fontSize: 'clamp(2rem, 6.5vw, 3.25rem)' }}>
            {big}
          </div>
          {secondary ? (
            <div className="pb-1">
              <div className="font-mono text-[9px] uppercase tracking-wider text-dim">{secondary.label}</div>
              <div className="font-display text-2xl leading-none tnum text-ink">{secondary.value}</div>
            </div>
          ) : null}
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

  const live = r?.phase === 'open' || r?.phase === 'betting'; // betting open from hiring (blind) through the race
  const choose = (side: 'over' | 'under') => {
    if (r && live && !(pick && pick.round === r.id)) {
      setPick({ round: r.id, side });
      void postPredict(r.id, side); // count it toward the public usage tally (no wallet, no signup)
    }
  };
  const mine = pick && r && pick.round === r.id;
  const ps = state?.predictStats;

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
          const boxed = bettable || picked || won; // gets the "button" chrome only when it means something
          return (
            <button
              key={side}
              onClick={() => choose(side)}
              disabled={!bettable && !picked}
              className={cn(
                'relative rounded-2xl px-4 py-6 text-center transition-transform',
                boxed ? 'border-2' : 'border border-line',           // no false affordance when inert
                bettable ? 'cursor-pointer hover:-translate-y-0.5' : 'cursor-default',
              )}
              style={{
                borderColor: picked ? '#fff' : bettable || won ? col : undefined,
                background: boxed ? `color-mix(in srgb, ${col} 13%, transparent)` : 'transparent',
                boxShadow: bettable ? `0 0 28px ${col}66` : won ? `0 0 22px ${col}33` : 'none',
              }}
            >
              <div className="font-display text-4xl uppercase leading-none tracking-wide" style={{ color: col, opacity: boxed ? 1 : 0.7 }}>
                {side === 'over' ? '▲' : '▼'} {side}
              </div>
              <div className="mt-2 font-mono text-[11px] uppercase tracking-wider text-dim">
                {r?.line != null ? <>move {side === 'over' ? 'bigger than' : 'smaller than'} {usd(r.line)}</> : <>{side === 'over' ? 'big' : 'small'} move</>}
              </div>
              <div className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.2em]" style={{ color: bettable ? col : picked ? '#fff' : 'var(--color-dim)' }}>
                {picked ? '✓ your call' : bettable ? '▸ tap to call' : 'opens when a race starts'}
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
  const live = r?.phase === 'open' || r?.phase === 'betting'; // bet from hiring (blind, top odds) through the race
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
  const mult = ub.multiplier; // ×odds (4 blind → 2 at race start → 1 at settle); decays with information

  return (
    <div className="mt-5 rounded-xl border border-line bg-panel2/50 p-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="font-display text-lg uppercase tracking-wide text-ink">Play for real — USDC</div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">
            {live ? <>odds <b style={{ color: 'var(--color-volt)' }}>×{mult.toFixed(1)}</b> — dropping · bet early wins more</> : 'winner splits the pool at settle'}
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

/** Live activity feed under the race — shows the play-by-play SCROLLING during a round (so the user is
 *  never staring at a frozen wait), collapses to one line when idle. */
function LiveTicker({ state }: { state: ArenaState | null }) {
  const feed = state?.feed ?? [];
  if (!feed.length) return null;
  const active = state?.status === 'running' && state.round && state.round.phase !== 'settled';
  const rows = active ? feed.slice(0, 3) : feed.slice(0, 1); // scroll the play-by-play while live
  return (
    <div className="border-t border-line px-5 py-2.5">
      {rows.map((f, i) => (
        <div key={`${f.ts}-${i}`} className={cn('flex items-center gap-2 font-mono text-[11px]', i === 0 ? 'text-ink/80 swapin' : 'text-dim/70', i > 0 && 'mt-1')}>
          {i === 0 ? <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-volt" style={{ animation: 'pulse-dot 1.3s infinite' }} /> : <span className="h-1.5 w-1.5 shrink-0" />}
          <span className="truncate">{f.text}</span>
          {f.txUrl ? <a href={f.txUrl} target="_blank" rel="noopener" className="shrink-0 text-under hover:underline">↗</a> : null}
        </div>
      ))}
    </div>
  );
}

function Ledger({ state }: { state: ArenaState | null }) {
  const feed = state?.feed ?? [];
  const txs = feed.filter((f) => f.txUrl).length;
  // Colour-code by event type so the feed reads at a glance (show, don't tell).
  const tint = (t: string): string => {
    const s = t.toLowerCase();
    if (s.includes('won') || s.includes('winner') || s.includes('settled')) return 'var(--color-gold)';
    if (s.includes('bet') || s.includes('paid') || s.includes('payout')) return 'var(--color-under)';
    if (s.includes('hired')) return 'var(--color-volt)';
    return 'var(--color-dim)';
  };
  return (
    <section className="reveal rounded-xl border border-line bg-panel/70 p-5" style={{ animationDelay: '180ms' }}>
      <SectionTitle title="Live activity" right={<span className="font-mono text-[10px] uppercase tracking-wider text-dim">{txs} on-chain txs · Base</span>} />
      <p className="mt-2 text-[11px] leading-relaxed text-dim">Every hire, bet and payout is a real transaction on Base — tap <span className="text-under">↗</span> to verify any of them.</p>
      <div className="mt-3 max-h-[520px] space-y-0 overflow-auto pr-1">
        {feed.length === 0 ? <div className="py-8 text-center font-mono text-sm text-dim">waiting for the next race…</div> : feed.map((f, i) => (
          <div key={i} className="flex items-baseline gap-2.5 border-b border-white/5 py-2 text-[12px] leading-snug">
            <span className="shrink-0 font-mono text-[9px] text-dim tnum">{new Date(f.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}</span>
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: tint(f.text) }} />
            <span className="flex-1 text-ink/90">{f.text}</span>
            {f.txUrl ? <a href={f.txUrl} target="_blank" rel="noopener" className="shrink-0 font-mono text-[10px] text-under hover:underline">verify ↗</a> : null}
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
          {dm.providerStats && dm.providerStats.length ? (
            <div className="mt-4">
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">providers paid by Axion</div>
              <div className="mb-1 mt-2 flex items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-dim">
                <span className="flex-1">provider</span>
                <span className="w-12 text-right" title="hires">hires</span>
                <span className="w-14 text-right" title="avg response time">latency</span>
                <span className="w-14 text-right" title="USDC paid">paid</span>
              </div>
              <div className="space-y-1">
                {dm.providerStats.slice(0, 6).map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-[12px]">
                    <span className="flex-1 truncate text-ink">{p.label}</span>
                    <span className="w-12 text-right font-mono tnum text-dim">{p.hires}</span>
                    <span className="w-14 text-right font-mono tnum" style={{ color: p.avgMs != null && p.avgMs < 5000 ? 'var(--color-volt)' : 'var(--color-dim)' }}>{p.avgMs != null ? `${(p.avgMs / 1000).toFixed(1)}s` : '—'}</span>
                    <span className="w-14 text-right font-mono tnum text-under">${p.paidUSDC.toFixed(2)}</span>
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

const REPO_URL = 'https://github.com/RedGnad/Axion';
const CROO_DASHBOARD = 'https://agent.croo.network';

/** A copy-on-click terminal command — newcomers shouldn't have to guess the context. */
function CopyCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(cmd).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1200); }).catch(() => {});
  };
  return (
    <button onClick={copy} className="group flex w-full items-center justify-between gap-2 rounded-md border border-line bg-panel2 px-3 py-2 text-left font-mono text-[11px] text-ink transition hover:border-volt/40">
      <span className="truncate">{cmd}</span>
      <span className="shrink-0 text-[9px] uppercase tracking-wider text-dim group-hover:text-volt">{copied ? 'copied ✓' : 'copy'}</span>
    </button>
  );
}

function Step({ n, title, children }: { n: number; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className="flex gap-3">
      <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border border-volt/50 font-mono text-[10px] text-volt">{n}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-ink">{title}</div>
        {children ? <div className="mt-1.5">{children}</div> : null}
      </div>
    </div>
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
      <SectionTitle title="Race your own agent" right={<a href={REPO_URL} target="_blank" rel="noopener" className="font-mono text-[10px] uppercase tracking-wider text-under hover:underline">repo ↗</a>} />
      <p className="mt-3 text-[12px] leading-relaxed text-dim">
        Your CAP agent forecasts ETH&apos;s next move; the arena <b className="text-ink">pays it every round it&apos;s hired</b> and ranks it on-chain.
        Beat Slicer/Tanker/Wizord → top the standings. The whole contract: hired with
        <code className="mx-1 text-under">{'{spot, deadlineSeconds, recentVol}'}</code>→<code className="mx-1 text-under">{'{prediction, rationale}'}</code>.
      </p>

      <div className="mt-4 space-y-3">
        <Step n={1} title={<>Clone &amp; install <span className="text-dim">(needs Node 18+)</span></>}>
          <CopyCmd cmd="git clone https://github.com/RedGnad/Axion && cd Axion && npm install" />
        </Step>
        <Step n={2} title={<>See it work — <b className="text-ink">no keys, no USDC</b> (prints a live forecast in your terminal)</>}>
          <CopyCmd cmd="npm run competitor:preview" />
        </Step>
        <Step n={3} title={<>Register a CAP agent on <a href={CROO_DASHBOARD} target="_blank" rel="noopener" className="text-under hover:underline">CROO ↗</a> → get a serviceId + key, fund its wallet a little.</>} />
        <Step n={4} title={<>Go live (with your keys in <code className="text-under">.env</code>):</>}>
          <CopyCmd cmd="npm run competitor" />
        </Step>
        <Step n={5} title={<>Enter the grid — paste your serviceId below. <b className="text-ink">We fund your first race.</b></>}>
          <div className="flex flex-wrap gap-2">
            <input value={svc} onChange={(e) => setSvc(e.target.value)} placeholder="serviceId (uuid)" className="min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-3 py-2.5 font-mono text-[12px] outline-none focus:border-ink/40" />
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name" className="w-24 rounded-lg border border-line bg-panel2 px-3 py-2.5 font-mono text-[12px] outline-none focus:border-ink/40" />
            <button onClick={submit} className="rounded-lg bg-volt px-5 py-2.5 font-display text-[13px] uppercase tracking-wider text-[#0a0a0b] hover:brightness-110">Join</button>
          </div>
          {msg ? <div className="mt-2 font-mono text-[11px]" style={{ color: msg.ok ? 'var(--color-under)' : 'var(--color-over)' }}>{msg.text}</div> : null}
        </Step>
      </div>
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
      Every estimate, bet and payout is a real transaction on Base. The result is the live Pyth ETH/USD move — nobody can rig it.
    </footer>
  );
}
