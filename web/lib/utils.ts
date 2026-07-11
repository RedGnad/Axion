import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const usd = (n: number | null | undefined, dp = 2) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** Racing livery per agent (id-based): gives each competitor a distinct team color. */
export const LIVERY: Record<string, string> = {
  slicer: '#FF3B6B',
  tanker: '#2AD6C9',
  wizord: '#B583FF',
  'agent-b525': '#FF8A1F',
  b525: '#FF8A1F',
};

/** Hues of the fixed liveries above, so a community racer never lands on a persona's color. */
const RESERVED_HUES = [345, 175, 265, 30];

function colorHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const liveryKey = (id: string) => id.toLowerCase().replace(/\*+$/g, '');
const hueGap = (a: number, b: number) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };

/** Hue held by each racer. Written ONCE per racer and never rewritten: a color is owned, not recomputed. */
const assignedHues = new Map<string, number>();
/** Below this separation two liveries read as the same color, so the hash hue gets overridden. */
const COMFORT_GAP = 28;

/** Distance from `hue` to the nearest hue already in use. */
const clearance = (hue: number, taken: number[]) => taken.reduce((m, t) => Math.min(m, hueGap(t, hue)), 360);

/** Mid-blue reads flat on the dark track at our fixed 88%/62%, so the override search saves that band
 *  for a crowded wheel instead of handing it to the first collision. */
const MUTED_BAND: [number, number] = [195, 250];

/** Keep the hash hue when it is comfortably clear, else take the hue FARTHEST from every taken one.
 *  Among fallbacks, a punchy hue wins over a muted-band one unless the muted one is clearly freer
 *  (>12 degrees): blues arrive late, they are never banned. The farthest-point pick always exists,
 *  so a racer can never fall back onto a used color. */
function pickHue(preferred: number, taken: number[]): number {
  if (clearance(preferred, taken) >= COMFORT_GAP) return preferred;
  let best = preferred;
  let bestClearance = -1;
  let punchy = preferred;
  let punchyClearance = -1;
  for (let hue = 0; hue < 360; hue++) {
    const c = clearance(hue, taken);
    if (c > bestClearance) { bestClearance = c; best = hue; }
    if ((hue < MUTED_BAND[0] || hue > MUTED_BAND[1]) && c > punchyClearance) { punchyClearance = c; punchy = hue; }
  }
  return punchyClearance >= bestClearance - 12 ? punchy : best;
}

/** CURRENT label -> the label this racer FIRST raced under. A rename changes the name, never the agent,
 *  so the color is keyed on that first name: it is the closest thing the UI has to a stable identity. */
const bornAs = new Map<string, string>();

/**
 * Teach the livery which names belong to the same racer. `origins` is the runner's CURRENT label ->
 * FIRST label map (resolved from the CROO service id), so b525 renamed to Remi keeps its orange and
 * CROOCRED renamed to agent-0dc7 keeps its fuchsia, instead of being colored as newcomers.
 * Call it before `assignLivery`.
 */
export function inheritLivery(origins?: Record<string, string>): void {
  if (!origins) return;
  for (const [currentId, originId] of Object.entries(origins)) {
    const to = liveryKey(currentId);
    const from = liveryKey(originId);
    if (!to || !from) continue;
    bornAs.set(to, from);
  }
}

/** The name a racer's color is owned by: its first one, whatever it calls itself today. */
const colorKey = (id: string) => {
  const key = liveryKey(id);
  return bornAs.get(key) ?? key;
};

/**
 * Give each community racer one distinct hue, ONCE. A raw `hash % 360` collides constantly at this
 * scale (edgerunner 102, dca-signal 106, pulsebnb 124 and alphaprobe 135 all read as the same green),
 * so the hash is only a PREFERENCE: a crowded hue is moved to the emptiest arc of the wheel.
 *
 * A racer that already owns a hue KEEPS it. Only newcomers are placed, against every hue already
 * spoken for, so a joining agent can never recolor the field. `ids` must arrive in a stable order
 * (roster join order first) so a page reload replays the same assignment.
 */
export function assignLivery(ids: string[]): void {
  for (const id of ids) {
    const key = colorKey(id);
    if (!key || LIVERY[key] || assignedHues.has(key)) continue;
    const taken = [...RESERVED_HUES, ...assignedHues.values()];
    assignedHues.set(key, pickHue(colorHash(key) % 360, taken));
  }
}

export const livery = (id: string) => {
  const key = colorKey(id);
  if (LIVERY[key]) return LIVERY[key];
  const hue = assignedHues.get(key) ?? colorHash(key) % 360; // fallback: racer not in the last pass
  return `hsl(${hue} 88% 62%)`;
};
