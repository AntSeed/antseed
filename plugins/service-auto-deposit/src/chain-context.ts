/** The slice of chain config the funding service needs. Structurally satisfied
 * by @antseed/node's ChainConfig, so the host's granted "chain" capability can
 * be passed straight through. */
export interface FundingChainContext {
  chainId: string;
  evmChainId: number;
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  usdcContractAddress: string;
  depositsContractAddress: string;
}
