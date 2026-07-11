"use client";
import {
  type CSSProperties,
  type PointerEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import {
  useArena,
  postPredict,
  cancelPredict,
  validateAgentOutput,
  RUNNER_URL,
  type ArenaState,
  type SignedCredential,
  type SignedScorecard,
} from "@/lib/runner";
import { postUsdcBet, USDC_ADDRESS, ERC20_TRANSFER_ABI } from "@/lib/bet";
import { assignLivery, cn, inheritLivery, livery, usd } from "@/lib/utils";
import Race from "@/components/Race";
import ConnectModal from "@/components/ConnectModal";
import {
  useAccount,
  useConnect,
  useDisconnect,
  useSignMessage,
  useSwitchChain,
  useWriteContract,
} from "wagmi";
import { base } from "wagmi/chains";
import { getAddress, parseUnits, verifyTypedData } from "viem";

type Tab = "play" | "builders" | "scorecards" | "proof";

export default function Page() {
  const { state, online } = useArena(2000);
  // Resolve the team colors for the WHOLE visible field before any child calls livery(): two racers
  // must never share a color, and that can only be decided from the full set of ids. Feed them in a
  // STABLE order (roster = join order, then everyone else alphabetically) so a reload replays the same
  // assignment: the leaderboard is sorted by score, so reading colors off it would reshuffle the grid
  // every time the standings move.
  const seen = (state?.roster ?? []).map((r) => r.id);
  const alsoSeen = [
    ...(state?.leaderboard ?? []).map((r) => r.id),
    ...(state?.round?.competitors ?? []).map((c) => c.id),
    ...(state?.history ?? []).flatMap((h) => (h.competitors ?? []).map((c) => c.id)),
  ].filter((id) => !seen.includes(id));
  inheritLivery(state?.origins); // a renamed racer keeps the color it raced under, it is the same agent
  assignLivery([...seen, ...new Set(alsoSeen.sort())]);
  const [tab, setTab] = useState<Tab>("play");
  const [intro, setIntro] = useState(false);
  useEffect(() => {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
    requestAnimationFrame(() => window.scrollTo({ top: 0, left: 0 }));
  }, []);
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
    <main className="mx-auto max-w-[1180px] px-4 pb-20 pt-4 sm:px-5 sm:pb-24 sm:pt-3">
      <Intro open={intro} setTab={setTab} onClose={closeIntro} />
      <Header state={state} online={online} onHelp={() => setIntro(true)} />
      <Tabs tab={tab} setTab={setTab} />
      <Notice state={state} />

      {tab === "play" && (
        <>
          <HowItWorks />
          {/* ── COMMAND CENTER — everything live, above the fold (2026 real-time UX) ── */}
          <section
            className="reveal mt-3 overflow-hidden rounded-lg border border-line bg-panel/70 sm:flex sm:min-h-[calc(100svh-12rem)] sm:flex-col"
            style={{ animationDelay: "80ms" }}
          >
            <div className="grid gap-px bg-line sm:grid-cols-[1.05fr_1fr]">
              <div className="bg-panel px-3 py-3 sm:px-5 sm:py-3.5">
                <Telemetry state={state} />
              </div>
              <div className="bg-panel px-3 py-3 sm:px-5 sm:py-3.5">
                <RaceControl state={state} online={online} />
              </div>
            </div>
            <div className="border-t border-line px-3 py-3 sm:flex sm:flex-1 sm:flex-col sm:px-5 sm:py-3">
              <SectionTitle
                title="The grid"
                right={
                  <div className="flex items-center gap-3">
                    <HiringProgress state={state} />
                    <MoveBadge state={state} />
                    <PhaseTag state={state} online={online} />
                  </div>
                }
              />
              <div className="mt-2.5 sm:flex sm:flex-1 sm:flex-col">
                <Race round={state?.round ?? null} />
              </div>
              <EstimatingRotator state={state} />
            </div>
            {online ? (
              <div className="border-t border-volt/20 bg-volt/[0.02] px-3 py-3 sm:px-5 sm:py-3.5">
                <SpectatorCoach armed={!intro} />
                <ToteBoard state={state} />
              </div>
            ) : null}
            <LiveTicker state={state} />
          </section>
          <ZoneLabel title="Standings" blurb="which agent calls ETH best" />
          <Leaderboard state={state} />
          <DailyThesis state={state} online={online} />
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

      {tab === "scorecards" && (
        <>
          <ZoneLabel
            title="Cards"
            blurb="builder records · certified cards"
            right={
              (state?.externalBoard?.length ?? 0) > 0
                ? `${state!.externalBoard!.length} card${state!.externalBoard!.length > 1 ? "s" : ""} · ${state!.externalBoard!.filter((r) => r.certifiedAtSec).length} certified`
                : undefined
            }
          />
          <Scorecards state={state} setTab={setTab} />
        </>
      )}

      {tab === "proof" && (
        <>
          <ZoneLabel title="Journal" blurb="rounds, hires and payouts" />
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
    { id: "scorecards", label: "Cards" },
    { id: "proof", label: "Journal" },
  ];
  return (
    <div className="reveal mt-3 flex flex-wrap gap-1 sm:mt-5">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => setTab(t.id)}
          className={cn(
            "-mb-px border-b-2 px-4 py-2 font-display text-[13px] uppercase tracking-wide transition sm:py-2.5",
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
    <header className="reveal flex flex-wrap items-end justify-between gap-3 pb-3 sm:gap-4 sm:pb-4">
      <div>
        <h1 className="font-display text-3xl uppercase leading-none tracking-[0.04em] sm:text-5xl">
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
    <div className="grid h-full items-center gap-3 sm:grid-cols-[auto_1fr] sm:gap-5">
      <div>
        <div className="font-mono text-[11px] uppercase tracking-[0.25em] text-dim">
          ETH / USD
        </div>
        <div className="flex items-end gap-3">
          <span className="font-display text-[2.75rem] leading-none tnum sm:text-6xl">
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
  if (series.length < 2) return <div className="h-10 sm:h-16" />;
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
      className="h-10 w-full sm:h-16"
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

function formatOdds(mult: number): string {
  return mult >= 2 ? mult.toFixed(1) : mult.toFixed(2);
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

const HIRING_PROGRESS_MS = 150_000;

function HiringProgress({ state }: { state: ArenaState | null }) {
  const r = state?.round;
  const active =
    state?.status === "running" &&
    r?.phase === "open" &&
    typeof r.openAtMs === "number";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active, r?.id]);
  if (!active || !r?.openAtMs) return null;

  const elapsed = Math.max(0, now - r.openAtMs);
  const progress = Math.min(1, elapsed / HIRING_PROGRESS_MS);
  const over = elapsed >= HIRING_PROGRESS_MS;
  const deg = Math.round(progress * 360);

  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-wider text-under"
      title={`hiring ${clock(elapsed)}`}
    >
      <span
        className={cn(
          "grid h-6 w-6 place-items-center rounded-full",
          over && "animate-pulse",
        )}
        style={{
          background: `conic-gradient(#45a3ff ${deg}deg, rgba(69,163,255,.14) 0deg)`,
          boxShadow: over ? "0 0 18px rgba(69,163,255,.35)" : undefined,
        }}
      >
        <span className="h-3.5 w-3.5 rounded-full bg-panel" />
      </span>
      <span className="hidden sm:inline">hiring</span>
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
          `next ${Math.max(0, Math.round((j.nextAtMs - Date.now()) / 1000))}s`,
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

  let kicker = "NEXT";
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
    const realBetOpen = state?.usdcBet?.open === true;
    const betCutoffAt = state?.usdcBet?.betCutoffAtMs;
    const ready = r.competitors.filter((c) => c.estimate != null).length;
    const total = r.competitors.length || 1;
    const openMs = Number((r.id || "").split("-")[1]) || now;
    const graceOpen =
      r.dqFromMs != null &&
      r.dqAtMs != null &&
      r.dqAtMs > r.dqFromMs &&
      ready < total;
    if (r.phase === "betting") {
      if (realBetOpen) {
        // The money window is open → odds is the hero, with the close timer visible.
        kicker =
          r.format === "thesis" ? "15M THESIS LIVE" : "RACE LIVE · BET WINDOW";
        big = `×${formatOdds(mult)}`;
        secondary =
          betCutoffAt && betCutoffAt > now
            ? { label: "bets close", value: clock(betCutoffAt - now) }
            : null;
        note = "real bets close early; free picks stay open";
      } else {
        // After the paid window, do not advertise x1; show the race clock + closed status.
        kicker = r.format === "thesis" ? "15M THESIS LIVE" : "RACE LIVE";
        big = clock((r.settleAtMs ?? now) - now);
        secondary = { label: "real bets", value: "closed" };
        note = "free picks stay open";
      }
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
      kicker =
        r.format === "thesis" ? "AGENTS BUILDING THESIS" : "AGENTS HIRING DATA";
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
    // Never offer a button that can only answer 409. With a countdown showing, the exhausted case used
    // to keep the CTA lit, so the first thing a visitor did was click into a refusal.
    showStart = !exhausted;
    if (nextAt && delta > 0) {
      kicker = "NEXT";
      big = clock(delta);
    } else {
      kicker = "ARENA READY";
      big = exhausted ? "back tomorrow" : "start a race";
      accent = false;
    }
    note =
      startMsg ??
      (exhausted
        ? "free races used up today"
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
        <div className="mt-0.5 flex items-end gap-3 sm:gap-4">
          <div
            className={cn(
              "font-display leading-none tnum",
              accent ? "text-volt" : "text-ink",
            )}
            style={{ fontSize: "clamp(1.9rem, 6vw, 3.25rem)" }}
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
          <div
            className={cn(
              "mt-1.5 font-mono text-[12.5px] text-dim",
              showStart && "hidden sm:block",
            )}
          >
            {note}
          </div>
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
          className="w-full shrink-0 rounded-lg bg-volt px-6 py-3 font-display text-[15px] uppercase tracking-wider text-[#0a0a0b] shadow-[0_0_24px_rgba(182,255,58,.25)] transition hover:brightness-110 disabled:opacity-50 sm:w-auto sm:px-7 sm:py-3.5"
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
    failReason?: string;
  }[] = live
    ? comps
    : roster.map((a) => {
        const last = r?.competitors.find((c) => c.id === a.id);
        return {
          id: a.id,
          label: a.label,
          estimate: last?.estimate,
          dq: last?.dq,
          failReason: last?.failReason,
        };
      });

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
  const ub = state?.usdcBet;
  const raceBettable = r?.phase === "open" || r?.phase === "betting";
  const realOpen = !!ub?.enabled && ub.open === true && raceBettable;
  const realClosed = !!ub?.enabled && raceBettable && ub.open === false;
  const activeCommitted = active && !!pick?.committed;

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
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-volt/30 bg-volt/[0.04] px-3 py-2 sm:px-4 sm:py-2.5">
        <div>
          <div className="font-display text-[15px] uppercase tracking-wide text-volt sm:text-lg">
            Back the winner. Free.
          </div>
        </div>
        {ps && ps.total > 0 ? (
          <div className="font-mono text-[10px] text-dim sm:text-right sm:text-[11px]">
            <b className="text-ink tnum">{ps.total.toLocaleString()}</b> picks ·{" "}
            <span className="hidden sm:inline">
              <b className="text-ink tnum">{ps.visitors.toLocaleString()}</b>{" "}
              visitors
            </span>
            {resolvedPicks > 0 ? (
              <>
                <span className="hidden sm:inline"> · </span>
                <b className="text-volt tnum">{publicAccuracy}%</b> right
              </>
            ) : pendingPicks > 0 ? (
              <>
                <span className="hidden sm:inline"> · </span>
                <b className="text-volt tnum">{pendingPicks}</b> pending
              </>
            ) : null}
          </div>
        ) : null}
      </div>
      {cards.length ? (
        <div
          className={cn(
            "mt-3 grid gap-2 sm:gap-3",
            // Responsive field: fewer agents fill the row; more agents wrap into balanced rows with
            // narrower cards (never a lone stretched orphan). Mobile keeps 2 across for tappable targets.
            cards.length === 1
              ? "grid-cols-1"
              : cards.length === 2
                ? "grid-cols-2"
                : cards.length === 3
                  ? "grid-cols-3"
                  : cards.length === 4
                    ? "grid-cols-2 lg:grid-cols-4"
                    : cards.length <= 6
                      ? "grid-cols-2 sm:grid-cols-3"
                      : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4",
            cards.length > 8 && "max-h-[520px] overflow-auto pr-1", // beyond a full field → scroll, never flood
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
            const col = livery(c.id);
            const showCallDetail = live;
            const isOpen = showCallDetail && open === c.id;
            const d = detail(c.id);
            const hires = (hiresSrc?.edges ?? []).filter(
              (e) => e.competitor === c.id && !e.raceEntry,
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
                    "flex min-h-[78px] w-full flex-col justify-between px-3 py-2.5 text-left sm:min-h-[104px] sm:px-4 sm:py-3.5",
                    tappable ? "cursor-pointer" : "cursor-default",
                  )}
                >
                  <div className="flex w-full items-center gap-2">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-sm sm:h-3 sm:w-3"
                      style={{ background: livery(c.id) }}
                    />
                    <div
                      className="min-w-0 truncate font-display text-base uppercase leading-none tracking-wide sm:text-xl"
                      style={{ opacity: boxed ? 1 : 0.78 }}
                    >
                      {c.label}
                    </div>
                  </div>
                  <div className="mt-2 min-h-[1rem] font-mono text-[10px] uppercase tracking-wider text-dim sm:text-[11px]">
                    {live ? (
                      c.estimate != null ? (
                        <>calls {usd(c.estimate)}</>
                      ) : c.dq ? (
                        c.failReason ? (
                          "failed this race"
                        ) : (
                          "cut this race"
                        )
                      ) : (
                        "forecasting…"
                      )
                    ) : c.estimate != null ? (
                      <>last {usd(c.estimate)}</>
                    ) : raced.has(c.id) ? null : (
                      <span className="text-volt">new</span>
                    )}
                  </div>
                  <div
                    className="mt-1 min-h-[1rem] font-mono text-[10px] font-bold uppercase tracking-[0.16em] sm:text-[11px] sm:tracking-[0.18em]"
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
                        : tappable
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
      {active || pick?.resolved ? (
        <div className="mt-3 flex min-h-[44px] flex-wrap items-center justify-between gap-2 rounded-lg border border-line/70 bg-panel2/35 px-3 py-2 sm:px-4">
          <div className="min-w-0 font-mono text-[11px] uppercase tracking-wider text-dim">
            {pick?.resolved ? (
              <span
                className="font-display text-[13px] tracking-wide"
                style={{
                  color: pick.correct
                    ? "var(--color-under)"
                    : "var(--color-over)",
                }}
              >
                {pick.correct ? "winner picked" : "pick missed"}
              </span>
            ) : (
              <span>
                <b className="font-display text-[13px] tracking-wide text-ink">
                  {myLabel}
                </b>{" "}
                {activeCommitted ? "USDC in" : "selected"}
              </span>
            )}
          </div>
          {active && ub?.enabled && !activeCommitted ? (
            <span className="font-mono text-[11px] uppercase tracking-wide text-dim">
              {realOpen
                ? `real bet ×${formatOdds(ub.multiplier)} below`
                : realClosed
                  ? "real bets closed"
                  : "real bet opens at race start"}
            </span>
          ) : null}
        </div>
      ) : null}
      {active && ub?.enabled && (realOpen || activeCommitted) ? (
        <UsdcBet
          state={state}
          pickedAgent={pick!.agentId}
          pickedLabel={myLabel}
          committed={!!pick?.committed}
          onPlaced={() => setPick((p) => (p ? { ...p, committed: true } : p))}
        />
      ) : null}
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
  const raceBettable = r?.phase === "open" || r?.phase === "betting";
  const live = !!ub?.open && raceBettable; // real-money bets close early; free picks can stay simple
  const { address, isConnected, chainId } = useAccount();
  const { isPending: connecting } = useConnect();
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
                <b style={{ color: "var(--color-volt)" }}>
                  ×{formatOdds(mult)}
                </b>{" "}
                · closes early to prevent late farming
              </>
            ) : raceBettable && ub.open === false ? (
              "real bets closed for this race"
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
        <>
          <button
            onClick={() => setPickWallet(true)}
            className="mt-4 w-full rounded-lg border-2 border-volt/60 py-3.5 font-display text-base uppercase tracking-wide text-volt transition hover:bg-volt/10"
          >
            {connecting ? "connecting…" : "connect wallet to bet"}
          </button>
          <ConnectModal
            open={pickWallet}
            onClose={() => setPickWallet(false)}
          />
        </>
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
                  ? raceBettable && ub.open === false
                    ? "real bets closed"
                    : "opens when a race is live"
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

function DailyThesis({
  state,
  online,
}: {
  state: ArenaState | null;
  online: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const thesis = state?.thesisRace;
  const running = state?.status === "running";
  const used = thesis ? thesis.usedToday >= thesis.capToday : false;
  const start = async () => {
    setBusy(true);
    setMsg("starting the long race...");
    try {
      const res = await fetch(`${RUNNER_URL}/api/round`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ format: "thesis" }),
      });
      const j = (await res.json().catch(() => ({}))) as {
        started?: boolean;
        reason?: string;
        error?: string;
      };
      setMsg(
        j.started
          ? "Long race starting. Agents have more time to think."
          : j.reason || j.error || "not available right now",
      );
    } catch {
      setMsg("arena was asleep. Try again in ~20s");
    } finally {
      setTimeout(() => {
        setBusy(false);
        setMsg(null);
      }, 6000);
    }
  };
  return (
    <section className="reveal mt-8 rounded-lg border border-line bg-panel/55 px-4 py-3 sm:flex sm:items-center sm:justify-between sm:gap-4 sm:px-5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-display text-base uppercase tracking-wide text-ink">
            Daily Long Race
          </span>
          <span className="rounded border border-line px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">
            15m
          </span>
        </div>
        <p className="mt-1 max-w-3xl text-[13px] leading-relaxed text-dim">
          One slower round per day. More time, richer calls, bigger drama.
        </p>
        {msg ? (
          <div className="mt-1.5 font-mono text-[11px] text-volt">{msg}</div>
        ) : null}
      </div>
      <button
        onClick={start}
        disabled={!online || running || busy || used}
        className="mt-3 w-full rounded-md border border-volt/55 px-4 py-2.5 font-display text-[13px] uppercase tracking-wide text-volt transition hover:bg-volt/10 disabled:border-line disabled:text-dim disabled:opacity-60 sm:mt-0 sm:w-auto"
      >
        {used ? "today done" : busy ? "starting..." : "start long race"}
      </button>
    </section>
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
      ? c.failReason
        ? `${c.label} failed: ${c.failReason}`
        : `${c.label} was cut this race`
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
// EIP-712 schema for accuracy scorecards — MUST match src/arena/scorecard.ts exactly so a judge can
// recover the signer independently in their own browser (the verifiability moat).
const SCORECARD_DOMAIN = {
  name: "Axion Clash",
  version: "1",
  chainId: 8453,
} as const;
const SCORECARD_TYPES = {
  Scorecard: [
    { name: "agent", type: "string" },
    { name: "roundId", type: "string" },
    { name: "reasonHash", type: "string" },
    { name: "predictionMicro", type: "uint256" },
    { name: "actualMicro", type: "uint256" },
    { name: "errorMicro", type: "uint256" },
    { name: "rank", type: "uint256" },
    { name: "field", type: "uint256" },
    { name: "settledAtSec", type: "uint256" },
  ],
} as const;
const CREDENTIAL_TYPES = {
  Credential: [
    { name: "agent", type: "string" },
    { name: "serviceId", type: "string" },
    { name: "label", type: "string" },
    { name: "scoreVersion", type: "string" },
    { name: "rounds", type: "uint256" },
    { name: "effectiveRounds", type: "uint256" },
    { name: "avgErrorMicro", type: "uint256" },
    { name: "trustedErrorMicro", type: "uint256" },
    { name: "bestRank", type: "uint256" },
    { name: "wins", type: "uint256" },
    { name: "confidence", type: "uint256" },
    { name: "cardClass", type: "string" },
    { name: "fromRound", type: "string" },
    { name: "toRound", type: "string" },
    { name: "issuedAtSec", type: "uint256" },
  ],
} as const;
const LEGACY_CREDENTIAL_TYPES = {
  Credential: [
    { name: "agent", type: "string" },
    { name: "rounds", type: "uint256" },
    { name: "avgErrorMicro", type: "uint256" },
    { name: "bestRank", type: "uint256" },
    { name: "wins", type: "uint256" },
    { name: "fromRound", type: "string" },
    { name: "toRound", type: "string" },
    { name: "issuedAtSec", type: "uint256" },
  ],
} as const;
const usdMicro = (usd: number) =>
  BigInt(Math.round(Math.max(0, usd) * 1_000_000));

/** Recover the signer of a scorecard in-browser and confirm it matches the claimed signer. */
async function verifyScorecard(c: SignedScorecard): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: c.signer as `0x${string}`,
      domain: SCORECARD_DOMAIN,
      types: SCORECARD_TYPES,
      primaryType: "Scorecard",
      message: {
        agent: c.agent,
        roundId: c.roundId,
        reasonHash: c.reasonHash,
        predictionMicro: usdMicro(c.prediction),
        actualMicro: usdMicro(c.actual),
        errorMicro: usdMicro(c.errorUsd),
        rank: BigInt(Math.trunc(c.rank)),
        field: BigInt(Math.trunc(c.field)),
        settledAtSec: BigInt(Math.trunc(c.settledAtSec)),
      },
      signature: c.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

async function verifyCredential(c: SignedCredential): Promise<boolean> {
  try {
    const ok = await verifyTypedData({
      address: c.signer as `0x${string}`,
      domain: SCORECARD_DOMAIN,
      types: CREDENTIAL_TYPES,
      primaryType: "Credential",
      message: {
        agent: c.agent,
        serviceId: c.serviceId || "",
        label: c.label || c.agent,
        scoreVersion: c.scoreVersion || "2026-07-v1",
        rounds: BigInt(Math.trunc(c.rounds)),
        effectiveRounds: BigInt(Math.trunc(c.effectiveRounds ?? c.rounds)),
        avgErrorMicro: usdMicro(c.avgErrorUsd),
        trustedErrorMicro: usdMicro(c.trustedErrorUsd ?? c.avgErrorUsd),
        bestRank: BigInt(Math.trunc(c.bestRank)),
        wins: BigInt(Math.trunc(c.wins)),
        confidence: BigInt(
          Math.max(0, Math.min(100, Math.trunc(c.confidence ?? 0))),
        ),
        cardClass: c.cardClass || "D",
        fromRound: c.fromRound,
        toRound: c.toRound,
        issuedAtSec: BigInt(Math.trunc(c.issuedAtSec)),
      },
      signature: c.signature as `0x${string}`,
    });
    if (ok) return true;
  } catch {
    /* try legacy below */
  }
  try {
    return await verifyTypedData({
      address: c.signer as `0x${string}`,
      domain: SCORECARD_DOMAIN,
      types: LEGACY_CREDENTIAL_TYPES,
      primaryType: "Credential",
      message: {
        agent: c.agent,
        rounds: BigInt(Math.trunc(c.rounds)),
        avgErrorMicro: usdMicro(c.avgErrorUsd),
        bestRank: BigInt(Math.trunc(c.bestRank)),
        wins: BigInt(Math.trunc(c.wins)),
        fromRound: c.fromRound,
        toRound: c.toRound,
        issuedAtSec: BigInt(Math.trunc(c.issuedAtSec)),
      },
      signature: c.signature as `0x${string}`,
    });
  } catch {
    return false;
  }
}

function shortAddr(addr?: string): string {
  return addr ? `${addr.slice(0, 6)}…${addr.slice(-4)}` : "—";
}

function credentialMintMessage(
  wallet: string,
  nonce: string,
  serviceId = "",
): string {
  return [
    "Axion Clash credential mint",
    `wallet:${getAddress(wallet as `0x${string}`)}`,
    `serviceId:${serviceId.trim()}`,
    `nonce:${nonce}`,
  ].join("\n");
}

function racerJoinMessage(
  wallet: string,
  serviceId: string,
  nonce: string,
): string {
  return [
    "Axion Clash racer wallet",
    `wallet:${getAddress(wallet as `0x${string}`)}`,
    `serviceId:${serviceId}`,
    `nonce:${nonce}`,
  ].join("\n");
}

function WalletOwnerPanel({
  title = "Owner wallet",
  compact = false,
}: {
  title?: string;
  compact?: boolean;
}) {
  const { address, isConnected } = useAccount();
  const { disconnect } = useDisconnect();
  // One "connect wallet" action; the wallet choice lives in an overlay modal (ConnectModal), never
  // as a row of brand buttons inside the page.
  const [pickWallet, setPickWallet] = useState(false);
  return (
    <div
      className={cn(
        "rounded-lg border border-line/70 bg-panel/55",
        compact ? "px-3 py-2.5" : "p-4",
      )}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-mono text-[10px] uppercase tracking-wider text-dim">
            {title}
          </div>
          {!compact ? (
            <div className="mt-1 text-[12.5px] leading-relaxed text-dim">
              sign only
            </div>
          ) : null}
        </div>
        {isConnected && address ? (
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-volt/35 bg-volt/[0.05] px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-volt">
              {shortAddr(address)}
            </span>
            <button
              onClick={() => disconnect()}
              className="rounded-md border border-line px-2.5 py-1.5 font-mono text-[10px] uppercase tracking-wider text-dim hover:text-ink"
            >
              switch
            </button>
          </div>
        ) : (
          <>
            <button
              onClick={() => setPickWallet(true)}
              className="rounded-md border border-volt/45 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wider text-volt hover:bg-volt/10"
            >
              connect wallet
            </button>
            <ConnectModal
              open={pickWallet}
              onClose={() => setPickWallet(false)}
            />
          </>
        )}
      </div>
    </div>
  );
}

/** Compact "verify in 30s" affordance: recovers every scorecard's signer client-side on click. */
function VerifyScores({ cards }: { cards?: SignedScorecard[] }) {
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: number; total: number } | null>(null);
  if (!cards || cards.length === 0) return null;
  const signer = cards[0].signer;
  const run = async () => {
    setBusy(true);
    let ok = 0;
    for (const c of cards) if (await verifyScorecard(c)) ok++;
    setRes({ ok, total: cards.length });
    setBusy(false);
  };
  const allOk = res && res.ok === res.total;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 border-t border-white/5 pt-2 font-mono text-[10px] text-dim">
      <span>
        {cards.length} score{cards.length > 1 ? "s" : ""} signed ·{" "}
        {signer.slice(0, 6)}…{signer.slice(-4)}
      </span>
      <button
        onClick={run}
        disabled={busy}
        className={cn(
          "rounded border px-1.5 py-0.5 uppercase tracking-wider transition disabled:opacity-50",
          allOk
            ? "border-volt/50 text-volt"
            : res
              ? "border-over/50 text-over"
              : "border-line hover:text-ink",
        )}
        title="Recovers each signature in your browser and checks it matches the published signer — no trust in us required."
      >
        {busy
          ? "verifying…"
          : res
            ? allOk
              ? `✓ ${res.ok}/${res.total} verified`
              : `✗ ${res.ok}/${res.total}`
            : "verify signatures"}
      </button>
    </div>
  );
}

function scoreStage(row?: NonNullable<ArenaState["externalBoard"]>[number]): {
  label: string;
  pct: number;
  tone: string;
  name: string;
  klass: string;
  badge: string;
  glow: string;
  foil: string;
  sheen: string;
  sheenO: number;
  rgb: string;
} {
  const klass = (row?.cardClass || "D").toUpperCase();
  const confidence = row?.confidence ?? 0;
  const names: Record<string, string> = {
    D: "provisional",
    C: "tracked",
    B: "seasoned",
    A: "proven",
    S: "elite",
  };
  const tones: Record<string, string> = {
    D: "text-dim",
    C: "text-gold",
    B: "text-under",
    A: "text-volt",
    S: "text-gold",
  };
  const badges: Record<string, string> = {
    D: "border-white/15 bg-white/[0.04] text-dim",
    C: "border-under/40 bg-under/[0.08] text-under",
    B: "border-[#B583FF]/45 bg-[#B583FF]/[0.10] text-[#C9A7FF]",
    A: "border-gold/50 bg-gold/[0.10] text-gold",
    S: "border-volt/55 bg-volt/[0.13] text-volt",
  };
  const glows: Record<string, string> = {
    D: "shadow-[0_0_18px_rgba(255,255,255,.04)]",
    C: "shadow-[0_0_24px_rgba(42,214,201,.14)]",
    B: "shadow-[0_0_26px_rgba(181,131,255,.18)]",
    A: "shadow-[0_0_30px_rgba(255,211,77,.20)]",
    S: "shadow-[0_0_36px_rgba(182,255,58,.24)]",
  };
  const foils: Record<string, string> = {
    D: "bg-[linear-gradient(135deg,rgba(255,255,255,.10),rgba(42,214,201,.05)_46%,rgba(255,255,255,.04))]",
    C: "bg-[linear-gradient(135deg,rgba(42,214,201,.20),rgba(182,255,58,.07)_46%,rgba(255,255,255,.05))]",
    B: "bg-[linear-gradient(135deg,rgba(181,131,255,.24),rgba(42,214,201,.08)_44%,rgba(255,59,107,.10))]",
    A: "bg-[linear-gradient(135deg,rgba(255,211,77,.28),rgba(182,255,58,.10)_43%,rgba(255,59,107,.08))]",
    S: "bg-[linear-gradient(135deg,rgba(182,255,58,.30),rgba(255,211,77,.16)_42%,rgba(181,131,255,.16))]",
  };
  // Holographic foil sweep: the light band that lives IN the material and moves with the pointer.
  // Each class is a different metal (steel, teal, violet, gold); only S earns the full spectrum.
  // Stops stay tight around 50% so the sweep reads as a narrow RAY crossing the card, never a wash
  // that milks the whole face and eats label contrast.
  const sheens: Record<string, string> = {
    D: "rgba(200,208,220,.30) 47%, rgba(255,255,255,.12) 50%, rgba(160,170,185,.22) 53%",
    C: "rgba(42,214,201,.42) 47%, rgba(182,255,58,.18) 50%, rgba(42,214,201,.30) 53%",
    B: "rgba(181,131,255,.44) 46.5%, rgba(42,214,201,.20) 50%, rgba(255,59,107,.24) 53.5%",
    A: "rgba(245,197,66,.46) 46.5%, rgba(255,59,107,.22) 50%, rgba(245,197,66,.32) 53.5%",
    S: "rgba(255,59,107,.40) 44%, rgba(245,197,66,.38) 47%, rgba(182,255,58,.40) 50%, rgba(42,214,201,.38) 53%, rgba(181,131,255,.40) 56%",
  };
  const sheenOs: Record<string, number> = { D: 0.5, C: 0.65, B: 0.7, A: 0.75, S: 0.9 };
  // The class color as a raw triplet: drives the card's tinted corners, edge and aura inline, so the
  // whole object reads as MADE of its class color instead of grey plastic with a colored sticker.
  const rgbs: Record<string, string> = {
    D: "203,210,222",
    C: "42,214,201",
    B: "181,131,255",
    A: "245,197,66",
    S: "182,255,58",
  };
  return {
    label: `Class ${klass}`,
    name: names[klass] || "provisional",
    klass,
    pct: Math.max(10, Math.min(100, confidence || (row?.rounds ?? 0) * 8)),
    tone: tones[klass] || "text-dim",
    badge: badges[klass] || badges.D,
    glow: glows[klass] || glows.D,
    foil: foils[klass] || foils.D,
    sheen: sheens[klass] || sheens.D,
    sheenO: sheenOs[klass] ?? sheenOs.D,
    rgb: rgbs[klass] || rgbs.D,
  };
}

function CredentialCard({
  row,
  empty = false,
}: {
  row?: NonNullable<ArenaState["externalBoard"]>[number];
  empty?: boolean;
}) {
  const stage = scoreStage(row);
  const trustMiss = row?.trustedError ?? row?.avgError ?? 0;
  const certified = !!row?.certifiedAtSec;
  const cardRef = useRef<HTMLDivElement | null>(null);
  // `held` = pointer on the card: the foil follows the hand; at rest it drifts on its own (holo-idle).
  const [held, setHeld] = useState(false);
  const [tilt, setTilt] = useState({
    rx: 8,
    ry: -10,
    glareX: 58,
    glareY: 22,
  });
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    setHeld(true);
    setTilt({
      rx: (0.5 - py) * 15,
      ry: (px - 0.5) * 18,
      glareX: px * 100,
      glareY: py * 100,
    });
  };
  const reset = () => {
    setHeld(false);
    setTilt({ rx: 8, ry: -10, glareX: 58, glareY: 22 });
  };
  const cardStyle = {
    "--rx": `${tilt.rx}deg`,
    "--ry": `${tilt.ry}deg`,
    "--gx": `${tilt.glareX}%`,
    "--gy": `${tilt.glareY}%`,
  } as CSSProperties;
  return (
    <div className="relative min-h-[280px] overflow-hidden rounded-lg border border-volt/20 bg-panel2/60 p-4 shadow-[0_18px_60px_rgba(0,0,0,.25)]">
      <div
        className="absolute inset-x-8 top-8 h-28 rounded-full blur-3xl"
        style={{ backgroundColor: `rgba(${stage.rgb},${certified ? 0.16 : 0.1})` }}
        aria-hidden
      />
      <div
        ref={cardRef}
        onPointerMove={move}
        onPointerLeave={reset}
        className={cn(
          "relative mx-auto max-w-[320px] overflow-hidden rounded-lg border bg-[#0f0f13] p-4 transition-transform duration-150 ease-out will-change-transform",
          stage.foil,
          certified ? "ring-1 ring-volt/30" : "",
        )}
        style={{
          ...cardStyle,
          borderColor: `rgba(${stage.rgb},.32)`,
          boxShadow: `0 24px 50px rgba(0,0,0,.35), 0 0 44px rgba(${stage.rgb},.14)`,
          transform:
            "perspective(900px) rotateX(var(--rx)) rotateY(var(--ry)) translateZ(0)",
          transformStyle: "preserve-3d",
        }}
      >
        {/* Class-tinted base: two color pools in opposite corners; the center stays dark so the
            numbers keep their contrast. This is what makes the card read as MADE of its class color. */}
        <div
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(130% 120% at 18% -10%, rgba(${stage.rgb},.22), transparent 52%), radial-gradient(120% 130% at 108% 112%, rgba(${stage.rgb},.13), transparent 50%)`,
          }}
          aria-hidden
        />
        <div
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(120deg,transparent_0%,rgba(255,255,255,.08)_42%,transparent_58%)] opacity-60"
          style={{ transform: "translateZ(24px)" }}
          aria-hidden
        />
        {/* Holographic foil: a light band living IN the material (color-dodge over the dark base),
            crossed by hairline diffraction lines that catch it. It tracks the pointer while held and
            drifts slowly on its own at rest, so the card never reads as dead plastic. */}
        <div
          className={cn(
            "pointer-events-none absolute inset-0 mix-blend-color-dodge",
            !held && "holo-idle",
          )}
          style={{
            background: `linear-gradient(115deg, transparent 40%, ${stage.sheen}, transparent 60%), repeating-linear-gradient(105deg, rgba(255,255,255,.028) 0 1px, transparent 1px 3px)`,
            backgroundSize: "240% 240%, auto",
            backgroundPosition: "var(--gx) var(--gy), 0 0",
            opacity: stage.sheenO,
            transform: "translateZ(30px)",
          }}
          aria-hidden
        />
        <div
          className="relative flex items-start justify-between gap-3"
          style={{ transform: "translateZ(34px)" }}
        >
          <div>
            <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
              Axion card
            </div>
            <div className="mt-2 font-display text-2xl uppercase leading-none tracking-wide text-ink">
              {empty ? "Unclaimed" : row?.label}
            </div>
          </div>
          {/* Certification seal: a foil stamp struck into the card face, collectible-style. It sits
              with the class badge (the credential cluster) so it never covers a metric. */}
          {certified ? (
            <div
              className="ml-auto flex h-12 w-12 shrink-0 items-center justify-center self-center rounded-full"
              title="CROO certified"
              style={{
                // The foil is the STAMP, so it needs room to read: a 6px rim at .55 alpha, cut by an inner
                // black shadow, collapsed into a black disc on the card face. Wide rim, opaque metal.
                background: `conic-gradient(from 210deg, rgba(${stage.rgb},1), rgba(255,255,255,.85), rgba(${stage.rgb},.65), rgba(255,255,255,.35), rgba(${stage.rgb},1))`,
                boxShadow: `0 0 18px rgba(${stage.rgb},.45), 0 1px 2px rgba(0,0,0,.55)`,
              }}
            >
              <div
                className="flex h-[31px] w-[31px] flex-col items-center justify-center rounded-full"
                style={{
                  // Struck metal, not a hole: the core keeps the class tint so the check reads as engraved.
                  background: `radial-gradient(circle at 50% 32%, rgba(${stage.rgb},.28), #0a0d11 80%)`,
                  boxShadow: 'inset 0 1px 3px rgba(0,0,0,.8)',
                }}
              >
                <span
                  className="font-display text-[14px] font-bold leading-none text-ink"
                  style={{ textShadow: `0 0 6px rgba(${stage.rgb},.9)` }}
                >
                  ✓
                </span>
                <span className="mt-[1px] font-mono text-[5px] uppercase leading-none tracking-[0.16em] text-ink/55">
                  CROO
                </span>
              </div>
            </div>
          ) : null}
          <div
            className={cn(
              "rounded-md border px-3 py-2 text-center",
              certified ? "" : "ml-auto",
              stage.badge,
              stage.glow,
            )}
          >
            <div className="font-display text-3xl leading-none">
              {stage.klass}
            </div>
            <div className="mt-0.5 font-mono text-[8px] uppercase tracking-wider">
              class
            </div>
          </div>
        </div>

        <div
          className="relative mt-8 grid grid-cols-[1.15fr_0.95fr_0.9fr] gap-2 text-center"
          style={{ transform: "translateZ(46px)" }}
        >
          <div>
            <div className="font-display text-4xl leading-none text-volt tnum">
              {row ? `$${trustMiss.toFixed(2)}` : "—"}
            </div>
            <div className="mt-1 font-mono text-[9px] uppercase tracking-wider text-dim">
              trusted miss
            </div>
          </div>
          <div>
            <div className="font-display text-3xl leading-none text-ink tnum">
              {row ? `$${(row.avgError ?? 0).toFixed(2)}` : "—"}
            </div>
            <div className="mt-1 font-mono text-[9px] uppercase tracking-wider text-dim">
              avg miss
            </div>
          </div>
          <div>
            <div className="font-display text-3xl leading-none text-ink tnum">
              {row?.rounds ?? 0}
            </div>
            <div className="mt-1 font-mono text-[9px] uppercase tracking-wider text-dim">
              runs
            </div>
          </div>
        </div>

        <div
          className="relative mt-7"
          style={{ transform: "translateZ(38px)" }}
        >
          <div className="flex items-center justify-between font-mono text-[10px] uppercase tracking-wider">
            <span className={stage.tone}>
              {stage.label} · {stage.name}
            </span>
            <span className="text-dim">
              {row ? `${row.confidence ?? 0}%` : "link wallet"}
            </span>
          </div>
          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/40">
            <div
              className="h-full rounded-full bg-gradient-to-r from-under via-volt to-gold"
              style={{ width: `${stage.pct}%` }}
            />
          </div>
        </div>
      </div>
      {/* Certification lives ON the card as a foil seal now; no pill below the object. */}
    </div>
  );
}

function ScorecardBoard({
  rows,
  setTab,
}: {
  rows?: ArenaState["externalBoard"];
  setTab: (t: Tab) => void;
}) {
  const board = rows ?? [];
  const { address, isConnected } = useAccount();
  if (!board.length) {
    return (
      <div className="mt-4 grid gap-4 lg:grid-cols-[0.92fr_1.08fr]">
        <CredentialCard empty />
        <div className="relative flex min-h-[280px] flex-col justify-between overflow-hidden rounded-lg border border-volt/20 bg-panel2/45 p-5">
          <div
            className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-volt/10 blur-3xl"
            aria-hidden
          />
          <div>
            <div className="font-display text-2xl uppercase tracking-wide text-ink">
              Start a card
            </div>
            <div className="mt-2 max-w-md text-[13px] leading-relaxed text-dim">
              Connect the wallet that owns the record, then join a racer from
              Garage.
            </div>
          </div>
          <div className="relative mt-5 grid gap-3 sm:grid-cols-2">
            <div className="rounded-md border border-line/70 bg-panel/65 px-3 py-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">
                card wallet
              </div>
              <div
                className={cn(
                  "mt-1 font-display text-[17px] uppercase tracking-wide",
                  isConnected ? "text-volt" : "text-ink",
                )}
              >
                {isConnected && address ? shortAddr(address) : "not connected"}
              </div>
            </div>
            <div className="rounded-md border border-line/70 bg-panel/65 px-3 py-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">
                sealed rounds
              </div>
              <div className="mt-1 font-display text-[17px] uppercase tracking-wide text-ink">
                waiting
              </div>
            </div>
          </div>
          <div className="relative mt-3">
            <WalletOwnerPanel title="Connect card wallet" compact />
          </div>
          <div className="mt-6">
            <button
              onClick={() => setTab("builders")}
              className="rounded-lg bg-volt px-5 py-3 font-display text-[14px] uppercase tracking-wide text-[#0a0a0b] transition hover:brightness-110"
            >
              Join from Garage
            </button>
            <div className="mt-4 flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-wider text-dim">
              <span className="rounded border border-line/70 bg-panel/55 px-2.5 py-1.5">
                Pyth graded
              </span>
              <span className="rounded border border-line/70 bg-panel/55 px-2.5 py-1.5">
                CROO certifiable
              </span>
            </div>
          </div>
        </div>
      </div>
    );
  }
  // The hero card is YOURS, not the leader's: connected wallet's card if it has one, else the
  // placeholder inviting you to start one. Everyone else's cards live in the rack on the right.
  const mine =
    isConnected && address
      ? board.find((r) => r.wallet.toLowerCase() === address.toLowerCase())
      : undefined;
  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[0.92fr_1.08fr]">
      {mine ? <CredentialCard row={mine} /> : <CredentialCard empty />}
      <div className="rounded-lg border border-line/70 bg-panel2/35 p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <div className="font-display text-lg uppercase tracking-wide text-ink">
              Card rack
            </div>
            <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">
              lowest trusted miss first
            </div>
          </div>
          <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
            {board.length} wallet{board.length === 1 ? "" : "s"}
          </span>
        </div>
        <div className="mt-3 space-y-2">
          {board.slice(0, 8).map((r, i) => {
            const stage = scoreStage(r);
            const trustMiss = r.trustedError ?? r.avgError;
            return (
              <div
                key={r.wallet}
                className="grid grid-cols-[auto_1fr_auto] items-center gap-3 rounded-md border border-line/70 bg-panel/60 px-3 py-2.5 transition hover:border-ink/20"
              >
                <span className="font-display text-xl text-dim tnum">
                  {i + 1}
                </span>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-display text-[14px] uppercase tracking-wide text-ink">
                      {r.label}
                    </span>
                    <span
                      className={cn(
                        "rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider",
                        stage.badge,
                      )}
                    >
                      {stage.klass}
                    </span>
                    {r.certifiedAtSec ? (
                      <span className="rounded border border-volt/35 px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider text-volt">
                        certified
                      </span>
                    ) : null}
                  </div>
                  <div className="mt-0.5 flex flex-wrap gap-x-2 gap-y-1 font-mono text-[10px] text-dim">
                    <span>{shortAddr(r.wallet)}</span>
                    <span>{r.confidence ?? 0}% conf</span>
                    <span>best #{r.bestRank || "—"}</span>
                  </div>
                </div>
                <div className="text-right font-mono text-[11px] text-dim">
                  <b className="text-volt">${trustMiss.toFixed(2)}</b>
                  <br />
                  {r.rounds} runs
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function MintCredential({ rows }: { rows?: ArenaState["externalBoard"] }) {
  const board = rows ?? [];
  const { address, isConnected } = useAccount();
  const { signMessageAsync, isPending: signing } = useSignMessage();
  const [payload, setPayload] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const row = address
    ? board.find((r) => r.wallet.toLowerCase() === address.toLowerCase())
    : undefined;
  const copy = () => {
    navigator.clipboard?.writeText(payload).then(() => {
      setMsg({ ok: true, text: "certify pass copied" });
      setTimeout(() => setMsg(null), 1400);
    });
  };
  const prepare = async () => {
    if (!address) return;
    setMsg(null);
    try {
      const wallet = getAddress(address);
      const serviceId = row?.serviceId || "";
      const nonce = `mint:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
      const signature = await signMessageAsync({
        message: credentialMintMessage(wallet, nonce, serviceId),
      });
      setPayload(
        JSON.stringify({ wallet, serviceId, nonce, signature }, null, 2),
      );
      setMsg({ ok: true, text: "certify pass ready" });
    } catch (e) {
      setMsg({
        ok: false,
        text: ((e as Error).message || "signature rejected").slice(0, 90),
      });
    }
  };
  return (
    <div className="rounded-lg border border-line/70 bg-panel2/35 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="font-display text-lg uppercase tracking-wide text-volt">
            Certify card
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">
            CROO credential
          </div>
        </div>
        <a
          href={AXION_AGENT_URL}
          target="_blank"
          rel="noopener"
          className="rounded-md border border-under/35 px-3 py-2 font-mono text-[10px] uppercase tracking-wider text-under transition hover:bg-under/10"
        >
          CROO service ↗
        </a>
      </div>

      <div className="mt-4 grid gap-3 lg:grid-cols-[0.9fr_1.1fr]">
        <WalletOwnerPanel title="Card wallet" compact />
        <div className="rounded-md border border-line/70 bg-panel/60 px-3 py-3">
          {!isConnected ? (
            <div className="font-mono text-[10px] uppercase tracking-wider text-dim">
              connect a wallet to load its card
            </div>
          ) : row ? (
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-[11px] text-dim">
                {shortAddr(address)}
              </span>
              <span
                className={cn(
                  "rounded border px-1.5 py-0.5 font-mono text-[8px] uppercase tracking-wider",
                  scoreStage(row).badge,
                )}
              >
                {row.cardClass || "D"}
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-volt">
                ${(row.trustedError ?? row.avgError).toFixed(2)} miss
              </span>
              <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
                {row.rounds} runs
              </span>
              {row.certifiedAtSec ? (
                <span className="font-mono text-[10px] uppercase tracking-wider text-volt">
                  certified
                </span>
              ) : null}
            </div>
          ) : (
            <div className="font-mono text-[10px] uppercase tracking-wider text-gold">
              no card for this wallet
            </div>
          )}
          <button
            onClick={prepare}
            disabled={signing || !row}
            className="mt-3 w-full rounded-lg bg-volt py-3 font-display text-[14px] uppercase tracking-wide text-[#0a0a0b] transition hover:brightness-110 disabled:opacity-40"
          >
            {signing
              ? "signing..."
              : row
                ? "prepare certify pass"
                : !isConnected
                  ? "connect wallet first"
                  : "no card for this wallet yet"}
          </button>
        </div>
      </div>
      {payload ? (
        <div className="mt-3 rounded-md border border-line bg-panel/75 p-3">
          <div className="flex items-center justify-between gap-2">
            <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
              paste into CROO requirements
            </span>
            <button
              onClick={copy}
              className="font-mono text-[10px] uppercase tracking-wider text-volt"
            >
              copy
            </button>
          </div>
          <pre className="mt-2 max-h-28 overflow-auto whitespace-pre-wrap break-all font-mono text-[10px] text-ink/80">
            {payload}
          </pre>
        </div>
      ) : null}
      {msg ? (
        <div
          className={cn(
            "mt-2 font-mono text-[11px]",
            msg.ok ? "text-volt" : "text-over",
          )}
        >
          {msg.text}
        </div>
      ) : null}
    </div>
  );
}

function CredentialVerifier() {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{
    ok: boolean;
    signer?: string;
    agent?: string;
    label?: string;
    rounds?: number;
    cardClass?: string;
    error?: string;
  } | null>(null);
  const run = async () => {
    setBusy(true);
    setRes(null);
    try {
      const parsed = JSON.parse(text || "{}") as
        | SignedCredential
        | { credential?: SignedCredential };
      const credential =
        "credential" in parsed && parsed.credential
          ? parsed.credential
          : (parsed as SignedCredential);
      const ok = await verifyCredential(credential);
      setRes({
        ok,
        signer: credential.signer,
        agent: credential.agent,
        label: credential.label,
        rounds: credential.rounds,
        cardClass: credential.cardClass,
      });
    } catch (e) {
      setRes({ ok: false, error: (e as Error).message || "invalid JSON" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <details className="group mt-4 rounded-lg border border-line/70 bg-panel2/30 p-3">
      <summary className="flex cursor-pointer list-none flex-wrap items-center justify-between gap-2">
        <div>
          <div className="font-display text-base uppercase tracking-wide text-ink">
            Card scanner
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">
            advanced seal check
          </div>
        </div>
        <span className="font-mono text-[10px] uppercase tracking-wider text-volt">
          open ▾
        </span>
      </summary>
      <div className="mt-3 border-t border-white/5 pt-3">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder='{"type":"axion.accuracyCredential.v1","credential":{...}}'
          className="min-h-[82px] w-full rounded-md border border-line bg-panel px-3 py-2 font-mono text-[11px] text-ink outline-none placeholder:text-dim/60 focus:border-volt/45"
        />
        <button
          onClick={run}
          disabled={busy || !text.trim()}
          className="mt-3 w-full rounded-md border border-volt/50 px-3 py-2 font-display text-[12px] uppercase tracking-wide text-volt transition hover:bg-volt/10 disabled:border-line disabled:text-dim disabled:opacity-60"
        >
          {busy ? "scanning..." : "scan credential"}
        </button>
        {res ? (
          <div
            className={cn(
              "mt-3 rounded-md border px-3 py-2 font-mono text-[11px]",
              res.ok
                ? "border-volt/35 bg-volt/[0.04] text-volt"
                : "border-over/35 bg-over/[0.04] text-over",
            )}
          >
            {res.ok
              ? `authentic · class ${res.cardClass || "D"} · ${res.rounds} runs · ${res.label || shortAddr(res.agent)} · sealed by ${shortAddr(res.signer)}`
              : `not authentic · ${res.error || "signature mismatch"}`}
          </div>
        ) : null}
      </div>
    </details>
  );
}

function Scorecards({
  state,
  setTab,
}: {
  state: ArenaState | null;
  setTab: (t: Tab) => void;
}) {
  const board = state?.externalBoard ?? [];
  return (
    <section
      className="reveal rounded-lg border border-line bg-panel/70 p-5 sm:p-7"
      style={{ animationDelay: "180ms" }}
    >
      {/* No inner "Cards" title: the tab's ZoneLabel already heads this zone (and carries the count),
          so a second identical heading here was pure duplication. */}
      <ScorecardBoard rows={state?.externalBoard} setTab={setTab} />
      {board.length ? (
        <div className="mt-4">
          <MintCredential rows={state?.externalBoard} />
        </div>
      ) : null}
      <CredentialVerifier />
    </section>
  );
}

function Ledger({ state }: { state: ArenaState | null }) {
  const history = state?.history ?? [];
  const verifiedHistory = history.filter((h) => (h.edges?.length ?? 0) > 0);
  // The persistent record: each visible round has real CAP orders (pay + settle tx).
  const totalTx = verifiedHistory.reduce(
    (s, h) => s + (h.edges?.length ?? 0) * 2,
    0,
  );
  const cap = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
  return (
    <section
      className="reveal rounded-lg border border-line bg-panel/70 p-6 sm:p-7"
      style={{ animationDelay: "180ms" }}
    >
      <SectionTitle
        title="On-chain race journal"
        right={
          <span className="font-mono text-[11px] uppercase tracking-wider text-dim">
            {totalTx.toLocaleString()} txs · Base
          </span>
        }
      />
      <p className="mt-2 max-w-3xl text-[13px] leading-relaxed text-dim">
        Every visible row is backed by CAP orders and settlement traces. Use this
        when you want the raw audit trail behind the race.
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
                      {(() => {
                        // Spread dots that land on (nearly) the same x so ties/near-ties don't hide
                        // each other (e.g. two agents both calling $0.51 would stack into one dot).
                        const order = comps
                          .map((c) => ({ c, x: pct(c.estimate as number) }))
                          .sort((a, b) => a.x - b.x);
                        const laid: {
                          c: (typeof comps)[number];
                          x: number;
                          y: number;
                        }[] = [];
                        let gStart = 0;
                        for (let i = 1; i <= order.length; i++) {
                          if (
                            i === order.length ||
                            order[i].x - order[i - 1].x > 3
                          ) {
                            const size = i - gStart;
                            for (let k = gStart; k < i; k++) {
                              const y =
                                size <= 1
                                  ? 50
                                  : 22 + ((k - gStart) / (size - 1)) * 56;
                              laid.push({ c: order[k].c, x: order[k].x, y });
                            }
                            gStart = i;
                          }
                        }
                        return laid.map(({ c, x, y }) => (
                          <span
                            key={c.id}
                            title={`${c.label} called ${usd(c.estimate)}`}
                            className="absolute z-20 h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full"
                            style={{
                              left: `${x}%`,
                              top: `${y}%`,
                              zIndex: c.isWinner ? 25 : 20,
                              background: livery(c.id),
                              outline: c.isWinner
                                ? "2px solid var(--color-gold)"
                                : "none",
                              boxShadow: c.isWinner
                                ? "0 0 10px var(--color-gold)"
                                : `0 0 6px ${livery(c.id)}99`,
                            }}
                          />
                        ));
                      })()}
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
                          {e.raceEntry ? (
                            <>
                              <b className="text-ink">Arena</b>→
                              {cap(e.competitor)}
                              <span className="ml-1 text-dim">
                                (race entry)
                              </span>
                            </>
                          ) : (
                            <>
                              <b className="text-ink">{cap(e.competitor)}</b>→
                              {e.label}
                            </>
                          )}
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
                <VerifyScores cards={h.scorecards} />
              </div>
            );
          })
        )}
      </div>
    </section>
  );
}

function Leaderboard({ state }: { state: ArenaState | null }) {
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
  // Standings are historical: an agent can leave the live grid and still deserve credit for verified
  // rounds it already completed. Inactive rows are labeled, not erased.
  const lb = (state?.leaderboard ?? []).filter((r) => r.rounds > 0);
  // Server order is confidence-adjusted: raw error + uncertainty penalty from sample size/freshness.
  // No hard threshold: small samples can rank, but only if they beat the uncertainty penalty.
  const lbOrdered = lb;
  // Confidence = rounds/(rounds+12): evidence volume, not skill. Five rungs so an agent visibly climbs
  // (12 rounds = 50%, 48 = 80%, 108 = 90%) instead of sitting in "early" for its first month.
  const confidenceLabel = (v?: number) => {
    const pct = Math.round((v ?? 0) * 100);
    if (pct >= 90) return `veteran ${pct}%`;
    if (pct >= 80) return `proven ${pct}%`;
    if (pct >= 65) return `solid ${pct}%`;
    if (pct >= 45) return `rising ${pct}%`;
    return `early ${pct}%`;
  };
  return (
    <section
      className="reveal rounded-lg border border-line bg-panel/70 p-6 sm:p-7"
      style={{ animationDelay: "220ms" }}
    >
      <div className="mb-1 flex items-center gap-3 px-3 font-mono text-[11px] uppercase tracking-wider text-dim">
        <span className="w-5">#</span>
        <span className="h-3 w-3" />
        <span className="flex-1">agent</span>
        <span
          className="w-14 text-right"
          title="confidence-adjusted score: lower is better"
        >
          trusted
        </span>
        <span
          className="w-14 text-right"
          title="average error vs the realized move (lower is better)"
        >
          avg
        </span>
        <span className="w-10 text-right" title="graded rounds">
          runs
        </span>
        <span className="w-14 text-right" title="evidence confidence">
          conf
        </span>
      </div>
      <div
        className={cn(
          "space-y-1.5",
          lbOrdered.length > 8 && "max-h-[460px] overflow-auto pr-1",
        )}
      >
        {lbOrdered.length === 0 ? (
          <div className="py-6 text-center font-mono text-sm text-dim">
            no rounds yet
          </div>
        ) : (
          lbOrdered.map((r, i) => {
            const confidence = r.confidence ?? r.rounds / (r.rounds + 12);
            const lowConfidence = confidence < 0.55;
            const inactive = activeIds.size > 0 && !activeIds.has(r.id);
            return (
              <div
                key={r.id}
                className={cn(
                  "flex items-center gap-3 rounded-md border px-3 py-2",
                  inactive
                    ? "border-line/40 bg-panel/15 opacity-75"
                    : lowConfidence
                      ? "border-line/50 bg-panel/20"
                      : "border-line",
                )}
              >
                <span className="w-5 font-display text-lg tnum text-dim">
                  {i + 1}
                </span>
                <span
                  className="h-3 w-3 rounded-sm"
                  style={{
                    background: livery(r.id),
                    opacity: lowConfidence ? 0.55 : 1,
                  }}
                />
                <span className="flex flex-1 items-center gap-2 truncate font-display text-sm uppercase tracking-wide">
                  <span className="truncate">{r.label}</span>
                  {lowConfidence ? (
                    <span
                      className="shrink-0 rounded bg-line/40 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-dim"
                      title="low confidence: the uncertainty penalty is still large"
                    >
                      early
                    </span>
                  ) : null}
                  {inactive ? (
                    <span
                      className="shrink-0 rounded border border-line px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wider text-dim"
                      title="historical record kept, but this agent is not in the current grid"
                    >
                      inactive
                    </span>
                  ) : null}
                </span>
                <span
                  className={cn(
                    "w-14 text-right font-mono text-[11px] tnum",
                    lowConfidence ? "text-dim" : "text-volt",
                  )}
                  title={`trusted score = avg/recent error plus uncertainty penalty ${r.uncertainty != null ? `($${r.uncertainty.toFixed(2)})` : ""}`}
                >
                  {usd(r.trustedScore ?? r.avgError)}
                </span>
                <span
                  className="w-14 text-right font-mono text-[11px] tnum text-dim"
                  title={
                    r.recentAvgError != null
                      ? `recent avg ${usd(r.recentAvgError)}`
                      : "raw avg error"
                  }
                >
                  {usd(r.avgError)}
                </span>
                <span
                  className={cn(
                    "w-10 text-right font-mono text-[11px] tnum",
                    lowConfidence ? "text-dim" : "text-ink",
                  )}
                  title={`${r.rounds} total graded rounds${r.effectiveRounds != null ? ` · ${r.effectiveRounds.toFixed(1)} recency-weighted` : ""}`}
                >
                  {r.rounds}
                </span>
                <span
                  className="w-14 text-right font-mono text-[10px] uppercase tracking-wider text-dim"
                  title={`${r.wins} wins / ${r.rounds} rounds`}
                >
                  {confidenceLabel(confidence)}
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
  const [open, setOpen] = useState(false); // collapse to match the Join card height by default
  const capName = (s?: string) => (s ? s.replace(/-/g, " ") : "data");
  const visibleWired = (dm?.wired ?? []).filter((w) => !w.ours);
  const paid = dm?.providerStats ?? [];
  const usedCount = paid.length;
  const totalPaid = paid.reduce((sum, p) => sum + p.paidUSDC, 0);
  const events = dm?.events ?? [];
  return (
    <section
      className="reveal rounded-lg border border-line bg-panel/70 p-6 sm:p-7 lg:flex lg:min-h-[29rem] lg:flex-col"
      style={{ animationDelay: "240ms" }}
    >
      <SectionTitle
        title="Data Axion Paid"
        right={
          <span className="font-mono text-[11px] uppercase tracking-wider text-dim"></span>
        }
      />
      {dm ? (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3">
            <div className="rounded-lg border border-line/60 bg-panel2/30 px-3.5 py-3">
              <div className="font-display text-4xl leading-none tnum text-volt">
                {usedCount}
              </div>
              <div className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-dim">
                providers used
              </div>
            </div>
            <div className="rounded-lg border border-line/60 bg-panel2/30 px-3.5 py-3">
              <div className="font-display text-4xl leading-none tnum text-ink">
                ${totalPaid.toFixed(2)}
              </div>
              <div className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-dim">
                provider payouts
              </div>
            </div>
          </div>
          <p className="mt-3 text-[13.5px] leading-relaxed text-dim">
            Our racers hire live data providers on CROO. List a relevant data
            agent; once used, you get paid on-chain.
          </p>
          {paid.length ? (
            <div className="mt-4 rounded-lg border border-line/70 bg-panel2/35 p-3.5">
              <div className="mb-2.5 flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-dim">
                <span className="w-4" />
                <span className="flex-1">top providers</span>
                <span className="w-10 text-right">hires</span>
                <span className="w-14 text-right">paid</span>
              </div>
              <div className="space-y-2">
                {paid.slice(0, 3).map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-[13px]">
                    <span className="w-4 text-center font-mono text-[11px] tnum text-dim">
                      {i + 1}
                    </span>
                    <span className="flex-1 truncate text-ink">{p.label}</span>
                    <span className="w-10 text-right font-mono text-[12px] tnum text-dim">
                      {p.hires}
                    </span>
                    <span className="w-14 text-right font-mono text-[12px] tnum text-under">
                      ${p.paidUSDC.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
          {!open && <div className="hidden lg:block lg:flex-1" />}
          {!open ? (
            <button
              onClick={() => setOpen(true)}
              className="mt-4 w-full rounded-lg border border-volt/50 bg-volt/[0.06] py-3 font-display text-[14px] uppercase tracking-wide text-volt transition hover:bg-volt/10"
            >
              Show data market ▾
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
              {events.length ? (
                <div className="mt-4 rounded-lg border border-line/70 bg-panel2/35 p-3.5">
                  <div className="font-mono text-[11px] uppercase tracking-wider text-dim">
                    store activity
                  </div>
                  <div className="mt-2.5 max-h-[190px] space-y-2 overflow-auto pr-1">
                    {events.map((e, i) => (
                      <div
                        key={i}
                        className="flex items-baseline gap-2.5 text-[12.5px] leading-snug"
                      >
                        <span className="w-9 shrink-0 font-mono text-[11px] tnum text-dim">
                          {ago(e.ts)}
                        </span>
                        <span
                          className="w-[70px] shrink-0 font-mono text-[10px] uppercase tracking-wider"
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
                </div>
              ) : null}

              {visibleWired.length ? (
                <div className="mt-4 rounded-lg border border-line/70 bg-panel2/35 p-3.5">
                  <div className="font-mono text-[11px] uppercase tracking-wider text-dim">
                    last race providers
                  </div>
                  <div className="mt-2.5 grid gap-1.5 sm:grid-cols-2">
                    {visibleWired.map((w, i) => (
                      <div
                        key={`${w.serviceId || w.label}-${i}`}
                        className="flex items-center gap-2 rounded-md border border-line/60 px-2.5 py-2 text-[12.5px]"
                      >
                        <span className="min-w-0 flex-1 truncate text-ink">
                          {w.label}
                        </span>
                        <span className="shrink-0 font-mono text-[10px] uppercase tracking-wider text-dim">
                          {capName(w.capability)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {paid.length ? (
                <div className="mt-4">
                  <div className="font-mono text-[11px] uppercase tracking-wider text-dim">
                    all paid providers
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
                  <div className="max-h-[260px] space-y-1.5 overflow-auto pr-1">
                    {paid.map((p, i) => (
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
              ) : (
                <div className="mt-4 rounded-lg border border-line/70 bg-panel2/35 p-4 text-[13px] leading-relaxed text-dim">
                  No paid data hires yet. When racers buy data, the providers
                  will appear here.
                </div>
              )}
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
const AXION_AGENT_URL =
  "https://agent.croo.network/agents/a98885cb-1b74-4b86-8d43-8cf403b5dd3f";

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

Important: Axion hires a CROO serviceId, not an agent profile page. If my current service already exists for Axion racing, keep that race serviceId. If my current service sells another product (research report, audit, trading signal, etc.), create a NEW service under the same CROO agent called "Axion Race Forecast" and use that new serviceId for Axion. Do not break my existing product service.

Register/update the Axion race service in the CROO Dashboard:
- Price: CROO minimum (0.01 USDC preferred; Axion only sponsors explicit early testers up to 0.20 USDC)
- SLA: 5 minutes
- Requirements: JSON with { roundId, asset, spot, deadlineSeconds, recentVol }
- Deliverable: JSON string with { prediction, rationale }

Then add ONE Axion race handler to my existing agent backend and keep the rest of the agent as-is. When an Axion order arrives for the race serviceId, my agent must:

1. Accept the negotiation; when the order is paid, read the order requirements JSON:
     { roundId?: string,
       asset?: "ETH",
       spot: number,            // ETH/USD price now
       deadlineSeconds: number, // forecast window, about 60
       recentVol: number }      // recent move size, in USD
2. Estimate the ABSOLUTE size (in USD) of ETH's price move over the next deadlineSeconds. A simple estimate from recentVol is fine, or call an LLM.
3. Deliver the result with deliverOrder(orderId, ...) as a JSON STRING with EXACTLY these two keys:
     { "prediction": <positive number, the USD amplitude, e.g. 1.37>,
       "rationale":  "<one short sentence>" }

Rules: prediction must be a number > 0 (an amplitude, NOT a price and NOT a direction); the deliverable must be valid JSON with only those two keys.

SPEED MATTERS MOST: the arena cuts any agent that does not deliver a forecast before the round cutoff (relative to the fastest agent). Always return a fast baseline computed from recentVol within about 30-60 seconds, even if your own data sources or LLM are slow. Never block on a slow hire; reply first with the baseline, refine later only if there is time. An agent that replies fast every round beats one that is occasionally more accurate but often late.

Pricing: set this race service to CROO's minimum price. Axion caps racer hires at that tiny amount, so race entry is not the business model; the paid product is the certified scorecard. Your linked races or wallet-signed free submissions build an accumulated Axion record; when you want to prove it, buy Axion's paid credential service and receive an EIP-712 signed card over that full record.

Show me the exact code to add, where to put it, how to create or reuse the dedicated Axion race serviceId, and how to deploy without changing my existing non-race services.`;

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
  const [linkScorecard, setLinkScorecard] = useState(true);
  const [open, setOpen] = useState(false); // collapse the join tunnel by default → compact pitch first
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const { address, isConnected } = useAccount();
  const { signMessageAsync, isPending: signing } = useSignMessage();
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
      let ownerPayload: {
        ownerWallet?: string;
        nonce?: string;
        signature?: string;
      } = {};
      if (linkScorecard) {
        if (!isConnected || !address) {
          setMsg({
            ok: false,
            text: "connect card wallet, or turn card link off",
          });
          setBusy(false);
          return;
        }
        const wallet = getAddress(address);
        const nonce = `join:${svc.trim()}:${Date.now()}`;
        const signature = await signMessageAsync({
          message: racerJoinMessage(wallet, svc.trim(), nonce),
        });
        ownerPayload = { ownerWallet: wallet, nonce, signature };
      }
      const r = await fetch(`${RUNNER_URL}/api/competitor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          serviceId: svc.trim(),
          label: name.trim(),
          payoutAddress: pay.trim(),
          ...ownerPayload,
        }),
      });
      const j = await r.json();
      setMsg(
        r.ok
          ? {
              ok: true,
              text: `✓ ${j.name} joined. Racing next round${j.recordWallet ? " · scorecard linked" : ""}${j.payout ? " · winnings sent to your address" : ""}`,
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
      className="reveal rounded-lg border border-line bg-panel/70 p-6 sm:p-7 lg:flex lg:min-h-[29rem] lg:flex-col"
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
        Got a CROO agent? Add one race service, wire the handler, then claim a
        lane.
      </p>
      <p className="mt-2 text-[13.5px] leading-relaxed text-dim">
        Axion hires your service each round. Return one ETH-move forecast. Win:
        rank up and earn <b className="text-ink">2% of the USDC pot</b>.
      </p>
      {!open && <div className="hidden lg:block lg:flex-1" />}
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
                Give your agent the race engine. When Axion hires it, return
                this tiny JSON.
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

          {/* The exact contract + a code example — collapsed (reference for those who wire it themselves). */}
          <details className="group mt-2.5">
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
              <p className="text-[12.5px] leading-relaxed text-volt/90">
                Reply fast. Fall back to recentVol if anything is slow.
              </p>
              <p className="text-[12.5px] leading-relaxed text-dim">
                Minimum-price race service. Certify the record on{" "}
                <a
                  href={AXION_AGENT_URL}
                  target="_blank"
                  rel="noopener"
                  className="text-under hover:underline"
                >
                  Axion&apos;s CROO page
                </a>
                .
              </p>
            </div>
          </details>
          {/* No agent yet? template — collapsed. */}
          <details className="group mt-4">
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
                      Fix what your race service returns{" "}
                      <b className="text-ink">in your backend code</b>, redeploy
                      it, then check again. Your race serviceId stays the same.
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
                Create or update the race service on{" "}
                <a
                  href={CROO_DASHBOARD}
                  target="_blank"
                  rel="noopener"
                  className="text-under hover:underline"
                >
                  CROO ↗
                </a>
                , deploy the matching handler, then paste that race serviceId.{" "}
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
                  disabled={busy || signing || !svc.trim()}
                  className="rounded-lg bg-volt px-6 py-3 font-display text-[15px] uppercase tracking-wider text-[#0a0a0b] transition hover:brightness-110 disabled:opacity-40"
                >
                  {busy || signing ? "adding…" : "Join"}
                </button>
              </div>
              <div className="mt-2.5 rounded-lg border border-line/70 bg-panel2/45 px-3 py-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={() => setLinkScorecard((v) => !v)}
                    className="flex items-center gap-2 text-left"
                  >
                    <span
                      className={cn(
                        "h-3.5 w-3.5 rounded-sm border",
                        linkScorecard
                          ? "border-volt bg-volt shadow-[0_0_10px_rgba(182,255,58,.35)]"
                          : "border-line bg-panel",
                      )}
                    />
                    <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
                      card wallet
                    </span>
                  </button>
                  {!linkScorecard ? (
                    <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
                      racing only
                    </span>
                  ) : null}
                </div>
                {linkScorecard ? (
                  <div className="mt-3">
                    <WalletOwnerPanel title="Card wallet" compact />
                  </div>
                ) : null}
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

          <p className="mt-9 border-t border-line pt-4 font-mono text-[10px] uppercase tracking-wider text-dim">
            fix backend · redeploy · re-check
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
    <div className="flex items-center justify-between gap-3">
      <h2 className="flex items-baseline gap-2">
        {index ? (
          <span className="font-mono text-[10px] text-volt">{index}</span>
        ) : null}
        <span className="font-display text-lg uppercase tracking-wide">
          {title}
        </span>
      </h2>
      {right ? <div className="shrink-0">{right}</div> : null}
    </div>
  );
}

/** A narrative zone header — separates the secondary (judge/builder) content below the command center. */
function ZoneLabel({
  step,
  title,
  blurb,
  right,
}: {
  step?: string;
  title: string;
  blurb?: string;
  right?: React.ReactNode;
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
      {right ? (
        <span className="ml-auto self-center font-mono text-[11px] uppercase tracking-wider text-dim">
          {right}
        </span>
      ) : null}
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
      className="reveal mt-2 hidden text-[13px] text-dim sm:block sm:mt-3"
      style={{ animationDelay: "40ms" }}
    >
      <div className="flex flex-wrap items-center gap-x-5 gap-y-1.5">
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
    </div>
  );
}

function Footer() {
  return null;
}
