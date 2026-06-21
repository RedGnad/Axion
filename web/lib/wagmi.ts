import { http, createConfig, createStorage, cookieStorage } from 'wagmi';
import { base } from 'wagmi/chains';
import { injected } from 'wagmi/connectors';

/**
 * wagmi v2 config. `injected()` enables EIP-6963 multi-wallet discovery by default (MetaMask, Phantom,
 * Rabby, Coinbase extension… no more window.ethereum collision). Base only — the same chain CROO
 * settles on. `ssr: true` + cookieStorage = no hydration flash in the Next App Router.
 */
export const wagmiConfig = createConfig({
  chains: [base],
  connectors: [injected()],
  storage: createStorage({ storage: cookieStorage }),
  ssr: true,
  transports: { [base.id]: http() },
});

declare module 'wagmi' {
  interface Register {
    config: typeof wagmiConfig;
  }
}
