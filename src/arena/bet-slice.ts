import { AgentClient, DeliverableType } from '@croo-network/sdk';
import { Orchestrator } from '../orchestrator.js';
import { Bookmaker } from './bookmaker.js';
import { USDC_BASE, type BetRequest } from './bet.js';

/**
 * Proof: one real CAP-native bet + payout on Base with a house RAKE (the economic loop).
 *
 * Bettor (requester) hires the bookmaker's fund-transfer service with fundAmount = stake (USDC → the
 * bookmaker fund address). On settlement the bookmaker keeps the rake and pays the winning side by
 * hiring the bettor's claim service with fundAmount = winnings. Both legs are real on-chain orders;
 * the rake stays in the bookmaker's wallet = verifiable revenue. ALL flows POLL (CROO WS unreliable).
 */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

/** Bettor's claim-service provider: WS connection = "accepting orders"; polling does accept+deliver. */
async function startClaimProvider(client: AgentClient, claimServiceId: string, fundAddress: string): Promise<void> {
  try { await client.connectWebSocket(); } catch { /* connection = "accepting"; events unused */ }
  const delivered = new Set<string>();
  const tick = async (): Promise<void> => {
    try {
      const negs = await client.listNegotiations({ role: 'provider', status: 'pending', page: 1, pageSize: 25 });
      for (const n of negs) if (n.serviceId === claimServiceId) { try { await client.acceptNegotiationWithFundAddress(n.negotiationId, fundAddress); console.log(`[bettor] accepted payout ${n.negotiationId}`); } catch { /* retry */ } }
      const orders = await client.listOrders({ role: 'provider', status: 'paid', page: 1, pageSize: 25 });
      for (const o of orders) if (o.serviceId === claimServiceId && !delivered.has(o.orderId)) {
        try { await client.deliverOrder(o.orderId, { deliverableType: DeliverableType.Text, deliverableText: JSON.stringify({ receipt: 'payout-received', amount: o.fundAmount }) }); delivered.add(o.orderId); console.log(`[bettor] received payout ${o.orderId} (fund ${o.fundAmount})`); } catch { /* retry */ }
      }
    } catch { /* transient */ }
  };
  setInterval(() => void tick(), 4000);
}

async function main(): Promise<void> {
  const cfg = { baseURL: requireEnv('CROO_API_URL'), wsURL: requireEnv('CROO_WS_URL') };

  // Bookmaker (provider of the bet service + payer) — polling, no WS.
  const bmClient = new AgentClient(cfg, requireEnv('BOOKMAKER_SDK_KEY'));
  const bookmakerServiceId = requireEnv('BOOKMAKER_SERVICE_ID');
  const bm = new Bookmaker({
    client: bmClient,
    serviceId: bookmakerServiceId,
    fundAddress: requireEnv('BOOKMAKER_FUND_ADDRESS'),
    rakeBps: Number(process.env.BOOKMAKER_RAKE_BPS ?? '300'), // 3% house rake — the real economic loop
  });
  await bm.start();

  // Bettor (places the bet as requester + provides the claim service to receive the payout).
  const betClient = new AgentClient(cfg, requireEnv('BETTOR_SDK_KEY'));
  const claimServiceId = requireEnv('BETTOR_CLAIM_SERVICE_ID');
  await startClaimProvider(betClient, claimServiceId, requireEnv('BETTOR_FUND_ADDRESS'));
  const bettorOrch = new Orchestrator(betClient);
  // Give the providers' WS a moment to register as "accepting" before placing the bet.
  await new Promise((r) => setTimeout(r, 3000));

  const roundId = `bet-test-${Date.now()}`;
  const stake = Number(process.env.BET_STAKE ?? '50000'); // 0.05 USDC (6 decimals)
  const req: BetRequest = { round_id: roundId, side: 'over', claim_service_id: claimServiceId };
  console.log(`\n[bet-slice] round ${roundId}: bettor stakes ${stake} on 'over'\n`);

  // 1. Place the bet (fund-transfer stake → bookmaker fund address), via the polling Orchestrator.
  const betHire = await bettorOrch.hireService(
    { capability: 'bet', serviceId: bookmakerServiceId, label: 'bookmaker', ours: false },
    JSON.stringify(req),
    { fundAmount: String(stake), fundToken: USDC_BASE },
  );
  console.log(`[bet-slice] bet placed on-chain — order ${betHire.orderId} pay https://basescan.org/tx/${betHire.payTxHash}`);

  // 2. Wait for the bookmaker to have recorded the bet (its provider loop books it).
  for (let i = 0; i < 30 && bm.betsFor(roundId).length === 0; i++) await new Promise((r) => setTimeout(r, 1000));
  const booked = bm.betsFor(roundId);
  if (booked.length === 0) throw new Error('bookmaker did not record the bet');
  console.log(`[bet-slice] bookmaker booked ${booked.length} bet(s); pool ${booked.reduce((s, b) => s + b.amount, 0)}`);

  // 3. Settle: 'over' wins → winners split (pool − rake); the house keeps the rake on-chain.
  const line = Number(process.env.BET_LINE ?? '1');
  const amplitude = Number(process.env.BET_AMPLITUDE ?? '10');
  const result = await bm.settleRound(roundId, line, amplitude);

  console.log(`\n===== settled: '${result.side}' | pool ${result.pool} | RAKE ${result.rake} (house revenue, kept on-chain) | dust ${result.dust} =====`);
  for (const p of result.paid) console.log(`- payout ${p.amount} to ${p.bettor} | pay https://basescan.org/tx/${p.payTxHash}`);
  console.log('\nresult (json): ' + JSON.stringify(result));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
