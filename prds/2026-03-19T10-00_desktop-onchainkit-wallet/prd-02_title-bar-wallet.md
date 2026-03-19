# PRD-02: Title Bar Wallet

**Created:** 2026-03-19T10:00:00Z
**Dependencies:** PRD-01
**Estimated Tasks:** 4

## Overview

Add a wallet connect button and balance badge to the title bar. When connected, show combined USDC balance (wallet + escrow). Clicking opens the OnchainKit `<WalletDropdown />` with address, balance breakdown, and disconnect option.

---

### Task 1: Create WalletBadge component

##### CREATE: apps/desktop/src/renderer/ui/components/WalletBadge.tsx

A compact component for the title bar that shows:
- **Disconnected:** A "Connect" button using OnchainKit's `<ConnectWallet />`
- **Connected:** A balance badge showing `12.50 USDC` that opens `<WalletDropdown />` on click

```tsx
import {
  ConnectWallet,
  Wallet,
  WalletDropdown,
  WalletDropdownDisconnect,
  WalletDropdownFundLink,
} from '@coinbase/onchainkit/wallet';
import {
  Address,
  Avatar,
  Name,
  Identity,
  EthBalance,
} from '@coinbase/onchainkit/identity';
import { useAccount, useBalance } from 'wagmi';
import { base } from 'viem/chains';
import styles from './WalletBadge.module.scss';

// USDC contract address on Base mainnet
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

export function WalletBadge() {
  const { address, isConnected } = useAccount();

  // Fetch USDC balance from wallet
  const { data: usdcBalance } = useBalance({
    address,
    token: USDC_ADDRESS,
    chainId: base.id,
    query: { enabled: isConnected, refetchInterval: 30_000 },
  });

  // TODO (PRD-04): Also fetch escrow balance via contract read
  const escrowBalance = 0n;

  const totalUsdc = (usdcBalance?.value ?? 0n) + escrowBalance;
  const formatted = formatUsdc(totalUsdc);

  return (
    <div className={styles.walletBadge}>
      <Wallet>
        <ConnectWallet
          className={styles.connectButton}
          text={isConnected ? `${formatted} USDC` : 'Connect'}
        >
          {isConnected && (
            <span className={styles.balanceText}>{formatted} USDC</span>
          )}
        </ConnectWallet>
        <WalletDropdown>
          <Identity className={styles.identity} hasCopyAddressOnClick>
            <Avatar />
            <Name />
            <Address />
          </Identity>
          <WalletDropdownFundLink />
          <WalletDropdownDisconnect />
        </WalletDropdown>
      </Wallet>
    </div>
  );
}

function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const frac = baseUnits % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0').slice(0, 2);
  return `${whole}.${fracStr}`;
}
```

#### Acceptance Criteria
- [ ] Renders "Connect" button when disconnected
- [ ] Shows formatted USDC balance when connected
- [ ] Clicking opens WalletDropdown with identity, fund link, disconnect
- [ ] Balance refreshes every 30 seconds
- [ ] No TypeScript errors

---

### Task 2: Create WalletBadge styles

##### CREATE: apps/desktop/src/renderer/ui/components/WalletBadge.module.scss

Style the wallet badge to sit compactly in the title bar next to the theme toggle.

```scss
.walletBadge {
  display: flex;
  align-items: center;
  position: relative;
}

.connectButton {
  font-family: var(--font-mono) !important;
  font-size: 12px !important;
  letter-spacing: 0.3px;
  padding: 5px 12px !important;
  border-radius: var(--radius-sm) !important;
  border: 1px solid var(--border) !important;
  background: var(--bg-secondary) !important;
  color: var(--text-primary) !important;
  cursor: pointer;
  transition: border-color 0.15s ease;
  height: 30px !important;
  min-height: unset !important;

  &:hover {
    border-color: var(--accent) !important;
  }
}

.balanceText {
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}

.identity {
  padding: 12px 16px;
}
```

#### Acceptance Criteria
- [ ] Badge is compact (30px height, fits title bar)
- [ ] Uses mono font for numbers
- [ ] Hover shows mint accent border
- [ ] Matches title bar height and spacing
- [ ] Works in both light and dark themes

---

### Task 3: Add WalletBadge to TitleBar

##### MODIFY: apps/desktop/src/renderer/ui/components/TitleBar.tsx

**Add import** (after existing imports):
```tsx
import { WalletBadge } from './WalletBadge';
```

**Add component** in the title bar, to the LEFT of the theme toggle button. Find the area in the JSX where the theme toggle button (`Sun02Icon`/`Moon02Icon`) is rendered and add `<WalletBadge />` before it.

The layout should be:
```
[AntStation Logo]  ────────────────  [12.50 USDC] [☀️] [Update]
                                      ^WalletBadge  ^theme ^update
```

Ensure the wallet badge and theme toggle are in a flex container with `gap: 8px`.

#### Acceptance Criteria
- [ ] WalletBadge renders in title bar to the left of theme toggle
- [ ] Layout doesn't break on window resize
- [ ] Drag region still works (title bar is draggable on macOS)
- [ ] No visual overlap with other title bar elements

---

### Task 4: Add escrow balance reading via wagmi useReadContract

##### MODIFY: apps/desktop/src/renderer/ui/components/WalletBadge.tsx

**Add escrow balance read** using wagmi's `useReadContract` hook to call `getBuyerBalance()` on the AntseedEscrow contract. This replaces the `escrowBalance = 0n` placeholder from Task 1.

```tsx
import { useReadContract } from 'wagmi';

// AntseedEscrow ABI fragment for getBuyerBalance
const ESCROW_ABI = [
  {
    name: 'getBuyerBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'buyer', type: 'address' }],
    outputs: [
      { name: 'available', type: 'uint256' },
      { name: 'reserved', type: 'uint256' },
      { name: 'pendingWithdrawal', type: 'uint256' },
      { name: 'lastActivity', type: 'uint256' },
    ],
  },
] as const;
```

**Add contract read** (inside the component, after useBalance):
```tsx
const escrowAddress = '0x...'; // TODO: read from config or env

const { data: escrowData } = useReadContract({
  address: escrowAddress as `0x${string}`,
  abi: ESCROW_ABI,
  functionName: 'getBuyerBalance',
  args: address ? [address] : undefined,
  chainId: base.id,
  query: { enabled: isConnected && !!address, refetchInterval: 30_000 },
});

const escrowBalance = escrowData ? escrowData[0] + escrowData[1] : 0n;
```

**Update badge display** to show breakdown in a tooltip or in the dropdown:
- Badge: `12.50 USDC` (total)
- Dropdown should show: Wallet: X.XX USDC / Escrow: X.XX USDC

#### Acceptance Criteria
- [ ] Escrow balance is fetched from the contract when connected
- [ ] Total = wallet USDC + escrow (available + reserved)
- [ ] Refetches every 30 seconds
- [ ] Handles missing/zero escrow gracefully (shows just wallet balance)
- [ ] Escrow contract address is configurable (not hardcoded)
