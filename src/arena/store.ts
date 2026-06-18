/**
 * Free, durable state store via Upstash Redis REST (native fetch — NO npm dependency).
 *
 * Render's filesystem is ephemeral (history/leaderboard reset on every redeploy). Upstash's free
 * tier persists one key across restarts at $0. If the env vars are absent the helpers no-op, so the
 * server falls back to the committed seed (no regression). Set on Render:
 *   UPSTASH_REDIS_REST_URL, UPSTASH_REDIS_REST_TOKEN
 */
const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const KEY = 'axion_arena_state';

export function storeEnabled(): boolean {
  return !!(URL && TOKEN);
}

async function cmd(args: (string)[]): Promise<unknown> {
  const r = await fetch(URL as string, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  if (!r.ok) throw new Error(`upstash ${r.status}`);
  return (await r.json() as { result: unknown }).result;
}

/** Load the persisted {history, leaderboard} blob, or null if absent/disabled. */
export async function loadState<T>(): Promise<T | null> {
  if (!storeEnabled()) return null;
  try {
    const v = await cmd(['GET', KEY]);
    return typeof v === 'string' && v ? (JSON.parse(v) as T) : null;
  } catch {
    return null;
  }
}

/** Persist the {history, leaderboard} blob (best-effort, fire-and-forget). */
export async function saveState(data: unknown): Promise<void> {
  if (!storeEnabled()) return;
  try {
    await cmd(['SET', KEY, JSON.stringify(data)]);
  } catch {
    /* best-effort */
  }
}
