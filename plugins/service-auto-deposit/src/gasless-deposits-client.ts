import {
  createPublicClient, http, fallback, getContract, maxUint256, parseErc6492Signature,
  erc20Abi, isAddressEqual, defineChain, type Address, type Hex, type Chain, type PublicClient,
} from 'viem';
import { base, baseSepolia } from 'viem/chains';
import { privateKeyToAccount } from 'viem/accounts';
import { createBundlerClient, entryPoint08Address } from 'viem/account-abstraction';
import { to7702SimpleSmartAccount } from 'permissionless/accounts';
import { createPimlicoClient } from 'permissionless/clients/pimlico';
import { encodeCirclePaymasterData, delegationTarget } from './codec.js';

function resolveViemChain(evmChainId: number, rpcUrl: string): Chain {
  if (evmChainId === base.id) return base;
  if (evmChainId === baseSepolia.id) return baseSepolia;
  return defineChain({
    id: evmChainId,
    name: `evm-${evmChainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpcUrl] } },
  });
}

/** 1 USDC (6 decimals): default cap the paymaster may pull for gas per op. */
const DEFAULT_MAX_GAS_USDC = 1_000_000n;

const DEPOSITS_ABI = [
  {
    type: 'function', name: 'deposit', stateMutability: 'nonpayable',
    inputs: [{ name: 'buyer', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [],
  },
  {
    type: 'function', name: 'getBuyerBalance', stateMutability: 'view',
    inputs: [{ name: 'buyer', type: 'address' }],
    outputs: [{ name: 'available', type: 'uint256' }, { name: 'reserved', type: 'uint256' }, { name: 'lastActivityAt', type: 'uint256' }],
  },
  {
    type: 'function', name: 'getBuyerCreditLimit', stateMutability: 'view',
    inputs: [{ name: 'buyer', type: 'address' }], outputs: [{ type: 'uint256' }],
  },
] as const;

// EIP-2612 permit needs nonces() + version() on top of the standard ERC-20 set.
const USDC_PERMIT_ABI = [
  ...erc20Abi,
  { type: 'function', name: 'nonces', stateMutability: 'view', inputs: [{ name: 'owner', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'version', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
] as const;

const PERMIT_TYPES = {
  Permit: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
  ],
} as const;

export interface GaslessDepositsConfig {
  evmChainId: number;
  rpcUrl: string;
  /** Additional RPC endpoints tried in order if `rpcUrl` fails (viem fallback transport). */
  fallbackRpcUrls?: string[];
  bundlerUrl: string;
  usdcAddress: Address;
  paymasterAddress: Address;
  depositsAddress: Address;
  delegateAddress: Address;
  /** Defaults to the canonical EntryPoint v0.8 singleton. */
  entryPointAddress?: Address;
  /** Permit cap the paymaster may pull for gas per op. Defaults to 1 USDC. */
  maxGasUsdc?: bigint;
}

export interface GaslessDepositResult {
  userOpHash: Hex;
  txHash: Hex;
  success: boolean;
  delegationApplied: boolean;
}

/**
 * Deposits USDC into AntseedDeposits with **no ETH**: gas is paid in USDC via the
 * Circle Paymaster, and the buyer's plain EOA is upgraded in place with EIP-7702.
 * The first deposit carries the delegation; later deposits are plain sponsored ops.
 *
 * Isolated from the ethers-based clients on purpose: this is the only viem +
 * permissionless surface in the package.
 */
export class GaslessDepositsClient {
  private readonly _owner: ReturnType<typeof privateKeyToAccount>;
  private readonly _chain: Chain;
  private readonly _client: PublicClient;
  private readonly _cfg: GaslessDepositsConfig;
  private readonly _entryPoint: Address;
  private readonly _maxGasUsdc: bigint;
  private _account?: Awaited<ReturnType<typeof to7702SimpleSmartAccount>>;

  constructor(privateKey: Hex, cfg: GaslessDepositsConfig) {
    this._owner = privateKeyToAccount(privateKey);
    this._cfg = cfg;
    this._entryPoint = cfg.entryPointAddress ?? entryPoint08Address;
    this._maxGasUsdc = cfg.maxGasUsdc ?? DEFAULT_MAX_GAS_USDC;
    this._chain = resolveViemChain(cfg.evmChainId, cfg.rpcUrl);
    // Mirror the ethers FallbackProvider the rest of the app uses: a single public
    // RPC rejecting a read (rate limit, transport error) must fail over, not stall
    // the whole funding loop on a backoff against one bad endpoint.
    const rpcUrls = [cfg.rpcUrl, ...(cfg.fallbackRpcUrls ?? [])];
    this._client = createPublicClient({
      chain: this._chain,
      transport: rpcUrls.length > 1 ? fallback(rpcUrls.map((url) => http(url))) : http(cfg.rpcUrl),
    });
  }

  get address(): Address {
    return this._owner.address;
  }

  // Delegated specifically to OUR Simple7702Account; a delegation to any other
  // target means the account runs unknown code, so we must (re)attach the
  // authorization on the next op rather than send a UserOp it can't validate.
  async isDelegated(): Promise<boolean> {
    const code = await this._client.getCode({ address: this._owner.address });
    const target = delegationTarget(code ?? null);
    return target !== null && isAddressEqual(target, this._cfg.delegateAddress);
  }

  async usdcBalance(): Promise<bigint> {
    return this._client.readContract({ address: this._cfg.usdcAddress, abi: erc20Abi, functionName: 'balanceOf', args: [this._owner.address] });
  }

  async buyerBalance(): Promise<{ available: bigint; reserved: bigint }> {
    const [available, reserved] = await this._client.readContract({
      address: this._cfg.depositsAddress, abi: DEPOSITS_ABI, functionName: 'getBuyerBalance', args: [this._owner.address],
    });
    return { available, reserved };
  }

  async creditLimit(): Promise<bigint> {
    return this._client.readContract({ address: this._cfg.depositsAddress, abi: DEPOSITS_ABI, functionName: 'getBuyerCreditLimit', args: [this._owner.address] });
  }

  async deposit(amount: bigint): Promise<GaslessDepositResult> {
    const account = await this._ensureAccount();
    const delegated = await this.isDelegated();

    const [paymasterData, authorization, fees] = await Promise.all([
      this._buildPaymasterData(),
      delegated ? Promise.resolve(undefined) : this._signDelegation(),
      this._estimateFees(),
    ]);

    const bundler = createBundlerClient({ account, client: this._client, chain: this._chain, transport: http(this._cfg.bundlerUrl) });

    const userOpHash = await bundler.sendUserOperation({
      account,
      calls: [
        { to: this._cfg.usdcAddress, abi: erc20Abi, functionName: 'approve', args: [this._cfg.depositsAddress, amount] },
        { to: this._cfg.depositsAddress, abi: DEPOSITS_ABI, functionName: 'deposit', args: [this._owner.address, amount] },
      ],
      paymaster: this._cfg.paymasterAddress,
      paymasterData,
      paymasterPostOpGasLimit: 50_000n,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      ...(authorization ? { authorization } : {}),
    });

    // Bound the wait: if the bundler accepts the op but it never mines, time out
    // (a transient error upstream) rather than leaving the manager stuck in-flight.
    const receipt = await bundler.waitForUserOperationReceipt({ hash: userOpHash, timeout: 120_000 });
    // A UserOp can be mined yet revert (success === false), e.g. the inner deposit
    // hits CreditLimitExceeded. Throw so callers don't record a phantom deposit and
    // retry-spin (the "revert" keyword routes it to the circuit breaker upstream).
    if (!receipt.success) {
      throw new Error(`Deposit UserOp reverted on-chain (tx ${receipt.receipt.transactionHash})`);
    }
    return {
      userOpHash,
      txHash: receipt.receipt.transactionHash,
      success: true,
      delegationApplied: !delegated,
    };
  }

  private async _ensureAccount(): Promise<Awaited<ReturnType<typeof to7702SimpleSmartAccount>>> {
    this._account ??= await to7702SimpleSmartAccount({
      client: this._client,
      owner: this._owner,
      entryPoint: { address: this._entryPoint, version: '0.8' },
      accountLogicAddress: this._cfg.delegateAddress,
    });
    return this._account;
  }

  /** EIP-2612 permit + Circle paymasterData. Permit is signed by the EOA directly
   *  (pre-delegation there is no ERC-1271), deadline = maxUint256. */
  private async _buildPaymasterData(): Promise<Hex> {
    const usdc = getContract({ address: this._cfg.usdcAddress, abi: USDC_PERMIT_ABI, client: this._client });
    const [name, version, nonce] = await Promise.all([
      usdc.read.name(),
      usdc.read.version(),
      usdc.read.nonces([this._owner.address]),
    ]);
    const wrapped = await this._owner.signTypedData({
      primaryType: 'Permit',
      types: PERMIT_TYPES,
      domain: { name, version, chainId: this._cfg.evmChainId, verifyingContract: this._cfg.usdcAddress },
      message: {
        owner: this._owner.address,
        spender: this._cfg.paymasterAddress,
        value: this._maxGasUsdc,
        nonce,
        deadline: maxUint256,
      },
    });
    const { signature } = parseErc6492Signature(wrapped);
    return encodeCirclePaymasterData(this._cfg.usdcAddress, this._maxGasUsdc, signature);
  }

  /** Real 7702 authorization for the first op. viem does not auto-sign it; the
   *  bundler (not the EOA) executes, so the nonce is the plain account nonce. */
  private async _signDelegation() {
    const nonce = await this._client.getTransactionCount({ address: this._owner.address });
    const signed = await this._owner.signAuthorization({
      contractAddress: this._cfg.delegateAddress,
      chainId: this._cfg.evmChainId,
      nonce,
    });
    return {
      address: signed.address ?? this._cfg.delegateAddress,
      chainId: signed.chainId ?? this._cfg.evmChainId,
      nonce: signed.nonce ?? nonce,
      r: signed.r,
      s: signed.s,
      yParity: signed.yParity ?? 0,
    };
  }

  private async _estimateFees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const pimlico = createPimlicoClient({
      chain: this._chain,
      transport: http(this._cfg.bundlerUrl),
      entryPoint: { address: this._entryPoint, version: '0.8' },
    });
    const { fast } = await pimlico.getUserOperationGasPrice();
    return { maxFeePerGas: fast.maxFeePerGas, maxPriorityFeePerGas: fast.maxPriorityFeePerGas };
  }
}
