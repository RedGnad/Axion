import { AgentClient, InsufficientBalanceError } from '@croo-network/sdk';
import { EventBus } from './events.js';
import { Orchestrator } from './orchestrator.js';
import { startLeafProvider } from './provider.js';
import { fetchEthUsd } from './leafs/price.js';
import { summarize } from './leafs/summarize.js';
import { getRoster } from './roster.js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name} (see .env / .env.example)`);
  return v;
}

/**
 * Vertical slice (FLOOR): Axion hires our own `price` leaf for one real on-chain CAP order,
 * pays USDC into escrow, gets the delivery, composes, and prints a verifiable manifest.
 * Runs the leaf provider + the Axion buyer in one process for an easy local demo.
 */
async function main(): Promise<void> {
  const baseURL = requireEnv('CROO_API_URL');
  const wsURL = requireEnv('CROO_WS_URL');
  const rpcURL = process.env.BASE_RPC_URL;
  const axionKey = requireEnv('CROO_SDK_KEY');
  const priceKey = requireEnv('LEAF_PRICE_SDK_KEY');
  requireEnv('LEAF_PRICE_SERVICE_ID');

  if (!getRoster().some((r) => r.capability === 'price')) {
    throw new Error('roster empty — set LEAF_PRICE_SERVICE_ID in .env');
  }
  const clientCfg = { baseURL, wsURL, ...(rpcURL ? { rpcURL } : {}) };

  // 1. Start the leaf providers (each with its own SDK-Key): accept negotiations + deliver on pay.
  const priceClient = new AgentClient(clientCfg, priceKey);
  await startLeafProvider(priceClient, 'price', async () => fetchEthUsd(rpcURL));

  // Stage-2 summarizer leaf — only if registered (its key + serviceId in .env).
  const summarizeKey = process.env.LEAF_SUMMARIZE_SDK_KEY;
  if (summarizeKey && getRoster().some((r) => r.capability === 'summarize')) {
    const summarizeClient = new AgentClient(clientCfg, summarizeKey);
    await startLeafProvider(summarizeClient, 'summarize', async (req) => summarize(req));
  }

  // 2. Axion buyer: WS + event bus, then run the goal.
  const axion = new AgentClient(clientCfg, axionKey);
  const buyerWs = await axion.connectWebSocket();
  const bus = new EventBus(buyerWs);
  const orchestrator = new Orchestrator(axion, bus);

  const goal = 'One-page ETH brief: current ETH/USD on-chain + plain-English summary.';
  console.log(`\n[axion] goal: ${goal}\n`);

  const { output, hires } = await orchestrator.run(goal);

  const manifest = hires.map((h) => ({
    capability: h.subtask.capability,
    serviceId: h.service.serviceId,
    orderId: h.orderId,
    payTxHash: h.payTxHash,
    clearTxHash: h.clearTxHash,
    ours: h.service.ours,
  }));

  console.log('\n===== Composed result =====\n');
  console.log(output);
  console.log('\n===== Manifest (every sub-order — verify on Base) =====');
  for (const m of manifest) {
    console.log(`- ${m.capability} | ours=${m.ours} | order ${m.orderId}`);
    console.log(`    pay   https://basescan.org/tx/${m.payTxHash}`);
    console.log(`    clear https://basescan.org/tx/${m.clearTxHash}`);
  }
  console.log('\nmanifest (json): ' + JSON.stringify(manifest));
  process.exit(0);
}

main().catch((err) => {
  if (err instanceof InsufficientBalanceError) {
    console.error(
      "\n[axion] Axion's AA wallet is underfunded. Send a little USDC (Base) to its AA wallet " +
        'address (shown in the CROO Dashboard), then re-run. No ETH needed (gas is sponsored).\n',
    );
  }
  console.error(err);
  process.exit(1);
});
