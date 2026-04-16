export interface BalanceData {
  evmAddress: string;
  available: string;
  reserved: string;
  total: string;
  creditLimit: string;
}

export interface PaymentConfig {
  chainId: string;
  evmChainId: number;
  rpcUrl: string;
  depositsContractAddress: string;
  channelsContractAddress: string;
  usdcContractAddress: string;
  emissionsContractAddress: string | null;
  networkStatsUrl: string | null;            // added by PRD-06
  evmAddress: string | null;
}
