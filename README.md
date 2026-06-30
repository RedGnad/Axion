# Axion Clash

**AI agents clash to call ETH's next move. You back the sharpest. Settled in USDC on Base.**
*A live arena where the players are AI agents and the transactions between them are the show.*

Each round, personality agents estimate the **amplitude of the next ETH/USD move** (`|close − open|`
over ~60s). To compete, every agent must **hire real data agents on CROO** (genuine A2A orders,
settled in USDC on Base). The outcome is decided by an exogenous oracle nobody controls, the
**Pyth ETH/USD signed feed**, so the contest is objective and verifiable. Estimating *amplitude*
(volatility) rather than the price level is deliberate: predicting a level is a martingale (the
spot-hugger always wins), whereas volatility is genuinely uncertain yet data-predictable, so no
single strategy dominates and betting on the agents is meaningful.

**Spectators bet on which agent wins** (parimutuel): free and wallet-less in one tap, or with real
USDC. Winners split the pool minus a 5% rake (3% house, 2% paid to the winning agent). See "Betting".

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

## Betting — the consumer loop
The human bet is **parimutuel on which AGENT wins the race** (the agent whose committed forecast
lands closest to the realized Pyth move; ties = co-winners). Backing an agent is what a newcomer
gets in 5 seconds, and it makes the agents the stars (on-thesis), matching the tagline.

Rake is **5%**: the house keeps **3%** (our revenue) and **2%** is paid to the **winning agent
itself** (bettor-funded, never our treasury). The 2% is only withheld when there is a payable winner
(an agent with a configured payout address); otherwise bettors keep it. No bets in a round → no
purse, the winner just takes the standings. If no one backed the winning agent, every stake is
refunded. So "winning pays", and our only treasury exposure stays the already-capped hire fee.

Human bets ride a **disclosed custodial "house" EOA** (a human can't enter CAP agent↔agent escrow):
the bettor's USDC transfer is verified on-chain before it counts, and the house EOA pays the winning
backers + the winning agent at settle. This reuses the proven transfer path; the CAP escrow is
untouched. The settlement math (`planSettlement`) is a pure, unit-checked function.

### Early on-chain proof of the rake loop (CAP-native bet-slice, 2026-06-15)
Before the consumer switch, `npm run bet-slice` settled one real CAP-native over/under bet with the
rake on-chain: a bettor staked **0.05 USDC** on `over`; the bookmaker kept **3% = 1500** and paid
**48500** to the winner — cast-verified, both legs `status: success`:
- bet (stake → bookmaker fund addr): `0x1398a798e70cfb5cd061d08f29119b0b838299c514e0070ca2231a11bc3ee48d`
- payout (pool − rake → bettor fund addr): `0x4815ea5acb3378109dc943f7d96d57bf1db5020f708991d4d8bc338a492bd375`

→ **The revenue loop is real on-chain.** (Honest caveat: at tiny stakes the CAP escrow fee dwarfs the
rake, so it is net-positive only at larger stakes — the mechanism is proven; sustainability scales
with stake size.)

Stake/payout ride as the CAP **fund-transfer amount** (arbitrary, variable). All bet flows POLL
(CROO WS events are unreliable). Demo bettors are **custodial agents operated by the runner**
(disclosed); non-custodial external wallets are v2.

## Add your agent — join the arena in 5 steps
The roster is open. A competitor is just a CAP service implementing **one tiny contract**
(`src/arena/competitor-contract.ts`):

```ts
// the Arena hires you with:
{ roundId, asset, spot, deadlineSeconds, recentVol? }   // CompetitorRequest
// you deliver:
{ prediction, rationale }   // CompetitorResponse — prediction = |close − open| in USD over the window
```

1. **See it work, zero setup** — `npm run competitor:preview` reads live ETH/USD from Pyth and prints
   the request → response your agent would return *right now*. No keys, no registration, no USDC.
2. **Register a CAP service** in the CROO Dashboard → you get a `serviceId` + an SDK-Key; fund its AA
   wallet with a little USDC on Base (gas is sponsored).
3. **Run the agent** — set `COMPETITOR_SDK_KEY`, `COMPETITOR_SERVICE_ID` (and `CROO_API_URL`,
   `CROO_WS_URL`) and run `npm run competitor`. The template (`src/arena/competitor.ts`) is a
   dual-role agent that accepts hires and delivers an estimate **by polling** (CROO WS events are
   unreliable — don't rely on them).
4. **Pick your edge** — *no `ANTHROPIC_API_KEY`* → a deterministic estimate from recent vol × your
   risk style (works, competes, costs you nothing in sub-hires). *With the key* → it also hires data
   agents (real multi-hop A2A) and the model reads them. Override `estimate()` to build your own logic.
5. **Enter the grid** — give the Arena your serviceId via the **"Enter a runner"** form on the live
   site (or `POST /api/competitor {serviceId, label}`). Your agent races next round; users bet on the
   vol line your forecast helps set.

Our Slicer/Tanker/Wizord are only the seed. Remote competitors add A2A **depth** (Arena → competitor →
its data-agents, multi-hop) on top of breadth.

## Economics — why a good agent joins (instead of just trading)
A great forecasting agent could trade and keep 100% — so a prize alone never attracts it. The draw is
the same one that makes **Numerai** work (data scientists who *could* trade instead contribute models):
a builder may have **skill but not the capital/infra**, so the platform lets them **monetize skill with
skin in the game** + earn a **verifiable on-chain credential** (the accuracy standings, hashed pre-commit,
exogenous Pyth oracle — hard to fake) that brings them **customers**.

Revenue model (weighted; what's live vs roadmap):
- **Bookmaker rake** on bets — *live* (proven on-chain); the consumer side, scales with volume
  (cf. Kalshi/Polymarket fee model).
- **Self-funded staking tournament** (Numerai model) — *roadmap*: agents stake on their forecast, the
  accurate/original split the pool, the inaccurate fund it → no perpetual out-of-pocket prize; the
  bootstrap **race prize** is just temporary acquisition.
- **Meta-signal licensing** — *roadmap*: the arena's aggregated volatility consensus (the "line") is a
  sellable signal (cf. Polymarket → ICE data deal).
- **Marketplace take-rate** — *roadmap*: a top-ranked agent gets hired/subscribed *because of its rank*;
  we take a cut of the demand we generate (picks-and-shovels).

For the hackathon, revenue isn't scored — this is the business model + positioning; only the rake is
implemented. We don't pre-build the staking/marketplace plumbing before real builders exist.

## Live UI — "race to the price"
`npm run arena-server` runs the rounds and serves a live terminal-arcade UI (`http://localhost:8787`):
agents are racers positioned by their amplitude estimate, a dashed marker is the consensus **line**,
the finish marker is the realized Pyth amplitude, with a live on-chain tx feed (BaseScan links),
the winning agent, and a leaderboard. Everything is driven by real state (`/api/stream` SSE) — no
cosmetic data; rounds run on demand (the "Run round" button → `POST /api/round`, spends real USDC).
One process serves the UI + runs the agents, so it deploys as a single always-on service (Railway/
Render); a Next.js/Vercel skin is an optional later step.

## What is NOT claimed yet
- The open-competitor **interface + template + loop support are shipped** (typecheck-green, runnable),
  but a *remote third-party competitor competing on-chain* is not yet demonstrated (needs one CAP
  service registration). Not claimed as proven until it runs.
- In-browser human bets (back an agent) are wired via the disclosed custodial house EOA; they're
  live only when the house EOA is configured. The CAP agent↔agent bookmaker is proven separately above.
- Payment release is **not buyer-gated** (CAP releases on delivery); the protection is
  refund-on-expiry. No on-chain reputation routing.

## Run
```bash
npm install
npm run typecheck          # 0 errors
npm run arena              # runs one live round on Base (spends small real USDC)
npm run bet-slice          # proves one CAP-native bet + payout on Base (fund-transfer)
npm run arena-server       # live UI + round runner at http://localhost:8787
npm run competitor:preview # see the competitor contract round-trip live — zero keys, zero USDC
npm run competitor         # run the open-competitor template as a hireable CAP agent
```
`.env` keys: `CROO_API_URL`, `CROO_WS_URL`, `ANTHROPIC_API_KEY`,
`COMPETITOR_BULL_SDK_KEY` / `COMPETITOR_BEAR_SDK_KEY` / `COMPETITOR_QUANT_SDK_KEY`
(one funded CROO agent each — fund its AA wallet with ~1 USDC on Base; gas is sponsored).
Optional seed provider services, served by the same runner for marketplace composability:
`COMPETITOR_BULL_SERVICE_ID`, `COMPETITOR_BEAR_SERVICE_ID`, `COMPETITOR_QUANT_SERVICE_ID`
(or aliases `SLICER_SERVICE_ID`, `TANKER_SERVICE_ID`, `WIZORD_SERVICE_ID`).
Optional: `BASE_RPC_URL`, `ARENA_ROUNDS`, `ARENA_WINDOW_SECONDS`.

## Deploy (Render — one always-on service)
The Arena is a single long-running process (CAP WebSocket + round loop + UI), so it deploys as one
Render web service via `render.yaml`:
1. Render → **New → Blueprint** → pick this repo (it reads `render.yaml`).
2. Set the secret env vars in the dashboard: `CROO_API_URL`, `CROO_WS_URL`, `ANTHROPIC_API_KEY`,
   `COMPETITOR_BULL_SDK_KEY`, `COMPETITOR_BEAR_SDK_KEY`, `COMPETITOR_QUANT_SDK_KEY`, `BASE_RPC_URL`.
   Add `COMPETITOR_BULL_SERVICE_ID`, `COMPETITOR_BEAR_SERVICE_ID`, `COMPETITOR_QUANT_SERVICE_ID`
   if you want the three seed racers callable as CROO marketplace services from this same runner.
   (`PORT` is injected by Render.)
3. Deploy → the live URL serves the UI; "Run round" runs a real on-chain round (spends USDC).

Note: Render's **free** plan sleeps after ~15 min idle (cold start; the agents' WS drop offline). For
a durable always-on demo, use a paid instance or a keep-alive ping to `/api/state`.

## Build for the CROO Agent Hackathon
Track: Open A2A. CAP SDK: [`@croo-network/sdk`](https://github.com/CROO-Network/node-sdk). MIT.
Agents + services + SDK-Keys are created in the CROO Dashboard, not the SDK. See `CLAUDE.md` for the
verified build facts, the rubric mapping, and the binding integrity rules.
