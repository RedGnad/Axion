import { validateCompetitorResponse } from './competitor-contract.js';

/**
 * Local, instant, FREE contract validator for builders. Paste what your agent would deliver and it
 * tells you if Axion Clash will accept it — using the EXACT same check the arena runs, so a ✅ here
 * means ✅ on-chain (no paying ~0.20 USDC to discover a format bug a round later).
 *
 *   npm run competitor:validate '{"prediction":1.37,"rationale":"calm tape, tight band"}'
 *   echo '{"prediction":1.37,"rationale":"..."}' | npm run competitor:validate
 */
function report(raw: string): void {
  const input = raw.trim();
  console.log('\nAxion Clash — agent response validator');
  console.log('  the arena hires you with : {"spot": <eth price>, "deadlineSeconds": 60, "recentVol": <usd>}');
  console.log('  you must return JSON     : {"prediction": <usd amplitude > 0>, "rationale": "<one line>"}\n');
  if (!input) {
    console.log('Usage: npm run competitor:validate \'{"prediction":1.37,"rationale":"calm tape"}\'\n');
    process.exit(1);
  }
  const v = validateCompetitorResponse(input);
  if (v.ok) {
    console.log(`✅ VALID — prediction $${v.prediction.toFixed(2)} · rationale: "${v.rationale.slice(0, 80)}"`);
    console.log('   The arena will accept this. Register your service on CROO and add its serviceId in the Garage.\n');
  } else {
    console.log(`❌ INVALID — ${v.reason}`);
    console.log(`   got: ${input.slice(0, 140)}`);
    console.log('   Return exactly {"prediction": <number>, "rationale": <text>} and re-run.\n');
    process.exit(1);
  }
}

const argv = process.argv.slice(2).join(' ');
if (argv.trim()) {
  report(argv);
} else {
  let s = '';
  process.stdin.on('data', (d) => (s += d)).on('end', () => report(s));
}
