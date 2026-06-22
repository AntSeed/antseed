import { getAddress, type Hex } from 'viem';
import { GaslessDepositsClient, type GaslessDepositsConfig } from './gasless-deposits-client.js';
import { AUTO_DEPOSIT_CHAINS } from './chains.js';
import { requireChain, requireWallet, type Service, type ServiceHost, type ServiceStatus } from '@antseed/service-core';
import type { FundingChainContext } from './chain-context.js';
import {
  AutoDepositManager,
  type AutoDepositConsentView,
  type AutoDepositManagerConfig,
  type AutoDepositReader,
  type AutoDepositExecutor,
  type AutoDepositStatus,
} from './manager.js';

export function gaslessConfigFromChain(chain: FundingChainContext): GaslessDepositsConfig | null {
  const aa = AUTO_DEPOSIT_CHAINS[chain.chainId];
  if (!aa) return null;
  return {
    evmChainId: chain.evmChainId,
    rpcUrl: chain.rpcUrl,
    fallbackRpcUrls: chain.fallbackRpcUrls,
    bundlerUrl: aa.bundlerUrl,
    usdcAddress: getAddress(chain.usdcContractAddress),
    paymasterAddress: getAddress(aa.paymasterAddress),
    depositsAddress: getAddress(chain.depositsContractAddress),
    delegateAddress: getAddress(aa.delegateAddress),
    entryPointAddress: getAddress(aa.entryPointAddress),
  };
}

/**
 * Build an {@link AutoDepositManager} wired to a gasless executor for the given
 * chain, or null when the chain is not gasless-capable. A single
 * {@link GaslessDepositsClient} serves as both the balance reader and the
 * deposit executor.
 */
export function createAutoDepositManager(opts: {
  chain: FundingChainContext;
  privateKey: Hex;
  consent: AutoDepositConsentView;
  config?: AutoDepositManagerConfig;
  onAttention?: (message: string) => void;
}): AutoDepositManager | null {
  const gaslessConfig = gaslessConfigFromChain(opts.chain);
  if (!gaslessConfig) return null;

  const client = new GaslessDepositsClient(opts.privateKey, gaslessConfig);
  const reader: AutoDepositReader = {
    looseUsdc: () => client.usdcBalance(),
    totalDeposited: async () => {
      const { available, reserved } = await client.buyerBalance();
      return available + reserved;
    },
    creditLimit: () => client.creditLimit(),
    isDelegated: () => client.isDelegated(),
  };
  const executor: AutoDepositExecutor = {
    deposit: async (amount) => {
      const { txHash } = await client.deposit(amount);
      return { txHash };
    },
  };
  return new AutoDepositManager({ reader, executor, consent: opts.consent, config: opts.config, onAttention: opts.onAttention });
}

function formatUsdc(baseUnits: string): string {
  return (Number(baseUnits) / 1_000_000).toFixed(2);
}

function summarize(status: AutoDepositStatus): string {
  switch (status.state) {
    case 'disabled': return 'Off';
    case 'needs_attention': return `Needs attention: ${status.lastError ?? 'see logs'}`;
    case 'backoff': return 'Retrying…';
    case 'pending': return 'Depositing…';
    case 'stranded': return `${formatUsdc(status.strandedBaseUnits)} USDC waiting (credit limit reached; deposits resume as it grows)`;
    case 'idle': return status.delegated ? '' : 'Your wallet upgrades on the first deposit';
    default: return '';
  }
}

const USDC_DECIMALS = 1_000_000;

export function toServiceStatus(status: AutoDepositStatus, receiveAddress: string): ServiceStatus {
  return {
    enabled: status.enabled,
    attention: status.state === 'needs_attention',
    summary: summarize(status),
    receiveAddress,
    receiveLimitUsdc: depositHeadroomUsdc(status),
  };
}

/** Live on-chain credit-limit headroom (creditLimit - deposited) in USDC, or
 * null before the first successful read (creditLimit still 0). Beyond this the
 * deposit reverts and the excess stays loose in the wallet. */
function depositHeadroomUsdc(status: AutoDepositStatus): number | null {
  const creditLimit = BigInt(status.creditLimitBaseUnits);
  if (creditLimit <= 0n) return null;
  const deposited = BigInt(status.depositedBaseUnits);
  const headroom = creditLimit > deposited ? creditLimit - deposited : 0n;
  return Number(headroom) / USDC_DECIMALS;
}

/** Build the auto-deposit {@link Service}, or null when the chain is not
 * gasless-capable. Reads the wallet + chain capabilities the plugin declared,
 * wraps the manager, and maps its rich status to the generic
 * {@link ServiceStatus} the desktop renders. */
export function createAutoDepositService(host: ServiceHost): Service | null {
  const wallet = requireWallet(host);
  const chain = requireChain(host);
  const manager = createAutoDepositManager({
    chain,
    privateKey: wallet.privateKey,
    consent: host.consent,
    onAttention: host.onAttention,
  });
  if (!manager) return null;
  const receiveAddress = wallet.address;
  return {
    start: () => manager.start(),
    stop: () => manager.stop(),
    poke: () => manager.runOnce(),
    getStatus: () => toServiceStatus(manager.getStatus(), receiveAddress),
  };
}
