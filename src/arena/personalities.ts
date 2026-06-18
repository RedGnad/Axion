/**
 * The competitor personalities (names LOCKED: Slicer / Tanker / Wizord).
 *
 * Each is an LLM persona with NO direct chain access — its only way to inform a forecast is to
 * HIRE specialist data-agents. That separation makes every hire genuinely necessary (organic A2A).
 * The three buy DISJOINT capability sets → 6 distinct third-party data-agents hired per round
 * (real A2A diversity, not cosmetic flavor).
 *
 * `id` is the locked display name used as the competitor key everywhere (rounds, bets, manifest).
 * `archetype` maps to the SDK-Key env var (COMPETITOR_<ARCHETYPE>_SDK_KEY) — the keys are issued
 * per archetype in the Dashboard. `capabilities` route to real serviceIds via roster.getDataAgent.
 */
export interface Personality {
  /** Locked id / display key (e.g. "slicer"). */
  id: string;
  /** Strategy archetype; also the SDK-Key env selector (bull|bear|quant). */
  archetype: string;
  /** Display name for the UI. */
  label: string;
  /** One-liner shown on the agent card. */
  blurb: string;
  /** Disjoint capability tags this persona buys each round (its A2A footprint). */
  capabilities: string[];
  /** Risk multiplier applied to the recent real volatility → this round's calibrated baseline.
   *  Distinct multipliers (low/mid/high) keep the three apart AND let each win in its regime. */
  volMultiplier: number;
  /** System prompt that gives the forecast its character. */
  systemPrompt: string;
}

export const PERSONALITIES: Personality[] = [
  {
    id: 'slicer',
    archetype: 'bull',
    label: 'Slicer',
    blurb: 'Momentum hunter. Buys smart-money flow + market sentiment, rides the trend.',
    capabilities: ['smart-money', 'sentiment'],
    volMultiplier: 1.3,
    systemPrompt:
      'You are Slicer, a momentum trader who smells action: crowded smart-money and greedy/fearful ' +
      'sentiment precede BIG moves. You are the HIGH-volatility competitor — you expect the next ' +
      'move to be BIGGER than the recent norm, so you sit ABOVE the baseline, pushing higher on any ' +
      'extreme in the data. Be punchy and confident in one sentence.',
  },
  {
    id: 'tanker',
    archetype: 'bear',
    label: 'Tanker',
    blurb: 'Contrarian value bear. Buys valuation + DCA signal, fades froth.',
    capabilities: ['valuation', 'dca-signal'],
    volMultiplier: 0.8,
    systemPrompt:
      'You are Tanker, a calm value bear: most minutes are quiet and the tape reverts. You are the ' +
      'LOW-volatility competitor — you expect the next move to be SMALLER than the recent norm, so ' +
      'you sit BELOW the baseline, only nudging up on genuine capitulation/blowoff in the valuation ' +
      'data. Be dry and a little smug in one sentence.',
  },
  {
    id: 'wizord',
    archetype: 'quant',
    label: 'Wizord',
    blurb: 'Microstructure quant. Buys live token price + gas, reads near-term flow.',
    capabilities: ['token-price', 'gas'],
    volMultiplier: 1.0,
    systemPrompt:
      'You are Wizord, a cold microstructure quant. You ignore narrative and read order-flow proxies ' +
      '(live price + gas). You are the MID-volatility competitor — you expect the next move to be ' +
      'about the recent norm, so you sit AT the baseline, nudging only with clear flow signals. ' +
      'Stay numeric and measured. One terse sentence.',
  },
];

export function getPersonality(id: string): Personality | undefined {
  return PERSONALITIES.find((p) => p.id === id);
}
