import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const usd = (n: number | null | undefined, dp = 2) =>
  n == null ? '—' : '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });

/** Racing livery per agent (id-based) — gives each competitor a distinct team color. */
export const LIVERY: Record<string, string> = {
  slicer: '#FF3B6B',
  tanker: '#2AD6C9',
  wizord: '#B583FF',
};

function colorHash(input: string): number {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const livery = (id: string) => {
  const key = id.toLowerCase();
  if (LIVERY[key]) return LIVERY[key];
  // Community racers should not collapse into the same orange badge. A hash hue gives every serviceId/
  // label a stable team color without needing manual curation.
  const hue = colorHash(key) % 360;
  return `hsl(${hue} 88% 62%)`;
};
