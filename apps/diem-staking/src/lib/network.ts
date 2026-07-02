import { useCallback, useEffect, useState } from 'react';
import { useChainModal } from '@rainbow-me/rainbowkit';
import { useAccount, useSwitchChain } from 'wagmi';
import { base } from 'wagmi/chains';

export const DIEM_CHAIN = base;
export const DIEM_CHAIN_ID = base.id;
export const DIEM_CHAIN_NAME = base.name;

export function useDiemNetwork() {
  const { isConnected, connector } = useAccount();
  const { switchChainAsync, isPending: isSwitchingChain } = useSwitchChain();
  const { openChainModal } = useChainModal();
  const [walletChainId, setWalletChainId] = useState<number | undefined>(undefined);

  const refreshWalletChainId = useCallback(async () => {
    if (!isConnected || !connector?.getChainId) {
      setWalletChainId(undefined);
      return undefined;
    }

    const chainId = await connector.getChainId();
    setWalletChainId(chainId);
    return chainId;
  }, [connector, isConnected]);

  useEffect(() => {
    let cancelled = false;

    async function refresh() {
      try {
        const chainId = await refreshWalletChainId();
        if (!cancelled) setWalletChainId(chainId);
      } catch {
        if (!cancelled) setWalletChainId(undefined);
      }
    }

    void refresh();

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
      void refresh();
    };

    connector.emitter.on('change', handleChange);

    return () => {
      cancelled = true;
      connector.emitter.off?.('change', handleChange);
    };
  }, [connector, refreshWalletChainId]);

  const ensureDiemNetwork = useCallback(async () => {
    if (!isConnected) {
      throw new Error('Connect your wallet before continuing.');
    }

    const currentChainId = await refreshWalletChainId();
    if (currentChainId === DIEM_CHAIN_ID) {
      return;
    }

    if (typeof switchChainAsync === 'function') {
      await switchChainAsync({ chainId: DIEM_CHAIN_ID });

      const startedAt = Date.now();
      while (Date.now() - startedAt < 10_000) {
        const chainId = await refreshWalletChainId();
        if (chainId === DIEM_CHAIN_ID) {
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }

    if (typeof openChainModal === 'function') {
      openChainModal();
    }

    throw new Error(`Please switch your wallet to ${DIEM_CHAIN_NAME} and try again.`);
  }, [isConnected, openChainModal, refreshWalletChainId, switchChainAsync]);

  return {
    expectedChainId: DIEM_CHAIN_ID,
    walletChainId,
    wrongChain: Boolean(isConnected && walletChainId && walletChainId !== DIEM_CHAIN_ID),
    isSwitchingChain,
    ensureDiemNetwork,
  };
}
