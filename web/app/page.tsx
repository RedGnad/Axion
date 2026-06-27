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
    <main className="mx-auto max-w-[1180px] px-5 pb-24 pt-6">
      <Intro open={intro} setTab={setTab} onClose={closeIntro} />
      <Header state={state} online={online} onHelp={() => setIntro(true)} />
      <Tabs tab={tab} setTab={setTab} />
      <Notice state={state} />

      {tab === "play" && (
        <>
          <HowItWorks />
          {/* ── COMMAND CENTER — everything live, above the fold (2026 real-time UX) ── */}
          <section
            className="reveal mt-4 overflow-hidden rounded-2xl border border-line bg-panel/70"
            style={{ animationDelay: "80ms" }}
          >
            <div className="grid gap-px bg-line sm:grid-cols-[1.05fr_1fr]">
              <div className="bg-panel px-5 py-5">
                <Telemetry state={state} />
              </div>
              <div className="bg-panel px-5 py-5">
                <RaceControl state={state} online={online} />
              </div>
            </div>
            <div className="border-t border-line px-5 py-5">
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
            </div>
            <EstimatingMarquee state={state} />
            <div className="border-t border-volt/20 bg-volt/[0.02] px-5 py-5">
              <ToteBoard state={state} />
            </div>
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
          <div className="grid gap-5 lg:grid-cols-2">
            <Join />
            <DataMarket state={state} />
          </div>
        </>
      )}

      {tab === "proof" && (
        <>
          <ZoneLabel
            title="Journal"
            blurb="every hire, bet & payout is a real tx on Base — verify any of them"
          />
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
  return (
    <div
      className="reveal mt-4 flex items-start gap-2.5 rounded-lg border px-4 py-3"
      style={{ borderColor: "color-mix(in srgb, var(--color-over) 45%, transparent)", background: "color-mix(in srgb, var(--color-over) 8%, transparent)" }}
    >
      <span className="mt-px font-mono text-[12px] font-bold" style={{ color: "var(--color-over)" }}>!</span>
      <span className="font-mono text-[11px] leading-relaxed text-ink/85">{n.text}</span>
    </div>
  );
}

/** First-run intent split (Figma-style "where do I start"): one tap routes a visitor to watch/bet or
 *  to bringing an agent, so nobody lands on a dense dashboard confused. Shown once; re-openable. */
function Intro({ open, setTab, onClose }: { open: boolean; setTab: (t: Tab) => void; onClose: () => void }) {
  if (!open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 px-5 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="reveal relative w-full max-w-lg overflow-hidden rounded-2xl border border-volt/30 bg-panel shadow-[0_0_60px_rgba(182,255,58,.12)]"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          onClick={onClose}
          className="absolute right-4 top-4 font-mono text-[10px] uppercase tracking-wider text-dim transition hover:text-ink"
        >
          skip ✕
        </button>
        <div className="px-7 pb-5 pt-9 text-center">
          <div className="font-display text-3xl uppercase tracking-[0.04em]">
            Axion <span className="text-volt">Clash</span>
          </div>
          <p className="mx-auto mt-3 max-w-md text-[13px] leading-relaxed text-dim">
            AI agents race to call the size of ETH&apos;s next move. They hire real data agents on-chain
            to decide, and you back the sharpest. Settled by the Pyth oracle, so nobody can rig it.
          </p>
          <p className="mt-3 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
            what brings you here?
          </p>
        </div>
        <div className="grid gap-px bg-line sm:grid-cols-2">
          <button
            onClick={() => { setTab("play"); onClose(); }}
            className="group bg-panel px-6 py-7 text-left transition hover:bg-volt/[0.05]"
          >
            <span className="block h-3 w-3 rounded-sm" style={{ background: "var(--color-volt)" }} />
            <div className="mt-3 font-display text-lg uppercase tracking-wide text-volt">Watch &amp; bet</div>
            <div className="mt-1.5 font-mono text-[11px] leading-relaxed text-dim">
              Pick the agent you think wins. Free, no wallet. Add USDC if you want skin in the game.
            </div>
            <div className="mt-3 font-mono text-[10px] uppercase tracking-wider text-volt opacity-60 transition group-hover:opacity-100">
              tap an agent, you&apos;re in ▸
            </div>
          </button>
          <button
            onClick={() => { setTab("builders"); onClose(); }}
            className="group bg-panel px-6 py-7 text-left transition hover:bg-volt/[0.05]"
          >
            <span className="block h-3 w-3 rounded-sm" style={{ background: "#d4d4d8" }} />
            <div className="mt-3 font-display text-lg uppercase tracking-wide text-ink">Bring your agent</div>
            <div className="mt-1.5 font-mono text-[11px] leading-relaxed text-dim">
              Race any CAP agent: hired in USDC every round, ranked on-chain. See a forecast run in
              under 5 min, no keys needed.
            </div>
            <div className="mt-3 font-mono text-[10px] uppercase tracking-wider text-ink opacity-60 transition group-hover:opacity-100">
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
        <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
          AI agents clash to call ETH&apos;s next move. You back the winner.
        </p>
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
        <div className="font-mono text-[10px] uppercase tracking-[0.25em] text-dim">
          ETH / USD · live · Pyth
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
      className="rounded-md border px-2.5 py-1 font-mono text-[10px] uppercase tracking-wider tnum"
      style={{
        borderColor: "color-mix(in srgb, var(--color-volt) 50%, transparent)",
        color: "var(--color-volt)",
      }}
    >
      {label} {usd(val)}
    </span>
  );
}

/** Small phase tag for the section header (the big countdown lives in RaceControl). */
function PhaseTag({
  state,
  online,
}: {
  state: ArenaState | null;
  online: boolean;
}) {
  const r = state?.round;
  const active = state?.status === "running" && r && r.phase !== "settled";
  const text = !online
    ? "offline"
    : !active
      ? "between races"
      : r!.phase === "betting"
        ? "race live"
        : "estimating";
  const col = !online
    ? "var(--color-over)"
    : active
      ? "var(--color-volt)"
      : "var(--color-dim)";
  return (
    <span
      className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider"
      style={{ color: col }}
    >
      <span
        className="h-1.5 w-1.5 rounded-full"
        style={{
          background: col,
          animation: active ? "pulse-dot 1.3s infinite" : "none",
        }}
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
      if (j.started) setStartMsg("✓ race starting — agents hiring data…");
      else if (j.reason) setStartMsg(j.reason);
      else if (j.nextAtMs)
        setStartMsg(
          `next race in ${Math.max(0, Math.round((j.nextAtMs - Date.now()) / 1000))}s`,
        );
      else setStartMsg(j.error || "a race is already running…");
    } catch {
      setStartMsg("arena was asleep — waking it, try again in ~20s");
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
    note = "runner unreachable — retrying every 2s";
  } else if (justSettled && r) {
    // Win flash (a few seconds) right after the race, before the next-race countdown resumes.
    const w = r.competitors.find((c) => c.isWinner);
    showStart = false;
    kicker = "WINNER";
    big = `🏆 ${w?.label ?? "—"}`;
    note =
      r.amplitude != null && r.line != null
        ? `called the move best — $${r.amplitude.toFixed(2)} vs line $${r.line.toFixed(2)}`
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
      note = "odds drop as the move reveals. back an agent below.";
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
      note =
        r.competitors.length > 4
          ? `${r.competitors.filter((c) => c.estimate != null).length}/${r.competitors.length} agents in · sourcing data on-chain`
          : r.competitors.map((c) => `${c.label} ${c.estimate != null ? "✓" : "⏳"}`).join("  ·  ");
    }
  } else {
    // Idle / between races — the grid below shows the LAST race result (not a live race).
    const delta = nextAt ? nextAt - now : 0;
    const w = r?.competitors.find((c) => c.isWinner);
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
        ? "today's free races are used up — back at UTC midnight"
        : `${w ? `last race won by ${w.label}` : "one tap runs a real on-chain race"}${budLeft != null ? ` · ${budLeft} free races left today` : ""}`);
  }

  return (
    <div className="flex h-full flex-wrap items-center justify-between gap-4">
      <div key={kicker} className="swapin min-w-0 flex-1">
        <div className="font-mono text-[10px] uppercase tracking-[0.28em] text-dim">
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
              <div className="font-mono text-[9px] uppercase tracking-wider text-dim">
                {secondary.label}
              </div>
              <div className="font-display text-2xl leading-none tnum text-ink">
                {secondary.value}
              </div>
            </div>
          ) : null}
        </div>
        {note ? (
          <div className="mt-1.5 font-mono text-[11px] text-dim">{note}</div>
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
          className="shrink-0 rounded-lg bg-volt px-7 py-4 font-display text-base uppercase tracking-wider text-[#0a0a0b] shadow-[0_0_24px_rgba(182,255,58,.25)] transition hover:brightness-110 disabled:opacity-50"
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
      setRec(JSON.parse(localStorage.getItem("axion_predict") || '{"c":0,"t":0}'));
    } catch {}
  }, []);

  const live = r?.phase === "open" || r?.phase === "betting"; // current race accepts predictions
  const roster = state?.roster ?? [];
  const idlePickable = !live && roster.length > 0; // between races → predict the NEXT race
  const cards: { id: string; label: string; estimate?: number; isWinner?: boolean; dq?: boolean }[] =
    live ? comps : roster.map((a) => ({ id: a.id, label: a.label }));

  // Expand data (the old "racers" content): rationale/latency from the round (live or last settled),
  // hires from the matching settled record. Honest: "this race" only when the shown round is in history.
  const cap = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
  const thisRound = history.find((h) => h.id === r?.id);
  const hiresSrc = thisRound ?? history[0];
  const hiresLabel = thisRound ? "paid this race" : history[0] ? "paid last race" : "";
  const detail = (id: string) => comps.find((x) => x.id === id);

  useEffect(() => {
    if (!r || r.phase !== "settled" || !pick || pick.resolved) return;
    const applies = pick.round === r.id || (pick.round === "next" && r.id !== pick.afterRound);
    if (!applies) return;
    const won = (r.competitors ?? []).some((c) => c.id === pick.agentId && c.isWinner);
    const next = { c: rec.c + (won ? 1 : 0), t: rec.t + 1 };
    setRec(next);
    try {
      localStorage.setItem("axion_predict", JSON.stringify(next));
    } catch {}
    setPick({ ...pick, resolved: true, correct: won });
  }, [r?.phase, r?.id, pick, rec]);

  const active = !!pick && !pick.resolved && (pick.round === "next" || (!!r && pick.round === r.id));
  const choose = (agentId: string) => {
    if (pick?.committed || pick?.resolved) return; // locked once you bet real money / race is over
    if (active && pick!.agentId === agentId) { setPick(null); void cancelPredict(); return; } // tap again = cancel
    if (live && r) { setPick({ round: r.id, agentId }); void postPredict(agentId); } // pick or change
    else if (idlePickable) { setPick({ round: "next", agentId, afterRound: r?.id }); void postPredict(agentId); }
  };
  const ps = state?.predictStats;
  const myLabel = active ? (cards.find((c) => c.id === pick!.agentId)?.label ?? pick!.agentId) : "";

  return (
    <div>
      {/* Free no-wallet on-ramp; USDC is an optional upgrade on the SAME pick (one decision). */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-volt/30 bg-volt/[0.04] px-4 py-3">
        <div>
          <div className="font-display text-lg uppercase tracking-wide text-volt">Back the winner. Free.</div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">
            no wallet · no signup ·{" "}
            {live ? <b className="text-ink">betting open now</b> : idlePickable ? <b className="text-ink">pick the next race&apos;s winner</b> : "one tap when a race is live"}
          </div>
        </div>
        {ps && ps.total > 0 ? (
          <div className="text-right font-mono text-[11px] text-dim">
            <b className="text-ink tnum">{ps.total.toLocaleString()}</b> picks ·{" "}
            <b className="text-ink tnum">{ps.visitors.toLocaleString()}</b> visitors ·{" "}
            <b className="text-volt tnum">{ps.total ? Math.round((100 * ps.correct) / ps.total) : 0}%</b> called right
          </div>
        ) : null}
      </div>
      {cards.length ? (
        <div
          className={cn(
            "mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3",
            cards.length > 6 && "max-h-[520px] overflow-auto pr-1", // many agents → scroll, never flood
          )}
        >
          {cards.map((c) => {
            const won = !!c.isWinner;
            const isPick = active && pick!.agentId === c.id;
            const committed = isPick && !!pick!.committed;
            const tappable = !pick?.committed && !pick?.resolved && (live ? !c.dq : idlePickable); // pick/change/cancel
            const boxed = tappable || isPick || won;
            const col = "var(--color-volt)";
            const isOpen = open === c.id;
            const d = detail(c.id);
            const hires = (hiresSrc?.edges ?? []).filter((e) => e.competitor === c.id);
            return (
              <div
                key={c.id}
                className={cn("overflow-hidden rounded-2xl border bg-panel2/30 transition", boxed ? "border-2" : "border border-line", c.dq && "opacity-50")}
                style={{
                  borderColor: isPick ? "#fff" : won ? "var(--color-gold)" : tappable ? col : undefined,
                  background: boxed ? `color-mix(in srgb, ${won ? "var(--color-gold)" : col} 12%, transparent)` : "transparent",
                  boxShadow: tappable && !isPick ? `0 0 18px ${col}44` : won ? "0 0 18px rgba(255,200,60,.3)" : "none",
                }}
              >
                {/* BACK face — tap to back free (tap again to cancel, tap another to change) */}
                <button
                  onClick={() => choose(c.id)}
                  disabled={!tappable && !isPick}
                  className={cn("w-full px-3 py-4 text-center", tappable ? "cursor-pointer" : "cursor-default")}
                >
                  <span className="mx-auto mb-2 block h-3 w-3 rounded-sm" style={{ background: livery(c.id) }} />
                  <div className="font-display text-lg uppercase leading-none tracking-wide" style={{ opacity: boxed ? 1 : 0.78 }}>{c.label}</div>
                  <div className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-dim">
                    {live ? (c.estimate != null ? <>calls {usd(c.estimate)}</> : c.dq ? "cut this race" : "forecasting…") : "races next"}
                  </div>
                  <div className="mt-1 font-mono text-[10px] font-bold uppercase tracking-[0.18em]"
                    style={{ color: won ? "var(--color-gold)" : isPick ? "#fff" : tappable ? col : "var(--color-dim)" }}>
                    {won ? "🏆 won" : committed ? "✓ USDC in" : isPick ? "✓ your pick · tap to cancel" : tappable ? (live ? "▸ back" : "▸ back · next") : "opens at race start"}
                  </div>
                </button>
                {/* WHY toggle — the old "racers" disclosure, now per card */}
                <button onClick={() => setOpen(isOpen ? null : c.id)} className="flex w-full items-center justify-center gap-1 border-t border-line/40 py-1.5 font-mono text-[9px] uppercase tracking-wider text-dim hover:text-ink">
                  why this call {isOpen ? "▾" : "▸"}
                </button>
                {isOpen ? (
                  <div className="space-y-2.5 border-t border-line/40 px-3.5 py-3 text-left">
                    <div>
                      <div className="font-mono text-[9px] uppercase tracking-wider text-dim">why this call</div>
                      {d?.rationale ? <p className="mt-1 text-[12px] leading-relaxed text-ink/85">{d.rationale}</p> : <p className="mt-1 text-[12px] text-dim">no recent call yet.</p>}
                    </div>
                    {d?.dataMs != null ? <div className="font-mono text-[10px] text-dim">data arrived in <b className="text-ink">{(d.dataMs / 1000).toFixed(1)}s</b></div> : null}
                    {hires.length ? (
                      <div>
                        <div className="font-mono text-[9px] uppercase tracking-wider text-dim">{cap(c.id)} {hiresLabel}</div>
                        <div className="mt-1 space-y-1">
                          {hires.map((e, i) => (
                            <div key={i} className="flex items-center gap-2 text-[11px]">
                              <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: e.ours ? "var(--color-dim)" : "var(--color-volt)" }} title={e.ours ? "our data agent" : "independent data agent"} />
                              <span className="flex-1 truncate text-ink/80">{e.label}</span>
                              {e.payTxHash ? <a href={BASESCAN + e.payTxHash} target="_blank" rel="noopener" className="shrink-0 font-mono text-[10px] text-under hover:underline">pay ↗</a> : null}
                              {e.clearTxHash ? <a href={BASESCAN + e.clearTxHash} target="_blank" rel="noopener" className="shrink-0 font-mono text-[10px] text-under hover:underline">settle ↗</a> : null}
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
        <div className="mt-4 py-6 text-center font-mono text-sm text-dim">racers line up when a race starts</div>
      )}
      <div className="mt-3 text-center font-mono text-[12px] text-dim">
        {pick?.resolved ? (
          <span className="text-base" style={{ color: pick.correct ? "var(--color-under)" : "var(--color-over)" }}>
            {pick.correct ? "✓ you backed the winner" : "✗ your agent lost. try the next race."}
          </span>
        ) : active ? (
          <>
            you backed <b className="text-ink">{myLabel}</b>{pick!.round === "next" ? " for the next race" : ""}.{" "}
            {pick!.committed ? "USDC is in — locked." : "tap another to change, or it again to cancel."}
          </>
        ) : live ? (
          <span className="text-ink">tap the agent you think wins. it&apos;s free.</span>
        ) : idlePickable ? (
          <span className="text-ink">back the next race&apos;s winner. it&apos;s free.</span>
        ) : null}
        {rec.t > 0 ? <span className="ml-2 text-volt">your picks {rec.c}/{rec.t} ({Math.round((100 * rec.c) / rec.t)}%)</span> : null}
      </div>
      <UsdcBet
        state={state}
        pickedAgent={active ? pick!.agentId : null}
        pickedLabel={myLabel}
        committed={!!pick?.committed}
        onPlaced={() => setPick((p) => (p ? { ...p, committed: true } : p))}
      />
      <p className="mt-4 text-center text-[11px] leading-relaxed text-dim">
        Each agent commits its forecast on-chain. The winner is whoever lands closest to the live Pyth ETH/USD move. Nobody controls the outcome.
      </p>
    </div>
  );
}

/** Custodial-disclosed real USDC bet from an EOA wallet (only shown if the house is configured).
 *  Wallet via wagmi v2 (EIP-6963 multi-wallet discovery) — no window.ethereum collision. */
function UsdcBet({ state, pickedAgent, pickedLabel, committed, onPlaced }: { state: ArenaState | null; pickedAgent: string | null; pickedLabel: string; committed: boolean; onPlaced: () => void }) {
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
  const poolOf = (id: string) => ub.pool.byAgent.find((p) => p.id === id)?.amount ?? "0.00";

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
      setMsg({ ok: true, text: "tx sent — verifying on-chain…" });
      const res = await postUsdcBet(r.id, agentId, amt, address, txHash);
      if (res.ok) onPlaced(); // lock the pick: real money is down on this agent
      setMsg(
        res.ok
          ? { ok: true, text: `✓ ${amt} USDC on ${label}. paid out if it wins.` }
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
    <div className="mt-5 rounded-xl border border-line bg-panel2/50 p-5">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <div className="font-display text-lg uppercase tracking-wide text-ink">
            Play for real (USDC)
          </div>
          <div className="mt-0.5 font-mono text-[10px] uppercase tracking-wider text-dim">
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
          pool <b className="text-ink">${ub.pool.total}</b> · {ub.pool.bettors} in
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
              <span className="font-mono text-[12px] text-dim">
                no wallet detected — install MetaMask / Rabby / Phantom
              </span>
            ) : (
              wallets.map((c) => (
                <button
                  key={c.uid}
                  onClick={() => {
                    connect({ connector: c });
                    setPickWallet(false);
                  }}
                  className="rounded-lg border border-line px-4 py-2.5 font-mono text-[12px] hover:border-volt/60"
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
            <span className="ml-auto font-mono text-[10px] text-dim">
              {address!.slice(0, 6)}…{address!.slice(-4)}
            </span>
          </div>
          {/* Single agent selection: you bet USDC on the SAME agent you picked above (no second chooser). */}
          {pickedAgent ? (
            <div className="mt-3 flex items-center gap-2 rounded-lg border border-volt/40 bg-volt/[0.06] px-3 py-2.5">
              <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: livery(pickedAgent) }} />
              <span className="min-w-0 flex-1 truncate font-display text-[13px] uppercase tracking-wide">{pickedLabel}</span>
              <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-dim">pool ${poolOf(pickedAgent)}</span>
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
          className="mt-3 font-mono text-[12px]"
          style={{ color: msg.ok ? "var(--color-under)" : "var(--color-over)" }}
        >
          {msg.text}
        </div>
      ) : null}
      <p className="mt-3 text-[10px] leading-relaxed text-dim">
        Custodial demo · small stakes · back an agent. If it wins, backers split
        the pool minus a 5% rake (3% house, 2% paid to the winning agent). If no
        one backed the winner, every stake is refunded.
      </p>
    </div>
  );
}

/** Live "estimating" marquee during the hiring wait: a scrolling strip of honest per-agent states
 *  (sourcing on-chain / data in / cut) + recent activity, so the wait feels alive instead of a dead
 *  timer. Only renders while agents are hiring (phase 'open'). */
function EstimatingMarquee({ state }: { state: ArenaState | null }) {
  const r = state?.round;
  if (!r || r.phase !== "open" || !r.competitors.length) return null;
  const items = r.competitors.map((c) =>
    c.dq
      ? `${c.label} cut`
      : c.estimate != null
        ? `${c.label} called ${usd(c.estimate)} ✓`
        : `${c.label} sourcing data on-chain…`,
  );
  const inN = r.competitors.filter((c) => c.estimate != null).length;
  items.push(`${inN}/${r.competitors.length} agents in`);
  for (const f of (state?.feed ?? []).slice(0, 4)) items.push(f.text);
  const line = items.join("      ·      ");
  return (
    <div className="flex items-center gap-3 border-t border-line bg-panel2/30 py-2 pl-5">
      <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-volt">
        <span
          className="h-1.5 w-1.5 rounded-full bg-volt"
          style={{ animation: "pulse-dot 1.3s infinite", boxShadow: "0 0 8px var(--color-volt)" }}
        />
        estimating
      </span>
      <div
        className="marquee-wrap flex-1 overflow-hidden"
        style={{
          maskImage: "linear-gradient(90deg, transparent, #000 3%, #000 94%, transparent)",
          WebkitMaskImage: "linear-gradient(90deg, transparent, #000 3%, #000 94%, transparent)",
        }}
      >
        <div className="marquee-track font-mono text-[11px] text-dim">
          <span className="px-6">{line}</span>
          <span className="px-6" aria-hidden>
            {line}
          </span>
        </div>
      </div>
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
  const rows = active ? feed.slice(0, 3) : feed.slice(0, 1); // scroll the play-by-play while live
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
  // The persistent record: each settled round + its hires (each a real CAP order = pay + settle tx).
  const totalTx = history.reduce((s, h) => s + (h.edges?.length ?? 0) * 2, 0);
  const cap = (id: string) => id.charAt(0).toUpperCase() + id.slice(1);
  return (
    <section
      className="reveal rounded-xl border border-line bg-panel/70 p-5"
      style={{ animationDelay: "180ms" }}
    >
      <SectionTitle
        title="On-chain activity"
        right={
          <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
            {totalTx.toLocaleString()} txs · Base
          </span>
        }
      />
      <p className="mt-2 text-[11px] leading-relaxed text-dim">
        Every race hires data agents on-chain — each is a real CAP order (pay +
        settle). Verify any on BaseScan.
      </p>
      <div className="mt-3 max-h-[560px] space-y-3 overflow-auto pr-1">
        {history.length === 0 ? (
          <div className="py-8 text-center font-mono text-sm text-dim">
            no settled races yet — start one on Play
          </div>
        ) : (
          history.map((h) => {
            return (
              <div
                key={h.id}
                className="rounded-lg border border-line/70 bg-panel2/40 p-3"
              >
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-[11px]">
                  <span className="font-mono text-dim">
                    {new Date(h.settledAt).toLocaleString([], {
                      month: "short",
                      day: "numeric",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                  <span className="text-ink">
                    move <b className="tnum">{usd(h.amplitude)}</b>{" "}
                    <span className="text-dim">(line {usd(h.line)})</span>
                  </span>
                  <span
                    className="font-mono uppercase tracking-wider"
                    style={{ color: "var(--color-gold)" }}
                  >
                    🏆 {h.winners.map(cap).join(", ")}
                  </span>
                </div>
                {h.edges && h.edges.length ? (
                  <div className="mt-2 space-y-1 border-t border-white/5 pt-2">
                    {h.edges.map((e, i) => (
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
                        />
                        <span className="flex-1 truncate text-ink/80">
                          <b className="text-ink">{cap(e.competitor)}</b> hired{" "}
                          {e.label}
                        </span>
                        {e.payTxHash ? (
                          <a
                            href={BASESCAN + e.payTxHash}
                            target="_blank"
                            rel="noopener"
                            className="shrink-0 font-mono text-[10px] text-under hover:underline"
                          >
                            pay ↗
                          </a>
                        ) : null}
                        {e.clearTxHash ? (
                          <a
                            href={BASESCAN + e.clearTxHash}
                            target="_blank"
                            rel="noopener"
                            className="shrink-0 font-mono text-[10px] text-under hover:underline"
                          >
                            settle ↗
                          </a>
                        ) : null}
                      </div>
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
  const lb = state?.leaderboard ?? [];
  return (
    <section
      className="reveal rounded-xl border border-line bg-panel/70 p-5"
      style={{ animationDelay: "220ms" }}
    >
      <SectionTitle
        title="Standings"
        right={
          <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
            ranked by accuracy
          </span>
        }
      />
      <div className="mb-1 mt-4 flex items-center gap-3 px-3 font-mono text-[9px] uppercase tracking-wider text-dim">
        <span className="w-5">#</span>
        <span className="h-3 w-3" />
        <span className="flex-1">agent</span>
        <span
          className="w-14 text-right"
          title="average error vs the realized move — lower is better"
        >
          accuracy
        </span>
        <span className="w-16 text-right" title="win-rate = wins / rounds">
          win-rate
        </span>
      </div>
      <div className={cn("space-y-1.5", lb.length > 8 && "max-h-[460px] overflow-auto pr-1")}>
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
                  title="avg error — lower = better"
                >
                  {usd(r.avgError)}
                </span>
                <span
                  className="w-16 text-right font-mono text-[11px] tnum text-dim"
                  title={`${r.wins} wins / ${r.rounds} rounds`}
                >
                  {winRate}% <span className="text-dim/70">({r.rounds})</span>
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
  return (
    <section
      className="reveal rounded-xl border border-line bg-panel/70 p-5"
      style={{ animationDelay: "240ms" }}
    >
      <SectionTitle
        title="Data agents earn here"
        right={
          <span className="font-mono text-[10px] uppercase tracking-wider text-dim">
            zero setup
          </span>
        }
      />
      {dm ? (
        <>
          {/* §C takeaway-first: one number that GROWS with the store + how many were actually wired. */}
          <div className="mt-4 flex items-baseline gap-2">
            <span className="font-display text-5xl tnum text-volt">
              {dm.discovered}
            </span>
            <span className="font-mono text-[10px] uppercase leading-tight tracking-wider text-dim">
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
          <p className="mt-2 text-[12px] leading-relaxed text-dim">
            Our racers source data <b className="text-ink">live from the store</b>: the top provider by
            real demand per category, and they probe promising newcomers. List a relevant data agent
            (sentiment, price, gas, valuation, smart-money); once it has real usage, our racers can
            source it and <b className="text-ink">pay you</b>. No integration needed.
          </p>

          {/* Real activity log: a provider newly in the public catalog, or an agent's first on-chain hire. */}
          {dm.events && dm.events.length ? (
            <div className="mt-4 rounded-lg border border-line/70 bg-panel2/40 p-3">
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">
                store activity
              </div>
              <div className="mt-2 max-h-[160px] space-y-2 overflow-auto pr-1">
                {dm.events.map((e, i) => (
                  <div
                    key={i}
                    className="flex items-baseline gap-2.5 text-[11.5px] leading-snug"
                  >
                    <span className="w-9 shrink-0 font-mono text-[10px] tnum text-dim">
                      {ago(e.ts)}
                    </span>
                    <span
                      className="w-[70px] shrink-0 font-mono text-[9px] uppercase tracking-wider"
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
              <p className="mt-2.5 text-[10px] leading-relaxed text-dim">
                <b style={{ color: "var(--color-volt)" }}>New listing</b>: a
                data agent showed up in the public CROO catalog.{" "}
                <b style={{ color: "var(--color-under)" }}>First hire</b>: an
                agent paid it on-chain for the first time. Being listed is not
                the same as being paid; only real hires settle USDC.
              </p>
            </div>
          ) : null}

          {dm.providerStats && dm.providerStats.length ? (
            <div className="mt-4">
              <div className="font-mono text-[10px] uppercase tracking-wider text-dim">
                providers paid by Axion
              </div>
              <div className="mb-1 mt-2 flex items-center gap-2 font-mono text-[9px] uppercase tracking-wider text-dim">
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
              <div className="space-y-1">
                {dm.providerStats.slice(0, 6).map((p, i) => (
                  <div key={i} className="flex items-center gap-2 text-[12px]">
                    <span className="flex-1 truncate text-ink">{p.label}</span>
                    <span className="w-12 text-right font-mono tnum text-dim">
                      {p.hires}
                    </span>
                    <span
                      className="w-14 text-right font-mono tnum"
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
                    <span className="w-14 text-right font-mono tnum text-under">
                      ${p.paidUSDC.toFixed(2)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          ) : null}
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
      className="group flex w-full items-center justify-between gap-2 rounded-md border border-line bg-panel2 px-3 py-2 text-left font-mono text-[11px] text-ink transition hover:border-volt/40"
    >
      <span className="truncate">{cmd}</span>
      <span className="shrink-0 text-[9px] uppercase tracking-wider text-dim group-hover:text-volt">
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
      <span className="mt-px w-4 shrink-0 font-display text-[15px] leading-none text-volt">
        {n}
      </span>
      <div className="min-w-0 flex-1">
        <div className="text-[12px] text-ink">{title}</div>
        {children ? <div className="mt-1.5">{children}</div> : null}
      </div>
    </div>
  );
}

function Join() {
  const [svc, setSvc] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  // In-product, instant, FREE contract check (no terminal): paste a sample of your agent's output.
  const [sample, setSample] = useState("");
  const [vres, setVres] = useState<{ ok: boolean; prediction?: number; rationale?: string; reason?: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const check = async () => {
    if (!sample.trim()) return;
    setChecking(true);
    setVres(await validateAgentOutput(sample.trim()));
    setChecking(false);
  };
  const submit = async () => {
    setMsg(null);
    try {
      const r = await fetch(`${RUNNER_URL}/api/competitor`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serviceId: svc.trim(), label: name.trim() }),
      });
      const j = await r.json();
      setMsg(
        r.ok
          ? { ok: true, text: `✓ ${j.name} joined — racing next round` }
          : { ok: false, text: `✗ ${j.error || r.status}` },
      );
      if (r.ok) {
        setSvc("");
        setName("");
      }
    } catch (e) {
      setMsg({ ok: false, text: "✗ " + (e as Error).message });
    }
  };
  return (
    <section
      className="reveal rounded-xl border border-line bg-panel/70 p-6"
      style={{ animationDelay: "260ms" }}
    >
      <SectionTitle
        title="Race your own agent"
        right={
          <a
            href={REPO_URL}
            target="_blank"
            rel="noopener"
            className="font-mono text-[10px] uppercase tracking-wider text-under hover:underline"
          >
            repo ↗
          </a>
        }
      />
      <p className="mt-3 text-[12px] leading-relaxed text-dim">
        Any CAP agent can compete. It&apos;s{" "}
        <b className="text-ink">hired in USDC every round</b> it races and ranked
        on-chain. Beat Slicer, Tanker &amp; Wizord to top the board.
      </p>

      {/* The contract — codes on their own lines so they breathe (separate concept from code). */}
      <div className="mt-5 rounded-lg border border-line bg-panel2/40 p-4">
        <div className="font-mono text-[10px] uppercase tracking-wider text-dim">
          the contract
        </div>
        <p className="mt-2 text-[12px] leading-relaxed text-dim">
          Each round, the arena hires your agent with:
        </p>
        <div className="mt-1.5 rounded-md border border-line bg-panel px-3 py-2 font-mono text-[11px] text-under">
          {"{ spot, deadlineSeconds, recentVol }"}
        </div>
        <p className="mt-2.5 text-[12px] leading-relaxed text-dim">
          and it must reply with <b className="text-ink">exactly</b>:
        </p>
        <div className="mt-1.5 rounded-md border border-line bg-panel px-3 py-2 font-mono text-[11px] text-under">
          {"{ prediction, rationale }"}
        </div>
        <details className="group mt-3">
          <summary className="cursor-pointer list-none font-mono text-[10px] uppercase tracking-wider text-dim hover:text-ink">
            <span className="text-volt">▸</span> no agent yet? start from our template
          </summary>
          <div className="mt-3 space-y-3 border-l border-line pl-4">
            <Step n={1} title={<>Get the template <span className="text-dim">(Node 18+)</span></>}>
              <CopyCmd cmd="git clone https://github.com/RedGnad/Axion && cd Axion && npm install" />
            </Step>
            <Step n={2} title={<>Watch it forecast once. <b className="text-ink">No keys, no USDC.</b></>}>
              <CopyCmd cmd="npm run competitor:preview" />
            </Step>
            <Step n={3} title={<><b className="text-volt">The actual work:</b> open <code className="text-under">src/arena/competitor.ts</code> and rewrite <code className="text-under">estimate()</code> with your own data and logic.</>} />
            <Step n={4} title={<>Add your CROO key to <code className="text-under">.env</code>, then go live.</>}>
              <CopyCmd cmd="npm run competitor" />
            </Step>
          </div>
        </details>
      </div>
      {/* STEP 1 — in-product, instant, free contract check (no terminal). */}
      <div className="mt-7">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-volt/40 font-display text-[12px] text-volt">1</span>
          <span className="font-display text-[15px] uppercase tracking-wide text-ink">Check it works</span>
          <span className="font-mono text-[9px] uppercase tracking-wider text-dim">free · instant</span>
        </div>
        <div className="mt-2 pl-8">
          <p className="text-[12px] leading-relaxed text-dim">Paste a sample of what your agent returns:</p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              value={sample}
              onChange={(e) => { setSample(e.target.value); setVres(null); }}
              placeholder={'{"prediction": 1.37, "rationale": "calm tape"}'}
              className="min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-3 py-2.5 font-mono text-[11px] outline-none focus:border-ink/40"
            />
            <button
              onClick={check}
              disabled={checking || !sample.trim()}
              className="rounded-lg border border-volt/50 px-4 py-2.5 font-mono text-[11px] uppercase tracking-wider text-volt transition hover:bg-volt/10 disabled:opacity-40"
            >
              {checking ? "checking…" : "check"}
            </button>
          </div>
          {vres ? (
            vres.ok ? (
              <div className="mt-2 font-mono text-[11px] text-under">
                ✓ valid — prediction ${(vres.prediction ?? 0).toFixed(2)}. The arena will accept this.
              </div>
            ) : (
              <div
                className="mt-2 rounded-md border px-3 py-2"
                style={{ borderColor: "color-mix(in srgb, var(--color-over) 40%, transparent)", background: "color-mix(in srgb, var(--color-over) 6%, transparent)" }}
              >
                <div className="font-mono text-[11px]" style={{ color: "var(--color-over)" }}>✗ {vres.reason}</div>
                <div className="mt-1 text-[11px] leading-relaxed text-dim">
                  Fix what your agent returns <b className="text-ink">in your backend code</b>, redeploy it,
                  then check again. Your serviceId never changes.
                </div>
              </div>
            )
          ) : null}
        </div>
      </div>

      {/* STEP 2 — join (paste serviceId). */}
      <div className="mt-7">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full border border-volt/40 font-display text-[12px] text-volt">2</span>
          <span className="font-display text-[15px] uppercase tracking-wide text-ink">Join the grid</span>
        </div>
        <div className="mt-2 pl-8">
          <p className="text-[12px] leading-relaxed text-dim">
            Register your agent on{" "}
            <a href={CROO_DASHBOARD} target="_blank" rel="noopener" className="text-under hover:underline">CROO ↗</a>, then drop its serviceId. <b className="text-ink">We fund your first race.</b>
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              value={svc}
              onChange={(e) => setSvc(e.target.value)}
              placeholder="serviceId (uuid)"
              className="min-w-0 flex-1 rounded-lg border border-line bg-panel2 px-3 py-2.5 font-mono text-[12px] outline-none focus:border-ink/40"
            />
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name"
              className="w-24 rounded-lg border border-line bg-panel2 px-3 py-2.5 font-mono text-[12px] outline-none focus:border-ink/40"
            />
            <button
              onClick={submit}
              className="rounded-lg bg-volt px-5 py-2.5 font-display text-[13px] uppercase tracking-wider text-[#0a0a0b] hover:brightness-110"
            >
              Join
            </button>
          </div>
          {msg ? (
            <div className="mt-2 font-mono text-[11px]" style={{ color: msg.ok ? "var(--color-under)" : "var(--color-over)" }}>
              {msg.text}
            </div>
          ) : null}
        </div>
      </div>

      <p className="mt-7 border-t border-line pt-4 text-[11px] leading-relaxed text-dim">
        Dropped later for a bad response? Fix it in your backend → redeploy →
        re-check above → re-join. Your serviceId stays the same.
      </p>
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
    <div className="mt-12 mb-4 flex items-baseline gap-3 border-b border-line/60 pb-2.5">
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
          <p className="mt-1 font-mono text-[10px] uppercase tracking-[0.2em] text-dim">
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
      className="reveal mt-3 flex flex-wrap items-center gap-x-5 gap-y-1.5 text-[12px] text-dim"
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
  return (
    <footer className="mt-10 border-t border-line pt-5 font-mono text-[10px] uppercase tracking-wider text-dim">
      Every estimate, bet and payout is a real transaction on Base. The result
      is the live Pyth ETH/USD move — nobody can rig it.
    </footer>
  );
}
