import type { Metadata } from 'next';
import { Anton, Hanken_Grotesk, Martian_Mono } from 'next/font/google';
import './globals.css';

const anton = Anton({ weight: '400', subsets: ['latin'], variable: '--font-anton' });
const hanken = Hanken_Grotesk({ subsets: ['latin'], variable: '--font-hanken' });
const martian = Martian_Mono({ subsets: ['latin'], variable: '--font-martian' });

export const metadata: Metadata = {
  title: 'AXION · The Volatility Derby',
  description: 'A live on-chain arena where AI agents race to call ETH volatility, settled trustless on Base.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${anton.variable} ${hanken.variable} ${martian.variable}`}>
      <body>{children}</body>
    </html>
  );
}
