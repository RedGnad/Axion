import Anthropic from '@anthropic-ai/sdk';
import type { Personality } from './personalities.js';

/**
 * Turn a persona + the data deliverables it PAID for into a committed ETH/USD forecast.
 *
 * Pure compute over already-fetched inputs — no CAP/USDC here (the hiring happens upstream in
 * loop.ts). Uses Claude Haiku for cost (many rounds); swap to Sonnet for richer trash-talk.
 * Returns a number + one-line rationale; never invents data beyond what was provided.
 */
const ARENA_MODEL = 'claude-haiku-4-5'; // cheap; distinct risk bands + 2-decimal contract keep estimates apart

export interface DataInput {
  /** Human label of the data-agent that produced this (for the rationale + UI). */
  label: string;
  /** The deliverable text the competitor paid for. */
  text: string;
}

export interface ForecastDraft {
  prediction: number;
  rationale: string;
}

export async function forecast(
  persona: Personality,
  spotPrice: number,
  inputs: DataInput[],
  horizonSeconds = 60,
): Promise<ForecastDraft> {
  const dataBlock = inputs.length
    ? inputs.map((i) => `### ${i.label}\n${i.text}`).join('\n\n')
    : '(no data purchased this round)';

  const client = new Anthropic(); // ANTHROPIC_API_KEY from env
  const msg = await client.messages.create({
    model: ARENA_MODEL,
    max_tokens: 300,
    system:
      persona.systemPrompt +
      `\n\nThe game: estimate the ABSOLUTE SIZE of the ETH/USD move (in USD, always >= 0) over the ` +
      `next ~${horizonSeconds} seconds — i.e. |price_then - price_now|, NOT the direction and NOT ` +
      `the level. Stay true to YOUR risk band above — your number should reflect your persona, so ` +
      `the three competitors land on clearly DIFFERENT values. Give a PRECISE 2-decimal number ` +
      `(e.g. 1.37, 2.84 — never a round number like 2 or 2.0). Use ONLY the data provided plus the ` +
      `spot; never invent numbers. Respond with ONLY a JSON object: ` +
      `{"prediction": <usd amplitude, 2 decimals>, "rationale": "<one in-character sentence>"}.`,
    messages: [
      {
        role: 'user',
        content:
          `Current ETH/USD spot: ${spotPrice}\n\nData you purchased:\n${dataBlock}\n\n` +
          `Estimate the absolute USD move over the next ~${horizonSeconds}s as JSON.`,
      },
    ],
  });

  const text = msg.content
    .filter((b): b is Anthropic.TextBlock => b.type === 'text')
    .map((b) => b.text)
    .join('')
    .trim();

  return parseForecast(text, spotPrice);
}

/** Robustly extract {prediction, rationale} as a non-negative USD amplitude. */
export function parseForecast(text: string, _spotPrice: number): ForecastDraft {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      const o = JSON.parse(jsonMatch[0]) as { prediction?: unknown; rationale?: unknown };
      const prediction = Math.abs(Number(o.prediction));
      if (Number.isFinite(prediction)) {
        const rationale =
          typeof o.rationale === 'string' && o.rationale.trim()
            ? o.rationale.trim()
            : '(no rationale)';
        return { prediction, rationale };
      }
    } catch {
      /* fall through */
    }
  }
  // Last resort: first plausible small number in the text, else a tiny default amplitude.
  const num = text.match(/\d+(?:\.\d+)?/);
  const prediction = num ? Math.abs(Number(num[0])) : 1;
  return { prediction, rationale: '(unparseable model output; defaulted amplitude)' };
}
