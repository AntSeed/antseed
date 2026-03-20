export interface BalanceData {
  evmAddress: string;
  available: string;
  reserved: string;
  total: string;
  pendingWithdrawal: string;
  creditLimit: string;
}

export interface PaymentConfig {
  chainId: string;
  rpcUrl: string;
  escrowContractAddress: string;
  usdcContractAddress: string;
  crossmintConfigured: boolean;
}
