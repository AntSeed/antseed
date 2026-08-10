import type { CooperativeCloseResult, DesktopBridge } from '../../../types/bridge';

export type ChannelCloseAction = 'seller-and-on-chain' | 'on-chain' | 'withdraw' | 'none';

export type ChannelCloseFeedback = {
  tone: 'success' | 'error';
  message: string;
};

export function isCurrentChannelStatus(status: string): boolean {
  return status === 'active'
    || status === 'open'
    || status === 'closing'
    || status === 'withdrawable';
}

export function isFundedCurrentChannel(row: {
  status: string;
  reserveMax: string;
  settledUsdc: string;
}): boolean {
  return isCurrentChannelStatus(row.status) && channelLockedBaseUnits(row) > 0n;
}

export function channelLockedBaseUnits(row: { reserveMax: string; settledUsdc: string }): bigint {
  try {
    const reserved = BigInt(row.reserveMax || '0');
    const settled = BigInt(row.settledUsdc || '0');
    return reserved > settled ? reserved - settled : 0n;
  } catch {
    return 0n;
  }
}

export function formatChannelLockedAmount(row: { reserveMax: string; settledUsdc: string }): string {
  const locked = channelLockedBaseUnits(row);
  if (locked === 0n) return 'No funds locked';
  if (locked < 10_000n) return '<$0.01 locked';
  const whole = locked / 1_000_000n;
  const cents = (locked % 1_000_000n) / 10_000n;
  return `$${whole}.${cents.toString().padStart(2, '0')} locked`;
}

export function compareChannelsByLockedAmount(
  left: { reserveMax: string; settledUsdc: string; reservedAt: number },
  right: { reserveMax: string; settledUsdc: string; reservedAt: number },
): number {
  const leftLocked = channelLockedBaseUnits(left);
  const rightLocked = channelLockedBaseUnits(right);
  if (leftLocked === rightLocked) return (right.reservedAt || 0) - (left.reservedAt || 0);
  return rightLocked > leftLocked ? 1 : -1;
}

export function channelCloseAction(
  status: string,
  cooperativeCloseSupported: boolean,
  cooperativeCloseFailed = false,
): ChannelCloseAction {
  if (status === 'active' || status === 'open') {
    return cooperativeCloseSupported && !cooperativeCloseFailed ? 'seller-and-on-chain' : 'on-chain';
  }
  if (status === 'withdrawable') return 'withdraw';
  return 'none';
}

export function cooperativeCloseRejectionMessage(result: CooperativeCloseResult): string {
  switch (result.code) {
    case 'busy':
      return 'The seller is still processing a request. Retry shortly.';
    case 'pending_auth':
      return 'The seller needs the latest payment authorization. Retry shortly.';
    case 'no_channel':
      return 'The seller no longer has this channel open. Refresh Activity to check its status.';
    case 'invalid_auth':
      return 'The seller could not verify the latest payment authorization. Use on-chain close instead.';
    case 'close_failed':
      return 'The seller could not close the channel. Use on-chain close instead.';
    case 'unsupported':
      return 'This seller does not support seller-assisted close. Use on-chain close instead.';
    default:
      return result.reason || 'The seller declined to close the channel. Use on-chain close instead.';
  }
}

export async function requestSellerAssistedClose(
  peerId: string,
  bridge: DesktopBridge | undefined,
  refresh: { credits: () => Promise<void>; summary: () => Promise<void> },
): Promise<ChannelCloseFeedback> {
  if (!bridge?.paymentsRequestCooperativeClose) {
    return { tone: 'error', message: 'Seller-assisted close is unavailable. The channel is unchanged.' };
  }
  let response: Awaited<ReturnType<NonNullable<DesktopBridge['paymentsRequestCooperativeClose']>>>;
  try {
    response = await bridge.paymentsRequestCooperativeClose({ peerId });
  } catch {
    return { tone: 'error', message: 'The seller could not be reached. The channel is unchanged.' };
  }
  if (!response.ok || !response.result) {
    return {
      tone: 'error',
      message: response.error
        ? `${response.error} The channel is unchanged.`
        : 'The close request failed. The channel is unchanged.',
    };
  }
  if (response.result.status === 'rejected') {
    return { tone: 'error', message: cooperativeCloseRejectionMessage(response.result) };
  }
  await Promise.allSettled([
    Promise.resolve().then(refresh.credits),
    Promise.resolve().then(refresh.summary),
  ]);
  return { tone: 'success', message: 'Seller closed the channel.' };
}
