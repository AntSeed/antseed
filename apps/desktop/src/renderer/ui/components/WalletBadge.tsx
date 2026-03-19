import {
  ConnectWallet,
  Wallet,
  WalletDropdown,
  WalletDropdownDisconnect,
  WalletDropdownFundLink,
} from '@coinbase/onchainkit/wallet';
import {
  Address,
  Avatar,
  Name,
  Identity,
} from '@coinbase/onchainkit/identity';
import { useAccount, useBalance, useReadContract } from 'wagmi';
import { base } from 'viem/chains';
import styles from './WalletBadge.module.scss';

// USDC contract address on Base mainnet
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

// AntseedEscrow ABI fragment for getBuyerBalance
const ESCROW_ABI = [
  {
    name: 'getBuyerBalance',
    type: 'function',
    stateMutability: 'view',
    inputs: [{ name: 'buyer', type: 'address' }],
    outputs: [
      { name: 'available', type: 'uint256' },
      { name: 'reserved', type: 'uint256' },
      { name: 'pendingWithdrawal', type: 'uint256' },
      { name: 'lastActivity', type: 'uint256' },
    ],
  },
] as const;

// TODO: read from config or environment variable
const ESCROW_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`;

export function WalletBadge() {
  const { address, isConnected } = useAccount();

  // Fetch USDC balance from wallet
  const { data: usdcBalance } = useBalance({
    address,
    token: USDC_ADDRESS,
    chainId: base.id,
    query: { enabled: isConnected, refetchInterval: 30_000 },
  });

  // Fetch escrow balance from AntseedEscrow contract
  const { data: escrowData } = useReadContract({
    address: ESCROW_ADDRESS,
    abi: ESCROW_ABI,
    functionName: 'getBuyerBalance',
    args: address ? [address] : undefined,
    chainId: base.id,
    query: { enabled: isConnected && !!address, refetchInterval: 30_000 },
  });

  const escrowBalance = escrowData ? escrowData[0] + escrowData[1] : 0n;

  const totalUsdc = (usdcBalance?.value ?? 0n) + escrowBalance;
  const formatted = formatUsdc(totalUsdc);

  return (
    <div className={styles.walletBadge}>
      <Wallet>
        <ConnectWallet
          className={styles.connectButton}
          text={isConnected ? `${formatted} USDC` : 'Connect'}
        >
          {isConnected && (
            <span className={styles.balanceText}>{formatted} USDC</span>
          )}
        </ConnectWallet>
        <WalletDropdown>
          <Identity className={styles.identity} hasCopyAddressOnClick>
            <Avatar />
            <Name />
            <Address />
          </Identity>
          <WalletDropdownFundLink />
          <WalletDropdownDisconnect />
        </WalletDropdown>
      </Wallet>
    </div>
  );
}

function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const frac = baseUnits % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0').slice(0, 2);
  return `${whole}.${fracStr}`;
}
