# PRD-01: Credits UI & WalletConnect Removal

**Created:** 2026-03-20T12:00Z
**Status:** DRAFT
**Dependencies:** None
**Estimated Tasks:** 8

## Overview

Remove all WalletConnect integration from the desktop app and add a Credits UI: a button in the TitleBar showing the buyer's escrow balance, a dropdown with "Add Credits", and balance awareness in chat empty states. Balance is read directly from the escrow contract via RPC using the EVM address derived from `identity.enc`.

---

### Task 1: Remove WalletConnect module and dependencies

**Delete** `apps/desktop/src/main/walletconnect.ts` entirely.

##### MODIFY: `apps/desktop/src/main/main.ts`

**Remove import** (line 19):
```ts
import { WalletConnectManager } from './walletconnect.js';
```

**Remove WalletConnect IPC section** (lines 571-602 — the comment `// ── WalletConnect IPC Handlers ──` through `wallet:wc-disconnect` handler):
```ts
// ── WalletConnect IPC Handlers ──

const walletConnectManager = new WalletConnectManager();

walletConnectManager.on('state', (state: unknown) => {
  getMainWindow()?.webContents.send('wallet:wc-state-changed', state);
});

ipcMain.handle('wallet:wc-state', async () => {
  return { ok: true, data: walletConnectManager.state };
});

ipcMain.handle('wallet:wc-connect', async () => {
  // ...
});

ipcMain.handle('wallet:wc-disconnect', async () => {
  // ...
});
```

**Remove WalletConnect init block** (lines 735-741 inside `app.whenReady()`):
```ts
  // Initialize WalletConnect if project ID is configured
  const wcProjectId = process.env['WALLETCONNECT_PROJECT_ID'] ?? '';
  if (wcProjectId.length > 0) {
    void walletConnectManager.init(wcProjectId).catch((err) => {
      console.error('[WalletConnect] init failed:', err instanceof Error ? err.message : String(err));
    });
  }
```

##### MODIFY: `apps/desktop/package.json`

**Remove dependency**:
```json
"@walletconnect/ethereum-provider": "^2.17.0",
```

Also remove `qrcode` dependency (was only used for WC QR display):
```json
"qrcode": "^1.5.4",
```

#### Acceptance Criteria
- [ ] `walletconnect.ts` deleted
- [ ] No references to `WalletConnectManager` or `wallet:wc-*` IPC channels remain
- [ ] `pnpm install` succeeds after dependency removal
- [ ] Desktop app starts without errors
- [ ] `grep -r "walletconnect\|WalletConnect\|wallet:wc" apps/desktop/src/` returns nothing

---

### Task 2: Replace wallet:get-info IPC with escrow balance reader

Replace the existing `wallet:get-info` handler (which returns hardcoded zeroes) with a real escrow balance reader.

##### MODIFY: `apps/desktop/src/main/main.ts`

**Add import** (after the existing `@antseed/node` import on line 20):
```ts
import { identityToEvmAddress, BaseEscrowClient } from '@antseed/node';
```

**Replace the `WalletInfo` type and `wallet:get-info` handler** (lines 504-551) with:
```ts
// ── Credits / Escrow Balance ──

type CreditsInfo = {
  evmAddress: string | null;
  balanceUsdc: string;      // human-readable, e.g. "10.50"
  reservedUsdc: string;
  availableUsdc: string;
  pendingWithdrawalUsdc: string;
  creditLimitUsdc: string;
};

function formatUsdc6(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const frac = (baseUnits % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

let cachedCreditsInfo: CreditsInfo | null = null;
let creditsRefreshPromise: Promise<void> | null = null;

async function refreshCreditsInfo(): Promise<CreditsInfo> {
  const identity = getSecureIdentity();
  if (!identity) {
    return { evmAddress: null, balanceUsdc: '0', reservedUsdc: '0', availableUsdc: '0', pendingWithdrawalUsdc: '0', creditLimitUsdc: '0' };
  }

  const config = await readConfig(ACTIVE_CONFIG_PATH);
  const payments = asRecord(config.payments);
  const crypto = asRecord(payments.crypto);
  const rpcUrl = asString(crypto.rpcUrl as string, '');
  const escrowAddress = asString(crypto.escrowContractAddress as string, '');
  const usdcAddress = asString(crypto.usdcContractAddress as string, '');

  if (!rpcUrl || !escrowAddress || !usdcAddress) {
    const evmAddress = identityToEvmAddress(identity);
    return { evmAddress, balanceUsdc: '0', reservedUsdc: '0', availableUsdc: '0', pendingWithdrawalUsdc: '0', creditLimitUsdc: '0' };
  }

  const evmAddress = identityToEvmAddress(identity);
  const client = new BaseEscrowClient({ rpcUrl, contractAddress: escrowAddress, usdcAddress });

  try {
    const [balance, creditLimit] = await Promise.all([
      client.getBuyerBalance(evmAddress),
      client.getBuyerCreditLimit(evmAddress),
    ]);
    const info: CreditsInfo = {
      evmAddress,
      balanceUsdc: formatUsdc6(balance.available + balance.reserved),
      reservedUsdc: formatUsdc6(balance.reserved),
      availableUsdc: formatUsdc6(balance.available),
      pendingWithdrawalUsdc: formatUsdc6(balance.pendingWithdrawal),
      creditLimitUsdc: formatUsdc6(creditLimit),
    };
    cachedCreditsInfo = info;
    return info;
  } catch (err) {
    console.error('[credits] Failed to fetch escrow balance:', err instanceof Error ? err.message : String(err));
    if (cachedCreditsInfo) return cachedCreditsInfo;
    return { evmAddress, balanceUsdc: '0', reservedUsdc: '0', availableUsdc: '0', pendingWithdrawalUsdc: '0', creditLimitUsdc: '0' };
  }
}

ipcMain.handle('credits:get-info', async (): Promise<{ ok: boolean; data: CreditsInfo | null; error: string | null }> => {
  try {
    await ensureSecureIdentity();
    const info = await refreshCreditsInfo();
    return { ok: true, data: info, error: null };
  } catch (err) {
    return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
  }
});
```

**Remove the old `wallet:deposit` and `wallet:withdraw` handlers** (lines 553-569) — these are stubs that just log messages. Deposit/withdraw will be handled by the payments portal.

#### Acceptance Criteria
- [ ] `credits:get-info` returns real escrow balance when crypto config is present
- [ ] Returns zeroes gracefully when no crypto config or no identity
- [ ] Uses `BaseEscrowClient.getBuyerBalance()` and `getBuyerCreditLimit()`
- [ ] No TypeScript errors

---

### Task 3: Add credits IPC to preload bridge

##### MODIFY: `apps/desktop/src/main/preload.cts`

**Add to the `contextBridge.exposeInMainWorld` object** (alongside existing IPC methods):
```ts
creditsGetInfo: () => ipcRenderer.invoke('credits:get-info'),
```

##### MODIFY: `apps/desktop/src/renderer/types/bridge.ts`

**Add to the `DesktopBridge` type** (after the existing methods, before the closing brace):
```ts
  creditsGetInfo?: () => Promise<{ ok: boolean; data: { evmAddress: string | null; balanceUsdc: string; reservedUsdc: string; availableUsdc: string; pendingWithdrawalUsdc: string; creditLimitUsdc: string } | null; error: string | null }>;
```

**Remove any wallet:wc-* bridge methods** if they exist in this type (check and clean).

#### Acceptance Criteria
- [ ] `bridge.creditsGetInfo()` callable from renderer
- [ ] TypeScript type matches the IPC handler return type
- [ ] No wallet:wc-* methods remain in the bridge type

---

### Task 4: Add credits state to RendererUiState

##### MODIFY: `apps/desktop/src/renderer/core/state.ts`

**Add to `RendererUiState` type** (after the `// --- Chat display ---` section, add a new section):
```ts
  // --- Credits / Payments ---
  creditsAvailableUsdc: string;
  creditsReservedUsdc: string;
  creditsTotalUsdc: string;
  creditsPendingWithdrawalUsdc: string;
  creditsCreditLimitUsdc: string;
  creditsEvmAddress: string | null;
  creditsLoading: boolean;
  creditsLastRefreshedAt: number;
```

**Add initial values to `createInitialUiState()`** (after the chat section):
```ts
    // Credits / Payments
    creditsAvailableUsdc: '0',
    creditsReservedUsdc: '0',
    creditsTotalUsdc: '0',
    creditsPendingWithdrawalUsdc: '0',
    creditsCreditLimitUsdc: '0',
    creditsEvmAddress: null,
    creditsLoading: false,
    creditsLastRefreshedAt: 0,
```

#### Acceptance Criteria
- [ ] New fields exist on `RendererUiState`
- [ ] Initial values are all zeroes/null/false
- [ ] No TypeScript errors

---

### Task 5: Add credits refresh module

##### CREATE: `apps/desktop/src/renderer/modules/credits.ts`

```ts
import type { RendererUiState } from '../core/state';
import { notifyUiStateChanged } from '../core/store';
import type { DesktopBridge } from '../types/bridge';

type CreditsModuleOptions = {
  bridge?: DesktopBridge;
  uiState: RendererUiState;
};

export type CreditsModuleApi = {
  refreshCredits: () => Promise<void>;
  startPeriodicRefresh: () => void;
  stopPeriodicRefresh: () => void;
  getAvailableUsdc: () => string;
};

const CREDITS_REFRESH_INTERVAL_MS = 60_000;

export function initCreditsModule({ bridge, uiState }: CreditsModuleOptions): CreditsModuleApi {
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  async function refreshCredits(): Promise<void> {
    if (!bridge?.creditsGetInfo) return;
    uiState.creditsLoading = true;
    notifyUiStateChanged();

    try {
      const result = await bridge.creditsGetInfo();
      if (result.ok && result.data) {
        uiState.creditsAvailableUsdc = result.data.availableUsdc;
        uiState.creditsReservedUsdc = result.data.reservedUsdc;
        uiState.creditsTotalUsdc = result.data.balanceUsdc;
        uiState.creditsPendingWithdrawalUsdc = result.data.pendingWithdrawalUsdc;
        uiState.creditsCreditLimitUsdc = result.data.creditLimitUsdc;
        uiState.creditsEvmAddress = result.data.evmAddress;
      }
    } catch {
      // Silently fail — cached values remain
    } finally {
      uiState.creditsLoading = false;
      uiState.creditsLastRefreshedAt = Date.now();
      notifyUiStateChanged();
    }
  }

  function startPeriodicRefresh(): void {
    if (refreshTimer) return;
    void refreshCredits();
    refreshTimer = setInterval(() => void refreshCredits(), CREDITS_REFRESH_INTERVAL_MS);
  }

  function stopPeriodicRefresh(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function getAvailableUsdc(): string {
    return uiState.creditsAvailableUsdc;
  }

  return { refreshCredits, startPeriodicRefresh, stopPeriodicRefresh, getAvailableUsdc };
}
```

##### MODIFY: `apps/desktop/src/renderer/app.ts`

**Add import** (after existing module imports):
```ts
import { initCreditsModule, type CreditsModuleApi } from './modules/credits';
```

**Initialize the module** (after `initChatModule` call):
```ts
const creditsApi = initCreditsModule({ bridge: bridge as DesktopBridge, uiState });
creditsApi.startPeriodicRefresh();
```

**Register the refresh action** in the actions object (alongside existing actions):
```ts
refreshCredits: () => void creditsApi.refreshCredits(),
```

#### Acceptance Criteria
- [ ] Credits module initializes on app start
- [ ] Polls escrow balance every 60 seconds
- [ ] Updates `uiState.creditsAvailableUsdc` etc. on each refresh
- [ ] No TypeScript errors

---

### Task 6: Add Credits button to TitleBar

##### MODIFY: `apps/desktop/src/renderer/ui/components/TitleBar.tsx`

**Add import** (after existing imports):
```ts
import { useUiSnapshot } from '../hooks/useUiSnapshot';
import { useActions } from '../hooks/useActions';
```

**Add state and actions** (inside the `TitleBar` component, after `useCallback`):
```ts
const { creditsAvailableUsdc } = useUiSnapshot();
const actions = useActions();
const [creditsDropdownOpen, setCreditsDropdownOpen] = useState(false);

const creditsDisplay = parseFloat(creditsAvailableUsdc) > 0
  ? `$${parseFloat(creditsAvailableUsdc).toFixed(2)}`
  : '$0.00';

const handleAddCredits = useCallback(() => {
  setCreditsDropdownOpen(false);
  actions.openPaymentsPortal?.();
}, [actions]);
```

**Add Credits button** in the `titleBarRight` div, before the theme toggle button:
```tsx
<div className={styles.titleBarCreditsWrapper}>
  <button
    className={styles.titleBarCreditsBtn}
    onClick={() => setCreditsDropdownOpen((prev) => !prev)}
    aria-label={`Credits: ${creditsDisplay}`}
    title="Credits balance"
  >
    {creditsDisplay}
  </button>
  {creditsDropdownOpen && (
    <div className={styles.titleBarCreditsDropdown}>
      <div className={styles.creditsDropdownBalance}>
        <span className={styles.creditsDropdownLabel}>Available</span>
        <span className={styles.creditsDropdownValue}>{creditsDisplay}</span>
      </div>
      <button
        className={styles.creditsDropdownAddBtn}
        onClick={handleAddCredits}
      >
        Add Credits
      </button>
    </div>
  )}
</div>
```

**Add click-outside handler** to close dropdown:
```ts
useEffect(() => {
  if (!creditsDropdownOpen) return;
  const handler = (e: MouseEvent) => {
    const target = e.target as HTMLElement;
    if (!target.closest(`.${styles.titleBarCreditsWrapper}`)) {
      setCreditsDropdownOpen(false);
    }
  };
  document.addEventListener('mousedown', handler);
  return () => document.removeEventListener('mousedown', handler);
}, [creditsDropdownOpen]);
```

##### MODIFY: `apps/desktop/src/renderer/ui/components/TitleBar.module.scss`

**Add styles** after `.title-bar-theme-toggle`:
```scss
.title-bar-credits-wrapper {
  position: relative;
}

.title-bar-credits-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 30px;
  padding: 0 10px;
  border-radius: 8px;
  background: #ffffff;
  border: 1px solid var(--border);
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 12px;
  font-weight: 600;
  font-family: inherit;
  white-space: nowrap;
  transition: all 0.15s ease;

  :global(body.dark-theme) & {
    background: var(--bg-hover);
  }

  &:hover {
    background: #f0f0f0;
    color: var(--text-primary);
    border-color: var(--border-strong);

    :global(body.dark-theme) & {
      background: var(--bg-surface);
    }
  }
}

.title-bar-credits-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  min-width: 180px;
  background: var(--bg-primary);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  z-index: 200;
  display: flex;
  flex-direction: column;
  gap: 10px;

  :global(body.dark-theme) & {
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
  }
}

.credits-dropdown-balance {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.credits-dropdown-label {
  font-size: 12px;
  color: var(--text-secondary);
}

.credits-dropdown-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.credits-dropdown-add-btn {
  width: 100%;
  padding: 8px 0;
  border-radius: 8px;
  border: none;
  background: var(--accent-green);
  color: #ffffff;
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: opacity 0.15s;

  &:hover {
    opacity: 0.85;
  }
}
```

#### Acceptance Criteria
- [ ] Credits button visible in TitleBar, left of theme toggle
- [ ] Shows formatted balance (e.g., "$10.50" or "$0.00")
- [ ] Clicking opens dropdown with balance and "Add Credits" button
- [ ] Dropdown closes on click outside
- [ ] Same visual style as theme toggle button (30px height, 8px border-radius, same bg/border)
- [ ] Dark mode support

---

### Task 7: Add "Add Credits" prompt to DiscoverWelcome empty state

##### MODIFY: `apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.tsx`

**Add import** (after existing imports):
```ts
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
```

**Add state reading** (inside `DiscoverWelcome` component, after `const [activeFilter, setActiveFilter]`):
```ts
const { creditsAvailableUsdc } = useUiSnapshot();
const actions = useActions();
const hasCredits = parseFloat(creditsAvailableUsdc) > 0;
```

**Add "Add Credits" banner** after the subtitle `<p>` and before the cards section. Insert inside the `<div className={styles.header}>` block, after the `</p>`:
```tsx
{!hasCredits && (
  <button
    className={styles.addCreditsBtn}
    onClick={() => actions.openPaymentsPortal?.()}
  >
    Add Credits to use paid services
  </button>
)}
```

##### MODIFY: `apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.module.scss`

**Add style** (after `.subtitle`):
```scss
.add-credits-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 12px;
  padding: 8px 18px;
  border-radius: 8px;
  border: 1px solid var(--accent-green);
  background: transparent;
  color: var(--accent-green);
  font-size: 13px;
  font-weight: 600;
  font-family: inherit;
  cursor: pointer;
  transition: all 0.15s ease;

  &:hover {
    background: var(--accent-green);
    color: #ffffff;
  }
}
```

#### Acceptance Criteria
- [ ] "Add Credits" button appears on discover screen when balance is $0
- [ ] Button hidden when user has credits
- [ ] Clicking triggers `openPaymentsPortal` action
- [ ] Styled with green accent border, fills on hover

---

### Task 8: Register `openPaymentsPortal` action placeholder

This task creates the action that Tasks 6 and 7 reference. In PRD-04, this will be wired to actually open the portal. For now, it opens a fallback message.

##### MODIFY: `apps/desktop/src/renderer/ui/actions.ts`

**Add to the actions type and registration** (alongside existing actions):
```ts
openPaymentsPortal?: () => void;
```

**Register placeholder** in the action registration section:
```ts
openPaymentsPortal: () => {
  console.log('[desktop] openPaymentsPortal called — will be wired in PRD-04');
},
```

#### Acceptance Criteria
- [ ] `actions.openPaymentsPortal` exists and is callable
- [ ] Does not crash when called
- [ ] Will be properly wired in PRD-04
