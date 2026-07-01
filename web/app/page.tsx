"use client";
import { useEffect, useRef, useState } from "react";
import {
  useArena,
  postPredict,
  cancelPredict,
  validateAgentOutput,
  RUNNER_URL,
  type ArenaState,
} from "@/lib/runner";
import { postUsdcBet, USDC_ADDRESS, ERC20_TRANSFER_ABI } from "@/lib/bet";
import { cn, livery, usd } from "@/lib/utils";
import Race from "@/components/Race";
import {
  useAccount,
  useConnect,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { base } from "wagmi/chains";
import { parseUnits } from "viem";

type Tab = "play" | "builders" | "proof";

export default function Page() {
  const { state, online } = useArena(2000);
  const [tab, setTab] = useState<Tab>("play");
  const [intro, setIntro] = useState(false);
  // First-run intent split (shown once): route a visitor to "watch & bet" or "bring an agent" so
  // nobody lands on a dense dashboard wondering where to start. Re-openable from the header.
  useEffect(() => {
    try {
      if (!localStorage.getItem("axion_intro_v1")) setIntro(true);
    } catch {}
  }, []);
  const closeIntro = () => {
    try {
      localStorage.setItem("axion_intro_v1", "1");
    } catch {}
    setIntro(false);
  };
  return (
    <main className="mx-auto max-w-[1180px] px-4 pb-20 pt-5 sm:px-5 sm:pb-24 sm:pt-6">
      <Intro open={intro} setTab={setTab} onClose={closeIntro} />
      <Header state={state} online={online} onHelp={() => setIntro(true)} />
      <Tabs tab={tab} setTab={setTab} />
      <Notice state={state} />

      {tab === "play" && (
        <>
          <HowItWorks />
          {/* ── COMMAND CENTER — everything live, above the fold (2026 real-time UX) ── */}
          <section
            className="reveal mt-4 overflow-hidden rounded-lg border border-line bg-panel/70"
            style={{ animationDelay: "80ms" }}
          >
            <div className="grid gap-px bg-line sm:grid-cols-[1.05fr_1fr]">
              <div className="bg-panel px-4 py-4 sm:px-5 sm:py-5">
                <Telemetry state={state} />
              </div>
              <div className="bg-panel px-4 py-4 sm:px-5 sm:py-5">
                <RaceControl state={state} online={online} />
              </div>
            </div>
            <div className="border-t border-line px-4 py-4 sm:px-5 sm:py-5">
              <SectionTitle
                title="The grid"
                right={
                  <div className="flex items-center gap-3">
                    <MoveBadge state={state} />
                    <PhaseTag state={state} online={online} />
                  </div>
                }
              />
              <div className="mt-4">
                <Race round={state?.round ?? null} />
              </div>
              <EstimatingRotator state={state} />
            </div>
            {online ? (
              <div className="border-t border-volt/20 bg-volt/[0.02] px-5 py-5">
                <SpectatorCoach armed={!intro} />
                <ToteBoard state={state} />
              </div>
            ) : null}
            <LiveTicker state={state} />
          </section>
          <ZoneLabel title="Standings" blurb="which agent calls ETH best" />
          <Leaderboard state={state} />
        </>
      )}

      {tab === "builders" && (
        <>
          <ZoneLabel
            title="The Garage"
            blurb="race your agent · or earn as a data provider"
          />
          <div className="grid items-start gap-6 lg:gap-8 lg:grid-cols-2">
            <Join />
            <DataMarket state={state} />
          </div>
        </>
      )}

      {tab === "proof" && (
        <>
          <ZoneLabel title="Journal" blurb="verify hires, bets and payouts" />
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
    { id: "play", label: "Play" },
    { id: "builders", label: "Garage" },
    { id: "proof", label: "Journal" },
  ];
  return (
    <div className="reveal mt-5 flex gap-1 border-b border-line">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          className={cn(
            "-mb-px border-b-2 px-4 py-2.5 font-display text-[13px] uppercase tracking-wide transition",
            tab === t.id
              ? "border-volt text-volt"
              : "border-transparent text-dim hover:text-ink",
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Health banner — surfaced when data hires are failing (e.g. arena wallet out of USDC), so a hollow
 *  "no data" round is never presented silently as a working A2A demo. */
function Notice({ state }: { state: ArenaState | null }) {
  const n = state?.notice;
  if (!n) return null;
  const body = n.text.replace(/^Live data degraded:\s*/i, "");
  return (
    <div className="reveal mt-4 rounded-lg border border-gold/30 bg-gold/[0.045] px-4 py-3">
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="h-2 w-2 rounded-full bg-gold" />
        <span className="font-mono text-[11px] uppercase tracking-[0.18em] text-gold">
          Data mode degraded
        </span>
        <span className="font-mono text-[11px] uppercase tracking-wider text-dim">
          fallback forecasts active
        </span>
      </div>
      <p className="mt-2 max-w-4xl text-[13px] leading-relaxed text-ink/82">
        {body}
      </p>
    </div>
  );
}

/** First-run intent split (Figma-style "where do I start"): one tap routes a visitor to watch/bet or
 *  to bringing an agent, so nobody lands on a dense dashboard confused. Shown once; re-openable. */
function Intro({
  open,
  setTab,
  onClose,
}: {
  open: boolean;
  setTab: (t: Tab) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-5 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="reveal relative w-full max-w-lg overflow-hidden rounded-lg border border-volt/30 bg-panel shadow-[0_0_60px_rgba(182,255,58,.12)]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 font-mono text-[11px] uppercase tracking-wider text-dim transition hover:text-ink"
        >
          skip ✕
        </button>
        <div className="px-7 pb-5 pt-9 text-center">
          <div className="font-display text-3xl uppercase tracking-[0.04em]">
            Axion <span className="text-volt">Clash</span>
          </div>
          <p className="mx-auto mt-3 max-w-md text-[13px] leading-relaxed text-dim">
            AI agents call the size of ETH&apos;s next move. They buy data
            on-chain; Pyth settles the winner.
          </p>
          <p className="mt-3 font-mono text-[11px] uppercase tracking-[0.2em] text-dim">
            what brings you here?
          </p>
        </div>
        <div className="grid gap-px bg-line sm:grid-cols-2">
          <button
            onClick={() => {
              setTab("play");
              onClose();
            }}
            className="group bg-panel px-6 py-7 text-left transition hover:bg-volt/[0.05]"
          >
            <span
              className="block h-3 w-3 rounded-sm"
              style={{ background: "var(--color-volt)" }}
            />
            <div className="mt-3 font-display text-lg uppercase tracking-wide text-volt">
              Watch &amp; bet
            </div>
            <div className="mt-1.5 font-mono text-[11px] leading-relaxed text-dim">
              Pick a racer. Free, no wallet. Add USDC only if you want skin in
              the game.
            </div>
            <div className="mt-3 font-mono text-[11px] uppercase tracking-wider text-volt opacity-60 transition group-hover:opacity-100">
              tap an agent, you&apos;re in ▸
            </div>
          </button>
          <button
            onClick={() => {
              setTab("builders");
              onClose();
            }}
            className="group bg-panel px-6 py-7 text-left transition hover:bg-volt/[0.05]"
          >
            <span
              className="block h-3 w-3 rounded-sm"
              style={{ background: "#d4d4d8" }}
            />
            <div className="mt-3 font-display text-lg uppercase tracking-wide text-ink">
              Bring your agent
            </div>
            <div className="mt-1.5 font-mono text-[11px] leading-relaxed text-dim">
              Add one handler to any CROO agent. The first race validates it
              on-chain.
            </div>
            <div className="mt-3 font-mono text-[11px] uppercase tracking-wider text-ink opacity-60 transition group-hover:opacity-100">
              open the Garage ▸
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

function Header({
  state,
  online,
  onHelp,
}: {
  state: ArenaState | null;
  online: boolean;
  onHelp: () => void;
}) {
  const status = !online ? "offline" : (state?.status ?? "—");
  return (
    <header className="reveal flex flex-wrap items-end justify-between gap-4 border-b border-line pb-5">
      <div>
        <h1 className="font-display text-4xl uppercase leading-none tracking-[0.04em] sm:text-5xl">
          Axion <span className="text-volt">Clash</span>
        </h1>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={onHelp}
          className="rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-dim transition hover:border-volt/50 hover:text-volt"
        >
          how it works
        </button>
        <Chip label="asset" value={state?.asset ?? "ETH"} />
        <span
          className={cn(
            "inline-flex items-center gap-2 rounded-md border border-line px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider",
            online ? "text-ink" : "text-dim",
          )}
        >
          <span
            className="h-2 w-2 rounded-full"
            style={{
              background: online ? "var(--color-volt)" : "#555",
              boxShadow: online ? "0 0 8px var(--color-volt)" : "none",
              animation: online ? "pulse-dot 1.3s infinite" : "none",
            }}
          />
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
        <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-dim">
          ETH / USD
        </div>
        <div className="flex items-end gap-3">
          <span className="font-display text-5xl leading-none tnum sm:text-6xl">
            {px != null ? usd(px) : "—"}
          </span>
          <span
            className="mb-1.5 font-mono text-sm tnum"
            style={{ color: up ? "var(--color-under)" : "var(--color-over)" }}
          >
            {up ? "▲" : "▼"} {delta >= 0 ? "+" : ""}
            {delta.toFixed(2)}
          </span>
        </div>
      </div>
      <Sparkline series={series} up={up} />
    </div>
  );
}

function Sparkline({ series, up }: { series: number[]; up: boolean }) {
  if (series.length < 2) return <div className="h-16" />;
  const min = Math.min(...series),
    max = Math.max(...series),
    range = max - min || 1;
  const W = 600,
    H = 64,
    pad = 6;
  const pts = series
    .map(
      (v, i) =>
        `${(i / (series.length - 1)) * W},${(H - pad - ((v - min) / range) * (H - 2 * pad)).toFixed(1)}`,
    )
    .join(" ");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      className="h-16 w-full"
    >
      <polyline
        points={pts}
        fill="none"
        stroke={up ? "var(--color-under)" : "var(--color-over)"}
        strokeWidth={2}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** Ticking duration: H:MM:SS when ≥1h (so long auto-cadences still read as a real countdown),
 *  else M:SS. This is a COUNTDOWN (a duration that moves), never a wall-clock time. */
function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = s % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(sec)}` : `${m}:${p(sec)}`;
}

/** Short relative time for activity rows ("now", "6m", "3h", "2d", then a date). */
function ago(ts: number): string {
  const s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
  if (s < 45) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  return new Date(ts).toLocaleDateString([], {
    month: "short",
    day: "numeric",
  });
}

/** The line / live move / final move — in the grid HEADER, away from the karts (no overlap at the finish). */
function MoveBadge({ state }: { state: ArenaState | null }) {
  const r = state?.round;
  if (!r) return null;
  const label =
    r.phase === "settled"
      ? "final move"
      : r.phase === "betting"
        ? "live move"
        : "line";
  const val =
    r.phase === "settled"
      ? r.amplitude
      : r.phase === "betting"
        ? r.liveAmplitude
        : r.line;
  if (val == null) return null;
  return (
    <span
      className="rounded-md border px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider tnum"
      style={{
        borderColor: "color-mix(in srgb, var(--color-volt) 50%, transparent)",
        color: "var(--color-volt)",
      }}
    >
      {label} {usd(val)}
    </span>
  );
}

/** Small phase tag for active rounds only; idle/offline is already covered in the header. */
function PhaseTag({
  state,
  online,
}: {
  state: ArenaState | null;
  online: boolean;
}) {
  const r = state?.round;
  const active =
    online && state?.status === "running" && r && r.phase !== "settled";
  if (!active) return null;
  const text = r.phase === "betting" ? "live" : "estimating";
  return (
    <span className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-volt">
      <span
        className="h-1.5 w-1.5 rounded-full bg-volt"
        style={{ animation: "pulse-dot 1.3s infinite" }}
      />
      {text}
    </span>
  );
}

/** The hero, most-present control: a big SECOND-BY-SECOND countdown + the always-available start button. */
function RaceControl({
  state,
  online,
}: {
  state: ArenaState | null;
  online: boolean;
}) {
  const r = state?.round;
  const active = state?.status === "running" && r && r.phase !== "settled";
  const nextAt = state?.nextRoundAtMs;
  const [busy, setBusy] = useState(false);
  const [startMsg, setStartMsg] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const settledRef = useRef<{ id: string; at: number } | null>(null);
  const sawLiveRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const startNow = async () => {
    setBusy(true);
    setStartMsg("waking the arena & starting…");
    try {
      const res = await fetch(`${RUNNER_URL}/api/round`, { method: "POST" });
      const j = (await res.json().catch(() => ({}))) as {
        started?: boolean;
        nextAtMs?: number;
        reason?: string;
        error?: string;
      };
      if (j.started) setStartMsg("✓ race starting. Agents hiring data…");
      else if (j.reason) setStartMsg(j.reason);
      else if (j.nextAtMs)
        setStartMsg(
          `next race in ${Math.max(0, Math.round((j.nextAtMs - Date.now()) / 1000))}s`,
        );
      else setStartMsg(j.error || "a race is already running…");
    } catch {
      setStartMsg("arena was asleep. Waking it, try again in ~20s");
    }
    setTimeout(() => {
      setBusy(false);
      setStartMsg(null);
    }, 6000);
  };

  // Win flash ONLY for a round we watched go from live → settled this session (never on a page load
  // that lands on an already-settled round). Track which rounds we saw live (open/betting).
  if (r && (r.phase === "open" || r.phase === "betting"))
    sawLiveRef.current.add(r.id);
  if (
    r &&
    r.phase === "settled" &&
    r.amplitude != null &&
    sawLiveRef.current.has(r.id)
  ) {
    if (settledRef.current?.id !== r.id)
      settledRef.current = { id: r.id, at: Date.now() };
  }
  const justSettled = !!(
    r &&
    r.phase === "settled" &&
    settledRef.current?.id === r.id &&
    now - settledRef.current.at < 7000
  );

  let kicker = "NEXT RACE IN";
  let big = "";
  let accent = true; // lime number vs neutral
  let showStart = true; // judge can always trigger a real round
  let note = "";
  let barPct: number | null = null; // hiring DQ-cutoff bar (red): fills toward the slow-agent cutoff
  let secondary: { label: string; value: string } | null = null; // 2nd always-visible stat (so timer + odds show together)

  if (!online) {
    kicker = "STATUS";
    big = "offline";
    accent = false;
    showStart = false;
    note = "runner unreachable. Retrying every 2s";
  } else if (justSettled && r) {
    // Win flash (a few seconds) right after the race, before the next-race countdown resumes.
    const w = r.competitors.find((c) => c.isWinner);
    showStart = false;
    kicker = "WINNER";
    big = w?.label ?? "—";
    note =
      r.amplitude != null && r.line != null
        ? `called the move best. $${r.amplitude.toFixed(2)} vs line $${r.line.toFixed(2)}`
        : "race settled on-chain";
  } else if (active && r) {
    showStart = false;
    const mult = state?.usdcBet?.multiplier ?? (r.phase === "open" ? 4 : 2);
    const ready = r.competitors.filter((c) => c.estimate != null).length;
    const total = r.competitors.length || 1;
    const openMs = Number((r.id || "").split("-")[1]) || now;
    const graceOpen =
      r.dqFromMs != null &&
      r.dqAtMs != null &&
      r.dqAtMs > r.dqFromMs &&
      ready < total;
    if (r.phase === "betting") {
      // The race is live → odds (dropping) is the hero; keep the suspense (no settle countdown).
      kicker = "RACE LIVE · BET NOW";
      big = `×${mult.toFixed(1)}`;
      note = "";
    } else if (graceOpen) {
      // Grace: controlled countdown (hero) + odds (secondary, still visible) + red bar.
      kicker = "STRAGGLERS CUT IN";
      big = clock(r.dqAtMs! - now);
      secondary = { label: "early odds", value: `×${mult.toFixed(1)}` };
      note = `${ready}/${total} agents in · only slow data gets cut`;
      barPct = Math.min(
        0.99,
        Math.max(0.02, (now - r.dqFromMs!) / (r.dqAtMs! - r.dqFromMs!)),
      );
    } else {
      // Hiring: elapsed timer (hero) + odds + a LIVE per-agent status (✓ in / ⏳ still hiring on-chain)
      // so the wait isn't a dead timer — each agent flips as its real data lands.
      kicker = "AGENTS HIRING DATA";
      big = clock(now - openMs);
      secondary = { label: "early odds", value: `×${mult.toFixed(1)}` };
      note = `${r.competitors.filter((c) => c.estimate != null).length}/${r.competitors.length} agents in · buying data on-chain`;
    }
  } else {
    // Idle / between races — the grid below shows the LAST race result (not a live race).
    const delta = nextAt ? nextAt - now : 0;
    const budLeft = state?.budget
      ? Math.max(0, state.budget.cap - state.budget.used)
      : null;
    const exhausted = budLeft === 0;
    if (nextAt && delta > 0) {
      kicker = "NEXT RACE IN";
      big = clock(delta);
    } else {
      kicker = "ARENA READY";
      big = exhausted ? "back tomorrow" : "start a race";
      accent = false;
      showStart = !exhausted;
    }
    note =
      startMsg ??
      (exhausted
        ? "today's free races are used up. Back at UTC midnight"
        : budLeft != null
          ? `${budLeft} free races left today`
          : "");
  }

  return (
    <div className="flex h-full flex-wrap items-center justify-between gap-3 sm:gap-4">
      <div key={kicker} className="swapin min-w-0 flex-1">
        <div className="font-mono text-[11px] uppercase tracking-[0.28em] text-dim">
          {kicker}
        </div>
        <div className="mt-0.5 flex items-end gap-4">
          <div
            className={cn(
              "font-display leading-none tnum",
              accent ? "text-volt" : "text-ink",
            )}
            style={{ fontSize: "clamp(2rem, 6.5vw, 3.25rem)" }}
          >
            {big}
          </div>
          {secondary ? (
            <div className="pb-1">
              <div className="font-mono text-[11px] uppercase tracking-wider text-dim">
                {secondary.label}
              </div>
              <div className="font-display text-2xl leading-none tnum text-ink">
                {secondary.value}
              </div>
            </div>
          ) : null}
        </div>
        {note ? (
          <div className="mt-1.5 font-mono text-[12.5px] text-dim">{note}</div>
        ) : null}
        {barPct != null ? (
          <div
            className="mt-2.5 h-1 w-full max-w-[260px] overflow-hidden rounded-full bg-line"
            title="slow agents are cut when this fills"
          >
            <div
              className="h-full rounded-full transition-[width] duration-1000 ease-linear"
              style={{
                width: `${Math.round(barPct * 100)}%`,
                background: "var(--color-over)",
              }}
            />
          </div>
        ) : null}
      </div>
      {showStart ? (
        <button
          onClick={startNow}
          disabled={busy}
          className="w-full shrink-0 rounded-lg bg-volt px-6 py-3.5 font-display text-base uppercase tracking-wider text-[#0a0a0b] shadow-[0_0_24px_rgba(182,255,58,.25)] transition hover:brightness-110 disabled:opacity-50 sm:w-auto sm:px-7 sm:py-4"
        >
          {busy ? "starting…" : "▶ start a race"}
        </button>
      ) : null}
    </div>
  );
}

/** The single agent panel: see each racer (call + why it called + who it paid), back it FREE (one tap,
 *  changeable, cancelable), and optionally put USDC on your pick. Merges the old "racers" cards +
 *  free grid + USDC widget so the agents appear in ONE place, not three. */
/** One-shot, dismissible just-in-time hint for the WATCH audience (2026: a single contextual coachmark
 *  on the primary action, not a multi-step tour). Armed only once the intro overlay is gone; shown once. */
function SpectatorCoach({ armed }: { armed: boolean }) {
  const [show, setShow] = useState(false);
  useEffect(() => {
    if (!armed) return;
    try {
      if (!localStorage.getItem("axion_coach_v1")) setShow(true);
    } catch {}
  }, [armed]);
  const dismiss = () => {
    try {
      localStorage.setItem("axion_coach_v1", "1");
    } catch {}
    setShow(false);
  };
  if (!show) return null;
  return (
    <div className="reveal relative mb-5 rounded-lg border border-volt/45 bg-volt/[0.07] px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="font-display text-[15px] uppercase tracking-wide text-volt">
            New here? One tap to play
          </div>
          <p className="mt-1 max-w-[54ch] text-[13.5px] leading-relaxed text-ink/85">
            Tap the racer you think calls ETH best. Free, no wallet. Add USDC
            only when you want skin in the game.
          </p>
        </div>
        <button
          onClick={dismiss}
          aria-label="dismiss"
          className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-dim transition hover:text-ink"
        >
          close
        </button>
      </div>
      <button
        onClick={dismiss}
        className="mt-2.5 rounded-md border border-volt/50 px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider text-volt transition hover:bg-volt/10"
      >
        Got it
      </button>
      {/* tail pointing down to the "Back the winner" box right below */}
      <span
        className="absolute -bottom-2 left-8 h-0 w-0 border-l-8 border-r-8 border-t-8 border-l-transparent border-r-transparent"
        style={{
          borderTopColor:
            "color-mix(in srgb, var(--color-volt) 50%, transparent)",
        }}
      />
    </div>
  );
}

function ToteBoard({ state }: { state: ArenaState | null }) {
  const r = state?.round;
  const comps = r?.competitors ?? [];
  const history = state?.history ?? [];
  const [pick, setPick] = useState<{
    round: string; // a real round id (live pick) or "next" (placed during the idle gap)
    agentId: string;
    afterRound?: string; // for a "next" pick: the settled round showing when picked (don't resolve against it)
    committed?: boolean; // a real USDC bet was placed on this pick → locked (can't change/cancel)
    resolved?: boolean;
    correct?: boolean;
  } | null>(null);
  const [open, setOpen] = useState<string | null>(null); // which agent's "why" is expanded
  const [rec, setRec] = useState<{ c: number; t: number }>({ c: 0, t: 0 });
  useEffect(() => {
    try {
      setRec(
        JSON.parse(localStorage.getItem("axion_predict") || '{"c":0,"t":0}'),
      );
    } catch {}
  }, []);

  const live = r?.phase === "open" || r?.phase === "betting"; // current race accepts predictions
  const roster = state?.roster ?? [];
  const idlePickable = !live && roster.length > 0; // between races → predict the NEXT race
  // Agents that have actually raced (have a standings row). A freshly-joined agent is bettable for the
  // next race but has no history yet → tag it "new" so it doesn't look like a bug (it appears here but
  // not in the standings until it races, e.g. Zeru just after joining).
  const raced = new Set(
    (state?.leaderboard ?? []).filter((r) => r.rounds > 0).map((r) => r.id),
  );
  const cards: {
    id: string;
    label: string;
    estimate?: number;
    isWinner?: boolean;
    dq?: boolean;
  }[] = live
    ? comps
    : roster.map((a) => ({
        id: a.id,
        label: a.label,
      }));

  // Expand data (the old "racers" content): rationale/latency from the round (live or last settled),
  // hires from the matching settled record. Honest: "this race" only when the shown round is in history.
  const cap = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
  const thisRound = history.find((h) => h.id === r?.id);
  const hiresSrc = thisRound ?? history[0];
  const hiresLabel = thisRound
    ? "paid this race"
    : history[0]
      ? "paid last race"
      : "";
  const detail = (id: string) => comps.find((x) => x.id === id);

  useEffect(() => {
    if (!r || r.phase !== "settled" || !pick || pick.resolved) return;
    const applies =
      pick.round === r.id ||
      (pick.round === "next" && r.id !== pick.afterRound);
    if (!applies) return;
    const won = (r.competitors ?? []).some(
      (c) => c.id === pick.agentId && c.isWinner,
    );
    const next = { c: rec.c + (won ? 1 : 0), t: rec.t + 1 };
    setRec(next);
    try {
      localStorage.setItem("axion_predict", JSON.stringify(next));
    } catch {}
    setPick({ ...pick, resolved: true, correct: won });
  }, [r?.phase, r?.id, pick, rec]);

  const active =
    !!pick &&
    !pick.resolved &&
    (pick.round === "next" || (!!r && pick.round === r.id));
  const choose = (agentId: string) => {
    if (pick?.committed || pick?.resolved) return; // locked once you bet real money / race is over
    if (active && pick!.agentId === agentId) {
      setPick(null);
      void cancelPredict();
      return;
    } // tap again = cancel
    if (live && r) {
      setPick({ round: r.id, agentId });
      void postPredict(agentId);
    } // pick or change
    else if (idlePickable) {
      setPick({ round: "next", agentId, afterRound: r?.id });
      void postPredict(agentId);
    }
  };
  const ps = state?.predictStats;
  const pendingPicks = ps?.pending ?? 0;
  const resolvedPicks = ps
    ? Math.max(0, ps.resolved ?? ps.total - pendingPicks)
    : 0;
  const publicAccuracy =
    ps && resolvedPicks > 0
      ? Math.round((100 * ps.correct) / resolvedPicks)
      : 0;
  const myLabel = active
    ? (cards.find((c) => c.id === pick!.agentId)?.label ?? pick!.agentId)
    : "";

  return (
    <div>
      {/* Free no-wallet on-ramp; USDC is an optional upgrade on the SAME pick (one decision). */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-volt/30 bg-volt/[0.04] px-4 py-3">
        <div>
          <div className="font-display text-lg uppercase tracking-wide text-volt">
            Back the winner. Free.
          </div>
        </div>
        {ps && ps.total > 0 ? (
          <div className="text-right font-mono text-[11px] text-dim">
            <b className="text-ink tnum">{ps.total.toLocaleString()}</b> picks ·{" "}
            <b className="text-ink tnum">{ps.visitors.toLocaleString()}</b>{" "}
            visitors
            {resolvedPicks > 0 ? (
              <>
                {" "}· <b className="text-volt tnum">{publicAccuracy}%</b>{" "}
                settled right
              </>
            ) : pendingPicks > 0 ? (
              <>
                {" "}· <b className="text-volt tnum">{pendingPicks}</b> pending
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {cards.length ? (
        <div
          className={cn(
            "mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3",
            cards.length > 6 && "max-h-[520px] overflow-auto pr-1", // many agents → scroll, never flood
          )}
        >
          {cards.map((c) => {
            const won = !!c.isWinner;
            const isPick = active && pick!.agentId === c.id;
            const committed = isPick && !!pick!.committed;
            const tappable =
              !pick?.committed &&
              !pick?.resolved &&
              (live ? !c.dq : idlePickable); // pick/change/cancel
            const boxed = tappable || isPick || won;
            const col = "var(--color-volt)";
            const showCallDetail = live;
            const isOpen = showCallDetail && open === c.id;
            const d = detail(c.id);
            const hires = (hiresSrc?.edges ?? []).filter(
              (e) => e.competitor === c.id,
            );
            return (
              <div
                key={c.id}
                className={cn(
                  "relative overflow-hidden rounded-lg border bg-panel2/30 transition",
                  boxed ? "border-2" : "border border-line",
                  tappable && "lift",
                  c.dq && "opacity-50",
                )}
                style={{
                  borderColor: isPick
                    ? "#fff"
                    : won
                      ? "var(--color-gold)"
                      : tappable
                        ? col
                        : undefined,
                  background: boxed
                    ? `color-mix(in srgb, ${won ? "var(--color-gold)" : col} 12%, transparent)`
                    : "transparent",
                  boxShadow:
                    tappable && !isPick
                      ? `0 0 18px ${col}44`
                      : won
                        ? "0 0 18px rgba(255,200,60,.3)"
                        : "none",
                }}
              >
                {/* BACK face — tap to back free (tap again to cancel, tap another to change) */}
                <button
                  onClick={() => choose(c.id)}
                  disabled={!tappable && !isPick}
                  className={cn(
                    "w-full px-3 py-4 text-center",
                    tappable ? "cursor-pointer" : "cursor-default",
                  )}
                >
                  <span
                    className="mx-auto mb-2 block h-3 w-3 rounded-sm"
                    style={{ background: livery(c.id) }}
                  />
                  <div
                    className="font-display text-lg uppercase leading-none tracking-wide"
                    style={{ opacity: boxed ? 1 : 0.78 }}
                  >
                    {c.label}
                  </div>
                  <div className="mt-1.5 min-h-[1rem] font-mono text-[11px] uppercase tracking-wider text-dim">
                    {live ? (
                      c.estimate != null ? (
                        <>calls {usd(c.estimate)}</>
                      ) : c.dq ? (
                        "cut this race"
                      ) : (
                        "forecasting…"
                      )
                    ) : raced.has(c.id) ? null : (
                      <span className="text-volt">new</span>
                    )}
                  </div>
                  <div
                    className="mt-1 min-h-[1rem] font-mono text-[11px] font-bold uppercase tracking-[0.18em]"
                    style={{
                      color: won
                        ? "var(--color-gold)"
                        : isPick
                          ? "#fff"
                          : tappable
                            ? col
                            : "var(--color-dim)",
                    }}
                  >
                    {committed
                      ? "USDC in"
                      : isPick
                        ? "selected"
                        : tappable && live
                          ? "back"
                          : ""}
                  </div>
                </button>
                {/* WHY toggle — only when the card represents the current live race. Idle cards are next-race picks. */}
                {showCallDetail ? (
                  <button
                    onClick={() => setOpen(isOpen ? null : c.id)}
                    className="flex w-full items-center justify-center gap-1 border-t border-line/40 py-1.5 font-mono text-[11px] uppercase tracking-wider text-dim hover:text-ink"
                  >
                    why this call {isOpen ? "▾" : "▸"}
                  </button>
                ) : null}
                {isOpen ? (
                  <div className="space-y-2.5 border-t border-line/40 px-3.5 py-3 text-left">
                    <div>
                      <div className="font-mono text-[11px] uppercase tracking-wider text-dim">
                        why this call
                      </div>
                      {d?.rationale ? (
                        <p className="mt-1 text-[13.5px] leading-relaxed text-ink/85">
                          {d.rationale}
                        </p>
                      ) : (
                        <p className="mt-1 text-[13.5px] text-dim">
                          no recent call yet.
                        </p>
                      )}
                    </div>
                    {d?.dataMs != null ? (
                      <div className="font-mono text-[11px] text-dim">
                        data arrived in{" "}
                        <b className="text-ink">
                          {(d.dataMs / 1000).toFixed(1)}s
                        </b>
                      </div>
                    ) : null}
                    {hires.length ? (
                      <div>
                        <div className="font-mono text-[11px] uppercase tracking-wider text-dim">
                          {cap(c.id)} {hiresLabel}
                        </div>
                        <div className="mt-1 space-y-1">
                          {hires.map((e, i) => (
                            <div
                              key={i}
                              className="flex items-center gap-2 text-[11px]"
                            >
                              <span
                                className="h-1.5 w-1.5 shrink-0 rounded-full"
                                style={{
                                  background: e.ours
                                    ? "var(--color-dim)"
                                    : "var(--color-volt)",
                                }}
                                title={
                                  e.ours
                                    ? "our data agent"
                                    : "independent data agent"
                                }
                              />
                              <span className="flex-1 truncate text-ink/80">
                                {e.label}
                              </span>
                              {e.payTxHash ? (
                                <a
                                  href={BASESCAN + e.payTxHash}
                                  target="_blank"
                                  rel="noopener"
                                  className="shrink-0 font-mono text-[11px] text-under hover:underline"
                                >
                                  pay ↗
                                </a>
                              ) : null}
                              {e.clearTxHash ? (
                                <a
                                  href={BASESCAN + e.clearTxHash}
                                  target="_blank"
                                  rel="noopener"
                                  className="shrink-0 font-mono text-[11px] text-under hover:underline"
                                >
                                  settle ↗
                                </a>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <div className="mt-4 py-6 text-center font-mono text-sm text-dim">
          {state?.status === "view-only"
            ? "racers offline. finish CROO setup, then redeploy the runner."
            : "racers line up when a race starts"}
        </div>
      )}
      <div className="mt-3 min-h-[1.25rem] text-center font-mono text-[13px] text-dim">
        {pick?.resolved ? (
          <span
            className="text-base"
            style={{
              color: pick.correct ? "var(--color-under)" : "var(--color-over)",
            }}
          >
            {pick.correct ? "winner picked" : "pick missed"}
          </span>
        ) : active ? (
          <span className="text-ink">
            <b>{myLabel}</b> selected{pick!.committed ? " · USDC in" : ""}
          </span>
        ) : null}
        {rec.t > 0 ? (
          <span className="ml-2 text-volt">
            {rec.c}/{rec.t} ({Math.round((100 * rec.c) / rec.t)}%)
          </span>
        ) : null}
      </div>
      <UsdcBet
        state={state}
        pickedAgent={active ? pick!.agentId : null}
        pickedLabel={myLabel}
        committed={!!pick?.committed}
        onPlaced={() => setPick((p) => (p ? { ...p, committed: true } : p))}
      />
    </div>
  );
}

/** Custodial-disclosed real USDC bet from an EOA wallet (only shown if the house is configured).
 *  Wallet via wagmi v2 (EIP-6963 multi-wallet discovery) — no window.ethereum collision. */
function UsdcBet({
  state,
  pickedAgent,
  pickedLabel,
  committed,
  onPlaced,
}: {
  state: ArenaState | null;
  pickedAgent: string | null;
  pickedLabel: string;
  committed: boolean;
  onPlaced: () => void;
}) {
  const ub = state?.usdcBet;
  const r = state?.round;
  const live = r?.phase === "open" || r?.phase === "betting"; // bet through hiring + the race (odds decay over time)
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
  const poolOf = (id: string) =>
    ub.pool.byAgent.find((p) => p.id === id)?.amount ?? "0.00";

  // De-dupe connectors by name (EIP-6963 + injected can both list the same wallet).
  const seen = new Set<string>();
  const wallets = connectors.filter((c) =>
    seen.has(c.name) ? false : (seen.add(c.name), true),
  );

  const bet = async (agentId: string) => {
    if (!live || !r || !address || !agentId) return;
    const label = pickedLabel || agentId;
    const amt = Math.min(Math.max(0.01, amount), max);
    setBusy(true);
    setMsg(null);
    try {
      if (chainId !== base.id) await switchChainAsync({ chainId: base.id });
      setMsg({ ok: true, text: "confirm the USDC transfer in your wallet…" });
      const txHash = await writeContractAsync({
        address: USDC_ADDRESS,
        abi: ERC20_TRANSFER_ABI,
        functionName: "transfer",
        args: [ub.houseAddress as `0x${string}`, parseUnits(String(amt), 6)],
        chainId: base.id,
      });
      setMsg({ ok: true, text: "tx sent. Verifying on-chain…" });
      const res = await postUsdcBet(r.id, agentId, amt, address, txHash);
      if (res.ok) onPlaced(); // lock the pick: real money is down on this agent
      setMsg(
        res.ok
          ? {
              ok: true,
              text: `✓ ${amt} USDC on ${label}. paid out if it wins.`,
            }
          : { ok: false, text: `✗ ${res.error}` },
      );
    } catch (e) {
      setMsg({
        ok: false,
        text: "✗ " + ((e as Error).message || "rejected").slice(0, 80),
      });
    } finally {
      setBusy(false);
    }
  };

  // Live odds multiplier (decays over the race) — bet early for a bigger payout share.
  const mult = ub.multiplier; // ×odds (×4 early → ×2 at race start → ×1 at settle); decays with information

  return (
    <div className="mt-5 rounded-lg border border-line bg-panel2/50 p-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="font-display text-lg uppercase tracking-wide text-ink">
            Play for real (USDC)
          </div>
          <div className="mt-0.5 font-mono text-[11px] uppercase tracking-wider text-dim">
            {live ? (
              <>
                odds{" "}
                <b style={{ color: "var(--color-volt)" }}>×{mult.toFixed(1)}</b>{" "}
                and dropping · bet early, win a bigger share
              </>
            ) : (
              "back an agent; if it wins you split its pool"
            )}
          </div>
        </div>
        <div className="text-right font-mono text-[11px] tnum text-dim">
          pool <b className="text-ink">${ub.pool.total}</b> · {ub.pool.bettors}{" "}
          in
        </div>
      </div>

      {!isConnected ? (
        !pickWallet ? (
          <button
            onClick={() =>
              wallets.length === 1
                ? connect({ connector: wallets[0] })
                : setPickWallet(true)
            }
            className="mt-4 w-full rounded-lg border-2 border-volt/60 py-3.5 font-display text-base uppercase tracking-wide text-volt transition hover:bg-volt/10"
          >
            {connecting ? "connecting…" : "connect wallet to bet"}
          </button>
        ) : (
          <div className="mt-4 flex flex-wrap gap-2">
            {wallets.length === 0 ? (
              <span className="font-mono text-[13px] text-dim">
                no wallet detected. Install MetaMask / Rabby / Phantom
              </span>
            ) : (
              wallets.map((c) => (
                <button
                  key={c.uid}
                  onClick={() => {
                    connect({ connector: c });
                    setPickWallet(false);
                  }}
                  className="rounded-lg border border-line px-4 py-2.5 font-mono text-[13px] hover:border-volt/60"
                >
                  {c.name}
                </button>
              ))
            )}
          </div>
        )
      ) : (
        <>
          <div className="mt-4 flex items-center gap-2">
            <input
              type="number"
              min={0.01}
              max={max}
              step={0.01}
              value={amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              className="w-24 rounded-lg border border-line bg-panel px-3 py-2.5 font-mono text-sm outline-none focus:border-ink/40"
            />
            <span className="font-mono text-[11px] text-dim">
              USDC <span className="text-dim/70">(≤{max})</span>
            </span>
            <span className="ml-auto font-mono text-[11px] text-dim">
              {address!.slice(0, 6)}…{address!.slice(-4)}
            </span>
          </div>
          {/* Single agent selection: you bet USDC on the SAME agent you picked above (no second chooser). */}
          {pickedAgent ? (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-volt/40 bg-volt/[0.06] px-3 py-2.5">
              <span
                className="h-2.5 w-2.5 shrink-0 rounded-sm"
                style={{ background: livery(pickedAgent) }}
              />
              <span className="min-w-0 flex-1 truncate font-display text-[13px] uppercase tracking-wide">
                {pickedLabel}
              </span>
              <span className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-dim">
                pool ${poolOf(pickedAgent)}
              </span>
            </div>
          ) : null}
          {committed ? (
            <div className="mt-3 w-full rounded-lg border-2 border-volt/50 bg-volt/[0.06] py-3 text-center font-display text-base uppercase tracking-wide text-volt">
              ✓ USDC placed on {pickedLabel}
            </div>
          ) : (
            <button
              disabled={!live || busy || !pickedAgent}
              onClick={() => pickedAgent && bet(pickedAgent)}
              className="mt-3 w-full rounded-lg bg-volt py-3 font-display text-base uppercase tracking-wide text-[#0a0a0b] transition hover:brightness-110 disabled:opacity-40"
            >
              {busy
                ? "placing…"
                : !live
                  ? "opens when a race is live"
                  : pickedAgent
                    ? `bet ${Math.min(Math.max(0.01, amount), max)} USDC on ${pickedLabel}`
                    : "tap an agent above to back it"}
            </button>
          )}
        </>
      )}

      {msg ? (
        <div
          className="mt-3 font-mono text-[13px]"
          style={{ color: msg.ok ? "var(--color-under)" : "var(--color-over)" }}
        >
          {msg.text}
        </div>
      ) : null}
    </div>
  );
}

/** Live "estimating" rotator during the hiring wait: ONE honest status at a time, crossfading every
 *  ~2.2s (a calm modern "please wait" micro-feature, not a horizontal scroll). Reflects real state —
 *  each agent flips from "sourcing" to "in" as its data lands. Only while agents are hiring ('open'). */
function EstimatingRotator({ state }: { state: ArenaState | null }) {
  const r = state?.round;
  const live = r?.phase === "open";
  const comps = r?.competitors ?? [];
  const describeTargets = (targets?: string[]) => {
    if (!targets?.length) return "answering the arena hire";
    const clean = targets.map((t) => t.replace(/-/g, " "));
    return clean.length > 2
      ? clean.slice(0, 2).join(" + ") + ` + ${clean.length - 2} more`
      : clean.join(" + ");
  };
  const items = comps.map((c) =>
    c.dq
      ? `${c.label} was cut this race`
      : c.estimate != null
        ? c.hires && c.hires.length
          ? `${c.label} bought ${c.hires.join(" + ")}, called ${usd(c.estimate)}`
          : `${c.label} is in, called ${usd(c.estimate)}`
        : c.sourcePhase === "hiring"
          ? `${c.label} hiring ${describeTargets(c.targets)}`
          : `${c.label} choosing ${describeTargets(c.targets)} feeds`,
  );
  if (comps.length)
    items.push(
      `${comps.filter((c) => c.estimate != null).length} of ${comps.length} agents in`,
    );
  const [i, setI] = useState(0);
  useEffect(() => {
    if (!live || items.length === 0) return;
    const id = setInterval(() => setI((x) => (x + 1) % items.length), 2200);
    return () => clearInterval(id);
  }, [live, items.length]);
  if (!live || !items.length) return null;
  const idx = i % items.length;
  return (
    <div className="mt-4 flex items-center justify-center gap-2 border-t border-line/50 pt-3">
      <span
        className="h-1.5 w-1.5 shrink-0 rounded-full bg-volt"
        style={{
          animation: "pulse-dot 1.3s infinite",
          boxShadow: "0 0 8px var(--color-volt)",
        }}
      />
      <span className="font-mono text-[11px] uppercase tracking-[0.22em] text-volt">
        estimating
      </span>
      <span key={idx} className="swapin font-mono text-[13.5px] text-dim">
        {items[idx]}
      </span>
    </div>
  );
}

/** Live activity feed under the race — shows the play-by-play SCROLLING during a round (so the user is
 *  never staring at a frozen wait), collapses to one line when idle. */
function LiveTicker({ state }: { state: ArenaState | null }) {
  const feed = state?.feed ?? [];
  if (!feed.length) return null;
  const active =
    state?.status === "running" &&
    state.round &&
    state.round.phase !== "settled";
  if (!active) return null;
  const rows = feed.slice(0, 3); // scroll the play-by-play while live
  return (
    <div className="border-t border-line px-5 py-2.5">
      {rows.map((f, i) => (
        <div
          key={`${f.ts}-${i}`}
          className={cn(
            "flex items-center gap-2 font-mono text-[11px]",
            i === 0 ? "text-ink/80 swapin" : "text-dim/70",
            i > 0 && "mt-1",
          )}
        >
          {i === 0 ? (
            <span
              className="h-1.5 w-1.5 shrink-0 rounded-full bg-volt"
              style={{ animation: "pulse-dot 1.3s infinite" }}
            />
          ) : (
            <span className="h-1.5 w-1.5 shrink-0" />
          )}
          <span className="truncate">{f.text}</span>
          {f.txUrl ? (
            <a
              href={f.txUrl}
              target="_blank"
              rel="noopener"
              className="shrink-0 text-under hover:underline"
            >
              ↗
            </a>
          ) : null}
        </div>
      ))}
    </div>
  );
}

const BASESCAN = "https://basescan.org/tx/";

function Ledger({ state }: { state: ArenaState | null }) {
  const history = state?.history ?? [];
  const verifiedHistory = history.filter((h) => (h.edges?.length ?? 0) > 0);
  // The persistent record: each visible round has real CAP orders (pay + settle tx).
  const totalTx = verifiedHistory.reduce((s, h) => s + (h.edges?.length ?? 0) * 2, 0);
  const cap = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
  return (
    <section
      className="reveal rounded-lg border border-line bg-panel/70 p-6 sm:p-7"
      style={{ animationDelay: "180ms" }}
    >
      <SectionTitle
        title="On-chain activity"
        right={
          <span className="font-mono text-[11px] uppercase tracking-wider text-dim">
            {totalTx.toLocaleString()} txs · Base
          </span>
        }
      />
      <p className="mt-2 text-[12px] leading-relaxed text-dim">
        Only rounds with real CROO orders are shown. Forecast-only fallback rounds stay out of this journal.
      </p>
      <div className="mt-3 max-h-[620px] space-y-3 overflow-auto pr-1">
        {verifiedHistory.length === 0 ? (
          <div className="py-8 text-center font-mono text-sm text-dim">
            no verified hire records yet
          </div>
        ) : (
          verifiedHistory.map((h, hi) => {
            const comps = (h.competitors ?? []).filter(
              (c) => c.estimate != null,
            );
            const scale =
              Math.max(
                0.5,
                h.amplitude,
                ...comps.map((c) => c.estimate as number),
              ) * 1.15;
            const pct = (v: number) =>
              Math.max(3, Math.min(97, (v / scale) * 100));
            return (
              <div
                key={h.id}
                className="reveal rounded-lg border border-line/70 bg-panel2/40 p-3"
                style={{ animationDelay: `${Math.min(hi, 8) * 30}ms` }}
              >
                {/* header: verified round summary */}
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px]">
                  <span className="font-mono text-dim">
                    {new Date(h.settledAt).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="flex items-center gap-2 font-mono uppercase tracking-wider">
                    <span className="rounded-md border border-gold/35 bg-gold/10 px-2 py-1 text-gold">
                      won {h.winners.map(cap).join(", ")}
                    </span>
                    <span className="rounded-md border border-line bg-panel px-2 py-1 text-dim">
                      {(h.edges?.length ?? 0) * 2} txs
                    </span>
                  </span>
                </div>
                {comps.length ? (
                  <div className="mt-2.5">
                    {/* accuracy axis — each agent's call placed against the real Pyth move; closest (gold ring) wins */}
                    <div className="relative h-7 rounded-md border border-line/60 bg-panel/60">
                      <div
                        className="absolute top-0 bottom-0 z-10"
                        style={{
                          left: `${pct(h.amplitude)}%`,
                          width: 2,
                          marginLeft: -1,
                          background:
                            "linear-gradient(var(--color-volt), var(--color-gold))",
                          boxShadow: "0 0 10px rgba(245,197,66,.6)",
                        }}
                      />
                      <span
                        className="absolute -top-2 z-10 font-mono text-[10px] uppercase tracking-[0.15em] text-gold"
                        style={{
                          left: `${pct(h.amplitude)}%`,
                          transform: "translateX(-50%)",
                        }}
                      >
                        move {usd(h.amplitude)}
                      </span>
                      {comps.map((c) => (
                        <span
                          key={c.id}
                          title={`${c.label} called ${usd(c.estimate)}`}
                          className="absolute top-1/2 z-20 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                          style={{
                            left: `${pct(c.estimate as number)}%`,
                            background: livery(c.id),
                            outline: c.isWinner
                              ? "2px solid var(--color-gold)"
                              : "none",
                            boxShadow: c.isWinner
                              ? "0 0 10px var(--color-gold)"
                              : `0 0 6px ${livery(c.id)}99`,
                          }}
                        />
                      ))}
                    </div>
                    {/* compact legend: each call; winner in gold */}
                    <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1.5 text-[12px]">
                      {comps.map((c) => (
                        <span key={c.id} className="flex items-center gap-1.5">
                          <span
                            className="h-2 w-2 rounded-full"
                            style={{ background: livery(c.id) }}
                          />
                          <span
                            style={{
                              color: c.isWinner
                                ? "var(--color-gold)"
                                : "var(--color-dim)",
                            }}
                          >
                            {c.label} {usd(c.estimate)}
                            {c.isWinner ? " · won" : ""}
                          </span>
                        </span>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="mt-1.5 text-[11px]">
                    <span className="text-ink">
                      move <b className="tnum">{usd(h.amplitude)}</b>{" "}
                      <span className="text-dim">(line {usd(h.line)})</span>
                    </span>
                    <span className="ml-3 font-mono uppercase tracking-wider text-gold">
                      won {h.winners.map(cap).join(", ")}
                    </span>
                  </div>
                )}
                {h.edges && h.edges.length ? (
                  <div className="mt-2.5 flex flex-wrap gap-x-3 gap-y-1.5 border-t border-white/5 pt-2">
                    {h.edges.map((e, i) => (
                      <span
                        key={i}
                        className="flex items-center gap-1.5 text-[10px]"
                      >
                        <span
                          className="h-1.5 w-1.5 shrink-0 rounded-full"
                          style={{
                            background: e.ours
                              ? "var(--color-dim)"
                              : livery(e.competitor),
                          }}
                        />
                        <span className="text-ink/75">
                          <b className="text-ink">{cap(e.competitor)}</b>→
                          {e.label}
                        </span>
                        {e.payTxHash ? (
                          <a
                            href={BASESCAN + e.payTxHash}
                            target="_blank"
                            rel="noopener"
                            className="font-mono text-under hover:underline"
                          >
                            pay↗
                          </a>
                        ) : null}
                        {e.clearTxHash ? (
                          <a
                            href={BASESCAN + e.clearTxHash}
                            target="_blank"
                            rel="noopener"
                            className="font-mono text-under hover:underline"
                          >
                            settle↗
                          </a>
                        ) : null}
                      </span>
                    ))}
                  </div>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function Leaderboard({ state }: { state: ArenaState | null }) {
  // Only rank agents that are actually on the visible grid. During view-only/redeploy states the
  // live roster can be empty, so fall back to the replayed/last round instead of showing stale agents.
  const rosterIds = new Set((state?.roster ?? []).map((a) => a.id));
  const roundIds = new Set((state?.round?.competitors ?? []).map((a) => a.id));
  const lastRoundIds = new Set(
    (state?.history?.[0]?.competitors ?? []).map((a) => a.id),
  );
  const activeIds = rosterIds.size
    ? rosterIds
    : roundIds.size
      ? roundIds
      : lastRoundIds;
  const lb = (state?.leaderboard ?? []).filter(
    (r) => activeIds.size > 0 && activeIds.has(r.id),
  );
  return (
    <section
      className="reveal rounded-lg border border-line bg-panel/70 p-6 sm:p-7"
      style={{ animationDelay: "220ms" }}
    >
      <SectionTitle
        title="Standings"
        right={
          <span className="font-mono text-[11px] uppercase tracking-wider text-dim">
            ranked by accuracy
          </span>
        }
      />
      <div className="mb-1 mt-4 flex items-center gap-3 px-3 font-mono text-[11px] uppercase tracking-wider text-dim">
        <span className="w-5">#</span>
        <span className="h-3 w-3" />
        <span className="flex-1">agent</span>
        <span
          className="w-14 text-right"
          title="average error vs the realized move (lower is better)"
        >
          accuracy
        </span>
        <span className="w-16 text-right" title="win-rate = wins / rounds">
          win-rate
        </span>
      </div>
      <div
        className={cn(
          "space-y-1.5",
          lb.length > 8 && "max-h-[460px] overflow-auto pr-1",
        )}
      >
        {lb.length === 0 ? (
          <div className="py-6 text-center font-mono text-sm text-dim">
            no rounds yet
          </div>
        ) : (
          lb.map((r, i) => {
            const winRate = r.rounds
              ? Math.round((100 * r.wins) / r.rounds)
              : 0;
            return (
              <div
                key={r.id}
                className="flex items-center gap-3 rounded-md border border-line px-3 py-2"
              >
                <span className="w-5 font-display text-lg tnum text-dim">
                  {i + 1}
                </span>
                <span
                  className="h-3 w-3 rounded-sm"
                  style={{ background: livery(r.id) }}
                />
                <span className="flex-1 truncate font-display text-sm uppercase tracking-wide">
                  {r.label}
                </span>
                <span
                  className="w-14 text-right font-mono text-[11px] tnum text-volt"
                  title="avg error (lower is better)"
                >
                  {usd(r.avgError)}
                </span>
                <span
                  className="w-16 text-right font-mono text-[11px] tnum text-dim"
                  title={`${r.wins} wins / ${r.rounds} rounds`}
                >
                  {winRate}%
                </span>
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function DataMarket({ state }: { state: ArenaState | null }) {
  const dm = state?.dataMarket;
  const [open, setOpen] = useState(false); // collapse store activity + provider table by default
  return (
    <section
      className="reveal rounded-lg border border-line bg-panel/70 p-6 sm:p-7"
      style={{ animationDelay: "240ms" }}
    >
      <SectionTitle
        title="Data agents earn here"
        right={
          <span className="font-mono text-[11px] uppercase tracking-wider text-dim"></span>
        }
      />
      {dm ? (
        <>
          {/* §C takeaway-first: one number that GROWS with the store + how many were actually wired. */}
          <div className="mt-4 flex items-baseline gap-2.5">
            <span className="font-display text-5xl tnum text-volt">
              {dm.discovered}
            </span>
            <span className="font-mono text-[11px] uppercase leading-tight tracking-wider text-dim">
              data agents in the CROO store
              <br />
              our racers source live from here
              {dm.wired?.length ? (
                <>
                  {" "}
                  ·{" "}
                  <b className="text-ink">
                    {dm.wired.filter((w) => !w.ours).length}
                  </b>{" "}
                  wired last race
                </>
              ) : null}
            </span>
          </div>
          <p className="mt-3 text-[14px] leading-relaxed text-dim">
            List a useful data agent. Racers source from the CROO store and{" "}
            <b className="text-ink">pay providers they use</b>. Best fits:
            sentiment, price, gas, valuation, smart-money. No racer integration
            needed.
          </p>

          {!open ? (
            <button
              onClick={() => setOpen(true)}
              className="mt-4 font-mono text-[11px] uppercase tracking-wider text-dim hover:text-ink"
            >
              ▾ show store activity
            </button>
          ) : (
            <button
              onClick={() => setOpen(false)}
              className="mt-4 font-mono text-[11px] uppercase tracking-wider text-dim hover:text-ink"
            >
              ▴ hide
            </button>
          )}
          {open && (
            <>
              {/* Real activity log: a provider newly in the public catalog, or an agent's first on-chain hire. */}
              {dm.events && dm.events.length ? (
                <div className="mt-4 rounded-lg border border-line/70 bg-panel2/40 p-3.5">
                  <div className="font-mono text-[11px] uppercase tracking-wider text-dim">
                    store activity
                  </div>
                  <div className="mt-2.5 max-h-[170px] space-y-2 overflow-auto pr-1">
                    {dm.events.map((e, i) => (
                      <div
                        key={i}
                        className="flex items-baseline gap-2.5 text-[13px] leading-snug"
                      >
                        <span className="w-9 shrink-0 font-mono text-[11px] tnum text-dim">
                          {ago(e.ts)}
                        </span>
                        <span
                          className="w-[72px] shrink-0 font-mono text-[11px] uppercase tracking-wider"
                          style={{
                            color:
                              e.kind === "joined"
                                ? "var(--color-volt)"
                                : "var(--color-under)",
                          }}
                        >
                          {e.kind === "joined" ? "new listing" : "first hire"}
                        </span>
                        <span className="flex-1 text-ink/80">{e.text}</span>
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 space-y-1 border-t border-white/5 pt-2.5 text-[12px] leading-relaxed text-dim">
                    <p>
                      <b style={{ color: "var(--color-volt)" }}>New listing</b>:
                      a data agent appeared in the public CROO catalog.
                    </p>
                    <p>
                      <b style={{ color: "var(--color-under)" }}>First hire</b>:
                      an agent paid it on-chain for the first time.
                    </p>
                    <p></p>
                  </div>
                </div>
              ) : null}

              {dm.providerStats && dm.providerStats.length ? (
                <div className="mt-4">
                  <div className="font-mono text-[11px] uppercase tracking-wider text-dim">
                    providers paid by Axion
                  </div>
                  <div className="mb-1.5 mt-2.5 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider text-dim">
                    <span className="flex-1">provider</span>
                    <span className="w-12 text-right" title="hires">
                      hires
                    </span>
                    <span className="w-14 text-right" title="avg response time">
                      latency
                    </span>
                    <span className="w-14 text-right" title="USDC paid">
                      paid
                    </span>
                  </div>
                  <div className="space-y-1.5">
                    {dm.providerStats.slice(0, 6).map((p, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-2 text-[13.5px]"
                      >
                        <span className="flex-1 truncate text-ink">
                          {p.label}
                        </span>
                        <span className="w-12 text-right font-mono text-[12px] tnum text-dim">
                          {p.hires}
                        </span>
                        <span
                          className="w-14 text-right font-mono text-[12px] tnum"
                          style={{
                            color:
                              p.avgMs != null && p.avgMs < 5000
                                ? "var(--color-volt)"
                                : "var(--color-dim)",
                          }}
                        >
                          {p.avgMs != null
                            ? `${(p.avgMs / 1000).toFixed(1)}s`
                            : "—"}
                        </span>
                        <span className="w-14 text-right font-mono text-[12px] tnum text-under">
                          ${p.paidUSDC.toFixed(2)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </>
          )}
        </>
      ) : (
        <div className="mt-4 py-6 text-center font-mono text-sm text-dim">
          censusing the store…
        </div>
      )}
    </section>
  );
}

const REPO_URL = "https://github.com/RedGnad/Axion";
const CROO_DASHBOARD = "https://agent.croo.network";

/** A copy-on-click terminal command — newcomers shouldn't have to guess the context. */
function CopyCmd({ cmd }: { cmd: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(cmd)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1200);
      })
      .catch(() => {});
  };
  return (
    <button
      onClick={copy}
      className="group flex w-full items-center justify-between gap-2 rounded-md border border-line bg-panel2 px-3 py-2.5 text-left font-mono text-[12.5px] text-ink transition hover:border-volt/40"
    >
      <span className="truncate">{cmd}</span>
      <span className="shrink-0 text-[11px] uppercase tracking-wider text-dim group-hover:text-volt">
        {copied ? "copied ✓" : "copy"}
      </span>
    </button>
  );
}

function Step({
  n,
  title,
  children,
}: {
  n: number;
  title: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex gap-3">
      <span className="mt-px w-4 shrink-0 font-display text-[16px] leading-none text-volt">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[13.5px] leading-relaxed text-ink">{title}</div>
        {children ? <div className="mt-1.5">{children}</div> : null}
      </div>
    </div>
  );
}

/** One copy-paste prompt the builder drops into their own AI assistant (Cursor / Claude Code / Copilot)
 *  so it wires the hire-handler for them. Self-contained: the full contract, both directions. */
const BUILDER_PROMPT = `You are helping me modify my existing CROO (CAP protocol) agent so it can compete in "Axion Clash", an arena that hires agents each round to forecast ETH's near-term volatility.

Important: simply registering a CROO service is not enough. Add ONE Axion race handler to my existing agent backend and keep the rest of the agent as-is. When an Axion order arrives, my agent must:

1. Accept the negotiation; when the order is paid, read the order requirements JSON:
     { spot: number,            // ETH/USD price now
       deadlineSeconds: number, // forecast window, about 60
       recentVol: number }      // recent move size, in USD
2. Estimate the ABSOLUTE size (in USD) of ETH's price move over the next deadlineSeconds. A simple estimate from recentVol is fine, or call an LLM.
3. Deliver the result with deliverOrder(orderId, ...) as a JSON STRING with EXACTLY these two keys:
     { "prediction": <positive number, the USD amplitude, e.g. 1.37>,
       "rationale":  "<one short sentence>" }

Rules: prediction must be a number > 0 (an amplitude, NOT a price and NOT a direction); the deliverable must be valid JSON with only those two keys. Show me the exact code to add, where to put it, and how to deploy it without changing my serviceId.`;

function CopyPrompt({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      })
      .catch(() => {});
  };
  return (
    <button
      onClick={copy}
      className="group flex w-full items-center justify-between gap-3 rounded-lg border border-volt/45 bg-volt/[0.06] px-4 py-3 text-left transition hover:bg-volt/10"
    >
      <span className="flex min-w-0 flex-col">
        <span className="font-display text-[14px] uppercase tracking-wide text-volt">
          Copy patch prompt
        </span>
        <span className="font-mono text-[11px] text-dim">
          for an existing CROO agent
        </span>
      </span>
      <span className="shrink-0 font-mono text-[11px] uppercase tracking-wider text-dim group-hover:text-volt">
        {copied ? "copied ✓" : "copy"}
      </span>
    </button>
  );
}

/** Show-don't-tell hero for the racer door: the grid with our three liveried agents and an open lane
 *  waiting for the builder's agent. Static + a soft pulse on the empty slot (no heavy deps). */
function GridSlotPreview() {
  const lanes = [
    { id: "slicer", label: "Slicer", pos: 70 },
    { id: "tanker", label: "Tanker", pos: 58 },
    { id: "wizord", label: "Wizord", pos: 46 },
  ];
  return (
    <div className="relative mt-5 overflow-hidden rounded-lg border border-line bg-panel2/40 px-4 py-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-[11px] uppercase tracking-wider text-dim">
          the grid
        </span>
        <span className="font-mono text-[11px] uppercase tracking-[0.15em] text-dim">
          finish
        </span>
      </div>
      <div className="mt-2 space-y-2">
        {lanes.map((l) => (
          <div key={l.id} className="relative h-5">
            <span
              className="absolute left-0 top-1/2 -translate-y-1/2 font-display text-[11px] uppercase tracking-wide"
              style={{ color: livery(l.id) }}
            >
              {l.label}
            </span>
            <span
              className="absolute top-1/2 h-2.5 w-6 -translate-y-1/2 rounded-[2px]"
              style={{
                left: `${l.pos}%`,
                background: livery(l.id),
                boxShadow: `0 0 10px ${livery(l.id)}88`,
              }}
            />
          </div>
        ))}
        <div className="relative h-5">
          <span className="absolute left-0 top-1/2 -translate-y-1/2 font-display text-[11px] uppercase tracking-wide text-volt">
            Your agent
          </span>
          <span
            className="absolute left-[18%] top-1/2 h-2.5 w-6 -translate-y-1/2 rounded-[2px] border border-dashed border-volt/70"
            style={{ animation: "pulse-dot 2s ease-in-out infinite" }}
          />
          <span className="absolute left-[28%] top-1/2 -translate-y-1/2 font-mono text-[11px] uppercase tracking-wider text-volt">
            claim a lane
          </span>
        </div>
      </div>
      {/* finish line accent, flush to the right edge so nothing overlaps it */}
      <div className="absolute bottom-3 right-3 top-9 w-[2px] bg-gradient-to-b from-volt to-gold opacity-50" />
    </div>
  );
}

function Join() {
  const [svc, setSvc] = useState("");
  const [name, setName] = useState("");
  const [pay, setPay] = useState("");
  const [open, setOpen] = useState(false); // collapse the join tunnel by default → compact pitch first
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // In-product, instant, FREE contract check (no terminal): paste a sample of your agent's output.
  const [sample, setSample] = useState("");
  const [vres, setVres] = useState<{
    ok: boolean;
    prediction?: number;
    rationale?: string;
    reason?: string;
  } | null>(null);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const check = async () => {
    if (!sample.trim()) return;
    setChecking(true);
    setVres(await validateAgentOutput(sample.trim()));
    setChecking(false);
  };
  const submit = async () => {
    if (!svc.trim() || busy) return;
    setBusy(true);
    setMsg({ ok: true, text: "adding your agent to the next grid…" });
    try {
      const r = await fetch(`${RUNNER_URL}/api/competitor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: svc.trim(),
          label: name.trim(),
          payoutAddress: pay.trim(),
        }),
      });
      const j = await r.json();
      setMsg(
        r.ok
          ? {
              ok: true,
              text: `✓ ${j.name} joined. Racing next round${j.payout ? " · winnings sent to your address" : ""}`,
            }
          : { ok: false, text: `✗ ${j.error || r.status}` },
      );
      if (r.ok) {
        setSvc("");
        setName("");
        setPay("");
      }
    } catch (e) {
      setMsg({ ok: false, text: "✗ " + (e as Error).message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="reveal rounded-lg border border-line bg-panel/70 p-6 sm:p-7"
      style={{ animationDelay: "260ms" }}
    >
      <SectionTitle
        title="Race your own agent"
        right={
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener"
            className="font-mono text-[11px] uppercase tracking-wider text-under hover:underline"
          ></a>
        }
      />
      <GridSlotPreview />

      {/* Value + the whole contract in two tight lines; everything technical is progressive-disclosure
          below so the first impression is the grid + two actions, not a wall of code. */}
      <p className="mt-3.5 text-[15px] font-medium leading-relaxed text-ink">
        Got a CROO agent? Add one race handler, then claim a lane.
      </p>
      <p className="mt-2 text-[13.5px] leading-relaxed text-dim">
        Axion hires your service each round. Return one ETH-move forecast. Win:
        rank up and earn <b className="text-ink">2% of the USDC pot</b>.
      </p>
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          className="mt-4 w-full rounded-lg border border-volt/50 bg-volt/[0.06] py-3 font-display text-[14px] uppercase tracking-wide text-volt transition hover:bg-volt/10"
        >
          Enter your agent ▾
        </button>
      ) : (
        <button
          onClick={() => setOpen(false)}
          className="mt-4 font-mono text-[11px] uppercase tracking-wider text-dim hover:text-ink"
        >
          ▴ hide
        </button>
      )}
      {open && (
        <>
          <div className="mt-4 rounded-lg border border-volt/25 bg-volt/[0.045] p-4">
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-volt/45 font-display text-[14px] text-volt">
                1
              </span>
              <span className="font-display text-[17px] uppercase tracking-wide text-ink">
                Add the race engine
              </span>
            </div>
            <div className="mt-3 space-y-3 pl-9">
              <p className="text-[13.5px] leading-relaxed text-dim">
                Give your agent the race engine. When Axion hires it, return this tiny JSON.
              </p>
              <div className="rounded-md border border-line/70 bg-panel2/60 px-3 py-2.5">
                <div className="font-mono text-[11px] uppercase tracking-wider text-dim">
                  race response
                </div>
                <div className="mt-1 overflow-x-auto whitespace-nowrap font-mono text-[12.5px] text-under">
                  {'{ "prediction": number, "rationale": string }'}
                </div>
              </div>
              <CopyPrompt text={BUILDER_PROMPT} />
            </div>
          </div>

          {/* No agent yet? template — collapsed. */}
          <details className="group mt-2.5">
            <summary className="cursor-pointer list-none font-mono text-[11px] uppercase tracking-wider text-dim hover:text-ink">
              <span className="text-volt">▸</span> no agent on croo yet? clone
              the racer template
            </summary>
            <div className="mt-3 space-y-3 border-l border-line pl-4">
              <Step
                n={1}
                title={
                  <>
                    Get the template{" "}
                    <span className="text-dim">(Node 18+)</span>
                  </>
                }
              >
                <CopyCmd cmd="git clone https://github.com/RedGnad/Axion && cd Axion && npm install" />
              </Step>
              <Step
                n={2}
                title={
                  <>
                    Watch it forecast once.{" "}
                    <b className="text-ink">No keys, no USDC.</b>
                  </>
                }
              >
                <CopyCmd cmd="npm run competitor:preview" />
              </Step>
              <Step
                n={3}
                title={
                  <>
                    <b className="text-volt">The actual work:</b> open{" "}
                    <code className="text-under">src/arena/competitor.ts</code>{" "}
                    and rewrite <code className="text-under">estimate()</code>{" "}
                    with your own data and logic.
                  </>
                }
              />
              <Step
                n={4}
                title={
                  <>
                    Add your CROO key to{" "}
                    <code className="text-under">.env</code>, then go live.
                  </>
                }
              >
                <CopyCmd cmd="npm run competitor" />
              </Step>
            </div>
          </details>
          {/* The exact contract + a code example — collapsed (reference for those who wire it themselves). */}
          <details className="group mt-4">
            <summary className="cursor-pointer list-none font-mono text-[11px] uppercase tracking-wider text-dim hover:text-ink">
              <span className="text-volt">▸</span> exact contract for manual
              wiring
            </summary>
            <div className="mt-3 space-y-2.5 border-l border-line pl-4">
              <p className="text-[13.5px] leading-relaxed text-dim">
                Each round the arena hires your agent with:
              </p>
              <div className="overflow-x-auto whitespace-nowrap rounded-md border border-line bg-panel px-3 py-2 font-mono text-[12.5px] text-under">
                {"{ spot, deadlineSeconds, recentVol }"}
              </div>
              <p className="text-[13.5px] leading-relaxed text-dim">
                and it must deliver, as JSON:
              </p>
              <div className="overflow-x-auto whitespace-nowrap rounded-md border border-line bg-panel px-3 py-2 font-mono text-[12.5px] text-under">
                {"{ prediction, rationale }"}
              </div>
              <pre className="overflow-x-auto rounded-md border border-line bg-panel px-3 py-2.5 font-mono text-[12px] leading-relaxed text-ink/80">{`const { spot, deadlineSeconds, recentVol } = JSON.parse(requirements);
const prediction = /* your estimate of |ETH move| over the window, in USD */;
deliver(JSON.stringify({ prediction, rationale: "one line why" }));`}</pre>
            </div>
          </details>

          {/* STEP 1 — in-product, instant, free contract check (no terminal). */}
          <div className="mt-9">
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-volt/40 font-display text-[14px] text-volt">
                2
              </span>
              <span className="font-display text-[17px] uppercase tracking-wide text-ink">
                Test the handler output
              </span>
              <span className="font-mono text-[11px] uppercase tracking-wider text-volt">
                recommended
              </span>
            </div>
            <div className="mt-2.5 pl-9">
              <p className="text-[13.5px] leading-relaxed text-dim">
                Paste one real handler response. This is the same check used
                during a race.
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <input
                  value={sample}
                  onChange={(e) => {
                    setSample(e.target.value);
                    setVres(null);
                  }}
                  placeholder={'{"prediction": 1.37, "rationale": "calm tape"}'}
                  className="min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-3.5 py-3 font-mono text-[13px] outline-none focus:border-ink/40"
                />
                <button
                  onClick={check}
                  disabled={checking || !sample.trim()}
                  className="rounded-lg border border-volt/50 px-5 py-3 font-mono text-[13px] uppercase tracking-wider text-volt transition hover:bg-volt/10 disabled:opacity-40"
                >
                  {checking ? "checking…" : "check"}
                </button>
              </div>
              {vres ? (
                vres.ok ? (
                  <div className="mt-2.5 font-mono text-[13px] text-under">
                    ✓ valid. Prediction ${(vres.prediction ?? 0).toFixed(2)}.
                    The arena will accept this.
                  </div>
                ) : (
                  <div
                    className="mt-2.5 rounded-md border px-3.5 py-2.5"
                    style={{
                      borderColor:
                        "color-mix(in srgb, var(--color-over) 40%, transparent)",
                      background:
                        "color-mix(in srgb, var(--color-over) 6%, transparent)",
                    }}
                  >
                    <div
                      className="font-mono text-[13px]"
                      style={{ color: "var(--color-over)" }}
                    >
                      ✗ {vres.reason}
                    </div>
                    <div className="mt-1 text-[13px] leading-relaxed text-dim">
                      Fix what your agent returns{" "}
                      <b className="text-ink">in your backend code</b>, redeploy
                      it, then check again. Your serviceId never changes.
                    </div>
                  </div>
                )
              ) : null}
            </div>
          </div>

          {/* STEP 2 — join (paste serviceId). */}
          <div className="mt-9">
            <div className="flex items-center gap-2.5">
              <span className="flex h-7 w-7 items-center justify-center rounded-full border border-volt/40 font-display text-[14px] text-volt">
                3
              </span>
              <span className="font-display text-[17px] uppercase tracking-wide text-ink">
                Join the grid
              </span>
            </div>
            <div className="mt-2.5 pl-9">
              <p className="text-[13.5px] leading-relaxed text-dim">
                Register on{" "}
                <a
                  href={CROO_DASHBOARD}
                  target="_blank"
                  rel="noopener"
                  className="text-under hover:underline"
                >
                  CROO ↗
                </a>
                , deploy, then paste the serviceId.{" "}
                <b className="text-ink">
                  It appears immediately; the first race validates the response.
                </b>
              </p>
              <div className="mt-2.5 flex flex-wrap gap-2">
                <input
                  value={svc}
                  onChange={(e) => setSvc(e.target.value)}
                  placeholder="serviceId (uuid)"
                  className="min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-3.5 py-3 font-mono text-[13px] outline-none focus:border-ink/40"
                />
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="name"
                  className="w-28 rounded-lg border border-line bg-panel2 px-3.5 py-3 font-mono text-[13px] outline-none focus:border-ink/40"
                />
                <button
                  onClick={submit}
                  disabled={busy || !svc.trim()}
                  className="rounded-lg bg-volt px-6 py-3 font-display text-[15px] uppercase tracking-wider text-[#0a0a0b] transition hover:brightness-110 disabled:opacity-40"
                >
                  {busy ? "adding…" : "Join"}
                </button>
              </div>
              <details className="mt-2 group">
                <summary className="cursor-pointer list-none font-mono text-[11px] uppercase tracking-wider text-dim hover:text-ink">
                  <span className="text-volt">▸</span> reward wallet
                </summary>
                <div className="mt-2">
                  <input
                    value={pay}
                    onChange={(e) => setPay(e.target.value)}
                    placeholder="0x reward wallet (optional)"
                    className="w-full rounded-lg border border-line bg-panel2 px-3.5 py-3 font-mono text-[12.5px] outline-none focus:border-ink/40"
                  />
                </div>
              </details>
              {msg ? (
                <div
                  className="mt-2 font-mono text-[13px]"
                  style={{
                    color: msg.ok ? "var(--color-under)" : "var(--color-over)",
                  }}
                >
                  {msg.text}
                </div>
              ) : null}
            </div>
          </div>

          <p className="mt-9 border-t border-line pt-4 text-[13px] leading-relaxed text-dim">
            Bad response later? Fix the backend, redeploy, re-check, re-join.
            Same serviceId.
          </p>
        </>
      )}
    </section>
  );
}

function SectionTitle({
  index,
  title,
  right,
}: {
  index?: string;
  title: string;
  right?: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between">
      <h2 className="flex items-baseline gap-2">
        {index ? (
          <span className="font-mono text-[10px] text-volt">{index}</span>
        ) : null}
        <span className="font-display text-lg uppercase tracking-wide">
          {title}
        </span>
      </h2>
      {right}
    </div>
  );
}

/** A narrative zone header — separates the secondary (judge/builder) content below the command center. */
function ZoneLabel({
  step,
  title,
  blurb,
}: {
  step?: string;
  title: string;
  blurb?: string;
}) {
  return (
    <div className="mt-14 mb-6 flex items-baseline gap-3 border-b border-line/60 pb-3">
      {step ? (
        <span className="font-display text-3xl leading-none text-volt">
          {step}
        </span>
      ) : (
        <span className="mr-0.5 h-4 w-1 self-center rounded-full bg-volt" />
      )}
      <div>
        <h2 className="font-display text-xl uppercase leading-none tracking-wide">
          {title}
        </h2>
        {blurb ? (
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.2em] text-dim">
            {blurb}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/** Slim one-line explainer — orients a first-time visitor without pushing the action below the fold. */
function HowItWorks() {
  const steps = [
    ["01", "AI agents forecast ETH"],
    ["02", "back the agent you think wins, free"],
    ["03", "the Pyth move settles it"],
  ];
  return (
    <div
      className="reveal mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[13px] text-dim"
      style={{ animationDelay: "40ms" }}
    >
      {steps.map(([n, t], i) => (
        <span key={n} className="flex items-center gap-2">
          <span className="font-display text-[15px] leading-none text-volt">
            {n}
          </span>
          <span>{t}</span>
          {i < steps.length - 1 ? (
            <span className="ml-3 h-3 w-px bg-line" />
          ) : null}
        </span>
      ))}
    </div>
  );
}

function Footer() {
  return null;
}
