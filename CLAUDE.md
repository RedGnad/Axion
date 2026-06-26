# Axion Clash — CROO Agent Hackathon build

> A live on-chain arena where AI personality agents (Slicer / Tanker / Wizord) clash to call the
> AMPLITUDE of ETH's next ~60s move. To compete, each agent must HIRE real data agents on CROO
> (genuine A2A orders, USDC on Base). The outcome is settled by an exogenous oracle nobody controls
> (Pyth ETH/USD). Spectators bet on WHICH AGENT wins — free and wallet-less, or with real USDC.
> The players are AI agents and the transactions between them are the show.

@/Users/red.g/CascadeProjects/Master/playbook.md

## Positioning
Axion Clash is a **consumer spectacle on top of real agent-to-agent commerce**. The A2A is not a
demo prop: a persona literally cannot forecast without buying data, so every round emits real,
needed CAP orders (organic by construction). Closest public precedent: Nof1's "Alpha Arena" (LLMs
trade crypto live, people watch) — we are NOT that: ours is forecasting + an A2A data economy +
spectator betting on the agents, not autonomous P&L trading. Do not name-collide with them.

Differentiator to defend (the "10"): the on-chain trust layer makes agent-vs-agent competition
*verifiable* — per-hire escrow + Pyth-settled outcome + pre-committed estimates (`reasonHash`) —
which is impossible on a normal API marketplace. The unfakeable Adoption lift is ≥1 INDEPENDENT
team's agent racing; everything else we can build ourselves, that we cannot.

## Economic model — LOCKED (do not reinvent; see memory `economic-model-locked`)
1. **One human bet: "which AGENT wins"** (parimutuel on the racers). NOT over/under (that bet on ETH,
   off-thesis, and is removed). The win outcome (`isWinner`, ties = co-winners) is computed in
   `settle.ts`; betting only changes the pool/odds.
2. **Winning-agent reward = a share of the betting RAKE only** (bettor-funded). NEVER a treasury
   guarantee (gameable + reads as wash at an organic-scored event). No bets → no purse, just standings.
3. **Rake = 5% flat → 3% house / 2% winning agent** (`BOOKMAKER_RAKE_BPS`=300, `WINNER_RAKE_BPS`=200).
   No probability-scaled curve. The 2% is only withheld when the winner has a configured payout
   address (`ARENA_PAYOUT_<ID>`), else bettors keep it. Payouts reuse the proven house-EOA path
   (`housebet.ts`); the CAP escrow is untouched.
4. **Agent staking (Numerai-style) = ROADMAP, no code.** Real only via an external agent staking its
   own money (us on both sides = wash). Onboarding effort → recruitment + Garage, not stake code.
5. **Cold-start subsidy is bounded**: we fund participation (data hires), capped at
   `ARENA_DAILY_RACES`/day, resets UTC midnight. Subsidize participating, never winning.

## Architecture (the REAL build = `src/arena/*` + `web/`)
Single Node process (Render) runs the rounds AND serves state; the Next.js app on Vercel is the UI.
- `src/arena/server.ts` — HTTP/SSE server, round scheduler, `/api/state|round|predict|bet|competitor`,
  persistence (Upstash + file + committed seed), cold-start budget, health `notice`. `GET /` 302s to
  `FRONTEND_URL` (the Vercel app).
- `src/arena/loop.ts` — `runRound`: each competitor estimates in parallel; LOCAL personas buy their
  data agents directly (real A2A), REMOTE open agents are hired by the arena. DQ cutoff relative to
  the fastest agent. Hire failures are surfaced via `onHireFail` (never silent).
- `src/orchestrator.ts` — `hireService` (negotiate → poll order → optional price cap → payOrder →
  poll completion → delivery). Used by the arena personas. (Polls; CROO WS events are unreliable.)
- `src/arena/forecast.ts` — persona + purchased data → committed 2-decimal amplitude + rationale (Haiku).
- `src/arena/personalities.ts` / `src/roster.ts` — 3 personas with disjoint capabilities → 6 distinct
  third-party data agents (`DATA_AGENTS`, all `ours:false`). `src/arena/discovery.ts` — live public
  catalog census ("the store evolves").
- `src/arena/settle.ts` — closest amplitude to the Pyth move wins (ties = co-winners) + pari-mutuel math.
- `src/arena/housebet.ts` — custodial-disclosed human USDC betting via a house EOA; `planSettlement`
  is a PURE unit-checked function (bettor split + winning-agent purse). `src/arena/oracle.ts` — Pyth.
- `web/` — Next 15 App Router + Tailwind v4 + wagmi v2: Play (race + agent cards + bet-on-agent),
  Garage (join + data market), On-chain proof tabs.

## Operational facts (current, verified on-chain 2026-06-26)
- **Three persona AA wallets, each pays its own data hires** (~0.2 USDC/round each), all currently
  near-empty → data hires fail → agents forecast on baseline ("no signal"). Fund all three with USDC
  on Base (gas is paid in USDC via paymaster, no ETH needed). See memory `arena-wallet-funding`:
  Slicer `0x5B6bEFFbbED35c55a7749f7E594B062B52BFF7FC`, Tanker `0xf398...BF76`, Wizord `0x62aa...F351`.
- Render `plan: free` spins down when idle (cold start); a cron ping keeps it warm. Any push
  redeploys Render and KILLS an in-flight round — check `/api/state` is idle before pushing.
- Human USDC betting + the winning-agent purse need env: `HOUSE_EOA_ADDRESS/PRIVATE_KEY`,
  `BASE_RPC_URL`, `ARENA_PAYOUT_SLICER/TANKER/WIZORD`.

## Verified build facts (tier [P], github.com/CROO-Network/node-sdk v0.2.1 MIT)
ONE class `AgentClient` does both roles.
- **Buyer:** `negotiateOrder({serviceId, requirements})` → `payOrder(orderId)` (→ Base txHash) →
  `getDelivery(orderId)`. **Provider:** `acceptNegotiation(id)` → on paid `deliverOrder(orderId, {...})`.
- Also: `getNegotiation, listNegotiations, getOrder, listOrders, rejectNegotiation, rejectOrder,
  uploadFile, getDownloadURL, connectWebSocket`. HTTP base `api.croo.network`; WS `wss://api.croo.network/ws`.
- WS event delivery is unreliable → everything POLLS.

### Hard constraints (do NOT rediscover the slow way)
1. Agent creation + service registration + SDK-Key issuance happen in the CROO Dashboard, not the SDK.
2. No discovery in the SDK, but YES via PUBLIC unauthenticated HTTP:
   `GET api.croo.network/backend/v1/public/services` + `/public/agents`. (The SDK-Key canNOT read
   `/services` — 401.) The roster (`src/roster.ts/DATA_AGENTS`) is a curated subset of that catalog.
3. Pre-fund the agent's AA (ERC-4337) wallet with USDC before `payOrder` (the SDK checks the
   agent-wallet balance, not the controller). Base mainnet.

### On-chain lifecycle + payment (tier [P], cap-contracts)
`NEGOTIATION ──payOrder──► LOCK ──deliverOrder──► DELIVER ──evaluateOrder──► CLEAR` (reject/expire →
refund). `payOrder`→`CAPVault.setupEscrow` (real escrow). `Order.feeAmount` = on-chain escrow fee in
USDC (bake into the margin; ~10% per hire). DO-NOT-OVERCLAIM (verified in code):
- **No buyer-gated release.** `needEvaluation=false` → `deliverOrder` auto-releases to the provider;
  the buyer cannot reject in DELIVER. The real buyer protection is **refund-on-expiry**, not a veto.
- **No on-chain reputation/PTS** in cap-contracts or SDK. Routing is price/availability, not reputation.
- Scoped permissions = selector-whitelist on the agent's OWN AA wallet, NOT per-hire grants.

## Integrity rules (binding — from Master)
- Never mark a feature live/ready without an end-to-end implementation. Say scaffold/coming-soon until
  the code path works. Trace every user/judge-visible claim to code before claiming it works.
- No dependency in package.json that isn't imported in a source file.
- No hardcoded data shown as live (no fake badges, counts, or "paid" states).
- Orders must be ORGANIC: an agent hires only when it genuinely needs the output. Never wash-trade to
  inflate counts — CROO feeds aggregated order data to judges and scores "organic".
- Real USDC: bounded budget; check the live runner is idle before pushing (push kills a round).
- Writing style: no em-dashes, no decorative emojis, label feed/list rows with time + a clear tag
  (see memory `writing-style-feedback`). Git: one-line commit messages; no Co-Authored-By / Claude mentions.

## Why this wins (official rubric, tier [O])
- **Technical Execution 30%** — robust CAP lifecycle, polling resilience, real payment-state handling,
  pure unit-checked settlement. Bonus: 10+ real CAP orders (organic, several per funded round).
- **A2A Composability 25%** — one round → 6 distinct third-party data hires by construction; depth via
  re-hiring the same providers across rounds. Lives only when the persona wallets are funded.
- **Innovation 20%** — verifiable agent-vs-agent competition: per-hire escrow + Pyth-settled outcome +
  pre-committed `reasonHash` + spectator betting ON the agents. Not orchestration alone.
- **Usability & Real Adoption 15%** — free wallet-less prediction (top of funnel) + real USDC bets;
  the unfakeable lift = ≥1 independent agent racing (Discord + Garage). WEAKEST axis today.
- **Presentation 10%** — one-tap demo, README reproducibility, on-chain proof tab, Demo Day.

Track: **Open A2A (Track 6)**. Deadline: plan **Jul 9**. Build early, run real rounds across the window.

## Status & known gaps (2026-06-26)
- WORKING: round lifecycle, leaderboard, on-chain proof, store-evolves feed, cold-start cap, health
  banner, bet-on-agent (free + USDC), winner-purse math (unit-checked). Verified live + via Playwright.
- BLOCKED on funding: real data hires (3 persona wallets empty) → the core A2A. Now surfaced, not silent.
- NOT built (roadmap): agent staking; bounded field/league for scale (100 agents); ≥1 external agent.
- LEGACY to quarantine: an older "general-contractor" codebase still exists (`src/index.ts`,
  `serve.ts`, `slice.ts`, `contract.ts`, `provider.ts`, `leafs/*`, `bookmaker.ts`, `src/arena/ui.html`)
  and the `dev/start/slice/serve` npm scripts point at it. It is NOT the product (the Arena is). Remove
  or clearly mark legacy so a judge/builder who clones doesn't land on the old thesis. `orchestrator.ts`
  is still used by the arena — keep it.
