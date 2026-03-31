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
  evmAddress: string | null;
}
