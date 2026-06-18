import { AgentClient, EventType, DeliverableType, type Event, type EventStream } from '@croo-network/sdk';
import { EventBus } from '../events.js';
import { Bookmaker } from './bookmaker.js';
import { USDC_BASE, type BetRequest } from './bet.js';

/**
 * Jalon 2 proof: one real CAP-native bet + payout on Base (fund-transfer mechanism #1).
 *
 * Flow: the bettor (requester) hires the bookmaker's fund-transfer service with fundAmount = stake
 * (USDC moves to the bookmaker's fund address). We then settle the vol bet against a line and have
 * the bookmaker pay the winning side by hiring the bettor's claim service with fundAmount = winnings.
 * Both legs are real on-chain orders. Spends real (tiny) USDC.
 */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name}`);
  return v;
}

const CREATE_TIMEOUT_MS = 60_000;
const COMPLETE_TIMEOUT_MS = 180_000;

/** Provider runtime for the bettor's claim service: accept payout (with fund address) + deliver. */
function attachClaimProvider(client: AgentClient, ws: EventStream, claimServiceId: string, fundAddress: string): void {
  ws.on(EventType.NegotiationCreated, (e: Event) => {
    void (async () => {
      if (e.service_id !== claimServiceId || !e.negotiation_id) return;
      try {
        await client.acceptNegotiationWithFundAddress(e.negotiation_id, fundAddress);
        console.log(`[bettor] accepted payout negotiation ${e.negotiation_id}`);
      } catch (err) {
        console.error('[bettor] accept payout failed:', (err as Error).message);
      }
    })();
  });
  ws.on(EventType.OrderPaid, (e: Event) => {
    void (async () => {
      if (!e.order_id) return;
      const order = await client.getOrder(e.order_id);
      if (order.serviceId !== claimServiceId) return;
      try {
        await client.deliverOrder(e.order_id, {
          deliverableType: DeliverableType.Text,
          deliverableText: JSON.stringify({ receipt: 'payout-received', amount: order.fundAmount }),
        });
        console.log(`[bettor] received payout order ${e.order_id} (fund ${order.fundAmount})`);
      } catch (err) {
        console.error('[bettor] deliver payout receipt failed:', (err as Error).message);
      }
    })();
  });
}

/** Bettor places one fund-transfer bet (requester side). Returns the on-chain order. */
async function placeBet(
  client: AgentClient,
  bus: EventBus,
  bookmakerServiceId: string,
  stake: number,
  req: BetRequest,
): Promise<{ orderId: string; payTxHash: string }> {
  const neg = await client.negotiateOrder({
    serviceId: bookmakerServiceId,
    requirements: JSON.stringify(req),
    fundAmount: String(stake),
    fundToken: USDC_BASE,
  });
  const created = await bus.wait(
    (e) => e.type === EventType.OrderCreated && e.negotiation_id === neg.negotiationId,
    CREATE_TIMEOUT_MS,
    'OrderCreated(bet)',
  );
  if (!created.order_id) throw new Error('bet OrderCreated had no order_id');
  const pay = await client.payOrder(created.order_id);
  console.log(`[bettor] placed bet, paid order ${created.order_id} (tx ${pay.txHash})`);
  await bus.wait(
    (e) => e.type === EventType.OrderCompleted && e.order_id === created.order_id,
    COMPLETE_TIMEOUT_MS,
    'OrderCompleted(bet)',
  );
  return { orderId: created.order_id, payTxHash: pay.txHash };
}

async function main(): Promise<void> {
  const cfg = { baseURL: requireEnv('CROO_API_URL'), wsURL: requireEnv('CROO_WS_URL') };

  // Bookmaker: one WS, one bus (payout buyer), provider handlers attached to the same WS.
  const bmClient = new AgentClient(cfg, requireEnv('BOOKMAKER_SDK_KEY'));
  const bmWs = await bmClient.connectWebSocket();
  const bmBus = new EventBus(bmWs);
  const bm = new Bookmaker({
    client: bmClient,
    serviceId: requireEnv('BOOKMAKER_SERVICE_ID'),
    fundAddress: requireEnv('BOOKMAKER_FUND_ADDRESS'),
    bus: bmBus,
    rakeBps: Number(process.env.BOOKMAKER_RAKE_BPS ?? '300'), // 3% house rake — the real economic loop
  });
  bm.attach(bmWs);

  // Bettor: one WS, one bus (bet buyer), claim provider on the same WS.
  const betClient = new AgentClient(cfg, requireEnv('BETTOR_SDK_KEY'));
  const betWs = await betClient.connectWebSocket();
  const betBus = new EventBus(betWs);
  const claimServiceId = requireEnv('BETTOR_CLAIM_SERVICE_ID');
  attachClaimProvider(betClient, betWs, claimServiceId, requireEnv('BETTOR_FUND_ADDRESS'));

  const roundId = `bet-test-${Date.now()}`;
  const stake = Number(process.env.BET_STAKE ?? '50000'); // 0.05 USDC (6 decimals)
  console.log(`\n[bet-slice] round ${roundId}: bettor stakes ${stake} on 'over'\n`);

  // 1. Place the bet (fund-transfer stake → bookmaker fund address).
  await placeBet(betClient, betBus, requireEnv('BOOKMAKER_SERVICE_ID'), stake, {
    round_id: roundId,
    side: 'over',
    claim_service_id: claimServiceId,
  });

  // Wait for the bookmaker to have recorded the bet (it records on OrderPaid).
  for (let i = 0; i < 20 && bm.betsFor(roundId).length === 0; i++) await new Promise((r) => setTimeout(r, 500));
  const booked = bm.betsFor(roundId);
  if (booked.length === 0) throw new Error('bookmaker did not record the bet');
  console.log(`[bet-slice] bookmaker booked ${booked.length} bet(s); pool ${booked.reduce((s, b) => s + b.amount, 0)}`);

  // 2. Settle the vol bet: line 1.0, realized amplitude 10.0 → 'over' wins → bettor takes the pool.
  const line = Number(process.env.BET_LINE ?? '1');
  const amplitude = Number(process.env.BET_AMPLITUDE ?? '10');
  const result = await bm.settleRound(roundId, line, amplitude);

  console.log(`\n===== bet settled: '${result.side}' won | pool ${result.pool} | RAKE ${result.rake} (house revenue, kept on-chain) | dust ${result.dust} =====`);
  for (const p of result.paid) {
    console.log(`- payout ${p.amount} to ${p.bettor} | order ${p.orderId}`);
    console.log(`    pay https://basescan.org/tx/${p.payTxHash}`);
  }
  console.log('\nresult (json): ' + JSON.stringify(result));
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
