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
  // Slicer — momentum/flow. Perp/vault positioning is flow too: who is levered, and how crowded, is a
  // first-order input on how far price can travel. Those listings (Hyperliquid vaults, holder
  // distribution) are among the most-bought in the store and matched nothing here.
  'smart-money': /smart.?money|top.?trader|whale|inflow|netflow|exchange.?flow|\bflow\b|position|holder|hyperliquid|\bvault|perp|funding|open.?interest/i,
  // Sentiment includes what the crowd is looking AT, not only how it feels.
  sentiment: /fear|greed|sentiment|social|mood|hot.?events|trending|\bnews\b/i,
  // Tanker — contrarian value. Macro risk context is the same thesis: is the market cheap or stretched.
  valuation: /\bvaluation\b|ahr|mvrv|nupl|rainbow|fair.?value|market.?value|indicator|regime|macro|\bfred\b/i,
  'dca-signal': /dca|accumulat|bottom|buy.?signal/i,
  // Wizord — microstructure: the tape (recent trades) belongs here as much as the quote does.
  'token-price': /(?:token|eth|base|chainlink|cex|dex).*(?:price|quote|spot|snapshot|feed)|(?:price|quote|spot|snapshot|feed).*(?:token|eth|base|chainlink|cex|dex)|recent.?trades|\btape\b|order.?book|\bdepth\b/i,
  gas: /gas|\bfees?\b/i,
};

const CAP_DENY: Record<string, RegExp> = {
  // "Liquidation Price Calculator" matched the old broad /price/ rule and repeatedly timed out for
  // Wizord. Token-price means a market quote/feed, not a leverage/risk calculator.
  // `fee` unanchored also matched "Price FEED", quietly binning Chainlink's feed: anchor it.
  'token-price': /liquidation|margin|leverage|risk|health|safety|audit|depeg|portfolio|wallet|gas|\bfees?\b|optimizer/i,
  // "risk" alone used to bin FRED Macro Risk Context, which is exactly Tanker's thesis. Deny what is
  // about an ADDRESS or a CONTRACT (trust, security, wallet), not what is about the market's state.
  valuation: /evaluation|trust|reputation|security|audit|safety|wallet|address|contract|protocol|rug|scam|counterparty/i,
  gas: /optimizer|optimization|audit|security|contract|wallet|risk/i,
  'smart-money': /audit|security|rug|scam|due.?diligence|compliance/i,
  sentiment: /audit|shill|fact.?check|claim|verify/i,
};

export interface ProviderSignal {
  /** Times WE hired it. The confidence radius of the UCB policy shrinks as this grows. */
  hires: number;
  failScore: number;
  slowScore: number;
  updatedAt: number;
  lastLatencyMs?: number;
}

// Provider health. A soft score, never a banlist: slow/failed services become less likely for fast
// races, then recover as the score decays. DURABLE (see (de)serializeProviderSignals): kept in memory
// it was wiped by every redeploy, so the arena kept re-probing services it had already learned about
// and forgot who had failed it.
const providerSignals = new Map<string, ProviderSignal>();

function signalOf(serviceId: string): ProviderSignal {
  return providerSignals.get(serviceId) ?? { hires: 0, failScore: 0, slowScore: 0, updatedAt: Date.now() };
}

/** Count a hire the moment it is ORDERED (not when it succeeds): an exploration that fails is still an
 *  exploration, and must lower this provider's uncertainty, or the policy would probe it forever. */
export function markProviderHired(serviceId: string): void {
  if (!serviceId) return;
  const s = signalOf(serviceId);
  providerSignals.set(serviceId, { ...s, hires: s.hires + 1 });
}

export function serializeProviderSignals(): [string, ProviderSignal][] {
  return [...providerSignals.entries()];
}

export function restoreProviderSignals(rows: [string, ProviderSignal][] | undefined): void {
  if (!rows?.length) return;
  for (const [id, s] of rows) {
    if (!id || typeof s?.updatedAt !== 'number') continue;
    providerSignals.set(id, { hires: Number(s.hires) || 0, failScore: Number(s.failScore) || 0, slowScore: Number(s.slowScore) || 0, updatedAt: s.updatedAt, lastLatencyMs: s.lastLatencyMs });
  }
}

function slowThresholdMs(): number {
  const v = Number(process.env.ARENA_PROVIDER_SLOW_MS);
  return Number.isFinite(v) && v > 0 ? v : 150_000;
}

function halfLifeMs(): number {
  const v = Number(process.env.ARENA_PROVIDER_HEALTH_HALFLIFE_MS);
  return Number.isFinite(v) && v > 0 ? v : 6 * 60 * 60_000;
}

function withDecay(serviceId: string, atMs = Date.now()): ProviderSignal {
  const prev = signalOf(serviceId);
  const elapsed = Math.max(0, atMs - prev.updatedAt);
  const decay = Math.pow(0.5, elapsed / halfLifeMs());
  return {
    hires: prev.hires, // experience is not forgotten, only the health penalty decays
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

/** How hard the policy leans on the unknown. Raise it to sweep the store faster, lower it to settle. */
function explorationC(): number {
  const v = Number(process.env.ARENA_PROVIDER_EXPLORATION_C);
  return Number.isFinite(v) && v >= 0 ? v : 0.6;
}

/**
 * PROCUREMENT POLICY (UCB1). We are a buyer of data under a fixed per-round budget, so the question is
 * not "which provider predicts best": we cannot measure that (a persona's error is joint over its two
 * feeds, and 50 rounds carry no attribution power), and claiming otherwise would be a fake alpha. The
 * question a buyer CAN answer is "which supplier is worth the next order", and that is a bandit:
 *
 *   score = value  +  C * sqrt( ln(totalHires) / hires )
 *           ^ what we measured   ^ what we do not know yet
 *
 * value blends the only two honest signals: DELIVERY (does it answer, and fast, from our own experience,
 * decayed so a provider that fixes itself comes back) and the store's own 7d demand, as a prior for a
 * supplier we have never used. The confidence radius makes a never-hired provider win on purpose, once:
 * it is hired, its radius collapses, and it then competes on what it actually delivered. So the sweep is
 * automatic and it TERMINATES: no forced quota, no coin flip, and the day the store lists a new provider
 * the policy reaches for it by construction. Equal providers alternate, because hiring one lowers its own
 * radius, which is exactly the rotation we want.
 */
export function chooseByUcb(cands: DiscoveredProvider[]): DiscoveredProvider | null {
  if (!cands.length) return null;
  const maxDemand = Math.max(1, ...cands.map((c) => c.orders7d));
  const totalHires = cands.reduce((s, c) => s + signalOf(c.serviceId).hires, 0);
  let best: DiscoveredProvider | null = null;
  let bestScore = -Infinity;
  for (const c of cands) {
    const hires = signalOf(c.serviceId).hires;
    const demandPrior = Math.sqrt(Math.max(0, c.orders7d)) / Math.sqrt(maxDemand); // 0..1
    const value = 0.65 * providerHealthWeight(c.serviceId) + 0.35 * demandPrior;
    // A listing nobody has ever bought is the weakest bet in the pool, so it is explored LAST, not never.
    const cold = hires === 0 && c.orders7d < 1 ? 0.35 : 1;
    const bonus = explorationC() * Math.sqrt(Math.log(totalHires + 2) / (hires + 1)) * cold;
    const score = value + bonus;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return best;
}

/** Live candidates for a capability: store providers whose name matches the capability, under the price
 *  cap. The pick itself is `chooseByUcb`: slow providers become less likely, never removed forever. */
export async function candidatesForCapability(capability: string): Promise<DiscoveredProvider[]> {
  const kw = CAP_KEYWORDS[capability];
  if (!kw) return [];
  const deny = CAP_DENY[capability];
  return (await discoverProviders()).filter((p) =>
    kw.test(p.name) &&
    !(deny?.test(p.name)),
  );
}
