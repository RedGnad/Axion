# Axion — Audit & Verification Report

> Purpose: let a reviewer/advisor independently verify every claim at the source (on-chain on
> Base mainnet + the CROO API). Nothing here is asserted without a tx hash or a reproducible check.
> Generated 2026-06-14.

## 1. What Axion is
Axion is a **composition primitive other CROO agents call**: given a goal, it subcontracts a
multi-agent task — hiring CAP sub-agents, escrowing USDC per sub-hire on Base, composing the
deliverables, and returning the result + an on-chain **manifest** of every sub-order. It is also
itself a registered CAP service (others can hire it). Picks-and-shovels infra, not an end-user app.

## 2. Agents & wallets (all on Base mainnet)
| Agent | Role | serviceId | AA wallet |
|---|---|---|---|
| **Axion** | composer / buyer + provider | `28263c7f-eb73-475e-84af-a8f1a7e5b097` | `0x064c6Fb59c4Fdbf6BDC0Dc27A2d2bCDb59E7B5Cb` |
| axion-price | leaf (ours) | `baa42341-ec9f-41fc-a3fa-3553321acbb7` | `0xD5D675DEA6c8aee9c06Ff42bC723cf3CE8687B26` |
| axion-summarize | leaf (ours) | `729d73e1-bbab-4a02-bbe5-98d3fb00f4e8` | `0x719Cc7A9c10e6B93A433E2C76c12083ABe36a9a1` |
| VERIS (third party) | provider (NOT ours) | `01261c7d-0b7f-4145-9fc8-d46d051ff228` | `0x25E6933538cbf1AED53BDccC5Ab06b70EcECC70C` |

USDC token (Base): `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (6 decimals).

## 3. On-chain settlements (completed CAP orders)
Every order below is `status=completed` (NEGOTIATION→LOCK→DELIVER→CLEAR). Verify on BaseScan:
`https://basescan.org/tx/<hash>`.

| # | capability | ours | orderId | price | pay tx | clear tx |
|---|---|---|---|---|---|---|
| 1 | price | ✅ ours | `ac6bfbae-a8f6-4429-a748-10e918900f66` | 0.01 | `0x8474e035715a4c26eb3106ae40eb35d5bf8fe52d3add300d4dfb8a8544d16e87` | `0xd83b71400cad788931c87f25176608db080641580e237d2496f12f15335487ae` |
| 2 | price | ✅ ours | `74acca1c-0bb4-4543-b027-8dcf6c34986e` | 0.01 | `0xdc519fc734a3c90bcaf522338b1e0f319a5cb2853e593efadae6b138ce239dd6` | `0x17fac13ffd3a944c44f206176ac1f5f41faf8946b4692507a9cc8d7faeacebdb` |
| 3 | summarize | ✅ ours | `c0207887-9373-456c-b3ca-136ce4fefc9f` | 0.01 | `0x3d0b547a1968ea7166ad1357cdbfed5b7680c1d2a2b43b9450fd204aa3c2181a` | `0x377c0cca733f12276953bb662a5fbeb76136c12ed91fd8394ae1550a5c94c5ed` |
| 4 | trust-vet | ❌ **THIRD-PARTY** | `56ee53e1-485f-4ea9-bf8d-e79eb661ca86` | 0.10 | `0x51627c054b3e0a3d1c4a92ebda03c6ecdad96112d3a9a3227706243040436cf1` | `0xd947754603d7b77c7cf7090b7ce6d2bdc1405d50245f0dccd0fd4e08a2b096e8` |
| 5 | trust-history | ❌ **THIRD-PARTY** | `090d0f39-18d2-4e6b-acf3-aaae4f29b1d5` | 0.20 | `0x9bbcd15b80031d69bc72ecbe6fe0aa12532b216435911ef09272444c31e22be7` | `0x90fd76be56e58e5b509e7cd5231c74f56b992f6730094020fea1be77cd747912` |

**5 completed orders → 10 on-chain txs** (5 pay + 5 clear). **Of these, 2 are non-self-trade**
(orders #4 and #5 — both paid to the third-party VERIS agent).

### The non-self-trade settlements (orders #4 and #5)
The load-bearing proof: Axion (requester `0x064c…B5Cb`) paid the **VERIS** agent twice — provider
`0x25E6933538cbf1AED53BDccC5Ab06b70EcECC70C`, a **different developer's wallet** (verified
`order.providerWalletAddress` is NOT any of our wallets, on both orders). Two genuine A2A edges,
recorded `ours:false`. Order #5 (Trust Receipt History) returned substantive content (a trust audit
of axion-price: legitimacy 1/100, maturity 13/100, confidence 63%); order #4 (Trust Compare)
returned a null-result. Orders #1–3 are our own composition (self-trade, `ours:true`) and are not
counted toward the non-self-trade requirement.

## 4. How to verify independently
```bash
# (a) BaseScan: open any tx hash above → expect status Success, USDC transfer.

# (b) CROO API — confirm order completed + the third-party provider wallet:
node --env-file=.env -e '
const {AgentClient}=require("@croo-network/sdk");
(async()=>{const a=new AgentClient({baseURL:process.env.CROO_API_URL,wsURL:process.env.CROO_WS_URL},process.env.CROO_SDK_KEY);
const o=await a.getOrder("56ee53e1-485f-4ea9-bf8d-e79eb661ca86");
console.log(o.status,o.requesterWalletAddress,o.providerWalletAddress);})()'
# → completed 0x064c...B5Cb 0x25E6933538cbf1AED53BDccC5Ab06b70EcECC70C   (provider ≠ ours)

# (c) Listing proof: negotiating Axion's own service returns "cannot negotiate own service"
#     (400) → the service exists & is registered/discoverable.

# (d) Reproduce a full composed run (our own leaves): npm run slice
#     Reproduce the third-party hire:               npm run serve  (Axion live) + a caller
```

## 5. Onboarding-bounty eligibility mapping
| Criterion | Evidence |
|---|---|
| Listed & discoverable on the Agent Store | Axion serviceId `28263c7f…` active; appears in `/backend/v1/services`; self-negotiate returns "cannot negotiate own service". |
| CAP-integrated + real USDC settlement | All 4 orders settled USDC on Base via CAP (escrow → clear). |
| ≥ 2 completed on-chain transactions | 5 completed orders / 10 txs — **2 of them non-self-trade** (orders #4, #5 to third-party VERIS). |
| No obvious self-trade loops | Orders #4 and #5 are genuine third-party settlements (provider wallet ≠ ours). Orders #1–3 are a real composition product, disclosed as `ours:true`. |
| One agent / one dev | Submitting **Axion** (`28263c7f…`), wallet `0x064c…B5Cb`. |

## 6. Honest scope & caveats (what we do NOT claim)
- **Orders #1–3 are between our own agents** (`ours:true`). We do not present them as third-party
  diversity. Only order #4 (VERIS) is third-party.
- **Third-party content varied.** Order #4 (VERIS Trust Compare) returned a null-result
  ("insufficient evidence"); order #5 (VERIS Trust Receipt History) returned a substantive audit.
  Both *settlements* are real and verifiable on-chain regardless of content.
- **Only one third-party provider was reachable.** Both non-self-trade orders went to the same
  VERIS agent — the only live third-party found in the liveness sweep. Counterparty diversity is
  therefore 1 external agent, not many.
- **Most third-party providers are offline.** A liveness sweep (2026-06-14) of listed third-party
  services found only VERIS online — services are listed but their providers aren't running.
- **Demand side not yet proven.** "An external team's agent calls Axion" has not happened. Axion is
  hireable (`npm run serve`), but for an external spot-check it must be **deployed always-on**
  (a laptop session is not sufficient).
- **No buyer-gated release / no on-chain reputation routing** — CAP releases on delivery; Axion's
  quality check is off-chain; the roster routes on availability, not PTS.
- **CROO fee is steep on small orders**: `feeAmount ≈ price` (e.g. 0.10 order → 0.10 fee). Margin
  math must charge the caller well above Σ(sub price + fee).

## 7. Code map (open source, MIT — github.com/RedGnad/Axion)
- `src/orchestrator.ts` — buyer flow `hire()` (negotiate→OrderCreated→pay→OrderCompleted→getDelivery) + 2-stage DAG `run()` + compose.
- `src/provider.ts` — generic leaf provider runtime (accept negotiation, deliver on pay).
- `src/serve.ts` — Axion live as a hireable CAP service (dual-role on one WS).
- `src/leafs/price.ts` — Chainlink ETH/USD on Base (`0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70`, verified `description()=="ETH / USD"`).
- `src/leafs/summarize.ts` — Claude Haiku summarizer.
- `src/roster.ts` — curated roster; `ours:true` leaves (env-driven) + real third-party `ours:false` (VERIS).
- `src/events.ts` — WS event bus with replay buffer.
- `src/hire-thirdparty.ts` — the third-party hire that produced order #4.
- `src/contract.ts` — Axion's public consumable contract (`AxionRequest`/`AxionResult`).
- `examples/hire-axion.ts` — 1-call integration snippet for any caller.
