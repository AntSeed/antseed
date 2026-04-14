import { useEffect, useState } from 'react';
import { useAccount, useSwitchChain } from 'wagmi';
import { base } from 'wagmi/chains';
import { useChainModal } from '@rainbow-me/rainbowkit';
import type { PaymentConfig } from './types';

const PAYMENT_CHAINS = {
  [base.id]: base,
} as const;

export function getPaymentChainName(config: PaymentConfig | null): string {
  if (!config?.evmChainId) return 'configured payments network';
  return PAYMENT_CHAINS[config.evmChainId as keyof typeof PAYMENT_CHAINS]?.name ?? config.chainId;
}

export function getErrorMessage(error: unknown, fallback = 'Something went wrong.'): string {
  if (error instanceof Error) {
    return error.message.split('\n')[0] ?? error.message;
  }
  return fallback;
}

export function usePaymentNetwork(config: PaymentConfig | null) {
  const { isConnected, connector } = useAccount();
  const { switchChainAsync, isPending: isSwitchingChain } = useSwitchChain();
  const { openChainModal } = useChainModal();
  const [walletChainId, setWalletChainId] = useState<number | undefined>(undefined);

  const expectedChainId = config?.evmChainId;
  const targetChainName = getPaymentChainName(config);
  const wrongChain = Boolean(
    isConnected &&
    expectedChainId &&
    walletChainId &&
    walletChainId !== expectedChainId
  );

  useEffect(() => {
    let cancelled = false;

    async function refreshWalletChainId() {
      if (!isConnected || !connector?.getChainId) {
        if (!cancelled) setWalletChainId(undefined);
        return;
      }

      try {
        const chainId = await connector.getChainId();
        if (!cancelled) setWalletChainId(chainId);
      } catch {
        if (!cancelled) setWalletChainId(undefined);
      }
    }

    void refreshWalletChainId();

    if (!connector?.emitter?.on) {
      return () => {
        cancelled = true;
      };
    }

    const handleChange = (data?: { chainId?: string | number }) => {
      if (typeof data?.chainId === 'number') {
        setWalletChainId(data.chainId);
        return;
      }
      if (typeof data?.chainId === 'string') {
        setWalletChainId(Number(data.chainId));
        return;
      }
      void refreshWalletChainId();
    };

    connector.emitter.on('change', handleChange);

    return () => {
      cancelled = true;
      connector.emitter.off?.('change', handleChange);
    };
  }, [connector, isConnected]);

  async function getCurrentWalletChainId() {
    if (!isConnected || !connector?.getChainId) {
      return undefined;
    }

    const chainId = await connector.getChainId();
    setWalletChainId(chainId);
    return chainId;
  }

  async function waitForWalletChain(targetChainId: number, timeoutMs = 10_000) {
    const startedAt = Date.now();

    while (Date.now() - startedAt < timeoutMs) {
      const currentChainId = await getCurrentWalletChainId();
      if (currentChainId === targetChainId) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    throw new Error(`Wallet is still on chain ${walletChainId ?? 'unknown'}. Please switch to ${targetChainName} and try again.`);
  }

  async function ensureCorrectNetwork() {
    if (!isConnected) {
      throw new Error('Connect your wallet before continuing.');
    }
    if (!expectedChainId) {
      throw new Error('Payments network is not configured.');
    }
    const currentChainId = await getCurrentWalletChainId();
    if (currentChainId === expectedChainId) {
      return;
    }

    if (typeof switchChainAsync === 'function') {
      await switchChainAsync({ chainId: expectedChainId });
      await waitForWalletChain(expectedChainId);
      return;
    }

    if (typeof openChainModal === 'function') {
      openChainModal();
    }

    throw new Error(`Please switch your wallet to ${targetChainName} and try again.`);
  }

  return {
    expectedChainId,
    targetChainName,
    walletChainId,
    wrongChain,
    isSwitchingChain,
    ensureCorrectNetwork,
  };
}
