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
  **the on-chain trust layer**: trustless per-hop escrow + reputation(PTS)-routed selection +
  scoped/time-bounded permissions across N hired agents + per-order dispute. NOT "orchestration"
  alone (that exists on normal marketplaces).
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

### On-chain (tier [P], github.com/CROO-Network/cap-contracts)
`CAPCore`, `CAPVault` (ERC-4337), `IERC8004IdentityRegistry`, `CROOExchange`,
`CROOValidationModule`. Verify orders on-chain (`cast`) for judge-facing proof.

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
3. **Hire (parallel)** — `negotiateOrder` → `payOrder` → await `OrderCompleted` → `getDelivery`,
   per subtask, with escrow + scoped permissions + timeout/dispute handling.
4. **Compose** — assemble verified sub-deliverables into one result.
5. **Sell** — Foreman is itself a registered service; it delivers the composed result to its
   caller and settles (price > Σ sub-costs = margin). Builds its own PTS.

Status: **scaffold**. The vertical slice (one real multi-hire run on Base, settled on-chain) is
the first milestone; nothing is "working" until that run is verifiable on-chain.
