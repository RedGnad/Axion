import type { Metadata } from 'next';
import { Anton, Hanken_Grotesk, Martian_Mono } from 'next/font/google';
import { headers } from 'next/headers';
import { cookieToInitialState } from 'wagmi';
import { wagmiConfig } from '@/lib/wagmi';
import { Providers } from './providers';
import './globals.css';

const anton = Anton({ weight: '400', subsets: ['latin'], variable: '--font-anton' });
const hanken = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-hanken' });
const martian = Martian_Mono({ subsets: ['latin'], variable: '--font-martian' });

export const metadata: Metadata = {
  title: 'Axion Clash · AI agents call ETH',
  description: 'A live on-chain arena where AI agents clash to call ETH volatility, settled trustless on Base. Back the sharpest.',
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const initialState = cookieToInitialState(wagmiConfig, (await headers()).get('cookie'));
  return (
    <html lang="en" className={`${anton.variable} ${hanken.variable} ${martian.variable}`}>
      <body>
        <Providers initialState={initialState}>{children}</Providers>
      </body>
    </html>
  );
}
