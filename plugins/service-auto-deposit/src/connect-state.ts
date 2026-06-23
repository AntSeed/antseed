import { createPublicClient, http, getAddress } from 'viem';
import { delegationTarget } from './codec.js';
import { AUTO_DEPOSIT_CHAINS } from './chains.js';

/** Auto-deposit status shared over AntSeed Connect. Structurally matches
 * connect-core's AutoDepositState, kept local to avoid a dependency edge. */
export interface AutoDepositConnectState {
  enabled: boolean;
  delegated: boolean;
}

export interface AutoDepositConnectStateInput {
  /** AntSeed chain id (e.g. 'base-mainnet'). Keys into {@link AUTO_DEPOSIT_CHAINS}. */
  chainId: string;
  rpcUrl: string;
  address: string;
  /** Whether the user enabled auto-deposit in the seed app — the caller reads
   * this from config; only the seed app knows it. */
  enabled: boolean;
}

/**
 * Read the auto-deposit state to advertise over Connect. `delegated` is read
 * on-chain the same way {@link AUTO_DEPOSIT_CHAINS}-backed deposits check it
 * (eth_getCode → EIP-7702 designator → our delegate). Best-effort: an
 * unsupported chain, a missing RPC, or any read failure yields `delegated: false`
 * while preserving the caller's `enabled` value.
 */
export async function readAutoDepositConnectState(
  input: AutoDepositConnectStateInput,
): Promise<AutoDepositConnectState> {
  const chain = AUTO_DEPOSIT_CHAINS[input.chainId];
  if (!chain || !input.rpcUrl) return { enabled: input.enabled, delegated: false };

  try {
    const client = createPublicClient({ transport: http(input.rpcUrl) });
    const code = await client.getCode({ address: getAddress(input.address) });
    const target = delegationTarget(code ?? null);
    const delegated = target !== null && target.toLowerCase() === chain.delegateAddress.toLowerCase();
    return { enabled: input.enabled, delegated };
  } catch {
    return { enabled: input.enabled, delegated: false };
  }
}
