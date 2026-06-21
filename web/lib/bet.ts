'use client';
import { createWalletClient, custom, getAddress, parseUnits } from 'viem';
import { base } from 'viem/chains';
import { RUNNER_URL } from './runner';

/**
 * Custodial-but-disclosed human USDC betting from an EOA wallet (Base).
 * The bettor sends USDC to the house address (one wallet tx); the runner verifies it on-chain before
 * counting, and the house pays winners back at settle. Disclosed in the UI; small stakes only.
 */
const USDC = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'; // Base USDC (6 decimals)
const BASE_HEX = '0x2105'; // Base mainnet chainId 8453
const ERC20_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

function injected(): { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> } {
  const eth = (typeof window !== 'undefined' ? (window as unknown as { ethereum?: unknown }).ethereum : undefined) as
    | { request: (a: { method: string; params?: unknown[] }) => Promise<unknown> }
    | undefined;
  if (!eth) throw new Error('No wallet found — install MetaMask, Rabby, or Coinbase Wallet');
  return eth;
}

/** Send the USDC bet tx (to the house) and return the txHash + the bettor's address. */
export async function placeUsdcBet(house: string, amountUSDC: number): Promise<{ txHash: string; eoa: string }> {
  const eth = injected();
  const [account] = (await eth.request({ method: 'eth_requestAccounts' })) as string[];
  try {
    await eth.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: BASE_HEX }] });
  } catch {
    /* user may already be on Base, or rejected the switch — the write will fail clearly if wrong chain */
  }
  const client = createWalletClient({ account: getAddress(account), chain: base, transport: custom(eth) });
  const txHash = await client.writeContract({
    address: USDC,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [getAddress(house), parseUnits(String(amountUSDC), 6)],
  });
  return { txHash, eoa: account };
}

/** Register the verified bet with the runner so it joins the pari-mutuel pool. */
export async function postUsdcBet(roundId: string, side: 'over' | 'under', amountUSDC: number, eoa: string, txHash: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${RUNNER_URL}/api/bet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roundId, side, amountUSDC, eoa, txHash }),
    });
    const j = (await r.json()) as { ok?: boolean; error?: string };
    return r.ok ? { ok: true } : { ok: false, error: j.error || String(r.status) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
