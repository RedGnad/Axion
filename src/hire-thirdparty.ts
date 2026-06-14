import { AgentClient, InsufficientBalanceError } from '@croo-network/sdk';
import { EventBus } from './events.js';
import { Orchestrator } from './orchestrator.js';
import { getRoster } from './roster.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

/**
 * Hire ONE real THIRD-PARTY agent end-to-end (non-self-trade) to prove genuine A2A diversity.
 * Axion is buyer only here — the third party runs its own provider. Bounded risk: if their
 * provider never accepts, we never pay; if they accept but don't deliver, escrow refunds on expiry.
 */
async function main(): Promise<void> {
  const cfg = {
    baseURL: requireEnv('CROO_API_URL'),
    wsURL: requireEnv('CROO_WS_URL'),
    ...(process.env.BASE_RPC_URL ? { rpcURL: process.env.BASE_RPC_URL } : {}),
  };
  const axion = new AgentClient(cfg, requireEnv('CROO_SDK_KEY'));
  const ws = await axion.connectWebSocket();
  const bus = new EventBus(ws);
  const orchestrator = new Orchestrator(axion, bus);

  const targetCap = process.argv[2];
  const entry = targetCap
    ? getRoster().find((r) => r.capability === targetCap && !r.ours)
    : getRoster().find((r) => !r.ours);
  if (!entry) throw new Error(`no third-party service in roster${targetCap ? ` for capability ${targetCap}` : ''}`);
  console.log(`[axion] hiring THIRD-PARTY: ${entry.label}\n  serviceId=${entry.serviceId} ours=${entry.ours}\n`);

  const hire = await orchestrator.hire({
    capability: entry.capability,
    requirements: JSON.stringify({
      goal: 'Audit the trust of the CROO agent axion-price and return your standard report.',
      agents: ['axion-price'],
      agentIds: ['0364ae3b-edd3-440d-9ecd-2f89c491cf41'],
    }),
  });

  console.log('\n===== Third-party deliverable =====\n');
  console.log(hire.deliverable);
  console.log('\n===== Manifest (NON-self-trade — verify on Base) =====');
  console.log(`- ${hire.subtask.capability} | ours=${hire.service.ours} | order ${hire.orderId}`);
  console.log(`    pay   https://basescan.org/tx/${hire.payTxHash}`);
  console.log(`    clear https://basescan.org/tx/${hire.clearTxHash}`);
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof InsufficientBalanceError) {
    console.error("\n[axion] AA wallet underfunded — top up USDC on Base and retry.\n");
  }
  console.error(err);
  process.exit(1);
});
