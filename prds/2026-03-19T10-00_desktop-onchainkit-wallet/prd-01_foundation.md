# PRD-01: OnchainKit Foundation

**Created:** 2026-03-19T10:00:00Z
**Dependencies:** None
**Estimated Tasks:** 5

## Overview

Add OnchainKit, wagmi, and viem dependencies to the desktop app. Create the provider wrapper in the React renderer. Remove the existing WalletConnect integration (stub code). Map CSS variables so OnchainKit components match the AntSeed theme.

---

### Task 1: Add OnchainKit + wagmi + viem dependencies

##### MODIFY: apps/desktop/package.json

**Add to `dependencies`:**
```json
"@coinbase/onchainkit": "^0.38.0",
"@tanstack/react-query": "^5.60.0",
"wagmi": "^2.14.0",
"viem": "^2.21.0"
```

**Remove from `dependencies`:**
```json
"@walletconnect/ethereum-provider": "^2.17.0"
```

Run `pnpm install` after modification.

#### Acceptance Criteria
- [ ] `pnpm install` completes without errors
- [ ] `@coinbase/onchainkit`, `wagmi`, `viem`, `@tanstack/react-query` are in node_modules
- [ ] `@walletconnect/ethereum-provider` is no longer in dependencies
- [ ] `pnpm run build:renderer` completes (Vite can resolve all imports)

---

### Task 2: Create OnchainKit provider wrapper

##### CREATE: apps/desktop/src/renderer/ui/providers/OnchainProviders.tsx

Create a provider component that wraps the app with wagmi + OnchainKit + QueryClient. This is the top-level provider that enables all OnchainKit components.

```tsx
import { type ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WagmiProvider, createConfig, http } from 'wagmi';
import { base } from 'wagmi/chains';
import { coinbaseWallet } from 'wagmi/connectors';
import { OnchainKitProvider } from '@coinbase/onchainkit';

const wagmiConfig = createConfig({
  chains: [base],
  connectors: [
    coinbaseWallet({
      appName: 'AntSeed Desktop',
      preference: 'smartWalletOnly',
    }),
  ],
  transports: {
    [base.id]: http(),
  },
});

const queryClient = new QueryClient();

type OnchainProvidersProps = {
  children: ReactNode;
};

export function OnchainProviders({ children }: OnchainProvidersProps) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <OnchainKitProvider chain={base}>
          {children}
        </OnchainKitProvider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
```

**Notes:**
- `preference: 'smartWalletOnly'` enables passkey-based Smart Wallet creation
- Uses Base mainnet (chain ID 8453)
- No API key needed for basic OnchainKit usage
- QueryClient is required by wagmi v2

#### Acceptance Criteria
- [ ] File created at correct path
- [ ] No TypeScript errors
- [ ] Exports `OnchainProviders` component

---

### Task 3: Wrap AppShell with OnchainProviders

##### MODIFY: apps/desktop/src/renderer/ui/mount.tsx

Read `mount.tsx` first to find the current React root mounting code. Wrap the existing `<AppShell />` with `<OnchainProviders>`.

**Add import** (after existing imports):
```tsx
import { OnchainProviders } from './providers/OnchainProviders';
```

**Wrap AppShell** (in the render call):
```tsx
<OnchainProviders>
  <AppShell />
</OnchainProviders>
```

Also add the OnchainKit CSS import at the top of the file (or in `app.ts` if that's where CSS imports live):
```tsx
import '@coinbase/onchainkit/styles.css';
```

#### Acceptance Criteria
- [ ] `OnchainProviders` wraps `AppShell` in the React tree
- [ ] OnchainKit CSS is imported
- [ ] App renders without errors
- [ ] No TypeScript errors

---

### Task 4: Remove WalletConnect integration

##### DELETE: apps/desktop/src/main/walletconnect.ts

Remove the entire file.

##### MODIFY: apps/desktop/src/main/main.ts

**Remove** the WalletConnect import (near top of file):
```typescript
import { WalletConnectManager } from './walletconnect.js';
```

**Remove** the WalletConnect manager instantiation and event listener (around line 1880):
```typescript
const walletConnectManager = new WalletConnectManager();

walletConnectManager.on('state', (state: unknown) => {
  mainWindow?.webContents.send('wallet:wc-state-changed', state);
});
```

**Remove** all WalletConnect IPC handlers (around lines 1886-1909):
```typescript
ipcMain.handle('wallet:wc-state', ...);
ipcMain.handle('wallet:wc-connect', ...);
ipcMain.handle('wallet:wc-disconnect', ...);
```

**Remove** the stub deposit/withdraw handlers (around lines 1860-1876):
```typescript
ipcMain.handle('wallet:deposit', ...);
ipcMain.handle('wallet:withdraw', ...);
```

**Keep** the `wallet:get-info` handler for now — it will be updated in PRD-02.

##### MODIFY: apps/desktop/src/main/preload.cts

**Remove** any WalletConnect-related bridge methods from the exposed API. Search for `wc-state`, `wc-connect`, `wc-disconnect`, `wallet:deposit`, `wallet:withdraw` in the preload file and remove those bridge methods.

#### Acceptance Criteria
- [ ] `walletconnect.ts` deleted
- [ ] No references to `WalletConnectManager` in main.ts
- [ ] No WalletConnect IPC handlers remain
- [ ] Stub deposit/withdraw handlers removed
- [ ] `wallet:get-info` handler still exists
- [ ] App builds without import errors
- [ ] `qrcode` package can be removed from dependencies if no other usage exists

---

### Task 5: Map OnchainKit CSS variables to AntSeed theme

##### CREATE: apps/desktop/src/renderer/ui/providers/onchainkit-theme.scss

Override OnchainKit's CSS variables to match the AntSeed desktop theme. OnchainKit uses `--ock-*` prefixed variables.

```scss
// OnchainKit theme overrides — match AntSeed desktop palette
// These override the default OnchainKit styling to integrate visually

:root {
  // Surface colors
  --ock-bg-default: var(--bg-primary);
  --ock-bg-default-hover: var(--bg-secondary);
  --ock-bg-default-active: var(--bg-secondary);
  --ock-bg-alternate: var(--bg-secondary);
  --ock-bg-alternate-hover: var(--bg-primary);
  --ock-bg-alternate-active: var(--bg-primary);
  --ock-bg-inverse: var(--text-primary);
  --ock-bg-primary: var(--accent);
  --ock-bg-primary-hover: #19c06a;
  --ock-bg-primary-active: #15a85e;
  --ock-bg-secondary: var(--bg-secondary);
  --ock-bg-secondary-hover: var(--bg-primary);
  --ock-bg-error: var(--danger);

  // Text colors
  --ock-text-foreground: var(--text-primary);
  --ock-text-foreground-muted: var(--text-secondary);
  --ock-text-inverse: var(--bg-primary);
  --ock-text-error: var(--danger);
  --ock-text-primary: var(--accent);
  --ock-text-success: var(--accent);
  --ock-text-disabled: var(--text-dim);

  // Border
  --ock-border-radius: var(--radius-sm);
  --ock-border-radius-inner: 6px;

  // Font
  --ock-font-family: var(--font-sans);

  // Line
  --ock-line-primary: var(--border);
  --ock-line-default: var(--border);
  --ock-line-heavy: var(--border-strong);
}

body.dark-theme {
  --ock-bg-default: var(--bg-primary);
  --ock-bg-default-hover: var(--bg-secondary);
  --ock-bg-alternate: var(--bg-secondary);
  --ock-bg-inverse: var(--text-primary);
  --ock-bg-primary: var(--accent);
  --ock-bg-primary-hover: #19c06a;
  --ock-text-foreground: var(--text-primary);
  --ock-text-foreground-muted: var(--text-secondary);
  --ock-text-inverse: #1c1c1e;
  --ock-line-primary: var(--border);
  --ock-line-default: var(--border);
}
```

**Import this file** in `global.scss` (after the theme variables):
```scss
@import '../ui/providers/onchainkit-theme';
```

Or import in `app.ts` / `mount.tsx` alongside the OnchainKit CSS import.

#### Acceptance Criteria
- [ ] OnchainKit components render with mint accent color (#1FD87A)
- [ ] Background matches cream (#F5F5F1) in light mode and dark (#1C1C1E) in dark mode
- [ ] Font matches Geist (the app's --font-sans)
- [ ] Border radius matches the app's --radius-sm (8px)
- [ ] Theme toggle (light/dark) correctly updates OnchainKit component appearance
