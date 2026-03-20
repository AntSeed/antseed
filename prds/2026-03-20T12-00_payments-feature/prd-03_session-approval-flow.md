# PRD-03: Session Approval Flow

**Created:** 2026-03-20T12:00Z
**Status:** DRAFT
**Dependencies:** PRD-01 (credits state in renderer)
**Estimated Tasks:** 10

## Overview

When a user sends a message to a paid peer, the chat shows a peer info card (reputation, sessions, network age) and an approval prompt for a pre-deposit. On approval, the desktop app signs an EIP-712 SpendingAuth with the local identity key, sends it to the peer, and waits for AuthAck before starting the session. Includes low-balance warnings during active sessions.

---

### Task 1: Add payment-related IPC handlers to main process

##### MODIFY: `apps/desktop/src/main/main.ts`

**Add imports** (extend existing `@antseed/node` import):
```ts
import {
  identityToEvmAddress,
  identityToEvmWallet,
  BaseEscrowClient,
  signSpendingAuth,
  makeEscrowDomain,
} from '@antseed/node';
```

**Add IPC handler for EIP-712 signing** (after the `credits:get-info` handler):
```ts
ipcMain.handle('payments:sign-spending-auth', async (_event, params: {
  sellerEvmAddress: string;
  sessionId: string;
  maxAmountBaseUnits: string;
  nonce: number;
  deadline: number;
  previousConsumption: string;
  previousSessionId: string;
}) => {
  try {
    await ensureSecureIdentity();
    const identity = getSecureIdentity();
    if (!identity) {
      return { ok: false, error: 'Identity not available' };
    }

    const config = await readConfig(ACTIVE_CONFIG_PATH);
    const payments = asRecord(config.payments);
    const crypto = asRecord(payments.crypto);
    const chainId = Number(asString(crypto.chainId as string, '8453'));
    const escrowAddress = asString(crypto.escrowContractAddress as string, '');

    if (!escrowAddress) {
      return { ok: false, error: 'No escrow contract configured' };
    }

    const wallet = identityToEvmWallet(identity);
    const domain = makeEscrowDomain(chainId, escrowAddress);

    const signature = await signSpendingAuth(wallet, domain, {
      seller: params.sellerEvmAddress,
      sessionId: params.sessionId,
      maxAmount: BigInt(params.maxAmountBaseUnits),
      nonce: params.nonce,
      deadline: params.deadline,
      previousConsumption: BigInt(params.previousConsumption),
      previousSessionId: params.previousSessionId,
    });

    const buyerEvmAddress = identityToEvmAddress(identity);

    return {
      ok: true,
      data: {
        signature,
        buyerEvmAddress,
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
```

**Add IPC handler for peer lookup** (for getting on-chain metadata):
```ts
ipcMain.handle('payments:get-peer-info', async (_event, peerId: string) => {
  try {
    await refreshPeerCache();
    const peer = lookupPeer(peerId.trim());
    if (!peer) {
      return { ok: false, error: 'Peer not found' };
    }

    return {
      ok: true,
      data: {
        peerId: peer.peerId,
        displayName: peer.displayName ?? null,
        reputation: peer.reputation ?? 0,
        onChainReputation: (peer as Record<string, unknown>).onChainReputation ?? null,
        onChainSessionCount: (peer as Record<string, unknown>).onChainSessionCount ?? null,
        onChainDisputeCount: (peer as Record<string, unknown>).onChainDisputeCount ?? null,
        evmAddress: (peer as Record<string, unknown>).evmAddress ?? null,
        timestamp: (peer as Record<string, unknown>).timestamp ?? null,
        providers: peer.providers ?? [],
        services: peer.services ?? [],
      },
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
```

#### Acceptance Criteria
- [ ] `payments:sign-spending-auth` signs EIP-712 SpendingAuth with identity key
- [ ] Returns signature hex + buyer EVM address
- [ ] `payments:get-peer-info` returns peer metadata including on-chain reputation
- [ ] Both handlers return `{ ok: false, error }` on failure

---

### Task 2: Add payment IPC to preload bridge

##### MODIFY: `apps/desktop/src/main/preload.cts`

**Add to contextBridge**:
```ts
paymentsSignSpendingAuth: (params: unknown) => ipcRenderer.invoke('payments:sign-spending-auth', params),
paymentsGetPeerInfo: (peerId: string) => ipcRenderer.invoke('payments:get-peer-info', peerId),
```

##### MODIFY: `apps/desktop/src/renderer/types/bridge.ts`

**Add to `DesktopBridge` type**:
```ts
paymentsSignSpendingAuth?: (params: {
  sellerEvmAddress: string;
  sessionId: string;
  maxAmountBaseUnits: string;
  nonce: number;
  deadline: number;
  previousConsumption: string;
  previousSessionId: string;
}) => Promise<{ ok: boolean; data?: { signature: string; buyerEvmAddress: string }; error?: string }>;

paymentsGetPeerInfo?: (peerId: string) => Promise<{
  ok: boolean;
  data?: {
    peerId: string;
    displayName: string | null;
    reputation: number;
    onChainReputation: number | null;
    onChainSessionCount: number | null;
    onChainDisputeCount: number | null;
    evmAddress: string | null;
    timestamp: number | null;
    providers: string[];
    services: string[];
  };
  error?: string;
}>;
```

#### Acceptance Criteria
- [ ] Both IPC methods callable from renderer
- [ ] TypeScript types match IPC handler return types

---

### Task 3: Add payment state to RendererUiState

##### MODIFY: `apps/desktop/src/renderer/core/state.ts`

**Add to `RendererUiState` type** (in the `// --- Credits / Payments ---` section from PRD-01):
```ts
  // --- Session approval ---
  chatPaymentApprovalVisible: boolean;
  chatPaymentApprovalPeerId: string | null;
  chatPaymentApprovalPeerName: string | null;
  chatPaymentApprovalAmount: string;  // human-readable USDC
  chatPaymentApprovalPeerInfo: {
    reputation: number;
    sessionCount: number | null;
    disputeCount: number | null;
    networkAgeDays: number | null;
    evmAddress: string | null;
  } | null;
  chatPaymentApprovalLoading: boolean;
  chatPaymentApprovalError: string | null;
  chatLowBalanceWarning: boolean;
```

**Add initial values to `createInitialUiState()`**:
```ts
    // Session approval
    chatPaymentApprovalVisible: false,
    chatPaymentApprovalPeerId: null,
    chatPaymentApprovalPeerName: null,
    chatPaymentApprovalAmount: '0.50',
    chatPaymentApprovalPeerInfo: null,
    chatPaymentApprovalLoading: false,
    chatPaymentApprovalError: null,
    chatLowBalanceWarning: false,
```

#### Acceptance Criteria
- [ ] New fields on `RendererUiState`
- [ ] Initial values set (approval hidden, no peer, $0.50 default)

---

### Task 4: Create SessionApprovalCard component

##### CREATE: `apps/desktop/src/renderer/ui/components/chat/SessionApprovalCard.tsx`

A card that appears in the chat area when the user needs to approve a pre-deposit:

```tsx
import styles from './SessionApprovalCard.module.scss';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';

export function SessionApprovalCard() {
  const {
    chatPaymentApprovalVisible,
    chatPaymentApprovalPeerName,
    chatPaymentApprovalAmount,
    chatPaymentApprovalPeerInfo,
    chatPaymentApprovalLoading,
    chatPaymentApprovalError,
  } = useUiSnapshot();
  const actions = useActions();

  if (!chatPaymentApprovalVisible) return null;

  const peerInfo = chatPaymentApprovalPeerInfo;
  const peerName = chatPaymentApprovalPeerName || 'Unknown peer';

  return (
    <div className={styles.approvalCard}>
      <div className={styles.approvalHeader}>
        <span className={styles.approvalTitle}>Session Approval Required</span>
      </div>

      {peerInfo && (
        <div className={styles.peerStats}>
          <div className={styles.statItem}>
            <span className={styles.statValue}>{peerInfo.reputation}</span>
            <span className={styles.statLabel}>Reputation</span>
          </div>
          {peerInfo.sessionCount !== null && (
            <div className={styles.statItem}>
              <span className={styles.statValue}>{peerInfo.sessionCount}</span>
              <span className={styles.statLabel}>Sessions</span>
            </div>
          )}
          {peerInfo.networkAgeDays !== null && (
            <div className={styles.statItem}>
              <span className={styles.statValue}>{peerInfo.networkAgeDays}d</span>
              <span className={styles.statLabel}>In Network</span>
            </div>
          )}
          {peerInfo.disputeCount !== null && peerInfo.disputeCount > 0 && (
            <div className={`${styles.statItem} ${styles.statWarn}`}>
              <span className={styles.statValue}>{peerInfo.disputeCount}</span>
              <span className={styles.statLabel}>Disputes</span>
            </div>
          )}
        </div>
      )}

      <p className={styles.approvalMessage}>
        To start your session, approve a pre-deposit of{' '}
        <strong>${chatPaymentApprovalAmount}</strong> to{' '}
        <strong>{peerName}</strong>.
        This is deducted from your credits.
      </p>

      {chatPaymentApprovalError && (
        <div className={styles.approvalError}>{chatPaymentApprovalError}</div>
      )}

      <div className={styles.approvalActions}>
        <button
          className={styles.approveBtn}
          onClick={() => actions.approveSessionPayment?.()}
          disabled={chatPaymentApprovalLoading}
        >
          {chatPaymentApprovalLoading ? 'Signing...' : 'Approve'}
        </button>
        <button
          className={styles.cancelBtn}
          onClick={() => actions.cancelSessionPayment?.()}
          disabled={chatPaymentApprovalLoading}
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
```

##### CREATE: `apps/desktop/src/renderer/ui/components/chat/SessionApprovalCard.module.scss`

Style the approval card:
- Card with subtle border, rounded corners, padding
- Peer stats in a horizontal row (flexbox, gap)
- Stat items: value above label, centered
- Dispute count in warning color (amber/red)
- Approve button: green accent, prominent
- Cancel button: ghost/outline style
- Error text: red
- Loading state: disabled buttons with spinner text

#### Acceptance Criteria
- [ ] Card renders when `chatPaymentApprovalVisible` is true
- [ ] Shows peer reputation, session count, network age, disputes
- [ ] Shows pre-deposit amount and peer name
- [ ] Approve and Cancel buttons functional
- [ ] Loading state disables buttons
- [ ] Error message displayed when present
- [ ] Hidden when not visible

---

### Task 5: Create LowBalanceWarning component

##### CREATE: `apps/desktop/src/renderer/ui/components/chat/LowBalanceWarning.tsx`

An inline warning that appears in the chat message area:

```tsx
import styles from './LowBalanceWarning.module.scss';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';

export function LowBalanceWarning() {
  const { chatLowBalanceWarning, creditsAvailableUsdc } = useUiSnapshot();
  const actions = useActions();

  if (!chatLowBalanceWarning) return null;

  return (
    <div className={styles.lowBalanceWarning}>
      <span className={styles.warningText}>
        Your balance is running low (${parseFloat(creditsAvailableUsdc).toFixed(2)} remaining).
        Add credits to continue using paid services.
      </span>
      <button
        className={styles.addCreditsLink}
        onClick={() => actions.openPaymentsPortal?.()}
      >
        Add Credits
      </button>
    </div>
  );
}
```

##### CREATE: `apps/desktop/src/renderer/ui/components/chat/LowBalanceWarning.module.scss`

- Warning bar: amber/yellow background, rounded, inline with chat messages
- Text: small, warning color
- "Add Credits" link: underlined, clickable

#### Acceptance Criteria
- [ ] Warning appears when `chatLowBalanceWarning` is true
- [ ] Shows current balance
- [ ] "Add Credits" links to payments portal
- [ ] Hidden when balance is healthy

---

### Task 6: Integrate SessionApprovalCard into ChatView

##### MODIFY: `apps/desktop/src/renderer/ui/components/views/ChatView.tsx`

**Add import**:
```ts
import { SessionApprovalCard } from '../chat/SessionApprovalCard';
import { LowBalanceWarning } from '../chat/LowBalanceWarning';
```

**Add SessionApprovalCard** in the chat messages area, after the welcome/empty state and before the input area. It should appear as an inline card within the message flow:

After the `chatMessages` map and before the input area, add:
```tsx
<SessionApprovalCard />
<LowBalanceWarning />
```

#### Acceptance Criteria
- [ ] SessionApprovalCard appears in chat when approval is needed
- [ ] LowBalanceWarning appears when balance is low
- [ ] Both integrate visually with the chat message flow
- [ ] Neither appears when not needed

---

### Task 7: Add payment approval logic to chat module

##### MODIFY: `apps/desktop/src/renderer/modules/chat.ts`

**Add payment gate to `sendMessage`** (around line 1092, at the start of the function):

Before the existing message sending logic, add a check:
```ts
// Check if this is a paid service and needs approval
const selectedService = uiState.chatServiceOptions.find(
  (opt) => opt.value === uiState.chatSelectedServiceValue
);
const isPaidService = selectedService && selectedService.protocol !== 'free';
const hasCredits = parseFloat(uiState.creditsAvailableUsdc) > 0;

if (isPaidService && !hasCredits) {
  uiState.chatError = 'No credits available. Add credits to use paid services.';
  notifyUiStateChanged();
  return;
}

if (isPaidService && hasCredits && !uiState.chatPaymentApprovalVisible && !isSessionApproved(selectedService.peerId)) {
  // Show approval card — do not send yet
  uiState.chatPaymentApprovalVisible = true;
  uiState.chatPaymentApprovalPeerId = selectedService.peerId;
  uiState.chatPaymentApprovalPeerName = selectedService.peerLabel || selectedService.peerId.slice(0, 12);
  uiState.chatPaymentApprovalAmount = '1.00'; // FIRST_SIGN_CAP in USDC
  // Store the pending message for sending after approval
  pendingPaymentMessage = { text, imageBase64, imageMimeType };
  // Fetch peer info
  void fetchPeerInfo(selectedService.peerId);
  notifyUiStateChanged();
  return;
}
```

**Add module-local state** (near the top with other module state):
```ts
let pendingPaymentMessage: { text: string; imageBase64?: string; imageMimeType?: string } | null = null;
const approvedPeerSessions = new Set<string>(); // peerId set for this app session
```

**Add helper functions**:
```ts
function isSessionApproved(peerId: string): boolean {
  return approvedPeerSessions.has(peerId);
}

async function fetchPeerInfo(peerId: string): Promise<void> {
  if (!bridge?.paymentsGetPeerInfo) return;
  try {
    const result = await bridge.paymentsGetPeerInfo(peerId);
    if (result.ok && result.data) {
      const now = Date.now() / 1000;
      const timestamp = result.data.timestamp || now;
      const ageDays = Math.floor((now - timestamp) / 86400);

      uiState.chatPaymentApprovalPeerInfo = {
        reputation: result.data.onChainReputation ?? result.data.reputation ?? 0,
        sessionCount: result.data.onChainSessionCount ?? null,
        disputeCount: result.data.onChainDisputeCount ?? null,
        networkAgeDays: ageDays > 0 ? ageDays : null,
        evmAddress: result.data.evmAddress ?? null,
      };
      notifyUiStateChanged();
    }
  } catch {
    // Silently fail — card shows without peer info
  }
}
```

#### Acceptance Criteria
- [ ] Paid service messages trigger approval card before sending
- [ ] Free service messages send immediately (no gate)
- [ ] Zero-balance users see error message for paid services
- [ ] Peer info fetched and displayed in card
- [ ] Pending message stored for sending after approval

---

### Task 8: Add approve/cancel action handlers

##### MODIFY: `apps/desktop/src/renderer/modules/chat.ts`

**Add `approveSessionPayment` function** (alongside existing module API functions):
```ts
async function approveSessionPayment(): Promise<void> {
  if (!bridge?.paymentsSignSpendingAuth || !uiState.chatPaymentApprovalPeerId) return;

  uiState.chatPaymentApprovalLoading = true;
  uiState.chatPaymentApprovalError = null;
  notifyUiStateChanged();

  try {
    const peerId = uiState.chatPaymentApprovalPeerId;
    const peerInfo = uiState.chatPaymentApprovalPeerInfo;
    const sellerEvmAddress = peerInfo?.evmAddress;

    if (!sellerEvmAddress) {
      throw new Error('Peer EVM address not available. Cannot sign spending authorization.');
    }

    // Generate session ID (random 32 bytes)
    const sessionIdBytes = new Uint8Array(32);
    crypto.getRandomValues(sessionIdBytes);
    const sessionId = '0x' + Array.from(sessionIdBytes).map(b => b.toString(16).padStart(2, '0')).join('');

    // FIRST_SIGN_CAP = 1 USDC = 1_000_000 base units
    const maxAmountBaseUnits = '1000000';
    const nonce = Date.now();
    const deadline = Math.floor(Date.now() / 1000) + 86400; // 24h from now

    const result = await bridge.paymentsSignSpendingAuth({
      sellerEvmAddress,
      sessionId,
      maxAmountBaseUnits,
      nonce,
      deadline,
      previousConsumption: '0',
      previousSessionId: '0x' + '0'.repeat(64),
    });

    if (!result.ok || !result.data) {
      throw new Error(result.error || 'Failed to sign spending authorization');
    }

    // Mark peer as approved for this session
    approvedPeerSessions.add(peerId);

    // Close approval card
    uiState.chatPaymentApprovalVisible = false;
    uiState.chatPaymentApprovalLoading = false;
    notifyUiStateChanged();

    // Now send the pending message
    if (pendingPaymentMessage) {
      const msg = pendingPaymentMessage;
      pendingPaymentMessage = null;
      sendMessage(msg.text, msg.imageBase64, msg.imageMimeType);
    }
  } catch (err) {
    uiState.chatPaymentApprovalError = err instanceof Error ? err.message : String(err);
    uiState.chatPaymentApprovalLoading = false;
    notifyUiStateChanged();
  }
}

function cancelSessionPayment(): void {
  uiState.chatPaymentApprovalVisible = false;
  uiState.chatPaymentApprovalPeerId = null;
  uiState.chatPaymentApprovalPeerName = null;
  uiState.chatPaymentApprovalPeerInfo = null;
  uiState.chatPaymentApprovalLoading = false;
  uiState.chatPaymentApprovalError = null;
  pendingPaymentMessage = null;
  notifyUiStateChanged();
}
```

**Add to the module's return API** (alongside existing functions in `ChatModuleApi`):
```ts
approveSessionPayment: () => void approveSessionPayment(),
cancelSessionPayment,
```

**Update `ChatModuleApi` type** to include the new functions:
```ts
approveSessionPayment: () => void;
cancelSessionPayment: () => void;
```

#### Acceptance Criteria
- [ ] Approve signs EIP-712 SpendingAuth via IPC
- [ ] On success: marks peer as approved, closes card, sends pending message
- [ ] On failure: shows error in card, keeps card visible
- [ ] Cancel closes card and clears pending message
- [ ] Session ID is random 32 bytes
- [ ] Uses FIRST_SIGN_CAP (1 USDC = 1_000_000 base units)

---

### Task 9: Register payment actions

##### MODIFY: `apps/desktop/src/renderer/ui/actions.ts`

**Add to actions type and registration**:
```ts
approveSessionPayment?: () => void;
cancelSessionPayment?: () => void;
```

**Wire in action registration** (where chatApi actions are registered):
```ts
approveSessionPayment: () => chatApi.approveSessionPayment(),
cancelSessionPayment: () => chatApi.cancelSessionPayment(),
```

#### Acceptance Criteria
- [ ] Actions callable from components
- [ ] Wired to chat module functions

---

### Task 10: Add low balance detection to credits module

##### MODIFY: `apps/desktop/src/renderer/modules/credits.ts`

**After each balance refresh**, check if balance is low and update the warning state:

```ts
// Inside refreshCredits(), after updating balance fields:
const available = parseFloat(uiState.creditsAvailableUsdc);
const reserved = parseFloat(uiState.creditsReservedUsdc);
// Show warning if: has active reservation AND available < reserved (can't start another session)
// OR if available > 0 but < 1.00 (below FIRST_SIGN_CAP)
uiState.chatLowBalanceWarning = available > 0 && (available < 1.0 || (reserved > 0 && available < reserved));
```

#### Acceptance Criteria
- [ ] `chatLowBalanceWarning` set to true when balance is below $1.00
- [ ] Warning also triggers when available balance < reserved amount
- [ ] Warning is false when balance is 0 (different UX: "Add Credits")
- [ ] Warning is false when balance is healthy
