/**
 * Fast settlement oracle: Pyth ETH/USD via Hermes (off-chain, sub-second, signed).
 *
 * Why not the on-chain feed: Chainlink ETH/USD on Base updates only every ~11-13 min, and Pyth's
 * on-chain price on Base is pull-based (stale unless someone pushes). Over a 60s round both are
 * frozen → no measurable move. Hermes serves sub-second prices, each carrying a signed Wormhole
 * VAA → exogenous and reproducible (not controlled by us). We record `publishTime` + the VAA so the
 * settlement is independently verifiable, even though the read itself is off-chain.
 */
const HERMES = 'https://hermes.pyth.network/v2/updates/price/latest';

/** Pyth price feed id for ETH/USD (same id across chains). */
export const PYTH_ETH_USD = '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace';

export interface OracleReading {
  /** Price in USD. */
  price: number;
  /** Pyth publish time (unix seconds) — the authoritative timestamp of this reading. */
  publishTime: number;
  /** Signed update blob (hex) for independent verification; '' if absent. */
  vaa: string;
}

interface HermesResponse {
  parsed: { price: { price: string; conf: string; expo: number; publish_time: number } }[];
  binary?: { data?: string[] };
}

/** Read the latest signed ETH/USD price from Pyth Hermes. */
export async function fetchPythPrice(id: string = PYTH_ETH_USD): Promise<OracleReading> {
  const r = await fetch(`${HERMES}?ids[]=${id}`);
  if (!r.ok) throw new Error(`Hermes ${r.status}`);
  const j = (await r.json()) as HermesResponse;
  const p = j.parsed?.[0]?.price;
  if (!p) throw new Error('Hermes returned no price');
  return {
    price: Number(p.price) * 10 ** p.expo,
    publishTime: p.publish_time,
    vaa: j.binary?.data?.[0] ?? '',
  };
}
