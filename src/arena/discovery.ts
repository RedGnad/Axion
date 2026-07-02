/**
 * Live store discovery — reads CROO's PUBLIC catalog so the arena's data-sourcing GROWS with the
 * store instead of a frozen list. The SDK has no discovery method; this public, unauthenticated
 * endpoint is the documented surface (see CLAUDE.md). Honest framing: discovery powers
 *   (a) the "data market" demo panel (how many hireable data providers exist + their real 7d demand),
 *   (b) live ranking of candidate providers by orders7d, and
 *   (c) an OPTIONAL dynamic-hire path (env DISCOVERY_HIRE_NEW=1) that lets NEW store providers be
 *       probed beyond our verified set — OFF by default so a demo never burns USDC on unknowns.
 * It does NOT increase the number of hires per round (cost stays bounded); it changes WHICH
 * providers are candidates. Routing is off-chain and is NOT the innovation claim (that stays the
 * per-hire on-chain escrow + Pyth oracle + pre-committed estimates).
 */

const CATALOG = 'https://api.croo.network/backend/v1/public/services';
const ORIGIN = 'https://agent.croo.network'; // required header for the public endpoint
const TTL_MS = 10 * 60_000; // re-census every ~10min; the store changes slowly

export interface DiscoveredProvider {
  serviceId: string;
  agentId: string;
  name: string;
  priceUSDC: number;
  orders7d: number; // real demand signal CROO exposes per service
}

interface CatalogItem {
  serviceId?: string;
  agentId?: string;
  name?: string;
  price?: string | number;
  orders7d?: string | number;
}

let cache: { at: number; list: DiscoveredProvider[] } | null = null;

/** Names that aren't ETH-forecast DATA feeds (subscriptions / execution / generic plans). Excluded
 *  so dynamic hiring can't drift into nonsensical or non-data orders. */
const DENY = /subscription|monthly|plan|days|swap|execute|execution|executor|bridge|deploy|mint|airdrop|faucet|pay|payout|split|resolver|ens|logo|design|buyer.?ping|\becho\b|\btest\b|arena|axion|racer|race|forecast/i;

function maxPriceUSDC(): number {
  const v = Number(process.env.DISCOVERY_MAX_PRICE_USDC);
  return Number.isFinite(v) && v > 0 ? v : 0.10; // never hire above this — protects the margin
}

/**
 * Fetch the full public catalog (paginated by `page`; `limit`/`offset` are ignored server-side),
 * keep plausible cheap DATA providers, rank by real 7d demand. Cached ~10min; never throws
 * (a network blip falls back to the last cache or an empty list — the curated roster still works).
 */
export async function discoverProviders(): Promise<DiscoveredProvider[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.list;
  const all: DiscoveredProvider[] = [];
  try {
    for (let page = 1; page <= 15; page++) {
      const r = await fetch(`${CATALOG}?page=${page}`, { headers: { Origin: ORIGIN } });
      if (!r.ok) break;
      const items = ((await r.json()) as { items?: CatalogItem[] }).items ?? [];
      if (!items.length) break;
      for (const i of items) {
        const price = Number(i.price) / 1e6;
        if (!i.serviceId || !Number.isFinite(price)) continue;
        all.push({
          serviceId: i.serviceId,
          agentId: i.agentId ?? '',
          name: String(i.name ?? '').slice(0, 60),
          priceUSDC: price,
          orders7d: Number(i.orders7d) || 0,
        });
      }
      if (items.length < 10) break; // last page (~10 per page)
    }
  } catch {
    return cache?.list ?? [];
  }
  const cap = maxPriceUSDC();
  const list = all
    .filter((p) => p.priceUSDC <= cap && !DENY.test(p.name))
    .sort((a, b) => b.orders7d - a.orders7d);
  cache = { at: Date.now(), list };
  return list;
}

/** Total hireable (≤ price cap, data-like) providers discovered — the "market size" that grows. */
export async function dataMarketSize(): Promise<number> {
  return (await discoverProviders()).length;
}

/** Top providers by real demand for the demo panel (name + orders7d + price). */
export async function topProviders(n = 6): Promise<DiscoveredProvider[]> {
  return (await discoverProviders()).slice(0, n);
}

/** New, not-yet-in-our-verified-set candidates, highest demand first (for the gated dynamic-hire). */
export async function newCandidates(knownServiceIds: Set<string>): Promise<DiscoveredProvider[]> {
  return (await discoverProviders()).filter((p) => !knownServiceIds.has(p.serviceId));
}

// ── LIVE SOURCING: agents pick their data providers from the evolving store (not a frozen list). ──
/** Match a provider NAME to a capability, so a persona can source NEW providers of the right kind. */
const CAP_KEYWORDS: Record<string, RegExp> = {
  // Slicer — momentum/flow
  'smart-money': /smart.?money|top.?trader|whale|inflow|netflow|exchange.?flow|\bflow\b|position/i,
  sentiment: /fear|greed|sentiment|social|mood/i,
  // Tanker — contrarian value
  valuation: /\bvaluation\b|ahr|mvrv|nupl|rainbow|fair.?value|market.?value|indicator|regime/i,
  'dca-signal': /dca|accumulat|bottom|buy.?signal/i,
  // Wizord — microstructure
  'token-price': /(?:token|eth|base|chainlink|cex|dex).*(?:price|quote|spot|snapshot|feed)|(?:price|quote|spot|snapshot|feed).*(?:token|eth|base|chainlink|cex|dex)/i,
  gas: /gas|\bfees?\b/i,
};

const CAP_DENY: Record<string, RegExp> = {
  // "Liquidation Price Calculator" matched the old broad /price/ rule and repeatedly timed out for
  // Wizord. Token-price means a market quote/feed, not a leverage/risk calculator.
  'token-price': /liquidation|margin|leverage|risk|health|safety|audit|depeg|portfolio|wallet|gas|fee|optimizer/i,
  valuation: /evaluation|trust|reputation|security|audit|safety|risk|wallet/i,
  gas: /optimizer|optimization|audit|security|contract|wallet|risk/i,
};

interface ProviderSignal {
  failScore: number;
  slowScore: number;
  updatedAt: number;
  lastLatencyMs?: number;
}

// In-memory provider health. This is deliberately a soft score, not a banlist: slow/failed services
// become less likely for fast Blitz races, then recover over time if the store/provider improves.
const providerSignals = new Map<string, ProviderSignal>();
const triedProviders = new Set<string>();
export function markProviderTried(serviceId: string): void { if (serviceId) triedProviders.add(serviceId); }
export function isProviderUntried(serviceId: string): boolean { return !!serviceId && !triedProviders.has(serviceId); }

function slowThresholdMs(): number {
  const v = Number(process.env.ARENA_PROVIDER_SLOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 150_000;
}

function halfLifeMs(): number {
  const v = Number(process.env.ARENA_PROVIDER_HEALTH_HALFLIFE_MS);
  return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 60_000;
}

function withDecay(serviceId: string, atMs = Date.now()): ProviderSignal {
  const prev = providerSignals.get(serviceId) ?? { failScore: 0, slowScore: 0, updatedAt: atMs };
  const elapsed = Math.max(0, atMs - prev.updatedAt);
  const decay = Math.pow(0.5, elapsed / halfLifeMs());
  return {
    failScore: prev.failScore * decay,
    slowScore: prev.slowScore * decay,
    updatedAt: atMs,
    lastLatencyMs: prev.lastLatencyMs,
  };
}

export function markProviderFailed(serviceId: string, atMs = Date.now()): void {
  if (!serviceId) return;
  const next = withDecay(serviceId, atMs);
  next.failScore = Math.min(8, next.failScore + 1);
  providerSignals.set(serviceId, next);
}

export function markProviderSucceeded(serviceId: string, latencyMs: number, atMs = Date.now()): void {
  if (!serviceId || !Number.isFinite(latencyMs)) return;
  const next = withDecay(serviceId, atMs);
  next.failScore *= 0.5;
  const slowRatio = latencyMs / slowThresholdMs();
  next.slowScore = slowRatio > 1
    ? Math.min(8, next.slowScore + Math.min(2, slowRatio - 1))
    : next.slowScore * 0.6;
  next.lastLatencyMs = latencyMs;
  providerSignals.set(serviceId, next);
}

export function providerHealthWeight(serviceId: string): number {
  if (!serviceId) return 1;
  const s = providerSignals.get(serviceId);
  if (!s) return 1;
  const now = withDecay(serviceId);
  const penalty = now.failScore * 1.8 + now.slowScore;
  return Math.max(0.08, Math.min(1, 1 / (1 + penalty)));
}

/** Live candidates for a capability: store providers whose name matches the capability, under the
 *  price cap, ranked by real 7d demand (already sorted by discoverProviders). Health weighting happens
 *  in loop.ts so slow providers are less likely, not removed forever. */
export async function candidatesForCapability(capability: string): Promise<DiscoveredProvider[]> {
  const kw = CAP_KEYWORDS[capability];
  if (!kw) return [];
  const deny = CAP_DENY[capability];
  return (await discoverProviders()).filter((p) =>
    kw.test(p.name) &&
    !(deny?.test(p.name)),
  );
}
