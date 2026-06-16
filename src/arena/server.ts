import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { loadCompetitors, runRound, type Competitor } from './loop.js';
import { PERSONALITIES } from './personalities.js';
import { fetchPythPrice } from './oracle.js';

/**
 * The Arena live server: one long-running process that runs real on-chain rounds and serves the
 * live "race to the price" UI. Everything shown is driven by real state (Pyth + CAP orders) — no
 * cosmetic data. Rounds cost USDC, so they run on demand (POST /api/round) unless ARENA_AUTORUN=1.
 *
 *   GET /            → the UI
 *   GET /api/state   → current ArenaState snapshot (JSON)
 *   GET /api/stream  → Server-Sent Events: pushes ArenaState on every change
 *   POST /api/round  → run one real round (if competitors are configured)
 */
interface CompetitorView {
  id: string;
  label: string;
  blurb: string;
  estimate?: number;
  rationale?: string;
  error?: number;
  isWinner?: boolean;
}
interface RoundView {
  id: string;
  phase: 'open' | 'betting' | 'settled';
  openPrice: number;
  closePrice?: number;
  line?: number;
  amplitude?: number;
  /** Live realized amplitude from Pyth during the betting window (the moving "current move"). */
  liveAmplitude?: number;
  /** When the race (betting window) started — the client animates progress between this and settleAtMs. */
  raceStartMs?: number;
  settleAtMs?: number;
  competitors: CompetitorView[];
}
interface HistoryItem {
  id: string;
  openPrice: number;
  closePrice: number;
  amplitude: number;
  line: number;
  winners: string[];
  settledAt: string;
}
interface FeedItem {
  ts: number;
  text: string;
  txUrl?: string;
}
interface ArenaState {
  status: 'idle' | 'running' | 'view-only';
  asset: string;
  /** Live ETH/USD from Pyth, streamed every ~2s so the screen is never static. */
  livePrice?: number;
  priceSeries: number[];
  round?: RoundView;
  history: HistoryItem[];
  leaderboard: { id: string; label: string; wins: number; rounds: number }[];
  feed: FeedItem[];
}

// Long-running server: a stray WebSocket/async error must never take down the HTTP server.
// Log and keep serving (availability over strictness for a live demo endpoint).
process.on('uncaughtException', (e) => console.error('[arena-server] uncaughtException:', (e as Error)?.message ?? e));
process.on('unhandledRejection', (e) => console.error('[arena-server] unhandledRejection:', (e as Error)?.message ?? e));

const PORT = Number(process.env.PORT ?? '8787');
const HISTORY_FILE = process.env.ARENA_HISTORY_FILE ?? 'arena-history.json';
const WINDOW = Number(process.env.ARENA_WINDOW_SECONDS ?? '60');
const BASESCAN = 'https://basescan.org/tx/';

const state: ArenaState = { status: 'idle', asset: 'ETH', priceSeries: [], history: [], leaderboard: [], feed: [] };
const clients = new Set<import('node:http').ServerResponse>();
let competitors: Competitor[] = [];
let metaById = new Map<string, { label: string; blurb: string }>();
let running = false;

function personaMeta(id: string): { label: string; blurb: string } {
  return metaById.get(id) ?? { label: id, blurb: '' };
}

function pushFeed(text: string, txUrl?: string): void {
  state.feed.unshift({ ts: Date.now(), text, txUrl });
  state.feed = state.feed.slice(0, 40);
}

function broadcast(): void {
  const payload = `data: ${JSON.stringify(state)}\n\n`;
  for (const res of clients) res.write(payload);
}

function bumpLeaderboard(competitorIds: string[], winners: string[]): void {
  for (const id of competitorIds) {
    let row = state.leaderboard.find((r) => r.id === id);
    if (!row) {
      row = { id, label: personaMeta(id).label, wins: 0, rounds: 0 };
      state.leaderboard.push(row);
    }
    row.rounds += 1;
    if (winners.includes(id)) row.wins += 1;
  }
  state.leaderboard.sort((a, b) => b.wins - a.wins || a.rounds - b.rounds);
}

function loadHistory(): void {
  if (existsSync(HISTORY_FILE)) {
    try {
      const data = JSON.parse(readFileSync(HISTORY_FILE, 'utf8')) as { history?: HistoryItem[]; leaderboard?: ArenaState['leaderboard'] };
      state.history = data.history ?? [];
      state.leaderboard = data.leaderboard ?? [];
    } catch {
      /* ignore corrupt history */
    }
  }
}

function saveHistory(): void {
  try {
    writeFileSync(HISTORY_FILE, JSON.stringify({ history: state.history, leaderboard: state.leaderboard }, null, 2));
  } catch {
    /* best-effort persistence */
  }
}

async function runOneRound(cfg: { baseURL: string; wsURL: string; rpcURL?: string }): Promise<void> {
  if (running || competitors.length === 0) return;
  running = true;
  state.status = 'running';
  try {
    await runRound(competitors, cfg, WINDOW, {
      onOpen: ({ id, openPrice }) => {
        state.round = {
          id,
          phase: 'open',
          openPrice,
          competitors: competitors.map((c) => ({ id: c.id, ...personaMeta(c.id) })),
        };
        pushFeed(`Round open — ETH/USD $${openPrice.toFixed(2)}; agents hiring data & estimating…`);
        broadcast();
      },
      onEstimate: ({ forecast, edges }) => {
        if (!state.round) return;
        const c = state.round.competitors.find((x) => x.id === forecast.competitor);
        if (c) { c.estimate = forecast.prediction; c.rationale = forecast.rationale; }
        for (const e of edges) {
          pushFeed(`${personaMeta(e.competitor).label} hired ${e.label} [${e.ours ? 'ours' : '3rd-party'}]`, BASESCAN + e.payTxHash);
        }
        pushFeed(`${personaMeta(forecast.competitor).label} estimates $${forecast.prediction.toFixed(2)}`);
        broadcast();
      },
      onEstimates: ({ line, settleAtMs }) => {
        if (!state.round) return;
        state.round.phase = 'betting';
        state.round.line = line;
        state.round.settleAtMs = settleAtMs;
        state.round.raceStartMs = Date.now();
        state.round.liveAmplitude = 0;
        pushFeed(`Line set at $${line.toFixed(2)} — over/under open; move building live…`);
        broadcast();
      },
      onTick: ({ liveAmplitude }) => {
        if (!state.round) return;
        state.round.liveAmplitude = liveAmplitude;
        broadcast();
      },
      onSettled: ({ round, line }) => {
        const o = round.outcome!;
        if (state.round) {
          state.round.phase = 'settled';
          state.round.closePrice = round.closePrice;
          state.round.amplitude = o.actual;
          state.round.competitors = state.round.competitors.map((c) => ({
            ...c,
            error: o.errors[c.id],
            isWinner: o.winners.includes(c.id),
          }));
        }
        const item: HistoryItem = {
          id: round.id,
          openPrice: round.openPrice,
          closePrice: round.closePrice ?? round.openPrice,
          amplitude: o.actual,
          line,
          winners: o.winners,
          settledAt: o.settledAt,
        };
        state.history.unshift(item);
        state.history = state.history.slice(0, 50);
        bumpLeaderboard(round.forecasts.map((f) => f.competitor), o.winners);
        const side = o.actual > line ? 'over' : o.actual < line ? 'under' : 'push';
        pushFeed(`Settled — amplitude $${o.actual.toFixed(2)} vs line $${line.toFixed(2)} → ${side}. Winner(s): ${o.winners.map((w) => personaMeta(w).label).join(', ')}`);
        saveHistory();
        broadcast();
      },
    });
  } catch (err) {
    pushFeed(`Round error: ${(err as Error).message}`);
    broadcast();
  } finally {
    running = false;
    state.status = competitors.length ? 'idle' : 'view-only';
    broadcast();
  }
}

async function main(): Promise<void> {
  loadHistory();

  // Always-on live ETH price stream (real Pyth, every 2s) → the screen is never static.
  setInterval(() => {
    void (async () => {
      try {
        const p = await fetchPythPrice();
        state.livePrice = p.price;
        state.priceSeries.push(Number(p.price.toFixed(2)));
        if (state.priceSeries.length > 90) state.priceSeries.shift();
        broadcast();
      } catch {
        /* transient Hermes hiccup */
      }
    })();
  }, 2000);

  const cfg = {
    baseURL: process.env.CROO_API_URL ?? '',
    wsURL: process.env.CROO_WS_URL ?? '',
    rpcURL: process.env.BASE_RPC_URL,
  };
  // Try to wire live competitors; if none are configured, serve in view-only mode (history + UI).
  try {
    competitors = await loadCompetitors(cfg);
    metaById = new Map(competitors.map((c) => [c.id, c.kind === 'local' ? { label: c.persona.label, blurb: c.persona.blurb } : { label: c.label, blurb: 'open third-party competitor' }]));
    state.status = 'idle';
    console.log(`[arena-server] ${competitors.length} competitors live: ${competitors.map((c) => c.id).join(', ')}`);
  } catch (err) {
    metaById = new Map(PERSONALITIES.map((p) => [p.id, { label: p.label, blurb: p.blurb }]));
    state.status = 'view-only';
    console.warn(`[arena-server] view-only (no competitors configured): ${(err as Error).message}`);
  }

  const html = readFileSync(new URL('./ui.html', import.meta.url), 'utf8');

  createServer((req, res) => {
    const url = req.url ?? '/';
    if (req.method === 'GET' && (url === '/' || url.startsWith('/?'))) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    if (req.method === 'GET' && url === '/api/state') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
      res.end(JSON.stringify(state));
      return;
    }
    if (req.method === 'GET' && url === '/api/stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'X-Accel-Buffering': 'no', // tell proxies (Render/Cloudflare) not to buffer the stream
      });
      res.write(`data: ${JSON.stringify(state)}\n\n`);
      clients.add(res);
      const hb = setInterval(() => res.write(': hb\n\n'), 20_000); // heartbeat keeps the stream flushing
      req.on('close', () => { clearInterval(hb); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && url === '/api/round') {
      res.writeHead(running ? 409 : 202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ started: !running, running }));
      if (!running) void runOneRound(cfg);
      return;
    }
    res.writeHead(404);
    res.end('not found');
  }).listen(PORT, () => console.log(`[arena-server] http://localhost:${PORT}  (status: ${state.status})`));

  if (process.env.ARENA_AUTORUN === '1') void runOneRound(cfg);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
