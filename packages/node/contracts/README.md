# Antseed Escrow Contract

`AntseedEscrow.sol` is the on-chain USDC escrow contract used by Antseed pull-payments.

## Contract Paths

- `packages/node/contracts/AntseedEscrow.sol` - production escrow contract
- `packages/node/contracts/MockUSDC.sol` - test ERC-20 for local flows

## Runtime API

The contract methods used by `EscrowClient` / `BaseEscrowClient` are:

### Buyer

- `deposit(uint256 amount)`
- `requestWithdrawal(uint256 amount)`
- `executeWithdrawal()`
- `cancelWithdrawal()`
- `getBuyerBalance(address buyer)`

### Seller

- `charge(address buyer, uint256 amount, bytes32 sessionId, uint256 maxAmount, uint256 nonce, uint256 deadline, bytes sig)`
- `claimEarnings()`
- `stake(uint256 amount)`
- `unstake(uint256 amount)`
- `getSessionAuth(address buyer, address seller, bytes32 sessionId)`

### Platform / Reputation

- `sweepFees()`
- `rateSeller(address seller, uint8 score)`
- `canRate(address buyer, address seller)`
- `getReputation(address seller)`

### Admin

- `transferOwnership(address)`
- `setFeeCollector(address)`
- `setPlatformFee(uint16)`
- `pause()`
- `unpause()`

## Constructor

```solidity
constructor(address usdcToken, address initialFeeCollector, uint16 initialFeeBps)
```

## Compile

Using Foundry:

```bash
cd packages/node
forge build --root . --contracts contracts --out contracts/out
```

Using `solc`:

```bash
solc --optimize --bin --abi packages/node/contracts/AntseedEscrow.sol -o packages/node/contracts/out
```

## TypeScript Usage

```ts
import { BaseEscrowClient } from '@antseed/node';

const client = new BaseEscrowClient({
  rpcUrl: process.env.RPC_URL!,
  contractAddress: process.env.ESCROW_ADDRESS!,
  usdcAddress: process.env.USDC_ADDRESS!,
  chainId: 8453,
});
```

## Notes

- Buyers authorize spending with EIP-712 `SpendingAuth` signatures; sellers submit `charge()`.
- Withdrawals are timelocked (1 hour) and executed in a second transaction.
- Pending withdrawal is best-effort and can be reduced by later charges before execution.
- Sellers must maintain minimum stake to charge.
