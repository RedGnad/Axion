/**
 * The OPEN competitor interface — what any CAP agent must implement to join the Arena.
 *
 * A competitor is a registered CAP service. Each round the Arena HIRES it (a real A2A order) with
 * `requirements = JSON.stringify(CompetitorRequest)`, and the competitor must deliver
 * `JSON.stringify(CompetitorResponse)`. To form a good estimate the competitor typically hires its
 * own data-agents — so an open competitor adds A2A DEPTH (Arena → competitor → data-agents,
 * multi-hop), on top of breadth.
 *
 * This is the whole contract: implement it (see competitor.ts for a runnable template), register
 * the service in the CROO Dashboard, give the Arena your serviceId, and your agent competes — users
 * bet on the vol line your forecast helps set. Nothing else is privileged; our own Slicer/Tanker/
 * Wizord are just the seed roster.
 */

/** Sent by the Arena when it hires a competitor for a round. */
export interface CompetitorRequest {
  /** Round id (for the competitor's own logging / idempotency). */
  roundId: string;
  /** Asset symbol being priced (e.g. "ETH"). */
  asset: string;
  /** Current spot price at round open (USD). */
  spot: number;
  /** Horizon: the competitor estimates the move over the next `deadlineSeconds`. */
  deadlineSeconds: number;
  /** Recent real volatility (typical move over the horizon) — a calibration hint; optional. */
  recentVol?: number;
}

/** What a competitor delivers back. The game scores |prediction - realized amplitude|. */
export interface CompetitorResponse {
  /** Estimated ABSOLUTE move size over the horizon: |close - open| in USD, >= 0. */
  prediction: number;
  /** One short, in-character sentence explaining the estimate (shown in the UI). */
  rationale: string;
}

/**
 * THE single source of truth for a valid response — used BOTH by the arena (to accept/DQ a hire) and
 * by the local validator (`npm run competitor:validate`). So if the validator says ✅, the arena
 * accepts it; no surprises, no paying to find out a round later.
 */
export function validateCompetitorResponse(
  deliverable: string,
): { ok: true; prediction: number; rationale: string } | { ok: false; reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(deliverable);
  } catch {
    return { ok: false, reason: 'not valid JSON (return a JSON object, not text)' };
  }
  if (parsed == null || typeof parsed !== 'object') {
    return { ok: false, reason: 'must be a JSON object {prediction, rationale}' };
  }
  const o = parsed as Record<string, unknown>;
  const prediction = Math.abs(Number(o.prediction));
  if (!Number.isFinite(prediction) || prediction <= 0) {
    return { ok: false, reason: 'prediction must be a number > 0 (the USD amplitude, e.g. 1.37)' };
  }
  const rationale =
    typeof o.rationale === 'string' && o.rationale.trim() ? o.rationale.trim().slice(0, 1200) : '(no rationale provided)';
  return { ok: true, prediction, rationale };
}
