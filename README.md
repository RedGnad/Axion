# Axion

**The composition primitive other CROO agents call.** Given a goal + USDC budget, Axion
subcontracts a multi-agent task: it hires CAP sub-agents, escrows USDC per sub-hire, composes
their deliverables, and returns the result plus an on-chain **manifest** of every sub-order
(orderId, pay/clear tx, and an honest `ours` flag). Picks-and-shovels infra — not an end-user app.

## Verified on-chain — Base mainnet (2026-06-14)
`npm run slice` ran a real **2-hire composition**. 0.01 USDC per hire. **Both sub-agents are ours**
(`ours: true` in the manifest — this is NOT third-party A2A diversity; see Scope below).
**4 transactions, all status: success on Base mainnet:**

**Hire 1 — price** (Chainlink ETH/USD on Base) · order `74acca1c-0bb4-4543-b027-8dcf6c34986e`
- pay&nbsp;&nbsp; `0xdc519fc734a3c90bcaf522338b1e0f319a5cb2853e593efadae6b138ce239dd6`
- clear `0x17fac13ffd3a944c44f206176ac1f5f41faf8946b4692507a9cc8d7faeacebdb`

**Hire 2 — summarize** (Claude Haiku, consumes hire 1) · order `c0207887-9373-456c-b3ca-136ce4fefc9f`
- pay&nbsp;&nbsp; `0x3d0b547a1968ea7166ad1357cdbfed5b7680c1d2a2b43b9450fd204aa3c2181a`
- clear `0x377c0cca733f12276953bb662a5fbeb76136c12ed91fd8394ae1550a5c94c5ed`

Verify any: `https://basescan.org/tx/<hash>` (real USDC transfer; pay via ERC-4337, clear via CAPCore).

### Non-self-trade settlements (real third-party)
Axion hired a genuine **third-party** agent (VERIS, `ours:false`) **twice** — settled on Base,
provider wallet `0x25E6933538cbf1AED53BDccC5Ab06b70EcECC70C` (**not ours**):
- Trust Compare · order `56ee53e1-485f-4ea9-bf8d-e79eb661ca86` · 0.10 USDC · completed
  - pay `0x51627c054b3e0a3d1c4a92ebda03c6ecdad96112d3a9a3227706243040436cf1` · clear `0xd947754603d7b77c7cf7090b7ce6d2bdc1405d50245f0dccd0fd4e08a2b096e8`
- Trust Receipt History · order `090d0f39-18d2-4e6b-acf3-aaae4f29b1d5` · 0.20 USDC · completed
  - pay `0x9bbcd15b80031d69bc72ecbe6fe0aa12532b216435911ef09272444c31e22be7` · clear `0x90fd76be56e58e5b509e7cd5231c74f56b992f6730094020fea1be77cd747912`

Orders #1–3 (price, summarize) are our own composition (`ours:true`, self-trade) — not counted as
third-party diversity. Full verifiable evidence + honest caveats: **[REPORT.md](./REPORT.md)**.

## What works today (the floor)
- **Deterministic planner** (no LLM) → 2-stage DAG: stage-1 data leaf(s) → stage-2 summarizer.
- Each hire is one real CAP order: `negotiate → pay (escrow LOCK) → deliver → CLEAR`.
- `price` leaf reads the verified Chainlink ETH/USD feed on Base
  (`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`, `description() == "ETH / USD"`); `summarize`
  leaf uses Claude Haiku.
- Returns the composed brief + a manifest carrying `ours: boolean` per sub-order.

## Honest scope (what is NOT claimed)
- **Both counterparties are our own seeded leaf-agents** (`ours: true`). There is **no third-party
  or "organic" A2A diversity yet** — an independent team's agent calling Axion is the next milestone.
- Payment release is **not buyer-gated** (CAP releases to the provider on delivery); Axion's
  deliverable check is **off-chain**. The real buyer protection is refund-on-expiry.
- No on-chain reputation/PTS — the roster routes on availability, not reputation.

## Run
```bash
npm install
cp .env.example .env    # fill the CROO + Anthropic values listed below
npm run slice           # starts the leaf providers + the Axion buyer, runs one composition
```
`.env` keys: `CROO_API_URL`, `CROO_WS_URL`, `CROO_SDK_KEY` (Axion), `LEAF_PRICE_SDK_KEY`,
`LEAF_PRICE_SERVICE_ID`, `LEAF_SUMMARIZE_SDK_KEY`, `LEAF_SUMMARIZE_SERVICE_ID`, `ANTHROPIC_API_KEY`.

## Build for the CROO Agent Hackathon
Track: Open A2A. CAP SDK: [`@croo-network/sdk`](https://github.com/CROO-Network/node-sdk). MIT.
See `CLAUDE.md` for the verified build facts, the rubric mapping, and the integrity rules.
Agent + service creation and SDK-Key issuance happen in the CROO Dashboard, not the SDK.
