# @antseed/topup

x402 top-up gateway: lets any x402-compatible agent or client fund an AntSeed
buyer deposit account through [Meridian](https://mrdn.finance)'s x402
facilitator — no ETH for gas, no contract-call logic, just an HTTP 402 flow.

New here? **[SETUP.md](./SETUP.md)** is a step-by-step tutorial: a complete
local sandbox (anvil + mock facilitator) in ~10 minutes, then the real
Base setup.

## Why a gateway

`AntseedDeposits.deposit(buyer, amount)` pulls USDC from `msg.sender`, so
funding a deposit normally requires a gas-funded wallet making a contract
call. The deployed contract is not upgradeable, so a gasless path cannot be
added on-chain. This service bridges the gap off-chain:

```
agent                    gateway                   Meridian              Base
  │  POST /v1/topup         │                         │                   │
  │ ───────────────────────▶│                         │                   │
  │  402 + requirements     │                         │                   │
  │ ◀───────────────────────│                         │                   │
  │  sign EIP-3009 (gasless)│                         │                   │
  │  retry with X-PAYMENT   │                         │                   │
  │ ───────────────────────▶│  POST /v1/settle        │                   │
  │                         │ ───────────────────────▶│ transferWithAuth  │
  │                         │                         │ ─────────────────▶│
  │                         │  net USDC → relayer     │                   │
  │                         │  deposit(buyer, net)    │                   │
  │                         │ ────────────────────────────────────────────▶
  │  200 + receipts         │                         │                   │
  │ ◀───────────────────────│                         │                   │
```

The relayer wallet briefly custodies the settled USDC between Meridian
settlement and the `deposit()` call. Every payment is tracked in a SQLite
state machine keyed by the payment signature, so crashes, RPC failures and
client retries are reconciled without double-crediting or losing funds.

## Guard rails

- **Credit limit**: `deposit()` reverts with `CreditLimitExceeded` when
  `balance + amount` exceeds the buyer's on-chain credit limit. The gateway
  quotes `maxAmountRequired` capped to live headroom, re-checks with a static
  call before spending gas, and **refunds the payer** if the deposit still
  cannot be credited (e.g. a concurrent deposit consumed the headroom).
- **First-deposit minimum**: `MIN_BUYER_DEPOSIT` applies to buyers with a
  zero balance. The quoted minimum is grossed up by `maxSettleFeeBps` so the
  post-fee net amount still clears it.
- **Fees**: Meridian deducts platform/treasury fees before crediting the
  recipient. The gateway reads the *actual* net amount from the settlement
  transaction's USDC `Transfer` logs and credits exactly that.
- **Idempotency**: the top-up id is `keccak256(signature)`. Replaying the
  same X-PAYMENT returns the recorded outcome; interrupted flows resume from
  their persisted state (`settling → settled → depositing → deposited`, with
  `refunding → refunded` and `needs_review` branches). Recovery runs at
  startup and never re-sends a deposit before checking `Deposited` logs for
  an earlier attempt.
- **Signature hygiene**: payloads are verified locally (EIP-712 recovery,
  facilitator binding, expiry, on-chain `authorizationState`) before any
  Meridian call, and payment signatures are never exposed via the API.

## Endpoints

| Method | Path             | Purpose                                              |
| ------ | ---------------- | ---------------------------------------------------- |
| POST   | `/v1/topup`      | 402 challenge; settle + deposit when X-PAYMENT is set |
| GET    | `/v1/topup/quote`| Read-only bounds (`?buyer=0x..&amount=..`)            |
| GET    | `/v1/topup/:id`  | Status of a submitted top-up                          |
| GET    | `/healthz`       | Gateway wiring info                                   |

`POST /v1/topup` body: `{ "buyer": "0x..", "amount": "5000000" }` — `amount`
is in USDC base units; `buyer` defaults to the payer (third-party funding of
any buyer is supported, matching the contract). The payment can be supplied
as a standard base64 `X-PAYMENT` header or a `paymentPayload` body field.

Responses: `200` deposited (with `X-PAYMENT-RESPONSE` header), `402`
challenge or settlement failure (fresh `accepts` included), `409` credit
limit reached / authorization reused / deposit refunded, `503` outcome
pending — retry the same request.

## Configuration

| Env var | Default | Notes |
| --- | --- | --- |
| `ANTSEED_TOPUP_RELAYER_KEY` | — (required) | Hex private key. Needs ETH for gas on Base. |
| `MERIDIAN_API_KEY` | — (required) | Organization key from mrdn.finance/dev/api-keys. |
| `ANTSEED_TOPUP_CHAIN_ID` | `base-mainnet` | `base-mainnet`, `base-sepolia`, `base-local`. |
| `ANTSEED_TOPUP_RPC_URL` | chain default | |
| `ANTSEED_TOPUP_PORT` / `ANTSEED_TOPUP_HOST` | `8390` / `127.0.0.1` | Put a TLS proxy in front for public exposure. |
| `ANTSEED_TOPUP_PUBLIC_URL` | `http://127.0.0.1:<port>` | Advertised as the x402 `resource`. |
| `ANTSEED_TOPUP_DATA_DIR` | `~/.antseed-topup` | SQLite state lives here. |
| `ANTSEED_TOPUP_MIN_AMOUNT` | `100000` (0.10 USDC) | Dust floor per top-up. |
| `ANTSEED_TOPUP_MAX_AMOUNT` | `0` (headroom only) | Optional per-request cap. |
| `ANTSEED_TOPUP_MAX_SETTLE_FEE_BPS` | `2000` | Worst-case fee assumption for first-deposit gross-up. |
| `MERIDIAN_API_BASE` | `https://api.mrdn.finance/v1` | |
| `MERIDIAN_X402_NETWORK` etc. | per-chain preset | Required overrides on `base-local`. |

## Operational notes

- **Meridian organization**: the org's recipient (or platform-mode
  `extra.creditedRecipient`, which the gateway always sets) **must be the
  relayer wallet** — otherwise settlements credit someone else and top-ups
  land in `needs_review`.
- **Relayer float**: on base-mainnet the payment token and the deposits
  token are both canonical USDC, so settled funds are deposited 1:1. On
  base-sepolia Meridian settles Circle testnet USDC while AntseedDeposits
  custodies MockUSDC — the relayer must hold a MockUSDC float there.
- **Monitoring**: alert on rows stuck in `needs_review` (operator action
  required) and on relayer ETH/deposit-token balances.
- **Custody**: between settlement and deposit the relayer wallet holds the
  funds. Keep the key hot-wallet sized; state + refunds bound the exposure
  to in-flight top-ups only.

## Run

```bash
pnpm --filter=@antseed/topup run build
ANTSEED_TOPUP_RELAYER_KEY=0x... MERIDIAN_API_KEY=pk_... \
  node apps/topup/dist/index.js
```

Tests: `pnpm --filter=@antseed/topup run test`
