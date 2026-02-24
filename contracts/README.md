# Antseed Escrow Contract

`AntseedEscrow.sol` is the on-chain escrow contract used by the payment channel flow.

## Contract Paths

- `node/contracts/AntseedEscrow.sol` - production escrow contract
- `node/contracts/MockUSDC.sol` - test-only ERC20 used for local integration flows

## ABI Compatibility

The contract exposes the runtime methods expected by `EscrowClient`:

- `deposit(bytes32 sessionId, address seller, uint256 amount)`
- `release(bytes32 sessionId)`
- `settle(bytes32 sessionId, uint256 sellerAmount, uint256 platformAmount)`
- `dispute(bytes32 sessionId)`
- `refund(bytes32 sessionId)`
- `resolveDisputeTimeout(bytes32 sessionId)`
- `getChannel(bytes32 sessionId) returns (address buyer, address seller, uint256 amount, uint8 state)`

Owner/admin methods:

- `setArbiter(address)`
- `setFeeCollector(address)`
- `setDisputeTimeout(uint64 seconds)`

Deployment uses the constructor signature:

- `constructor(address usdcToken, address initialArbiter)`

Channel states are encoded as:

- `0 = open`
- `1 = active`
- `2 = disputed`
- `3 = settled`
- `4 = closed`

## Compile

Example using Foundry (`forge`):

```bash
cd node
forge build --root . --contracts contracts --out contracts/out
```

Example using `solc`:

```bash
solc --optimize --bin --abi node/contracts/AntseedEscrow.sol -o node/contracts/out
```

## Deploy (TypeScript Helper)

Use `deployEscrowContract` from `node/src/payments/crypto/deploy.ts` with compiled bytecode:

```ts
import { deployEscrowContract } from '@antseed/node/payments';

const result = await deployEscrowContract({
  rpcUrl: process.env.RPC_URL!,
  privateKey: process.env.DEPLOYER_PRIVATE_KEY!,
  usdcAddress: process.env.USDC_ADDRESS!,
  bytecode: process.env.ESCROW_BYTECODE!, // from compiler output
  arbiterAddress: process.env.ARBITER_ADDRESS,
  confirmations: 1,
});

console.log(result.contractAddress, result.deployTxHash);
```

## End-to-End Integration Test

A full on-chain test lives in:

- `node/tests/escrow-contract.integration.test.ts`

It compiles `AntseedEscrow.sol` + `MockUSDC.sol`, starts a local Anvil chain, deploys the contract via `deployEscrowContract`, and exercises:

- `deposit -> release`
- `deposit -> dispute -> arbiter refund`
- `deposit -> settle(seller/platform/refund split)`
- `deposit -> dispute -> resolveDisputeTimeout`

Run only this suite:

```bash
cd node
npm test -- escrow-contract.integration.test.ts
```

The test auto-skips when `anvil` or `forge` is unavailable.

## Operational Notes

- `deposit` sets `buyer = msg.sender`; it expects an approved USDC `transferFrom`.
- `release` while active can be called by buyer/seller/arbiter.
- `release` while disputed requires arbiter.
- `settle` while active can be called by buyer/seller/arbiter.
- `settle` while disputed requires arbiter and supports explicit seller/platform payouts with automatic buyer refund remainder.
- `refund` while active can be called by buyer/arbiter.
- `refund` while disputed requires arbiter.
- `resolveDisputeTimeout` allows anyone to refund a stale disputed channel after `disputeTimeout`.
