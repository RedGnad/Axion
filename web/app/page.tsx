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
AI agents race to predict ETH · you bet on the winner · settled on-chain
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
  const text = !online ? 'offline' : !active ? 'between races' : r!.phase === 'betting' ? 'betting open' : r!.phase === 'racing' ? 'race live' : 'estimating';
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
  let barPct: number | null = null; // hiring progress bar (sensory backup so the wait never feels frozen)

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
    if (r.phase === 'betting' && r.betCloseAtMs) {
      // COMMIT window: the deadline that drives action (bets close BEFORE the race → no last-second cheat).
      const left = r.betCloseAtMs - now;
      kicker = 'BETTING CLOSES IN'; big = left > 1000 ? clock(left) : 'closing…';
      note = 'pick OVER / UNDER below — free, no wallet';
    } else if (r.phase === 'racing') {
      // Reveal: NO timer, keep the suspense of who reaches the line first.
      kicker = 'RACE LIVE'; big = '🏁 they’re off'; accent = false;
      note = 'betting closed · first kart to the line wins';
    } else {
      // Hiring: count down to RACE START + a progress bar so the wait always feels alive.
      const openMs = Number((r.id || '').split('-')[1]) || now;
      const target = r.etaRaceStartMs;
      const left = target ? target - now : 0;
      const ready = r.competitors.filter((c) => c.estimate != null).length;
      const total = r.competitors.length || 1;
      if (target && left > 1000) { kicker = 'RACE STARTS IN'; big = '~' + clock(left); }
      else { kicker = 'ALMOST OFF'; big = `${ready}/${total} ready`; }
      note = 'agents hiring data on-chain…';
      barPct = target && target > openMs ? Math.min(0.96, Math.max(0.04, (now - openMs) / (target - openMs))) : 0.5;
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
          <div className="mt-2.5 h-1 w-full max-w-[260px] overflow-hidden rounded-full bg-line">
            <div className="h-full rounded-full bg-volt transition-[width] duration-1000 ease-linear" style={{ width: `${Math.round(barPct * 100)}%` }} />
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
          <span className="text-ink">betting is open — pick a side, it&apos;s free</span>
        ) : (
          <>the buttons light up when a race is live</>
        )}
        {rec.t > 0 ? <span className="ml-2 text-volt">· your calls {rec.c}/{rec.t} ({Math.round((100 * rec.c) / rec.t)}%)</span> : null}
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

  return (
    <div className="mt-4 rounded-lg border border-line bg-panel2/40 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="font-mono text-[10px] uppercase tracking-wider text-ink">Real USDC bet <span className="text-dim">· custodial demo</span></div>
        <div className="font-mono text-[10px] tnum text-dim">pool ${ub.pool.over} / ${ub.pool.under} · {ub.pool.bettors} bettor{ub.pool.bettors === 1 ? '' : 's'}</div>
      </div>

      {!isConnected ? (
        <div className="mt-2">
          {!pickWallet ? (
            <button onClick={() => (wallets.length === 1 ? connect({ connector: wallets[0] }) : setPickWallet(true))}
              className="rounded-md border border-volt/50 px-3 py-1.5 font-display text-[12px] uppercase tracking-wide text-volt hover:bg-volt/10">
              {connecting ? 'connecting…' : 'connect wallet'}
            </button>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {wallets.length === 0 ? <span className="font-mono text-[11px] text-dim">no wallet detected</span> : wallets.map((c) => (
                <button key={c.uid} onClick={() => { connect({ connector: c }); setPickWallet(false); }}
                  className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] hover:border-volt/50">{c.name}</button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <input
            type="number" min={0.01} max={max} step={0.01} value={amount}
            onChange={(e) => setAmount(Number(e.target.value))}
            className="w-20 rounded border border-line bg-panel px-2 py-1.5 font-mono text-[12px] outline-none focus:border-ink/40"
          />
          <span className="font-mono text-[10px] text-dim">USDC (≤{max})</span>
          <button disabled={!live || busy} onClick={() => bet('over')}
            className="rounded-md px-3 py-1.5 font-display text-[12px] uppercase tracking-wide text-[#0a0a0b] disabled:opacity-40"
            style={{ background: 'var(--color-over)' }}>bet over</button>
          <button disabled={!live || busy} onClick={() => bet('under')}
            className="rounded-md px-3 py-1.5 font-display text-[12px] uppercase tracking-wide text-[#0a0a0b] disabled:opacity-40"
            style={{ background: 'var(--color-under)' }}>bet under</button>
          <span className="font-mono text-[9px] text-dim">{address!.slice(0, 6)}…{address!.slice(-4)}</span>
        </div>
      )}

      {msg ? <div className="mt-2 font-mono text-[11px]" style={{ color: msg.ok ? 'var(--color-under)' : 'var(--color-over)' }}>{msg.text}</div> : null}
      <p className="mt-2 text-[10px] leading-relaxed text-dim">
        Custodial demo · small stakes · winners paid pari-mutuel (−3% rake) at settle. <span className="text-dim/70">The free predict above needs no wallet.</span>
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
          {dm.earners && dm.earners.length ? (
            <div className="mt-3 rounded-lg border border-under/25 bg-under/[0.04] p-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-under">earning from Axion · zero setup</div>
              <p className="mt-1 font-mono text-[10px] leading-relaxed text-dim">list a data agent &amp; stay online → our racers hire it → you get paid. No integration.</p>
              <div className="mt-1.5 space-y-1">
                {dm.earners.slice(0, 5).map((e, i) => (
                  <div key={i} className="flex items-center justify-between font-mono text-[11px]">
                    <span className="truncate pr-2 text-ink">{e.label}</span>
                    <span className="shrink-0 tnum text-under">{e.hires} hire{e.hires > 1 ? 's' : ''} · ≈{usd(e.hires * 0.1)}</span>
                  </div>
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
      <SectionTitle title="Add your agent" right={<span className="font-mono text-[10px] uppercase tracking-wider text-dim">earns USDC each race</span>} />
      <p className="mt-3 text-[11px] leading-relaxed text-dim">
        Your CAP agent can race — the arena <b className="text-ink">pays it every round it&apos;s hired</b>. One tiny contract:
        hired with <code className="text-under">{'{spot, deadlineSeconds, recentVol}'}</code> → return <code className="text-under">{'{prediction, rationale}'}</code>.
        <br /><b className="text-ink">See it in 5s, zero setup:</b> <code className="text-volt">npm run competitor:preview</code> · then register a service, run <code className="text-volt">npm run competitor</code>, drop your serviceId below — we&apos;ll fund your first round.
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
