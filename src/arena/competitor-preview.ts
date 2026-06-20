import { fetchPythPrice } from './oracle.js';
import { forecast } from './forecast.js';
import { getPersonality, PERSONALITIES } from './personalities.js';
import type { CompetitorRequest, CompetitorResponse } from './competitor-contract.js';

/**
 * Zero-config PREVIEW of the competitor contract — your fastest "first success".
 *
 * No CROO keys, no registration, no USDC: it reads live ETH/USD from Pyth, builds a sample
 * {@link CompetitorRequest}, and prints the {@link CompetitorResponse} your agent would return this
 * second. Run `npm run competitor:preview` to see the round-trip before you register anything.
 * (With ANTHROPIC_API_KEY it uses the model; without, the deterministic baseline.)
 */
async function sampleRecentVol(samples = 6, gapMs = 1500, horizonSeconds = 60): Promise<{ spot: number; vol: number }> {
  const prices: number[] = [];
  for (let i = 0; i < samples; i++) {
    prices.push((await fetchPythPrice()).price);
    if (i < samples - 1) await new Promise((r) => setTimeout(r, gapMs));
  }
  const spot = prices[prices.length - 1];
  let sum = 0, n = 0;
  for (let i = 1; i < prices.length; i++) { sum += Math.abs(prices[i] - prices[i - 1]); n++; }
  const perGap = n ? sum / n : Math.max(0.4, spot * 0.0003);
  // Random-walk scale the per-sample move up to the horizon (a rough calibration hint).
  const vol = Math.max(0.4, perGap * Math.sqrt((horizonSeconds * 1000) / gapMs));
  return { spot, vol };
}

async function main(): Promise<void> {
  const personaId = process.env.COMPETITOR_PERSONA ?? PERSONALITIES[0].id;
  const persona = getPersonality(personaId);
  if (!persona) throw new Error(`unknown COMPETITOR_PERSONA '${personaId}' (have: ${PERSONALITIES.map((p) => p.id).join(', ')})`);

  console.log(`\n  Axion Arena — competitor preview (${persona.label})  ·  live ETH/USD from Pyth, no CROO/USDC\n`);
  const { spot, vol } = await sampleRecentVol();
  const req: CompetitorRequest = { roundId: `preview-${Date.now()}`, asset: 'ETH', spot: Number(spot.toFixed(2)), deadlineSeconds: 60, recentVol: Number(vol.toFixed(2)) };

  const baseline = vol * persona.volMultiplier;
  let resp: CompetitorResponse;
  if (process.env.ANTHROPIC_API_KEY) {
    const d = await forecast(persona, spot, [], req.deadlineSeconds, baseline);
    resp = { prediction: d.prediction, rationale: d.rationale };
  } else {
    const prediction = Math.max(0.01, Number((baseline + 0.01 * persona.volMultiplier).toFixed(2)));
    resp = { prediction, rationale: `${persona.label}: deterministic ~$${prediction.toFixed(2)} (set ANTHROPIC_API_KEY for the model + data).` };
  }

  console.log('  Arena → your agent  (CompetitorRequest):');
  console.log('   ', JSON.stringify(req));
  console.log('\n  your agent → Arena  (CompetitorResponse):');
  console.log('   ', JSON.stringify(resp));
  console.log(`\n  → predicting a ~$${resp.prediction.toFixed(2)} ETH move over the next ${req.deadlineSeconds}s.`);
  console.log('\n  Next: register a CAP service, set COMPETITOR_SDK_KEY + COMPETITOR_SERVICE_ID, run `npm run competitor`,');
  console.log('  then add your serviceId to the Arena (POST /api/competitor or the "Enter a runner" form).\n');
}

main().catch((err) => { console.error(err); process.exit(1); });
