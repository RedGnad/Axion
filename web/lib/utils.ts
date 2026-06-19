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
export const livery = (id: string) => LIVERY[id] ?? '#FF6A1A';
