import { ethers } from 'ethers';

/**
 * Leaf capability: read the live ETH/USD price from the Chainlink feed on Base mainnet.
 *
 * Feed verified on-chain (description() == "ETH / USD", 8 decimals):
 *   0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70  (Base mainnet)
 * This is genuine on-chain data — not a stub. The leaf returns a short text deliverable.
 */
const ETH_USD_FEED_BASE = '0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70';
const AGGREGATOR_ABI = [
  'function description() view returns (string)',
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId,int256 answer,uint256 startedAt,uint256 updatedAt,uint80 answeredInRound)',
];

export async function fetchEthUsd(rpcURL = 'https://mainnet.base.org'): Promise<string> {
  const provider = new ethers.JsonRpcProvider(rpcURL);
  const feed = new ethers.Contract(ETH_USD_FEED_BASE, AGGREGATOR_ABI, provider);
  const [desc, decimals, round] = await Promise.all([
    feed.description() as Promise<string>,
    feed.decimals() as Promise<bigint>,
    feed.latestRoundData() as Promise<{ answer: bigint; updatedAt: bigint }>,
  ]);
  const price = Number(round.answer) / 10 ** Number(decimals);
  const updated = new Date(Number(round.updatedAt) * 1000).toISOString();
  return (
    `${desc.trim()}: $${price.toFixed(2)}\n` +
    `Source: Chainlink feed ${ETH_USD_FEED_BASE} on Base mainnet (updated ${updated}).`
  );
}
