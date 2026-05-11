import { useQuery } from '@tanstack/react-query';
import type { PublicClient } from 'viem';
import {
  getBalance,
  getBuyerUsage,
  getConfig,
  getEmissionsInfo,
  getEmissionsPending,
  getEmissionsShares,
  getNetworkStats,
  getTransfersEnabled,
} from '../api';
import { scanDiemEpochs } from '../utils/diemScan';

export const queryKeys = {
  balance: ['balance'] as const,
  config: ['config'] as const,
  buyerUsage: ['buyer-usage'] as const,
  networkStats: (url: string) => ['network-stats', url] as const,
  emissionsInfo: ['emissions', 'info'] as const,
  emissionsPending: (address: string | null) => ['emissions', 'pending', address] as const,
  emissionsShares: ['emissions', 'shares'] as const,
  transfersEnabled: ['emissions', 'transfers-enabled'] as const,
  diemScan: (address: string | null, limit: number) => ['diem-scan', address, limit] as const,
};

export function useBalance() {
  return useQuery({
    queryKey: queryKeys.balance,
    queryFn: getBalance,
    refetchInterval: 3000,
    refetchIntervalInBackground: false,
    retry: false,
  });
}

export function useConfig() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: getConfig,
    staleTime: Infinity,
  });
}

export function useBuyerUsage() {
  return useQuery({
    queryKey: queryKeys.buyerUsage,
    queryFn: getBuyerUsage,
    staleTime: 30_000,
  });
}

export function useNetworkStats(url: string | null) {
  return useQuery({
    queryKey: queryKeys.networkStats(url ?? ''),
    queryFn: () => getNetworkStats(url as string),
    enabled: !!url,
    staleTime: 30_000,
  });
}

export function useEmissionsInfo() {
  return useQuery({
    queryKey: queryKeys.emissionsInfo,
    queryFn: getEmissionsInfo,
    staleTime: 60_000,
  });
}

export function useEmissionsPending(address: string | null) {
  return useQuery({
    queryKey: queryKeys.emissionsPending(address),
    queryFn: () => getEmissionsPending(address as string),
    enabled: !!address,
    staleTime: 15_000,
  });
}

export function useEmissionsShares() {
  return useQuery({
    queryKey: queryKeys.emissionsShares,
    queryFn: getEmissionsShares,
    staleTime: Infinity,
  });
}

export function useTransfersEnabled() {
  return useQuery({
    queryKey: queryKeys.transfersEnabled,
    queryFn: getTransfersEnabled,
    staleTime: 60_000,
  });
}

export function useDiemScan(
  publicClient: PublicClient | undefined,
  address: string | null,
  limit: number,
) {
  return useQuery({
    queryKey: queryKeys.diemScan(address, limit),
    queryFn: () => scanDiemEpochs(publicClient as PublicClient, address as `0x${string}`, limit),
    enabled: !!publicClient && !!address,
    staleTime: 30_000,
  });
}
