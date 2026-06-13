# Foreman — CROO Agent Hackathon build (working title)

> The general-contractor agent for the CROO economy: one callable CAP agent that, given a
> goal + USDC budget, discovers (curated roster), hires, escrows, verifies and composes
> multiple CAP sub-agents into one finished deliverable — becoming by construction the most-
> connected, highest-order-volume node in the Agent Store, and the demand engine that makes
> other agents get paid.

@/Users/red.g/CascadeProjects/Master/playbook.md

## Positioning — APEX (iii): picks-and-shovels, consumed BY other agents
Foreman is NOT an end-user product. It is a **composition primitive that OTHER CROO agents call**
to subcontract a multi-agent task — trustless agent→agent subcontracting with on-chain escrow per
sub-hire. This is what out-ceils the bare orchestrator: it keeps the 25%+30% strength, sharpens
Innovation (agents subcontracting trustless on-chain = agent-native), and fixes Adoption with a
REALIZABLE in-window userbase — the other registered teams' agents — instead of a consumer
audience we don't have. (Out-of-sample support: playbook picks-and-shovels-win-infra +
ecosystem-motion-in-window.)

**LOAD-BEARING PIER — TWO-SIDED ecosystem dependency (red-team 14 Jun; store = 0 agents/0 orders,
field = 0 BUIDLs / 77 registered / 28 days left):**
- HIRE side: with an empty store there is nothing to compose → we self-seed all sub-agents → graph
  diversity is self-manufactured (judges see aggregated order data → reads as synthetic).
- DEMAND side: "other agents call Foreman" is optimistic — 77 registered / 0 shipped → realistically
  0–2 integrators, late. Do NOT make this the floor.

**Therefore: FLOOR vs UPSIDE (build to the floor, the field is near-empty so the floor wins/places).**
- FLOOR (must work even if the ecosystem stays empty): a genuinely useful composer over a coherent
  set of OUR OWN leaf-agents, labelled `ours`, with on-chain-verifiable orders, listed, crisp demo.
  In a track with ~0 real submissions this floor already places.
- UPSIDE (lifts Adoption+Innovation if it lands, never the floor): ≥1–2 INDEPENDENT teams' agents
  genuinely call Foreman, and/or real third-party agents in the roster. Attack early, NEVER fake —
  CROO scores "organic" + feeds aggregated order data to judges.
- HONEST MANIFEST: every SubOrderRef carries `ours: boolean`; never claim third-party diversity we
  don't have. Re-census near deadline for (a) rival orchestrators (duplication — currently none, but
  orchestrator is the OBVIOUS read of A2A 25% → expect crowding) and (b) hireable third-party agents.
Confidence LOW (taste unvalidated); reasoned ceiling, not a guaranteed winner.

## Consumable interface (the adoption lever — keep it 5-lines-to-integrate)
Foreman registers ONE CAP service (Dashboard) → `FOREMAN_SERVICE_ID`. Any agent hires it via the
standard verified path: `negotiateOrder({ serviceId: FOREMAN_SERVICE_ID, requirements })`. The
`requirements` JSON IS Foreman's public contract (see `src/contract.ts`):
```jsonc
{ "goal": "natural-language composite task",
  "budgetUSDC": "max smallest-unit Foreman may spend across sub-hires",
  "deliverable": "text" | "file",
  "constraints": { "maxSubAgents": 6, "deadlineSeconds": 300 } }
```
Foreman returns the composed result + a **manifest** of every sub-order (orderIds, agents, Base
txHashes) so the caller (and judges) can verify the A2A graph on-chain. The manifest also lifts the
CALLER's composability — that mutual benefit is the integration hook.

**Distribution = MCP (verified 14 Jun).** CROO's own MCP server (`agent.croo.network/mcp`) exposes
ONLY the bilateral SDK primitives (negotiate_order/pay_order/deliver_order/…) — **no discovery tool,
no native composer**, and the npm package is unpublished today. So: (1) there is NO platform-native
orchestrator that duplicates Foreman; (2) Foreman, being a CAP service, is already callable via
`negotiate_order → FOREMAN_SERVICE_ID` from any MCP client (incl. CROO's once published) — no
separate MCP server required. OPTIONAL upside: ship a thin `compose_task` MCP tool so LLM clients
get one-call composition (MCP-distributed infra = the Stellar x402 winning pattern). Do not make a
Foreman MCP server a milestone-1 requirement; the on-chain CAP service is the product. (Integrity:
CROO advertises an unpublished MCP package — re-verify at deadline; never build the pitch on their
absence.)

**Cashflow (real, do not miss):** when hired, Foreman is the PROVIDER (caller's USDC escrows into
Foreman's order, releases only after Foreman delivers) and simultaneously the REQUESTER paying
sub-agents DURING delivery → Foreman must hold a USDC **float** in its AA wallet to front a batch
of sub-hires before its parent order clears. Margin = caller payment − Σ(sub-budgets + feeAmount).

## Outreach plan (turn the kill-condition into an attack, in-window)
1. Ship Foreman + public `FOREMAN_SERVICE_ID` + a 5-line integration snippet EARLY.
2. Post in the CROO community: "subcontract any multi-agent task in 5 lines; your agent gets
   composability + a richer demo, you skip building orchestration." Offer a small USDC **faucet**
   so teams test-call for free (removes friction → real organic orders).
3. Seed the roster with the 2 existing store agents (Chainguard, Web3 Address Intel) as both
   hireable sub-agents AND reciprocal callers.
4. Co-demo an integrator (their agent calling Foreman live) in the Demo Day video = organic A2A +
   ecosystem motion. NEVER fabricate this; if no one integrates, report honestly.

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
