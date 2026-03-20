# PRD-02: Payments Portal

**Created:** 2026-03-20T12:00Z
**Status:** DRAFT
**Dependencies:** None
**Estimated Tasks:** 12

## Overview

Create a standalone `apps/payments` app (Fastify + React + Vite) that serves as the buyer's payment portal. It runs on localhost, launched by the desktop app or via `antseed payments` CLI command. Supports crypto deposit (connect wallet, approve USDC, call `deposit()`) and credit card deposit (Crossmint `depositFor()`). Also provides withdrawal management and balance display.

---

### Task 1: Scaffold `apps/payments` package

##### CREATE: `apps/payments/package.json`

```json
{
  "name": "@antseed/payments",
  "version": "0.1.0",
  "private": true,
  "description": "Buyer payments portal for AntSeed",
  "type": "module",
  "main": "dist/index.js",
  "scripts": {
    "build": "npm run build:server && npm run build:web",
    "build:server": "tsc -p tsconfig.json",
    "build:web": "vite build",
    "dev": "concurrently -k \"npm:dev:web\" \"npm:dev:server\"",
    "dev:web": "vite",
    "dev:server": "tsc -p tsconfig.json --watch --preserveWatchOutput",
    "start": "node dist/index.js",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@antseed/node": "workspace:*",
    "@fastify/cors": "^10.0.0",
    "@fastify/static": "^9.0.0",
    "ethers": "^6.13.0",
    "fastify": "^5.7.4"
  },
  "devDependencies": {
    "@types/node": "^20.11.0",
    "@types/react": "^18.3.12",
    "@types/react-dom": "^18.3.1",
    "@vitejs/plugin-react": "^4.3.0",
    "concurrently": "^9.0.1",
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "sass": "^1.97.3",
    "typescript": "^5.6.0",
    "vite": "^6.0.0"
  }
}
```

##### CREATE: `apps/payments/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "Node16",
    "moduleResolution": "Node16",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"],
  "exclude": ["src/web", "node_modules", "dist"]
}
```

##### CREATE: `apps/payments/vite.config.ts`

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  root: 'web',
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
  },
  server: {
    port: 5175,
  },
});
```

##### CREATE: `apps/payments/web/index.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>AntSeed Payments</title>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
```

##### Add to workspace

**MODIFY**: root `pnpm-workspace.yaml` — add `apps/payments` to the packages list if not already included by glob.

#### Acceptance Criteria
- [ ] `pnpm install` succeeds
- [ ] `pnpm --filter @antseed/payments build:server` compiles without errors
- [ ] `pnpm --filter @antseed/payments build:web` bundles without errors
- [ ] Package follows same structure as `apps/dashboard`

---

### Task 2: Create Fastify server with balance API

##### CREATE: `apps/payments/src/index.ts`

Entry point that starts the Fastify server:
```ts
import { createServer } from './server.js';

const DEFAULT_PORT = 3118;

async function main() {
  const port = Number(process.env['ANTSEED_PAYMENTS_PORT']) || DEFAULT_PORT;
  const dataDir = process.env['ANTSEED_DATA_DIR'] || undefined;
  const identityHex = process.env['ANTSEED_IDENTITY_HEX'] || undefined;

  const server = await createServer({ port, dataDir, identityHex });
  await server.listen({ port, host: '127.0.0.1' });
  console.log(`[payments] Portal running at http://127.0.0.1:${port}`);
}

main().catch((err) => {
  console.error('[payments] Failed to start:', err);
  process.exit(1);
});
```

##### CREATE: `apps/payments/src/server.ts`

Fastify app with CORS, static serving, and API routes:
- `createServer({ port, dataDir, identityHex })` — returns configured Fastify instance
- Serves static web files from `dist/web/`
- Registers routes from `./routes.js`
- Loads config from `~/.antseed/config.json` (same path as CLI)
- Derives EVM address from identity hex if provided

Key exports: `createServer`, `PaymentsServerOptions`

##### CREATE: `apps/payments/src/routes.ts`

API routes:

**`GET /api/balance`** — Returns buyer escrow balance
- Uses `BaseEscrowClient.getBuyerBalance(evmAddress)` and `getBuyerCreditLimit(evmAddress)`
- Returns: `{ evmAddress, available, reserved, total, pendingWithdrawal, creditLimit }` (all as human-readable USDC strings)

**`GET /api/transactions`** — Returns deposit/withdrawal history
- Reads from on-chain events (placeholder for v1 — return empty array with TODO)

**`GET /api/config`** — Returns payment config (chain, contract addresses)
- Returns: `{ chainId, rpcUrl, escrowContractAddress, usdcContractAddress }`

**`POST /api/withdraw/request`** — Initiate withdrawal
- Body: `{ amount: string }` (human-readable USDC)
- Calls `BaseEscrowClient.requestWithdrawal(signer, baseUnits)`
- Returns: `{ ok: true, txHash }`

**`POST /api/withdraw/execute`** — Execute pending withdrawal (after 48h delay)
- Calls `BaseEscrowClient.executeWithdrawal(signer)`
- Returns: `{ ok: true, txHash }`

**`POST /api/withdraw/cancel`** — Cancel pending withdrawal
- Calls `BaseEscrowClient.cancelWithdrawal(signer)`
- Returns: `{ ok: true, txHash }`

#### Acceptance Criteria
- [ ] Server starts on port 3118
- [ ] `GET /api/balance` returns real escrow balance
- [ ] `GET /api/config` returns chain/contract info
- [ ] Withdrawal routes call escrow contract correctly
- [ ] All routes handle errors gracefully (return `{ ok: false, error }`)

---

### Task 3: Create crypto context loader

##### CREATE: `apps/payments/src/crypto-context.ts`

Loads identity and derives EVM wallet for the payments portal:

```ts
import { loadOrCreateIdentity, identityToEvmWallet, identityToEvmAddress, BaseEscrowClient } from '@antseed/node';
import type { Identity } from '@antseed/node';
import { Wallet } from 'ethers';

export interface CryptoContext {
  identity: Identity;
  wallet: Wallet;
  evmAddress: string;
}

export interface PaymentCryptoConfig {
  rpcUrl: string;
  escrowContractAddress: string;
  usdcContractAddress: string;
}

/**
 * Load crypto context from either ANTSEED_IDENTITY_HEX env var
 * or from the data directory's identity file.
 */
export async function loadCryptoContext(options: {
  identityHex?: string;
  dataDir?: string;
}): Promise<CryptoContext> {
  let identity: Identity;

  if (options.identityHex) {
    // Desktop passes the decrypted identity hex via env var
    const { hexToBytes, toPeerId, bytesToHex } = await import('@antseed/node');
    const { getPublicKey } = await import('@noble/ed25519');
    const privateKey = hexToBytes(options.identityHex);
    const publicKey = getPublicKey(privateKey);
    identity = { peerId: toPeerId(bytesToHex(publicKey)), privateKey, publicKey };
  } else {
    const dataDir = options.dataDir || (await import('node:os')).homedir() + '/.antseed';
    identity = await loadOrCreateIdentity(dataDir);
  }

  const wallet = identityToEvmWallet(identity);
  const evmAddress = identityToEvmAddress(identity);
  return { identity, wallet, evmAddress };
}

export function createEscrowClient(config: PaymentCryptoConfig): BaseEscrowClient {
  return new BaseEscrowClient({
    rpcUrl: config.rpcUrl,
    contractAddress: config.escrowContractAddress,
    usdcAddress: config.usdcContractAddress,
  });
}
```

#### Acceptance Criteria
- [ ] Loads identity from hex env var (desktop path)
- [ ] Loads identity from file (CLI path)
- [ ] Derives correct EVM address matching `identityToEvmAddress()`
- [ ] Creates escrow client from config

---

### Task 4: Create React app shell and routing

##### CREATE: `apps/payments/web/src/main.tsx`

```tsx
import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.scss';

const root = document.getElementById('root')!;
createRoot(root).render(<App />);
```

##### CREATE: `apps/payments/web/src/App.tsx`

Main app component with tab-based navigation:
- **Tabs**: "Balance", "Deposit", "Withdraw"
- **Header**: "AntSeed Payments" title + EVM address display (truncated)
- Fetches balance on mount and after any deposit/withdrawal action
- Stores `balance`, `config`, and `activeTab` in state

Key structure:
```tsx
export function App() {
  const [activeTab, setActiveTab] = useState<'balance' | 'deposit' | 'withdraw'>('deposit');
  const [balance, setBalance] = useState<BalanceData | null>(null);
  const [config, setConfig] = useState<PaymentConfig | null>(null);

  // Fetch balance and config on mount
  // ...

  return (
    <div className="app">
      <header className="app-header">
        <h1>AntSeed Payments</h1>
        {balance?.evmAddress && <span className="evm-address">{truncateAddress(balance.evmAddress)}</span>}
      </header>
      <nav className="tabs">
        <button onClick={() => setActiveTab('balance')} className={activeTab === 'balance' ? 'active' : ''}>Balance</button>
        <button onClick={() => setActiveTab('deposit')} className={activeTab === 'deposit' ? 'active' : ''}>Deposit</button>
        <button onClick={() => setActiveTab('withdraw')} className={activeTab === 'withdraw' ? 'active' : ''}>Withdraw</button>
      </nav>
      <main>
        {activeTab === 'balance' && <BalanceView balance={balance} />}
        {activeTab === 'deposit' && <DepositView config={config} onDeposited={refreshBalance} />}
        {activeTab === 'withdraw' && <WithdrawView balance={balance} onAction={refreshBalance} />}
      </main>
    </div>
  );
}
```

##### CREATE: `apps/payments/web/src/styles/global.scss`

Global styles following AntSeed design language (dark theme, similar to desktop app):
- CSS variables matching desktop app's color scheme
- Clean, minimal layout
- Card-based sections
- Green accent for CTAs

#### Acceptance Criteria
- [ ] App renders with header, tabs, and content area
- [ ] Fetches balance from `/api/balance` on mount
- [ ] Tab switching works
- [ ] EVM address displayed in header (truncated: `0x1234...abcd`)

---

### Task 5: Create BalanceView component

##### CREATE: `apps/payments/web/src/components/BalanceView.tsx`

Displays escrow balance breakdown:

```
┌─────────────────────────────────┐
│ Available Balance                │
│ $10.50                          │
│                                 │
│ Reserved     $0.50              │
│ Pending      $0.00              │
│ Total        $11.00             │
│ Credit Limit $50.00             │
└─────────────────────────────────┘
```

Props: `{ balance: BalanceData | null }`

Shows loading skeleton when balance is null. Displays all fields from the `/api/balance` response.

#### Acceptance Criteria
- [ ] Shows available, reserved, pending withdrawal, total, and credit limit
- [ ] Shows loading state when data is null
- [ ] Formats USDC values with 2 decimal places

---

### Task 6: Create DepositView with crypto wallet connection

##### CREATE: `apps/payments/web/src/components/DepositView.tsx`

Two deposit methods in tabs: "Crypto" and "Credit Card".

**Crypto tab:**
- "Connect Wallet" button — uses `window.ethereum` (MetaMask/injected provider)
- Once connected:
  - Shows connected wallet address
  - Amount input field
  - "Deposit" button
  - Flow: approve USDC → call `deposit()` on escrow contract
- Uses ethers.js `BrowserProvider` + `Contract` directly in the browser
- Contract ABI: only `deposit(uint256)` and USDC `approve(address,uint256)` + `balanceOf(address)`
- Chain validation: must be on Base (chainId 8453) — prompt to switch if wrong chain

**Credit Card tab:**
- Shows Crossmint integration placeholder
- "Coming soon — credit card deposits will be available here"
- Reserved for Task 7

Props: `{ config: PaymentConfig | null; onDeposited: () => void }`

#### Acceptance Criteria
- [ ] "Connect Wallet" connects via `window.ethereum`
- [ ] Shows connected address after connection
- [ ] Amount input validates > 0
- [ ] First deposit enforces MIN_BUYER_DEPOSIT (10 USDC) — show hint in UI
- [ ] Calls USDC `approve()` then escrow `deposit()` sequentially
- [ ] Shows tx hash on success, error on failure
- [ ] Calls `onDeposited()` callback to refresh balance
- [ ] Chain validation: detects wrong chain, shows switch prompt

---

### Task 7: Add Crossmint credit card integration slot

##### MODIFY: `apps/payments/web/src/components/DepositView.tsx`

**In the "Credit Card" tab**, replace placeholder with Crossmint integration structure:

```tsx
function CrossmintDeposit({ config, buyerAddress, onDeposited }: {
  config: PaymentConfig;
  buyerAddress: string;
  onDeposited: () => void;
}) {
  // Crossmint Pay API integration
  // Uses: POST https://www.crossmint.com/api/v1-alpha2/checkout/mintTo
  // with destinationAddress = escrow contract
  // callData = depositFor(buyerAddress, amount) encoded
  //
  // Requires CROSSMINT_API_KEY in env
  // For now: show configuration instructions if no API key

  const apiKeyConfigured = Boolean(config.crossmintApiKey);

  if (!apiKeyConfigured) {
    return (
      <div className="crossmint-setup">
        <h3>Credit Card Deposits</h3>
        <p>To enable credit card deposits, configure your Crossmint API key:</p>
        <code>ANTSEED_CROSSMINT_API_KEY=your_key</code>
        <p>
          Crossmint's Pay API will call <code>depositFor(buyerAddress, amount)</code>{' '}
          on the escrow contract, funding your account directly from a credit card.
        </p>
      </div>
    );
  }

  return (
    <div className="crossmint-deposit">
      <h3>Deposit via Credit Card</h3>
      {/* Amount input + Crossmint checkout button */}
      {/* Will integrate Crossmint SDK here */}
    </div>
  );
}
```

##### MODIFY: `apps/payments/src/routes.ts`

**Add `GET /api/config`** to include `crossmintApiKey: boolean` (whether configured, not the actual key):
```ts
crossmintConfigured: Boolean(process.env['ANTSEED_CROSSMINT_API_KEY']),
```

**Note**: The escrow contract needs a `depositFor(address buyer, uint256 amount)` function for Crossmint to call. Verify this exists. If not, it will need to be added in a contract update (out of scope for this PRD — flag as follow-up).

#### Acceptance Criteria
- [ ] Credit card tab shows setup instructions when no API key configured
- [ ] Config endpoint exposes `crossmintConfigured` boolean
- [ ] Architecture ready for Crossmint SDK integration
- [ ] No API key leaked to frontend

---

### Task 8: Create WithdrawView component

##### CREATE: `apps/payments/web/src/components/WithdrawView.tsx`

Withdrawal management UI:

**States:**
1. **No pending withdrawal**: Shows "Request Withdrawal" form with amount input
2. **Pending withdrawal**: Shows countdown to WITHDRAWAL_DELAY (48h), with "Cancel" button
3. **Ready to execute**: Shows "Execute Withdrawal" button (after 48h passed)

```tsx
function WithdrawView({ balance, onAction }: { balance: BalanceData | null; onAction: () => void }) {
  // Read pending withdrawal from balance
  // If pendingWithdrawal > 0: show pending state
  // If withdrawal delay elapsed: show execute button
  // Otherwise: show request form
}
```

API calls:
- `POST /api/withdraw/request` with `{ amount }`
- `POST /api/withdraw/execute`
- `POST /api/withdraw/cancel`

Show tx hash on success, error message on failure.

#### Acceptance Criteria
- [ ] Request withdrawal with amount input
- [ ] Shows pending withdrawal with countdown timer
- [ ] Execute button appears after 48h delay
- [ ] Cancel button for pending withdrawals
- [ ] Error handling for all API calls

---

### Task 9: Add `depositFor` to escrow contract ABI (if missing)

Check `AntseedEscrow.sol` for a `depositFor(address, uint256)` function. If it doesn't exist, add it.

##### MODIFY: `packages/node/contracts/AntseedEscrow.sol`

**Add function** (after the existing `deposit` function):
```solidity
/**
 * @notice Deposit USDC on behalf of a buyer (for fiat ramps like Crossmint).
 * @param buyer The address to credit.
 * @param amount USDC amount in base units (6 decimals).
 */
function depositFor(address buyer, uint256 amount) external {
    if (amount == 0) revert ZeroAmount();
    BuyerAccount storage ba = buyerAccounts[buyer];
    if (ba.balance == 0 && amount < MIN_BUYER_DEPOSIT) revert BelowMinDeposit();
    if (ba.balance + amount > getBuyerCreditLimit(buyer)) revert CreditLimitExceeded();

    usdc.transferFrom(msg.sender, address(this), amount);
    ba.balance += amount;
    ba.lastActivityAt = block.timestamp;
    if (ba.firstSessionAt == 0) ba.firstSessionAt = block.timestamp;

    emit Deposited(buyer, amount);
}
```

##### MODIFY: `packages/node/src/payments/evm/escrow-client.ts`

**Add to ESCROW_ABI** array:
```ts
'function depositFor(address buyer, uint256 amount) external',
```

**Add method to `BaseEscrowClient`** (after `deposit`):
```ts
async depositFor(signer: AbstractSigner, buyer: string, amount: bigint): Promise<string> {
  const connected = this._ensureConnected(signer);
  const signerAddress = await connected.getAddress();
  const usdc = new Contract(this._usdcAddress, ERC20_ABI, connected);
  const approveNonce = await this._reserveNonce(signerAddress);
  const approveTx = await usdc.getFunction('approve')(this._contractAddress, amount, { nonce: approveNonce });
  const approveReceipt = await approveTx.wait();
  if (!approveReceipt) throw new Error('Transaction was dropped or replaced');
  const contract = new Contract(this._contractAddress, ESCROW_ABI, connected);
  const depositNonce = await this._reserveNonce(signerAddress);
  const tx = await contract.getFunction('depositFor')(buyer, amount, { nonce: depositNonce });
  const receipt = await tx.wait();
  if (!receipt) throw new Error('Transaction was dropped or replaced');
  return receipt.hash;
}
```

#### Acceptance Criteria
- [ ] `depositFor(address, uint256)` exists in the Solidity contract
- [ ] Same deposit rules apply (MIN_BUYER_DEPOSIT, credit limit)
- [ ] `BaseEscrowClient.depositFor()` method works
- [ ] Emits `Deposited(buyer, amount)` event (same as self-deposit)

---

### Task 10: Add `antseed payments` CLI command

##### CREATE: `apps/cli/src/cli/commands/payments.ts`

```ts
import type { Command } from 'commander';

export function registerPaymentsCommand(program: Command): void {
  program
    .command('payments')
    .description('Launch the buyer payments portal')
    .option('-p, --port <port>', 'Portal port', '3118')
    .action(async (options) => {
      const { createServer } = await import('@antseed/payments');
      const port = Number(options.port) || 3118;

      // Pass identity hex if available
      const identityHex = process.env['ANTSEED_IDENTITY_HEX'] || undefined;
      const server = await createServer({ port, identityHex });
      await server.listen({ port, host: '127.0.0.1' });

      console.log(`Payments portal running at http://127.0.0.1:${port}`);
      console.log('Press Ctrl+C to stop.');
    });
}
```

##### MODIFY: `apps/cli/src/cli/index.ts`

**Add import and register** (alongside existing command registrations):
```ts
import { registerPaymentsCommand } from './commands/payments.js';
// ... in the command registration section:
registerPaymentsCommand(program);
```

##### MODIFY: `apps/payments/src/index.ts`

**Export `createServer`** for use by CLI:
```ts
export { createServer } from './server.js';
export type { PaymentsServerOptions } from './server.js';
```

##### MODIFY: `apps/payments/package.json`

**Add exports field**:
```json
"exports": {
  ".": "./dist/index.js"
}
```

#### Acceptance Criteria
- [ ] `antseed payments` starts the portal on port 3118
- [ ] `antseed payments --port 4000` uses custom port
- [ ] Portal serves the web UI and API routes
- [ ] Ctrl+C gracefully stops the server

---

### Task 11: Shared types

##### CREATE: `apps/payments/web/src/types.ts`

```ts
export interface BalanceData {
  evmAddress: string;
  available: string;
  reserved: string;
  total: string;
  pendingWithdrawal: string;
  creditLimit: string;
}

export interface PaymentConfig {
  chainId: string;
  rpcUrl: string;
  escrowContractAddress: string;
  usdcContractAddress: string;
  crossmintConfigured: boolean;
}
```

#### Acceptance Criteria
- [ ] Types used consistently across all components
- [ ] Match API response shapes

---

### Task 12: API client helper

##### CREATE: `apps/payments/web/src/api.ts`

```ts
import type { BalanceData, PaymentConfig } from './types';

const BASE = '';  // Same origin

async function fetchJson<T>(url: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${url}`, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function getBalance(): Promise<BalanceData> {
  return fetchJson('/api/balance');
}

export async function getConfig(): Promise<PaymentConfig> {
  return fetchJson('/api/config');
}

export async function requestWithdrawal(amount: string): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  return fetchJson('/api/withdraw/request', {
    method: 'POST',
    body: JSON.stringify({ amount }),
  });
}

export async function executeWithdrawal(): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  return fetchJson('/api/withdraw/execute', { method: 'POST' });
}

export async function cancelWithdrawal(): Promise<{ ok: boolean; error?: string }> {
  return fetchJson('/api/withdraw/cancel', { method: 'POST' });
}
```

#### Acceptance Criteria
- [ ] All API endpoints wrapped
- [ ] Error handling extracts error message from response
- [ ] Types match server responses
