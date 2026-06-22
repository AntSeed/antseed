/** Config for gasless USDC auto-deposit (Circle Paymaster + EIP-7702). */
export interface AutoDepositChainConfig {
  bundlerUrl: string;
  paymasterAddress: string;
  entryPointAddress: string;
  delegateAddress: string;
}

// EntryPoint v0.8 + Simple7702Account v0.8: canonical singletons, same on every chain.
const ENTRY_POINT_V08 = '0x4337084D9E255Ff0702461CF8895CE9E3b5Ff108';
const SIMPLE_7702_ACCOUNT_V08 = '0xe6Cae83BdE06E4c305530e199D7217f42808555B';

/**
 * Per-chain gasless config, keyed by AntSeed chainId. A chain absent here is not
 * gasless-capable, so auto-deposit stays off for it.
 *
 * base-sepolia is intentionally omitted: its USDC is an AntSeed mock, but Circle's
 * paymaster only charges in Circle USDC, so the gasless path would deterministically
 * fail. Re-add once Deposits is wired to Circle Sepolia USDC.
 */
export const AUTO_DEPOSIT_CHAINS: Record<string, AutoDepositChainConfig> = {
  'base-mainnet': {
    bundlerUrl: 'https://public.pimlico.io/v2/8453/rpc',
    paymasterAddress: '0x0578cFB241215b77442a541325d6A4E6dFE700Ec',
    entryPointAddress: ENTRY_POINT_V08,
    delegateAddress: SIMPLE_7702_ACCOUNT_V08,
  },
};
