# Setup guide — x402 top-up gateway

This is a step-by-step tutorial for running the `@antseed/topup` gateway.
It has two parts:

- **[Part 1 — Local sandbox](#part-1--local-sandbox)**: the full flow on a
  local anvil chain with a mock Meridian facilitator. No real money, no
  Meridian account, ~10 minutes. Do this first — you'll see every moving
  piece.
- **[Part 2 — Base mainnet](#part-2--base-mainnet)**: what changes when you
  run it for real.

If you haven't read [README.md](./README.md) yet, the one-paragraph version:
agents `POST /v1/topup`, get an HTTP 402 with x402 payment requirements,
sign a gasless EIP-3009 authorization, retry with an `X-PAYMENT` header —
and the gateway settles the payment through Meridian and relays the credited
USDC into `AntseedDeposits.deposit(buyer, amount)`.

---

## Part 1 — Local sandbox

You'll run four processes/steps: a local chain, the AntSeed contracts, a
mock facilitator, and the gateway — then pay it with an x402 client.

### 0. Prerequisites

- Node.js >= 20 and pnpm >= 9
- [Foundry](https://getfoundry.sh) (`anvil`, `forge`, `cast`):

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

### 1. Install and build

From the repo root:

```bash
pnpm install
git submodule update --init --recursive   # forge-std, needed to deploy contracts
pnpm run build:tier0                      # @antseed/ui, api-adapter, node
pnpm --filter=@antseed/topup run build
```

### 2. Start a local chain

In its own terminal (leave it running):

```bash
anvil
```

anvil prints ten funded dev accounts. This tutorial uses three of them:

| Role | Account | Address |
| --- | --- | --- |
| relayer (gateway) | #1 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` |
| payer (agent)     | #2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` |
| mock facilitator  | #5 | `0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc` |

The payer never spends gas — it only signs. That's the point of the flow.

### 3. Deploy the AntSeed contracts

```bash
cd packages/contracts
forge script script/Deploy.s.sol --rpc-url http://127.0.0.1:8545 --broadcast
cd ../..
```

Deployment is deterministic; the addresses match the `base-local` presets in
`packages/node/src/payments/chain-config.ts`:

```
MockUSDC:         0x5FbDB2315678afecb367f032d93F642f64180aa3
AntseedDeposits:  0x5FC8d32690cc91D4c39d9d3abcBD16989F875707
```

### 4. Start the mock facilitator

In its own terminal, from the repo root:

```bash
node apps/topup/examples/mock-facilitator.mjs
```

The real Meridian facilitator pulls the payer's USDC via EIP-3009 and pays
the recipient net of fees. The mock mimics the part the gateway can observe:
on `POST /v1/settle` it mints `value − 2%` MockUSDC to the
`extra.creditedRecipient` (the relayer) and returns the settlement tx hash.
The 2% fee is deliberate — you'll see the gateway credit the *net* amount.

### 5. Start the gateway

In its own terminal, from the repo root:

```bash
ANTSEED_TOPUP_CHAIN_ID=base-local \
ANTSEED_TOPUP_RELAYER_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d \
MERIDIAN_API_KEY=pk_local_test \
MERIDIAN_API_BASE=http://127.0.0.1:9490/v1 \
MERIDIAN_X402_NETWORK=base-local \
MERIDIAN_PAYMENT_ASSET=0x5FbDB2315678afecb367f032d93F642f64180aa3 \
MERIDIAN_PAYMENT_ASSET_NAME="USD Coin" \
MERIDIAN_PAYMENT_ASSET_VERSION=2 \
MERIDIAN_FACILITATOR_ADDRESS=0x8E7769D440b3460b92159Dd9C6D17302b036e2d6 \
ANTSEED_TOPUP_DATA_DIR=/tmp/antseed-topup-local \
node apps/topup/dist/index.js
```

What the overrides mean:

- `base-local` has no Meridian preset, so the x402 network, payment asset
  and facilitator address are set explicitly. The payment asset is the
  local MockUSDC — on mainnet the preset handles all of this.
- The facilitator address only anchors the signed `authorization.to`
  locally; no contract lives there on anvil.
- The relayer key is anvil account #1 — it pays the gas that the agent
  doesn't.

You should see:

```
[topup] listening on http://127.0.0.1:8390 (chain base-local, x402 network base-local, relayer 0x7099...79C8)
```

Sanity check:

```bash
curl -s http://127.0.0.1:8390/healthz
```

### 6. Make your first top-up

```bash
node apps/topup/examples/x402-client.mjs
```

The client walks the full protocol and prints each stage:

1. **Unpaid request → HTTP 402.** The body contains `accepts[0]` — the
   Meridian-style payment requirements (`payTo` = facilitator,
   `maxAmountRequired` = 5 USDC, token domain in `extra`) plus a `topup`
   block with the buyer's live bounds. Note `minAmount: 1250000`: the
   contract's 1 USDC first-deposit minimum, grossed up 25% for worst-case
   facilitator fees.
2. **Paid request → HTTP 200.** The gateway settled through the mock
   facilitator, read the net credit from the settlement tx, and deposited
   it. `grossAmount` is `5000000`, `netAmount` is `4900000` — the 2% fee,
   detected from on-chain logs rather than assumed. Both the settlement tx
   and deposit tx hashes are returned, and the standard
   `X-PAYMENT-RESPONSE` header is set.
3. **Replay → HTTP 200, same `depositTx`.** Submitting the identical
   `X-PAYMENT` again returns the recorded outcome. Nothing settles or
   deposits twice.

### 7. Look around

The buyer's deposit account is credited on-chain (available, reserved,
lastActivity):

```bash
cast call 0x5FC8d32690cc91D4c39d9d3abcBD16989F875707 \
  'getBuyerBalance(address)(uint256,uint256,uint256)' \
  0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC --rpc-url http://127.0.0.1:8545
# 4900000 — exactly the net amount
```

The relayer holds nothing between top-ups:

```bash
cast call 0x5FbDB2315678afecb367f032d93F642f64180aa3 \
  'balanceOf(address)(uint256)' \
  0x70997970C51812dc3A010C7d01b50e0d17dc79C8 --rpc-url http://127.0.0.1:8545
# 0
```

Read-only quote (what an agent can pay right now — headroom shrank by the
first top-up):

```bash
curl -s 'http://127.0.0.1:8390/v1/topup/quote?buyer=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC'
```

Status of any top-up by id (`topupId` from the client output):

```bash
curl -s http://127.0.0.1:8390/v1/topup/<topupId>
```

### 8. Kick the tires

Ask for more than the credit limit allows — rejected *before* any money
moves, with the live bounds in the response:

```bash
curl -s -X POST http://127.0.0.1:8390/v1/topup \
  -H 'content-type: application/json' \
  -d '{"buyer":"0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC","amount":"20000000"}'
# {"success":false,"errorReason":"amount_too_high", ... "maxTopup":"5100000"}
```

Kill the mock facilitator and run the client again — the paid request
returns `503` with `errorReason: "pending"` and the row parks in `settling`;
restart the facilitator and resubmit the same `X-PAYMENT` (or restart the
gateway, which reconciles at boot) and it completes. No state is lost, no
payment is double-settled.

### 9. Reset

Stop the three processes, then:

```bash
rm -rf /tmp/antseed-topup-local
```

(anvil state is in-memory; restarting it resets the chain.)

---

## Part 2 — Base mainnet

Same service, three real-world substitutions: a Meridian organization, a
funded relayer wallet, and no overrides (the `base-mainnet` preset carries
the canonical USDC, facilitator address and x402 network).

### 1. Meridian organization

1. Connect a wallet at <https://mrdn.finance> and create an organization.
2. Create an organization API key at <https://mrdn.finance/dev/api-keys>
   (`pk_...`).
3. **Set the organization's recipient to the relayer wallet address.** This
   is the critical step: Meridian pays the org's configured recipient (or
   `extra.creditedRecipient`, which the gateway sets, depending on org
   mode). If settlements credit any other address, top-ups land in
   `needs_review` and funds sit outside the gateway's control.

### 2. Relayer wallet

- Generate a fresh key; this is a **hot wallet** — it briefly custodies
  settled USDC between Meridian settlement and the deposit call, and it
  signs every deposit/refund.
- Fund it with ETH on Base for gas (a deposit is a single ~60k-gas call;
  the first run also sends one max-approval to AntseedDeposits).
- Keep it hot-wallet sized. Exposure is bounded by in-flight top-ups: the
  gateway deposits or refunds every settlement and holds nothing at rest.

### 3. Configure and run

```bash
ANTSEED_TOPUP_RELAYER_KEY=0x<relayer-key> \
MERIDIAN_API_KEY=pk_<org-key> \
ANTSEED_TOPUP_HOST=0.0.0.0 \
ANTSEED_TOPUP_PUBLIC_URL=https://topup.example.com \
ANTSEED_TOPUP_DATA_DIR=/var/lib/antseed-topup \
node apps/topup/dist/index.js
```

Defaults you may want to revisit: `ANTSEED_TOPUP_MAX_AMOUNT` (per-request
cap, default headroom-only), `ANTSEED_TOPUP_MAX_SETTLE_FEE_BPS` (fee
assumption for the first-deposit gross-up, default 20%). Full table in
[README.md](./README.md#configuration). Terminate TLS in front of the
service; the API itself is unauthenticated by design (any agent may fund
any buyer — the contract allows the same).

### 4. Smoke test

```bash
curl -s https://topup.example.com/healthz
curl -s 'https://topup.example.com/v1/topup/quote?buyer=0x<your-buyer>'
```

Then run a real payment. Any x402-compatible client works; the flow is the
standard one from Meridian's EIP-3009 guide (sign
`TransferWithAuthorization` with `to = payTo = facilitator`, chain id 8453,
verifying contract = USDC `0x8335...2913`). `examples/x402-client.mjs` runs
against mainnet too:

```bash
GATEWAY_URL=https://topup.example.com \
EVM_CHAIN_ID=8453 \
PAYER_KEY=0x<payer-key> \
AMOUNT=2000000 \
node apps/topup/examples/x402-client.mjs
```

The payer wallet needs USDC on Base — and no ETH.

### 5. Operate it

- **Alert on `needs_review` rows** in the SQLite store
  (`$ANTSEED_TOPUP_DATA_DIR/topups.db`): they mean funds moved but could
  not be attributed automatically (almost always a mis-configured Meridian
  recipient). Everything else self-heals at startup recovery.
- Watch the relayer's ETH balance (gas) and, on testnets, its deposit-token
  float — on base-sepolia Meridian settles Circle testnet USDC while
  AntseedDeposits custodies MockUSDC, so the relayer deposits from its own
  float there. On mainnet both tokens are canonical USDC and settle 1:1.
- Back up the data dir; it is the source of truth for reconciling
  interrupted top-ups.

---

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `forge script` fails with missing `forge-std/Script.sol` | Run `git submodule update --init --recursive`. |
| Gateway exits with `No Meridian preset for chain "base-local"` | The five `MERIDIAN_*` overrides from step 5 are required on local chains. |
| Gateway exits with `EADDRINUSE` | A previous gateway is still running on 8390 (`ANTSEED_TOPUP_PORT` to change). |
| Paid request returns 503 `pending` | The facilitator was unreachable or errored mid-settlement. Safe to retry the same `X-PAYMENT`; the gateway reconciles via the on-chain authorization state. |
| Top-up ends `needs_review` with "credited no funds to the relayer" | Meridian settled to an address that isn't the relayer — fix the org recipient (Part 2, step 1). |
| First top-up rejected `amount_too_low` at 1 USDC | The on-chain first-deposit minimum is grossed up for worst-case fees (default → 1.25 USDC). Lower `ANTSEED_TOPUP_MAX_SETTLE_FEE_BPS` if your org's real fees are lower. |
