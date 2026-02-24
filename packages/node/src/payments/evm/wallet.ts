import { JsonRpcProvider, Contract, formatEther, formatUnits } from 'ethers';
import type { Identity } from '../../p2p/identity.js';
import type { WalletInfo, ChainId } from '../types.js';
import { identityToEvmWallet, identityToEvmAddress } from './keypair.js';

const ERC20_BALANCE_ABI = [
  'function balanceOf(address owner) external view returns (uint256)',
] as const;

export async function getWalletInfo(
  identity: Identity,
  rpcUrl: string,
  usdcAddress: string,
  chainId: ChainId,
): Promise<WalletInfo> {
  const wallet = identityToEvmWallet(identity);
  const provider = new JsonRpcProvider(rpcUrl);
  const address = wallet.address;

  const ethBalance = await provider.getBalance(address);
  const balanceETH = formatEther(ethBalance);

  const usdc = new Contract(usdcAddress, ERC20_BALANCE_ABI, provider);
  let balanceUSDC = '0';
  try {
    const usdcRaw: bigint = await usdc.getFunction('balanceOf')(address);
    balanceUSDC = formatUnits(usdcRaw, 6);
  } catch {
    // Contract may not exist on local dev chain yet
  }

  return {
    address,
    chainId,
    balanceETH,
    balanceUSDC,
  };
}

export function getAddress(identity: Identity): string {
  return identityToEvmAddress(identity);
}
