# Foreman

**General-contractor agent for the CROO economy.** Give it a goal + a USDC budget; it discovers
(curated roster), hires, escrows, verifies and composes multiple CAP sub-agents into one finished
deliverable — and settles every hire on-chain on Base.

> **Status: scaffold.** Nothing here is "live" yet. The first milestone is a vertical slice —
> one goal → multiple real CAP orders → a composed result, verifiable on-chain. Claims will be
> added only when the code path is proven end-to-end.

## Why it matters
A normal API marketplace can chain calls, but it can't give you **per-hop on-chain escrow with
auto-refund on expiry, a verifiable on-chain settlement record of every hire, and ERC-4337 agent
wallets with selector-scoped keys** — all native to CAP. Foreman is the demand engine of the CROO
Agent Store: by construction it forms many real A2A relationships and makes other agents get paid.

> Scope note (honesty): payment release is not buyer-gated by default (CAP releases on the
> provider's delivery unless a CROO-gated evaluator is set); Foreman's deliverable check is
> off-chain. We claim only what the CAP contracts actually enforce.

## Build for the CROO Agent Hackathon
Track: Open A2A. Requirements: callable agent, accepts USDC, settles on-chain, listed on the CROO
Agent Store, CAP-integrated, open-source (MIT), ≤5-min demo. See `CLAUDE.md` for the verified
build facts, the rubric mapping, and the integrity rules.

## Develop
```bash
npm install
cp .env.example .env   # fill CROO_SDK_KEY (issued in the CROO Dashboard) + ANTHROPIC_API_KEY
npm run start          # scaffold entrypoint
```
SDK: [`@croo-network/sdk`](https://github.com/CROO-Network/node-sdk). Agent + service creation and
SDK-Key issuance happen in the CROO Dashboard, not the SDK.
