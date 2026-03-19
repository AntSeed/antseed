# PRD-04: Payment Flow Orchestration

**Created:** 2026-03-19T10:00:00Z
**Dependencies:** PRD-02, PRD-03
**Estimated Tasks:** 5

## Overview

Wire the payment bubbles into the chat flow with a state machine. When a user sends a message, detect the wallet/balance/deposit state and inject the appropriate payment bubble. Handle action completion to release the pending message. Wire the SpendingAuth signature back to the buyer payment manager for P2P transmission.

---

### Task 1: Create payment state machine

##### CREATE: apps/desktop/src/renderer/modules/payment-state.ts

A module that tracks the buyer's payment readiness and determines what action is needed before a message can be sent.

```typescript
import type { PaymentAction } from '../ui/components/chat/payment-types';

export type PaymentReadiness =
  | { ready: true }
  | { ready: false; action: PaymentAction; meta?: Record<string, unknown> };

/**
 * Determine what payment action (if any) is needed before a message can be sent.
 * Called by the chat module's sendMessage flow.
 *
 * @param walletConnected - is a wallet connected via wagmi?
 * @param walletUsdcBalance - USDC balance in the wallet (base units)
 * @param escrowBalance - USDC deposited in escrow (base units)
 * @param hasActiveSession - does the buyer have a confirmed session with this seller?
 * @param sellerPeerId - the target seller's peer ID
 */
export function checkPaymentReadiness(params: {
  walletConnected: boolean;
  walletUsdcBalance: bigint;
  escrowBalance: bigint;
  hasActiveSession: boolean;
  sellerPeerId: string | null;
}): PaymentReadiness {
  const { walletConnected, walletUsdcBalance, escrowBalance, hasActiveSession, sellerPeerId } = params;

  // Step 1: Need wallet
  if (!walletConnected) {
    return { ready: false, action: 'connect-wallet' };
  }

  // Step 2: Need USDC in wallet or escrow
  if (walletUsdcBalance === 0n && escrowBalance === 0n) {
    return { ready: false, action: 'fund-wallet' };
  }

  // Step 3: Need deposit in escrow
  if (escrowBalance === 0n && walletUsdcBalance > 0n) {
    return { ready: false, action: 'deposit-escrow', meta: { suggestedAmount: walletUsdcBalance.toString() } };
  }

  // Step 4: Need active session with seller (SpendingAuth)
  if (!hasActiveSession && sellerPeerId) {
    return { ready: false, action: 'sign-spending-auth' };
  }

  // Ready to send
  return { ready: true };
}
```

#### Acceptance Criteria
- [ ] Returns correct action for each state: no wallet → fund → deposit → sign → ready
- [ ] Handles edge cases: wallet connected but zero balance, escrow has balance but no session
- [ ] Pure function, no side effects
- [ ] Unit test: test all 5 states return correct action

---

### Task 2: Create usePaymentState hook

##### CREATE: apps/desktop/src/renderer/ui/hooks/usePaymentState.ts

A React hook that combines wagmi wallet state with escrow contract reads to produce the current `PaymentReadiness`.

```typescript
import { useAccount, useBalance, useReadContract } from 'wagmi';
import { base } from 'viem/chains';
import { useMemo } from 'react';
import { checkPaymentReadiness, type PaymentReadiness } from '../../modules/payment-state';

const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const ESCROW_ADDRESS = '0x...'; // TODO: from config

const ESCROW_ABI = [{
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
}] as const;

export function usePaymentState(sellerPeerId: string | null, hasActiveSession: boolean): PaymentReadiness {
  const { address, isConnected } = useAccount();

  const { data: usdcBalance } = useBalance({
    address,
    token: USDC_ADDRESS,
    chainId: base.id,
    query: { enabled: isConnected, refetchInterval: 30_000 },
  });

  const { data: escrowData } = useReadContract({
    address: ESCROW_ADDRESS as `0x${string}`,
    abi: ESCROW_ABI,
    functionName: 'getBuyerBalance',
    args: address ? [address] : undefined,
    chainId: base.id,
    query: { enabled: isConnected && !!address, refetchInterval: 30_000 },
  });

  return useMemo(() => checkPaymentReadiness({
    walletConnected: isConnected,
    walletUsdcBalance: usdcBalance?.value ?? 0n,
    escrowBalance: escrowData ? escrowData[0] : 0n,
    hasActiveSession,
    sellerPeerId,
  }), [isConnected, usdcBalance?.value, escrowData, hasActiveSession, sellerPeerId]);
}
```

#### Acceptance Criteria
- [ ] Returns current payment readiness based on live wallet + contract state
- [ ] Memoized — doesn't re-trigger unless inputs change
- [ ] Handles loading states (returns not-ready while fetching)
- [ ] Refetches balances every 30 seconds

---

### Task 3: Integrate payment check into sendMessage flow

##### MODIFY: apps/desktop/src/renderer/modules/chat.ts

This is the core integration point. When the user sends a message, check payment readiness. If not ready, inject a payment bubble into the chat instead of sending the message. Store the pending message and release it when the payment action completes.

**Add state variables** (near the top of `initChatModule`, alongside existing state):
```typescript
let pendingMessage: { text: string; imageBase64?: string; imageMimeType?: string } | null = null;
let pendingPaymentCallbackId: string | null = null;
```

**Modify `sendMessage` function** — add payment readiness check before the existing send logic. After the line `const content = text.trim();`:

```typescript
// Payment readiness check (only when a seller is selected)
const sellerPeerId = getSelectedSellerPeerId(); // TODO: implement based on selected service
const paymentReady = bridge?.getPaymentReadiness?.(sellerPeerId);

if (paymentReady && !paymentReady.ready) {
  // Store the pending message
  pendingMessage = { text, imageBase64, imageMimeType };

  // Inject payment bubble into chat
  const callbackId = `payment-${Date.now()}`;
  pendingPaymentCallbackId = callbackId;

  const paymentMessage: ChatMessage = {
    role: 'system',
    content: '',
    createdAt: Date.now(),
    meta: {
      paymentAction: paymentReady.action,
      callbackId,
      ...paymentReady.meta,
    },
  };

  uiState.chatMessages = [...uiState.chatMessages, paymentMessage];
  notifyUiStateChanged();
  return; // Don't send yet
}
```

**Add payment completion handler** (new exported function):
```typescript
function onPaymentComplete(callbackId: string): void {
  if (callbackId !== pendingPaymentCallbackId) return;
  pendingPaymentCallbackId = null;

  if (pendingMessage) {
    const { text, imageBase64, imageMimeType } = pendingMessage;
    pendingMessage = null;
    // Re-trigger sendMessage now that payment is ready
    sendMessage(text, imageBase64, imageMimeType);
  }
}
```

**Export `onPaymentComplete`** in the module's returned actions.

#### Acceptance Criteria
- [ ] Sending a message without a wallet injects a connect bubble instead
- [ ] Sending with zero balance injects a fund bubble
- [ ] Sending with wallet balance but no escrow deposit injects a deposit bubble
- [ ] After payment action completes, the original message is sent
- [ ] Multiple rapid sends don't create duplicate payment bubbles
- [ ] Regular messages (with payment ready) are unaffected

---

### Task 4: Wire PaymentBubble onComplete to chat module

##### MODIFY: apps/desktop/src/renderer/ui/components/chat/ChatBubble.tsx

Update the PaymentBubble rendering to pass the `onComplete` callback that connects back to the chat module's `onPaymentComplete`.

**Update the payment bubble rendering** (from PRD-03 Task 6):
```tsx
if (isPaymentBubble(message)) {
  return (
    <PaymentBubble
      message={message}
      onComplete={(callbackId) => {
        // Fire the chat module's payment completion handler
        const actions = getActions();
        actions.onPaymentComplete?.(callbackId);
      }}
    />
  );
}
```

**Register `onPaymentComplete` in actions** — ensure the `registerActions` call in `app.ts` includes `onPaymentComplete` from the chat module exports.

#### Acceptance Criteria
- [ ] PaymentBubble onComplete triggers chat module's handler
- [ ] Pending message is released after successful payment action
- [ ] Chat continues normally after payment flow completes

---

### Task 5: Wire SpendingAuth signature to BuyerPaymentManager via IPC

##### MODIFY: apps/desktop/src/main/main.ts

Add an IPC handler that receives the signed SpendingAuth from the renderer and passes it to the buyer's payment flow.

**Add handler** (in the wallet IPC section):
```typescript
ipcMain.handle('wallet:send-spending-auth', async (_event, payload: {
  sellerPeerId: string;
  sellerEvmAddr: string;
  sessionId: string;
  maxAmount: string;
  nonce: number;
  deadline: number;
  previousConsumption: string;
  previousSessionId: string;
  buyerSig: string;
  buyerEvmAddr: string;
}) => {
  try {
    // Find the PaymentMux for this seller and send the SpendingAuth
    // This connects the renderer's OnchainKit signature to the P2P protocol
    const paymentMux = getPaymentMuxForPeer(payload.sellerPeerId);
    if (!paymentMux) {
      return { ok: false, error: 'No connection to seller' };
    }

    paymentMux.sendSpendingAuth({
      sessionId: payload.sessionId,
      maxAmountUsdc: payload.maxAmount,
      nonce: payload.nonce,
      deadline: payload.deadline,
      buyerSig: payload.buyerSig,
      buyerEvmAddr: payload.buyerEvmAddr,
      previousConsumption: payload.previousConsumption,
      previousSessionId: payload.previousSessionId,
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});
```

##### MODIFY: apps/desktop/src/main/preload.cts

**Add bridge method:**
```typescript
sendSpendingAuth: (payload: Record<string, unknown>) =>
  ipcRenderer.invoke('wallet:send-spending-auth', payload),
```

##### MODIFY: apps/desktop/src/renderer/ui/components/chat/bubbles/SignAuthBubble.tsx

**Update `handleSuccess`** to send the signature via IPC:
```tsx
const handleSuccess = useCallback(async (sig: string) => {
  const bridge = window.antseedDesktop;
  if (bridge?.sendSpendingAuth) {
    await bridge.sendSpendingAuth({
      ...authRequest,
      buyerSig: sig,
      buyerEvmAddr: address, // from useAccount()
    });
  }
  onComplete();
}, [authRequest, onComplete, address]);
```

#### Acceptance Criteria
- [ ] Signed SpendingAuth is sent via IPC to the main process
- [ ] Main process sends it over the P2P PaymentMux to the seller
- [ ] Bridge method is typed and available in the renderer
- [ ] Error handling returns meaningful errors if seller not connected
- [ ] The full flow works: chat → payment bubble → signature → IPC → P2P → seller
