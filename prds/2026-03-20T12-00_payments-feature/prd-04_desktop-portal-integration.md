# PRD-04: Desktop ↔ Portal Integration

**Created:** 2026-03-20T12:00Z
**Status:** DRAFT
**Dependencies:** PRD-01, PRD-02
**Estimated Tasks:** 5

## Overview

Wire the payments portal to auto-launch when the desktop app starts, deep-link "Add Credits" buttons to the portal, and refresh credits balance when the user returns from the portal. Also wire the CLI `antseed payments` command.

---

### Task 1: Auto-launch payments portal from desktop main process

##### MODIFY: `apps/desktop/src/main/main.ts`

**Add import** (at the top, with other imports):
```ts
import { createServer as createPaymentsServer } from '@antseed/payments';
import type { FastifyInstance } from 'fastify';
```

**Add portal management** (after the `processManager` initialization, around line 232):
```ts
// ── Payments Portal ──

let paymentsServer: FastifyInstance | null = null;
const PAYMENTS_PORT = Number(process.env['ANTSEED_PAYMENTS_PORT']) || 3118;

async function startPaymentsPortal(): Promise<void> {
  if (paymentsServer) return;
  try {
    await ensureSecureIdentity();
    const identityHex = secureIdentityEnv().ANTSEED_IDENTITY_HEX;
    paymentsServer = await createPaymentsServer({
      port: PAYMENTS_PORT,
      identityHex,
    });
    await paymentsServer.listen({ port: PAYMENTS_PORT, host: '127.0.0.1' });
    console.log(`[desktop] Payments portal running at http://127.0.0.1:${PAYMENTS_PORT}`);
  } catch (err) {
    console.error('[desktop] Failed to start payments portal:', err instanceof Error ? err.message : String(err));
    paymentsServer = null;
  }
}

async function stopPaymentsPortal(): Promise<void> {
  if (!paymentsServer) return;
  try {
    await paymentsServer.close();
  } catch {
    // Already closed
  }
  paymentsServer = null;
}
```

**Start portal in `app.whenReady()`** (after `ensureSecureIdentity` call, around line 693):
```ts
  // Start payments portal
  void startPaymentsPortal().catch(() => {});
```

**Stop portal on quit** — add to the `before-quit` handler (inside `processManager.stopAll()` chain):
```ts
void processManager.stopAll()
  .then(() => stopPaymentsPortal())
  .finally(() => {
    app.quit();
  });
```

Also add to the `SIGTERM` handler:
```ts
process.on('SIGTERM', () => {
  void Promise.all([processManager.stopAll(), stopPaymentsPortal()]).finally(() => process.exit(0));
});
```

#### Acceptance Criteria
- [ ] Payments portal starts on port 3118 when desktop launches
- [ ] Uses the same identity as the desktop app
- [ ] Portal stops when desktop quits
- [ ] Handles startup failures gracefully (doesn't crash desktop)
- [ ] Port configurable via `ANTSEED_PAYMENTS_PORT`

---

### Task 2: Add IPC handler for opening payments portal

##### MODIFY: `apps/desktop/src/main/main.ts`

**Add IPC handler** (after the payments portal management code):
```ts
ipcMain.handle('payments:open-portal', async () => {
  try {
    // Ensure portal is running
    await startPaymentsPortal();
    const url = `http://127.0.0.1:${PAYMENTS_PORT}`;

    // Open in default browser
    const { default: open } = await import('open');
    await open(url);

    return { ok: true, url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
```

##### MODIFY: `apps/desktop/src/main/preload.cts`

**Add to contextBridge**:
```ts
paymentsOpenPortal: () => ipcRenderer.invoke('payments:open-portal'),
```

##### MODIFY: `apps/desktop/src/renderer/types/bridge.ts`

**Add to `DesktopBridge` type**:
```ts
paymentsOpenPortal?: () => Promise<{ ok: boolean; url?: string; error?: string }>;
```

#### Acceptance Criteria
- [ ] `payments:open-portal` starts portal if not running
- [ ] Opens portal URL in default system browser
- [ ] Returns the URL on success

---

### Task 3: Wire `openPaymentsPortal` action to IPC

##### MODIFY: `apps/desktop/src/renderer/ui/actions.ts`

**Replace the placeholder** `openPaymentsPortal` from PRD-01 Task 8 with the real implementation:

```ts
openPaymentsPortal: () => {
  const bridge = (window as unknown as { antseedDesktop?: DesktopBridge }).antseedDesktop;
  void bridge?.paymentsOpenPortal?.();
},
```

#### Acceptance Criteria
- [ ] Clicking "Add Credits" anywhere in the app opens the payments portal in browser
- [ ] Works from TitleBar dropdown, DiscoverWelcome, and LowBalanceWarning

---

### Task 4: Refresh credits on window focus

When the user deposits funds in the portal (browser) and switches back to the desktop app, credits should refresh immediately.

##### MODIFY: `apps/desktop/src/renderer/modules/credits.ts`

**Add window focus listener** in `initCreditsModule`:

```ts
// Refresh credits when window regains focus (user may have deposited in portal)
function onWindowFocus(): void {
  void refreshCredits();
}

// Return the listener setup as part of the module API
function startPeriodicRefresh(): void {
  if (refreshTimer) return;
  void refreshCredits();
  refreshTimer = setInterval(() => void refreshCredits(), CREDITS_REFRESH_INTERVAL_MS);
  window.addEventListener('focus', onWindowFocus);
}

function stopPeriodicRefresh(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  window.removeEventListener('focus', onWindowFocus);
}
```

Also leverage the existing bridge `onWindowFocusChange` if available:

##### MODIFY: `apps/desktop/src/renderer/app.ts`

**After initializing the credits module**, add:
```ts
// Refresh credits when window regains focus
const bridge = (window as unknown as { antseedDesktop?: DesktopBridge }).antseedDesktop;
bridge?.onWindowFocusChange?.((isFocused) => {
  if (isFocused) {
    void creditsApi.refreshCredits();
  }
});
```

#### Acceptance Criteria
- [ ] Credits refresh when desktop window regains focus
- [ ] Balance updates within seconds after depositing in portal
- [ ] No duplicate refresh timers
- [ ] Focus listener cleaned up when periodic refresh stops

---

### Task 5: Add `@antseed/payments` dependency to desktop and CLI

##### MODIFY: `apps/desktop/package.json`

**Add dependency**:
```json
"@antseed/payments": "workspace:*",
```

##### MODIFY: `apps/cli/package.json`

**Add dependency**:
```json
"@antseed/payments": "workspace:*",
```

##### MODIFY: root build script (if needed)

Ensure `apps/payments` builds before `apps/cli` and `apps/desktop` in the build order. The payments portal must be built first since both apps import from it.

**Update build order comment in root `package.json`** or build script to include:
```
node → provider-core/router-core → plugins → dashboard → payments → cli → desktop
```

#### Acceptance Criteria
- [ ] `pnpm install` resolves `@antseed/payments` workspace dependency
- [ ] `pnpm run build` builds payments before cli and desktop
- [ ] Desktop can `import { createServer } from '@antseed/payments'`
- [ ] CLI can `import { createServer } from '@antseed/payments'`
- [ ] Full build succeeds end-to-end
