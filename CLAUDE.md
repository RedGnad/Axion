# Foreman — CROO Agent Hackathon build (working title)

> The general-contractor agent for the CROO economy: one callable CAP agent that, given a
> goal + USDC budget, discovers (curated roster), hires, escrows, verifies and composes
> multiple CAP sub-agents into one finished deliverable — becoming by construction the most-
> connected, highest-order-volume node in the Agent Store, and the demand engine that makes
> other agents get paid.

@/Users/red.g/CascadeProjects/Master/playbook.md

## Why this wins (verified against the official rubric)
Judging (official image, tier [O], verified 13 Jun):
- **Technical Execution 30%** — robust CAP, reliable A2A, payment-state handling. **Bonus: 10+
  real CAP orders.** → the orchestrator emits multiple real orders per run; 10+ is organic.
- **A2A Composability 25%** — number, diversity, AND **depth** of A2A relationships; CROO feeds
  aggregated order data to judges (semi-objective). → one request → N sub-orders to N distinct
  agents BY CONSTRUCTION. **Depth ≠ count: re-hire counterparties + chain multi-hop, not just
  one-shot fan-out.**
- **Innovation 20%** — "impossible / much worse on a normal API marketplace?" → the answer is
  **the on-chain trust layer, claimed ONLY as verified in cap-contracts**: per-hop **escrow**
  with **delivery-window + auto-refund on expiry** (CAPVault) + an **on-chain settlement record**
  of every hire + optional **trusted-evaluator arbitration** (EVALUATOR_ROLE) + ERC-4337 AA
  wallet with **owner/executor selector-scoped keys** (CROOValidationModule). NOT "orchestration"
  alone (that exists on normal marketplaces).
  **DO-NOT-OVERCLAIM (red-team 13 Jun, verified in code):**
  - The **buyer is NOT the on-chain evaluator by default.** With `needEvaluation=false`,
    `deliverOrder` releases payment to the provider immediately (no buyer veto; requestor cannot
    reject in DELIVER phase). With `needEvaluation=true`, only `EVALUATOR_ROLE` (CROO-gated) can
    approve/refund. → Foreman's quality check is **off-chain, post-delivery**, UNLESS we confirm
    Foreman can hold EVALUATOR_ROLE for its own orders. Never claim "buyer-gated release."
  - **No on-chain reputation/PTS** in cap-contracts or SDK types. PTS is off-chain/backend. →
    Do NOT claim "reputation-routed selection." Roster routes on price/availability until a
    queryable PTS source is verified at source.
  - **Scoped permissions** = owner/executor selector-whitelist on the agent's OWN AA wallet,
    NOT per-hire grants to counterparties. Describe it correctly.
- **Usability & Real Adoption 15%** — real users, **organic** interactions, retention. → orders
  must be genuinely useful (never wash; CROO sees aggregated order data — integrity IS scored).
- **Presentation 10%** — demo clarity, README reproducibility, Demo Day. → "one prompt pays six
  agents and settles on-chain in 5 minutes."

Track target: **Open A2A (Track 6)**. Reveal: build early, list early, run real orders across
the window (orders accumulate → the 10+ bonus + the 25% axis compound). Deadline: plan **Jul 9**.

## Verified build facts (tier [P], from github.com/CROO-Network/node-sdk, v0.2.1 MIT)
ONE class `AgentClient` does both roles. Confirmed methods:
- **Buyer/orchestrator path:** `negotiateOrder({serviceId, requirements})` → on
  `EventType.OrderCreated` → `payOrder(orderId)` (→ txHash on Base) → on `EventType.OrderCompleted`
  → `getDelivery(orderId)`.
- **Provider path (our own leaf service):** on `EventType.NegotiationCreated` →
  `acceptNegotiation(id)`; on `EventType.OrderPaid` → `deliverOrder(orderId, {deliverableType,
  deliverableText})`.
- Also: `getNegotiation, listNegotiations, getOrder, listOrders, rejectNegotiation, rejectOrder,
  uploadFile, getDownloadURL, connectWebSocket`.
- HTTP base used by SDK: `api.croo.network` (paths `/orders`, `/orders/negotiate`,
  `/objects/upload-url`, `/objects/download-url`). WS: `wss://api.croo.network/ws`.

### Hard constraints found in-source (do NOT rediscover the slow way)
1. **Agent creation + service registration + SDK-Key issuance happen in the CROO Dashboard, NOT
   the SDK.** Seeding N leaf-agents = N manual dashboard registrations (budget the time).
2. **No discovery/search method in the SDK.** A requester targets a known `serviceId`. →
   Foreman runs on a **curated roster of serviceIds** (`src/roster.ts`). Do not build a
   dependency on a discovery API; if `api.croo.network` later exposes a list endpoint, treat as
   a bonus, verify at source first.
3. **Pre-fund the agent's AA (ERC-4337) wallet with USDC** before `payOrder` (the SDK checks the
   agent-wallet balance, not the controller address). Base mainnet.

### On-chain lifecycle + payment (tier [P], github.com/CROO-Network/cap-contracts)
State machine (ICAPCore): `NEGOTIATION ──payOrder──► LOCK ──deliverOrder──► DELIVER
──evaluateOrder──► CLEAR` (reject/expire → REJECTED/refund). Contracts: `CAPCore`,
`CAPVault` (pure escrow), `IERC8004IdentityRegistry`, `CROOValidationModule` (ERC-7579
owner/executor selector scoping), `CROOExchange` (sells the AGENT itself — NOT order flow, don't
confuse), `CAPSwapExecutor` (fund-order execution).
- **Escrow is real:** `payOrder`→`CAPVault.setupEscrow` (`transferFrom`) OR `payOrderX402`→
  `setupEscrowX402` (EIP-3009 `transferWithAuthorization`, gasless USDC). Standard path needs the
  requestor to **approve CAPVault for `budget` first** — confirm whether the node-sdk `payOrder`
  does approve+pay or uses the x402 path before funding.
- **Escrow service FEE:** SDK `Order.feeAmount` = on-chain escrow fee in USDC. Foreman must charge
  caller > Σ(sub-budget + feeAmount) + margin, or it loses USDC per hire. Bake fee into the math.
- **Evaluation:** `needEvaluation=false` → `deliverOrder` auto-`releasePayment(provider)` →CLEAR
  (no buyer veto). `needEvaluation=true` → `evaluateOrder(isApproved)` is `onlyRole(EVALUATOR_ROLE)`.
  Decide per order; verify whether Foreman can hold EVALUATOR_ROLE for its hires. `rejectOrder`
  reverts in DELIVER phase.
- **Refund safety:** on expiry past `deliveryWindow`, escrow refunds the requestor — this is the
  real buyer protection (not buyer-gated release). Verify every hire on-chain (`cast`) for the demo.

## Integrity rules (binding — from Master)
- Never mark a feature live/ready without end-to-end implementation. README says scaffold/
  coming-soon until the code path works.
- No dependency in package.json that isn't imported in a source file.
- No hardcoded data shown as live (no fake "ACTIVE" badges, no fake order counts).
- Orders must be ORGANIC: Foreman hires a sub-agent only when it genuinely needs that output.
  Never wash-trade to inflate the order count — CROO feeds aggregated order data to judges and
  scores "organic"; faking it loses on the 15% axis and breaks our rules.
- New branch + care before anything touches real USDC. Bounded budget per run.
- Git: one-line commit messages; no Co-Authored-By / Claude mentions.

## Architecture (the build)
`src/index.ts` entrypoint → `src/orchestrator.ts` core loop:
1. **Plan** — decompose the incoming goal into typed subtasks (LLM).
2. **Route** — for each subtask pick a serviceId from `src/roster.ts` (reputation/price aware).
3. **Hire (parallel)** — `negotiateOrder` → `payOrder` (escrow LOCK) → await `OrderCompleted` →
   `getDelivery`, per subtask, with delivery-window/expiry-refund handling. Foreman's quality
   check on each deliverable is OFF-CHAIN (post-delivery) — see DO-NOT-OVERCLAIM above; do not
   claim on-chain buyer-gated release.
4. **Compose** — assemble verified sub-deliverables into one result.
5. **Sell** — Foreman is itself a registered service; it delivers the composed result to its
   caller and settles (price > Σ sub-costs = margin). Builds its own PTS.

Status: **scaffold**. The vertical slice (one real multi-hire run on Base, settled on-chain) is
the first milestone; nothing is "working" until that run is verifiable on-chain.
