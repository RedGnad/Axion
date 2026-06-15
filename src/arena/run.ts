import { loadCompetitors, runRound } from './loop.js';

/**
 * Arena entrypoint: run one (or a few) live rounds on Base and print a verifiable manifest.
 *
 * Running spends real USDC — each competitor's hires are real CAP orders. Configure before use:
 *   CROO_API_URL, CROO_WS_URL                      (CROO endpoints)
 *   COMPETITOR_BULL_SDK_KEY / _BEAR_ / _QUANT_     (one per competitor agent, funded AA wallet)
 *   ANTHROPIC_API_KEY                              (persona forecasts)
 *   BASE_RPC_URL        (optional)                 (Chainlink reads; defaults to mainnet.base.org)
 *   ARENA_ROUNDS        (optional, default 1)
 *   ARENA_WINDOW_SECONDS(optional, default 120)
 */
function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env: ${name} (see .env / .env.example)`);
  return v;
}

async function main(): Promise<void> {
  const cfg = {
    baseURL: requireEnv('CROO_API_URL'),
    wsURL: requireEnv('CROO_WS_URL'),
    rpcURL: process.env.BASE_RPC_URL,
  };
  const rounds = Number(process.env.ARENA_ROUNDS ?? '1');
  const windowSeconds = Number(process.env.ARENA_WINDOW_SECONDS ?? '120');

  const competitors = await loadCompetitors(cfg);
  console.log(`[arena] ${competitors.length} competitors live: ${competitors.map((c) => c.persona.id).join(', ')}`);

  for (let i = 0; i < rounds; i++) {
    const { round, edges } = await runRound(competitors, cfg, windowSeconds);

    console.log(`\n===== ${round.id} =====`);
    console.log(
      `open $${round.openPrice.toFixed(2)} -> close $${round.closePrice?.toFixed(2)} | ` +
        `amplitude $${round.outcome?.actual.toFixed(2)} | winner(s): ${round.outcome?.winners.join(', ')}`,
    );
    console.log('\nAmplitude estimates:');
    for (const f of round.forecasts) {
      console.log(`- ${f.competitor}: $${f.prediction.toFixed(2)} (err ${round.outcome?.errors[f.competitor].toFixed(2)}) reasonHash ${f.reasonHash.slice(0, 18)}…`);
    }
    console.log(`\nA2A edges this round (${edges.length} real CAP orders — verify on Base):`);
    for (const e of edges) {
      console.log(`- ${e.competitor} hired ${e.label} [ours=${e.ours}] order ${e.orderId}`);
      console.log(`    pay   https://basescan.org/tx/${e.payTxHash}`);
      console.log(`    clear https://basescan.org/tx/${e.clearTxHash}`);
    }
    console.log('\nmanifest (json): ' + JSON.stringify({ round, edges }));
  }
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
