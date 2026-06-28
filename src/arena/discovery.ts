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
const DENY = /subscription|monthly|plan|days|swap|execute|executor|bridge|deploy|mint|airdrop|faucet/i;

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
  valuation: /valuation|ahr|mvrv|nupl|rainbow|fair.?value|indicator|regime/i,
  'dca-signal': /dca|accumulat|bottom|buy.?signal/i,
  // Wizord — microstructure
  'token-price': /price|quote|spot/i,
  gas: /gas|\bfees?\b/i,
};

// In-memory learning cache (resets on restart → re-probes occasionally, bounded). Curated seeds are
// NEVER blacklisted (protected in loop.ts); only unproven dynamic providers land here.
const failedProviders = new Set<string>();
const triedProviders = new Set<string>();
export function markProviderFailed(serviceId: string): void { if (serviceId) failedProviders.add(serviceId); }
export function markProviderTried(serviceId: string): void { if (serviceId) triedProviders.add(serviceId); }
export function isProviderUntried(serviceId: string): boolean { return !!serviceId && !triedProviders.has(serviceId); }

/** Live candidates for a capability: store providers whose name matches the capability, under the
 *  price cap, not previously failed, ranked by real 7d demand (already sorted by discoverProviders). */
export async function candidatesForCapability(capability: string): Promise<DiscoveredProvider[]> {
  const kw = CAP_KEYWORDS[capability];
  if (!kw) return [];
  return (await discoverProviders()).filter((p) => kw.test(p.name) && !failedProviders.has(p.serviceId));
}
