import type { CooperativeCloseResult, DesktopBridge } from '../../../types/bridge';

export type ChannelCloseAction = 'seller-and-on-chain' | 'on-chain' | 'withdraw' | 'none';

export type ChannelCloseFeedback = {
  tone: 'success' | 'error';
  message: string;
};

export function channelCloseAction(status: string, cooperativeCloseSupported: boolean): ChannelCloseAction {
  if (status === 'active' || status === 'open') {
    return cooperativeCloseSupported ? 'seller-and-on-chain' : 'on-chain';
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
  try {
    const response = await bridge.paymentsRequestCooperativeClose({ peerId });
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
    await Promise.all([refresh.credits(), refresh.summary()]);
    return { tone: 'success', message: 'Seller closed the channel.' };
  } catch {
    return { tone: 'error', message: 'The seller could not be reached. The channel is unchanged.' };
  }
}
