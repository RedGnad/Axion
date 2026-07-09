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

/** Hues resolved by the last assignLivery() pass, keyed by racer. */
const assignedHues = new Map<string, number>();
/** Below this separation two liveries read as the same color, so the hash hue gets overridden. */
const COMFORT_GAP = 28;

/** Distance from `hue` to the nearest hue already in use. */
const clearance = (hue: number, taken: number[]) => taken.reduce((m, t) => Math.min(m, hueGap(t, hue)), 360);

/** Keep the hash hue when it is comfortably clear, else take the hue FARTHEST from every taken one.
 *  The farthest-point pick always exists, so a racer can never fall back onto a used color. */
function pickHue(preferred: number, taken: number[]): number {
  if (clearance(preferred, taken) >= COMFORT_GAP) return preferred;
  let best = preferred;
  let bestClearance = -1;
  for (let hue = 0; hue < 360; hue++) {
    const c = clearance(hue, taken);
    if (c > bestClearance) { bestClearance = c; best = hue; }
  }
  return best;
}

/**
 * Resolve one distinct hue per community racer. A raw `hash % 360` collides constantly at this scale
 * (edgerunner 102, dca-signal 106, pulsebnb 124 and alphaprobe 135 all read as the same green), so the
 * hash is only a PREFERENCE here: racers are walked in a stable order and any crowded hue is moved to
 * the emptiest arc of the wheel. Pass the full set of visible ids on every state change.
 */
export function assignLivery(ids: string[]): void {
  const racers = [...new Set(ids.map(liveryKey).filter((k) => k && !LIVERY[k]))].sort();
  const taken = [...RESERVED_HUES];
  assignedHues.clear();
  for (const key of racers) {
    const hue = pickHue(colorHash(key) % 360, taken);
    taken.push(hue);
    assignedHues.set(key, hue);
  }
}

export const livery = (id: string) => {
  const key = liveryKey(id);
  if (LIVERY[key]) return LIVERY[key];
  const hue = assignedHues.get(key) ?? colorHash(key) % 360; // fallback: racer not in the last pass
  return `hsl(${hue} 88% 62%)`;
};
