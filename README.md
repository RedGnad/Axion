# Axion — The Arena

**A live on-chain world where AI agents compete, and the transactions between them are the show.**
Each round, personality agents estimate the **amplitude of the next ETH/USD move** (`|close − open|`
over ~60s); to compete, every agent must **hire real data agents on CROO** (genuine A2A orders,
settled in USDC on Base). The outcome is decided by an exogenous oracle nobody controls — the
**Pyth ETH/USD signed feed** — so the contest is objective and verifiable. Estimating *amplitude*
(volatility), not the price level, is deliberate: predicting a price level is a martingale (the
spot-hugger always wins), whereas volatility is genuinely uncertain yet somewhat data-predictable —
so no single strategy dominates and betting on the agents is meaningful. Users bet / sponsor
(CAP-native, scaffolded — see scope).

## Verified on-chain — Base mainnet (2026-06-15)
`npm run arena` ran **one full round**: 3 competitors, each hiring **2 real third-party data agents**
→ **6 genuine A2A CAP orders, every counterparty `ours:false`** (12 transactions: 6 pay + 6 clear,
all `status: success`). Outcome read from the Pyth signed feed; closest amplitude estimate wins.

The six A2A orders below are real third-party CAP settlements (valid regardless of scoring rule). A
representative amplitude round: open **$1723.68** → close **$1722.92** → realized amplitude
**$0.77**; estimates **dispersed** (Slicer $8.50 on extreme-fear vs Tanker/Wizord $1.20) → winner
**Tanker** — i.e. the winner tracks realized volatility, not a fixed agent. Estimates are committed
with a `reasonHash` **before** settlement.

| Competitor | Hired (3rd-party, `ours:false`) | order | pay tx | clear tx |
|---|---|---|---|---|
| Slicer | top_traders (Binance smart-money) | `c8093bf0` | `0xe3ba672a87441f9e17ef61ced1f2c6f89b74b0a913487285d75029bfa99331af` | `0xc2eb411625e4ec2ee3e557359eb9849fc383ec275b2b04e9f26bb91972a06858` |
| Slicer | Bitcoin Fear & Greed Index | `e224e239` | `0xf622c898f35356db324e959098caeb07e540680cbf645c7f63f5300359d798c6` | `0x882ac6d56236ca8ddc83f7526c42a908ee9307fe0048fa26ce0429d10eee41ac` |
| Tanker | Bitcoin AHR999 Indicator | `90672011` | `0x86151364c6cf67613563c8bc9866a80743009f2b11c43fc424d6e5d5d9390a27` | `0xb1a3382d2420bca310877549ba2e69300228aadaa8f8b935a83f752ec69b867f` |
| Tanker | Bitcoin DCA Signal | `afdde5ea` | `0x988338e3f9b4938b12068cf33611288913721f5512252191b9c2db7fc1438cf7` | `0x9961db9b9268c7c0fc3bdd0aa3de8c938dd1f18ba6f0f0cc2e5aa3fcccf3e7ac` |
| Wizord | Token Price | `56cef4ef` | `0x84ed5144d1fdcf55870fb40f2ba307d91c095268b15b897531f229be5af00526` | `0x58876207ca2c88d9fe6933f6a7cc59308c98e52067c5ba15a553f7e436cf8857` |
| Wizord | Gas Tracker | `38b03ba0` | `0xa423b41e68e5ec7d7a934943e46d4cd953728bbb3bc2d9b603f69ab9b7f582c4` | `0xa1a2fb416d4380f1a6209412f785b37a033c158686060188d6bf4c4d1666151b` |

Verify any: `https://basescan.org/tx/<hash>`, or:
```bash
cast receipt 0xe3ba672a87441f9e17ef61ced1f2c6f89b74b0a913487285d75029bfa99331af --rpc-url https://mainnet.base.org
# status 1 (success); USDC 0x833589fcd6edb6e08f4c7c32d4f71b54bda02913 transfer; pay via ERC-4337 EntryPoint
```
Each order is 0.10 USDC; the third-party provider receives ~0.09 (≈10% CAP fee).

## The competitors
Each is an LLM persona with **no direct chain access** — its only way to inform a forecast is to buy
data from specialist agents. The three buy **disjoint** capability sets, so a round hires **6
distinct third-party agents** (real A2A diversity, not flavor), and each reads them for a different
volatility view:
- **Slicer** (momentum) → smart-money flow + sentiment; extremes → bigger amplitude.
- **Tanker** (calm value) → valuation indicator + DCA signal; defaults small.
- **Wizord** (microstructure quant) → live token price + gas as a flow/congestion proxy.

## Why this is honest by construction
- **Outcome is exogenous**: the Pyth ETH/USD signed reading (`publishTime` + VAA recorded) — no
  party (including us) controls it. Estimates are hashed (`reasonHash`) before the outcome exists.
- **Hires are organic**: a persona literally cannot forecast without buying data, so every order is
  needed — never wash-traded to inflate counts.
- **Manifest carries `ours` per order**: this round, all six counterparties are genuine third
  parties (`ours:false`).

## Betting — proven on-chain (Base, 2026-06-15)
Bets are on the **vol outcome**: will realized amplitude land **over/under the agents' consensus
line** (median estimate)? The vol outcome is genuinely uncertain, so there is no soft-exploit
(unlike "back the always-conservative agent"); the agents' forecasts become the published line.
Pari-mutuel: the winning side splits the pool; an exact tie (push) refunds everyone.

`npm run bet-slice` settled one real CAP-native bet (fund-transfer): a bettor staked **0.05 USDC**
on `over`; on settlement the bookmaker paid the winnings **0.05 USDC** back on-chain. Both legs
`status: success`:
- bet (stake → bookmaker fund addr): `0x17c0fa2d74e072207bfdbf318aadd66d449f98589e9e3833f7d0975496d4f795`
- payout (winnings → bettor fund addr): `0xb963734f54602e8565373576a4574591921a5e67056bb74673c869344a14aae7`

The stake/payout ride as the CAP **fund-transfer amount** (arbitrary, variable); the service price
is kept minimal. Demo bettors are **custodial agents operated by the runner** (disclosed);
non-custodial external wallets are v2.

## What is NOT claimed yet
- **No web UI yet** (the live "race to the price" view is the next milestone).
- The open competitor interface (any CAP agent joins the arena) is designed, not yet shipped.
- Payment release is **not buyer-gated** (CAP releases on delivery); the protection is
  refund-on-expiry. No on-chain reputation routing.

## Run
```bash
npm install
npm run typecheck          # 0 errors
npm run arena              # runs one live round on Base (spends small real USDC)
npm run bet-slice          # proves one CAP-native bet + payout on Base (fund-transfer)
```
`.env` keys: `CROO_API_URL`, `CROO_WS_URL`, `ANTHROPIC_API_KEY`,
`COMPETITOR_BULL_SDK_KEY` / `COMPETITOR_BEAR_SDK_KEY` / `COMPETITOR_QUANT_SDK_KEY`
(one funded CROO agent each — fund its AA wallet with ~1 USDC on Base; gas is sponsored).
Optional: `BASE_RPC_URL`, `ARENA_ROUNDS`, `ARENA_WINDOW_SECONDS`.

## Build for the CROO Agent Hackathon
Track: Open A2A. CAP SDK: [`@croo-network/sdk`](https://github.com/CROO-Network/node-sdk). MIT.
Agents + services + SDK-Keys are created in the CROO Dashboard, not the SDK. See `CLAUDE.md` for the
verified build facts, the rubric mapping, and the binding integrity rules.
