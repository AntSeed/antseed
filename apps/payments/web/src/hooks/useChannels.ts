import { useCallback, useEffect, useMemo, useState } from 'react';
import { useReadContracts } from 'wagmi';
import { formatUnits, parseAbi } from 'viem';
import { getChannels, type ChannelData, type RawChannel } from '../api';
import { CHANNELS_ABI } from '../channels-abi';
import type { PaymentConfig } from '../types';

const parsedAbi = parseAbi(CHANNELS_ABI);

// Tuple shape of the `channels(bytes32)` getter return.
// [buyer, seller, deposit, settled, metadataHash, deadline, settledAt, closeRequestedAt, status]
type ChannelTuple = readonly [
  `0x${string}`, `0x${string}`, bigint, bigint, `0x${string}`, bigint, bigint, bigint, number | bigint,
];

function safeBigint(s: string): bigint {
  try { return BigInt(s); } catch { return 0n; }
}

export function useChannels(config: PaymentConfig | null): {
  channels: ChannelData[];
  history: ChannelData[];
  loading: boolean;
  refetch: () => Promise<void>;
} {
  const [rawChannels, setRawChannels] = useState<RawChannel[]>([]);
  const [listLoading, setListLoading] = useState(true);

  const refetchList = useCallback(async () => {
    try {
      const { channels } = await getChannels();
      setRawChannels(channels);
    } catch {
      setRawChannels([]);
    }
  }, []);

  useEffect(() => {
    setListLoading(true);
    void refetchList().finally(() => setListLoading(false));
  }, [refetchList]);

  const contracts = useMemo(() => {
    if (!config?.channelsContractAddress || !config.evmChainId) return [];
    const address = config.channelsContractAddress as `0x${string}`;
    const chainId = config.evmChainId;
    return rawChannels.map((c) => ({
      address,
      abi: parsedAbi,
      functionName: 'channels' as const,
      args: [c.channelId as `0x${string}`] as const,
      chainId,
    }));
  }, [rawChannels, config?.channelsContractAddress, config?.evmChainId]);

  const {
    data: onChainReads,
    refetch: refetchOnChain,
    isFetching: onChainFetching,
  } = useReadContracts({
    contracts,
    query: {
      enabled: contracts.length > 0,
      refetchOnWindowFocus: false,
    },
  });

  const { channels, history } = useMemo<{ channels: ChannelData[]; history: ChannelData[] }>(() => {
    const enriched: ChannelData[] = rawChannels.map((raw, i) => {
      const read = onChainReads?.[i];
      const tuple = read?.status === 'success' ? (read.result as unknown as ChannelTuple) : null;
      // Fall back to local reserveMax/cumulativeSigned while the multicall is
      // in-flight so the UI renders something immediately. On-chain values
      // overwrite these on the next render.
      const deposit = tuple ? tuple[2] : safeBigint(raw.reserveMax);
      const settled = tuple ? tuple[3] : safeBigint(raw.cumulativeSigned);
      const closeRequestedAt = tuple ? Number(tuple[7]) : 0;
      const status = tuple ? Number(tuple[8]) : (raw.status === 'active' ? 1 : 2);
      return {
        channelId: raw.channelId,
        seller: raw.seller,
        deposit: formatUnits(deposit, 6),
        settled: formatUnits(settled, 6),
        reservedAt: raw.reservedAt,
        deadline: raw.deadline,
        closeRequestedAt,
        status,
      };
    });
    return {
      channels: enriched.filter((c) => c.status === 1),
      history: enriched.filter((c) => c.status !== 1),
    };
  }, [rawChannels, onChainReads]);

  const refetch = useCallback(async () => {
    setListLoading(true);
    await refetchList();
    setListLoading(false);
    await refetchOnChain();
  }, [refetchList, refetchOnChain]);

  return {
    channels,
    history,
    loading: listLoading || onChainFetching,
    refetch,
  };
}
