'use client';
import { RUNNER_URL } from './runner';

/** Base USDC (6 decimals) — the same asset CROO settles on. */
export const USDC_ADDRESS = '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913' as const;
export const ERC20_TRANSFER_ABI = [
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const;

/** Register a verified USDC bet with the runner (the on-chain transfer is done via wagmi in the UI). */
export async function postUsdcBet(roundId: string, agentId: string, amountUSDC: number, eoa: string, txHash: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const r = await fetch(`${RUNNER_URL}/api/bet`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roundId, agentId, amountUSDC, eoa, txHash }),
    });
    const j = (await r.json()) as { ok?: boolean; error?: string };
    return r.ok ? { ok: true } : { ok: false, error: j.error || String(r.status) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
