/**
 * Watches the buyer's hot wallet for incoming USDC and sweeps it into the
 * deposits contract via a relayer.
 *
 * The buyer never holds funds and never pays gas: the sweep is authorized
 * off-chain (EIP-3009 receive authorization) and broadcast by whichever peer
 * relays it — this module signs and waits, it never sends a transaction.
 */
import {
  DepositsClient,
  DepositRelayClient,
  buildReceiveAuthorization,
  formatUsdc,
  makeUsdcDomain,
  peerRelaysSweeps,
} from '@antseed/node';
import type { SweepReceiptPayload, SweepRequestPayload } from '@antseed/node';
import { LOCALHOST_URL } from '../constants.js';
import { getSecureIdentity } from '../identity.js';
import { resolveBuyerProxyPort } from '../runtime/active-config.js';
import { getMainWindow } from '../ui/window.js';
import { invalidateCreditsCache, loadCachedCryptoConfig } from './credits.js';

type DepositWatchStatus = {
  phase: 'received' | 'sweeping' | 'credited' | 'error';
  amountBaseUnits?: string;
  txHash?: string;
  error?: string;
};

export const DEPOSIT_WATCH_INTERVAL_MS = 2_000;
const SWEEP_AUTH_VALIDITY_SECS = 3_600;
const SWEEP_CONFIRM_TIMEOUT_MS = 120_000;
const SWEEP_POLL_INTERVAL_MS = 1_000;
// After a failed/incomplete sweep the funds stay in the wallet; retry on the
// watcher tick once this cooldown passes instead of hammering the network.
const SWEEP_RETRY_COOLDOWN_MS = 60_000;
// AntseedDeposits enforces a 1 USDC minimum first deposit (net of the fee).
const MIN_FIRST_DEPOSIT_BASE_UNITS = 1_000_000n;
// Minimum top-up when the sweep is clamped by the credit-limit headroom.
// Without a floor, a wallet holding more than the remaining headroom would
// grind it into the limit gap in dust increments — paying the fixed relay
// fee on each sliver every time spending frees a few cents of headroom.
const MIN_TOPUP_BASE_UNITS = 1_000_000n;

let depositWatchTimer: NodeJS.Timeout | null = null;
let depositWatchBalance = 0n;
let depositSweepInFlight = false;
let depositSweepLastAttemptAt = 0;

export function makeDepositsClient(cc: NonNullable<Awaited<ReturnType<typeof loadCachedCryptoConfig>>>): DepositsClient {
  return new DepositsClient({
    rpcUrl: cc.rpcUrl,
    ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
    contractAddress: cc.depositsAddress,
    usdcAddress: cc.usdcAddress,
    ...(cc.chainId ? { evmChainId: cc.chainId } : {}),
  });
}

function sendDepositWatchStatus(status: DepositWatchStatus): void {
  getMainWindow()?.webContents.send('deposits:watch-status', status);
}

// ─── Buyer-daemon sweep control plane ───
// The running buyer daemon already holds authenticated seller connections and
// exposes the sweep endpoints on its proxy port (a second node with the same
// identity would collide with the daemon's peerId on the network).

async function buyerDaemonFetch(pathname: string, init?: RequestInit, timeoutMs = 10_000): Promise<Response | null> {
  try {
    const port = await resolveBuyerProxyPort();
    return await fetch(`${LOCALHOST_URL}:${port}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

/** POST the signed sweep payload to the daemon, which offers it to relayers
 *  one at a time so they never race the same nonce. Returns the offer-round
 *  result, or null when no daemon is listening on the proxy port. The long
 *  timeout covers the sequential round (~10s per candidate relayer);
 *  `accepted` is undefined when an older daemon predates sequential dispatch. */
async function daemonBroadcastSweep(payload: SweepRequestPayload): Promise<{ sent: number; accepted?: boolean } | null> {
  const res = await buyerDaemonFetch('/_antseed/sweep', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  }, 90_000);
  if (!res) return null;
  const body = await res.json().catch(() => null) as { ok?: boolean; sent?: number; accepted?: boolean; error?: string } | null;
  if (!res.ok || !body?.ok || typeof body.sent !== 'number') {
    throw new Error(`Buyer daemon rejected the sweep request: ${body?.error ?? `HTTP ${res.status}`}`);
  }
  return { sent: body.sent, ...(typeof body.accepted === 'boolean' ? { accepted: body.accepted } : {}) };
}

/** Ask the daemon to refresh discovery and eagerly connect to a few peers
 *  that announce the sweep-relay capability. */
async function daemonConnectSweepRelayers(): Promise<void> {
  await buyerDaemonFetch('/_antseed/peers/refresh', { method: 'POST' }, 30_000);
  const res = await buyerDaemonFetch('/_antseed/peers');
  const body = await res?.json().catch(() => null) as {
    peers?: Array<{ peerId: string; capabilities?: string[]; metadata?: { capabilities?: string[] } }>;
  } | null;
  const relayers = (body?.peers ?? []).filter(peerRelaysSweeps);
  await Promise.allSettled(relayers.slice(0, 4).map((p) => buyerDaemonFetch('/_antseed/connect', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ peerId: p.peerId }),
  }, 20_000)));
}

async function daemonGetSweepReceipt(nonce: string): Promise<SweepReceiptPayload | null> {
  const res = await buyerDaemonFetch(`/_antseed/sweep/${nonce}`, undefined, 3_000);
  const body = await res?.json().catch(() => null) as { receipt?: SweepReceiptPayload | null } | null;
  return body?.receipt ?? null;
}

/** The on-chain fallbacks usually confirm a sweep before the relayer's
 *  'confirmed' receipt (which carries the tx hash) arrives — grace-poll the
 *  receipt briefly so the credited status can still link the transaction. */
async function pollReceiptTxHash(nonce: string, graceMs: number): Promise<string | undefined> {
  const deadline = Date.now() + graceMs;
  while (Date.now() < deadline) {
    const receipt = await daemonGetSweepReceipt(nonce).catch(() => null);
    if (receipt?.txHash) return receipt.txHash;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return undefined;
}

// ─── Sweep confirmation ───
// Source of truth is on-chain: a matching SweepExecuted relay event, the
// consumed EIP-3009 authorization, or the deposits-balance increase. Relayer
// receipts only surface the txHash faster; zero receipts must be tolerated.
async function waitForSweepConfirmation(params: {
  depositsClient: DepositsClient;
  relayClient: DepositRelayClient;
  buyer: string;
  initialTotal: bigint;
  expectedNet: bigint;
  fee: bigint;
  usdcAddress: string;
  authNonce: string;
}): Promise<{ credited: bigint; txHash?: string } | null> {
  const { depositsClient, relayClient, buyer, initialTotal, expectedNet, fee, usdcAddress, authNonce } = params;
  const deadline = Date.now() + SWEEP_CONFIRM_TIMEOUT_MS;
  let txHash: string | undefined;

  while (Date.now() < deadline) {
    const receipt = await daemonGetSweepReceipt(authNonce).catch(() => null);
    if (receipt?.txHash) txHash = receipt.txHash;

    if (txHash) {
      const confirmation = await relayClient.getSweepConfirmation(txHash, {
        buyer,
        deposited: expectedNet,
        fee,
        authNonce,
      }).catch(() => null);
      if (confirmation) {
        return { credited: confirmation.deposited, txHash: confirmation.txHash };
      }
    }

    const authorizationUsed = await relayClient.isAuthorizationUsed(usdcAddress, buyer, authNonce).catch(() => false);
    if (authorizationUsed) {
      return { credited: expectedNet, ...(txHash ? { txHash } : {}) };
    }

    const current = await depositsClient.getBuyerBalance(buyer).catch(() => null);
    if (current && current.available + current.reserved >= initialTotal + expectedNet) {
      return { credited: current.available + current.reserved - initialTotal, ...(txHash ? { txHash } : {}) };
    }

    await new Promise((resolve) => setTimeout(resolve, SWEEP_POLL_INTERVAL_MS));
  }
  return null;
}

export async function sweepIncomingUsdc(client: DepositsClient, buyer: string): Promise<void> {
  if (depositSweepInFlight) return;
  depositSweepInFlight = true;
  depositSweepLastAttemptAt = Date.now();
  try {
    const identity = getSecureIdentity();
    const cc = await loadCachedCryptoConfig();
    if (!identity || !cc) return;
    if (!cc.depositRelayAddress) {
      sendDepositWatchStatus({
        phase: 'error',
        error: 'Automatic deposit is not available on this chain yet. Your USDC is safe in the wallet.',
      });
      return;
    }
    const relayClient = new DepositRelayClient({
      rpcUrl: cc.rpcUrl,
      ...(cc.fallbackRpcUrls ? { fallbackRpcUrls: cc.fallbackRpcUrls } : {}),
      contractAddress: cc.depositRelayAddress,
      evmChainId: cc.chainId,
    });

    const [usdcBalance, deposits, creditLimit, fee] = await Promise.all([
      client.getUSDCBalance(buyer),
      client.getBuyerBalance(buyer),
      client.getBuyerCreditLimit(buyer),
      relayClient.fee(),
    ]);

    const depositsBalance = deposits.available + deposits.reserved;
    // Below the sweepable minimum (fee, plus the contract's 1 USDC first-
    // deposit floor) — keep waiting; more USDC may still be on the way.
    const minRequired = depositsBalance === 0n ? MIN_FIRST_DEPOSIT_BASE_UNITS + fee : fee + 1n;
    if (usdcBalance < minRequired) return;

    // Deposits caps the credited balance at the buyer's credit limit; a net
    // amount past it would revert the whole sweep, so clamp and leave the
    // rest in the wallet for a later sweep.
    const headroom = creditLimit > depositsBalance ? creditLimit - depositsBalance : 0n;
    if (headroom === 0n) {
      sendDepositWatchStatus({
        phase: 'error',
        error: `Your credits are at the account limit (${formatUsdc(creditLimit)} USDC). Spend or withdraw before depositing more.`,
      });
      return;
    }
    // Headroom-clamped top-up: wait until at least MIN_TOPUP_BASE_UNITS of
    // headroom is free instead of sweeping fee-heavy slivers repeatedly.
    if (usdcBalance - fee > headroom && headroom < MIN_TOPUP_BASE_UNITS) {
      sendDepositWatchStatus({
        phase: 'error',
        error: `Your credits are near the account limit (${formatUsdc(creditLimit)} USDC). The USDC in your wallet tops up automatically as you spend.`,
      });
      return;
    }
    let amount = usdcBalance;
    if (amount - fee > headroom) amount = headroom + fee;

    sendDepositWatchStatus({ phase: 'sweeping', amountBaseUnits: amount.toString() });

    // A wrong USDC domain (name/version differ per deployment) would produce
    // signatures the token silently rejects — refuse to sign.
    const usdcDomain = makeUsdcDomain(cc.chainId, cc.usdcAddress);
    const domainOk = await relayClient.verifyUsdcDomain(cc.usdcAddress, usdcDomain);
    if (!domainOk) {
      throw new Error('USDC EIP-712 domain mismatch — refusing to sign the sweep authorization.');
    }

    // The single EIP-3009 signature, addressed to the relay contract, is the
    // consent to its immutable fixed FEE — no second signature.
    const nowSecs = Math.floor(Date.now() / 1000);
    const validAfter = nowSecs - 60;
    const validBefore = nowSecs + SWEEP_AUTH_VALIDITY_SECS;
    const { message, signature: sig3009 } = await buildReceiveAuthorization(identity.wallet, usdcDomain, {
      to: cc.depositRelayAddress,
      value: amount,
      validAfter: BigInt(validAfter),
      validBefore: BigInt(validBefore),
    });

    const payload: SweepRequestPayload = {
      version: 1,
      evmChainId: cc.chainId,
      relayAddress: cc.depositRelayAddress,
      from: buyer,
      amount: amount.toString(),
      validAfter,
      validBefore,
      nonce: message.nonce,
      sig3009,
    };

    let dispatch = await daemonBroadcastSweep(payload);
    if (dispatch === null) {
      throw new Error('The AntSeed connection is not running — start it to complete the deposit. Your USDC is safe in the wallet.');
    }
    if (dispatch.sent === 0) {
      await daemonConnectSweepRelayers();
      dispatch = await daemonBroadcastSweep(payload) ?? { sent: 0 };
    }
    if (dispatch.sent === 0) {
      throw new Error('No deposit relayers are reachable right now. Your USDC is safe in the wallet — retrying automatically.');
    }
    // accepted === false means every relayer in the round declined (or stayed
    // silent) — fail fast into the watcher's retry instead of waiting out the
    // full confirmation window. undefined (older daemon) falls through.
    if (dispatch.accepted === false) {
      throw new Error('No deposit relayer accepted the request right now. Your USDC is safe in the wallet — retrying automatically.');
    }

    const result = await waitForSweepConfirmation({
      depositsClient: client,
      relayClient,
      buyer,
      initialTotal: depositsBalance,
      expectedNet: amount - fee,
      fee,
      usdcAddress: cc.usdcAddress,
      authNonce: message.nonce,
    });
    if (!result) {
      throw new Error('The deposit was not confirmed in time. Your USDC is safe in the wallet — retrying automatically.');
    }

    depositWatchBalance = await client.getUSDCBalance(buyer).catch(() => 0n);
    invalidateCreditsCache();
    sendDepositWatchStatus({
      phase: 'credited',
      amountBaseUnits: result.credited.toString(),
      ...(result.txHash ? { txHash: result.txHash } : {}),
    });
    // The on-chain fallbacks often confirm before the relayer's 'confirmed'
    // receipt (the only carrier of the tx hash) arrives. Never delay the
    // credited status for it — backfill the hash when the receipt lands.
    if (!result.txHash) {
      void pollReceiptTxHash(message.nonce, 15_000).then((txHash) => {
        if (!txHash) return;
        sendDepositWatchStatus({
          phase: 'credited',
          amountBaseUnits: result.credited.toString(),
          txHash,
        });
      });
    }
  } catch (err) {
    sendDepositWatchStatus({ phase: 'error', error: err instanceof Error ? err.message : String(err) });
  } finally {
    depositSweepInFlight = false;
  }
}

export async function pollDepositWatch(): Promise<void> {
  const identity = getSecureIdentity();
  const cc = await loadCachedCryptoConfig();
  if (!identity || !cc) return;
  const client = makeDepositsClient(cc);
  let balance: bigint;
  try {
    balance = await client.getUSDCBalance(identity.wallet.address);
  } catch {
    return; // transient RPC failure — try again next tick
  }
  if (balance > depositWatchBalance) {
    const delta = balance - depositWatchBalance;
    depositWatchBalance = balance;
    sendDepositWatchStatus({ phase: 'received', amountBaseUnits: delta.toString() });
    void sweepIncomingUsdc(client, identity.wallet.address);
  } else if (balance < depositWatchBalance) {
    depositWatchBalance = balance;
  } else if (balance > 0n && !depositSweepInFlight && Date.now() - depositSweepLastAttemptAt > SWEEP_RETRY_COOLDOWN_MS) {
    // Funds from an earlier failed/partial sweep are still sitting in the
    // wallet — retry once the cooldown passes.
    void sweepIncomingUsdc(client, identity.wallet.address);
  }
}


export function getDepositWatchTimer(): NodeJS.Timeout | null {
  return depositWatchTimer;
}

export function setDepositWatchTimer(timer: NodeJS.Timeout | null): void {
  depositWatchTimer = timer;
}

export function setDepositWatchBalance(balance: bigint): void {
  depositWatchBalance = balance;
}
