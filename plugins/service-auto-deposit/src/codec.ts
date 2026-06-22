import { encodePacked, getAddress, type Address, type Hex } from 'viem';

/** EIP-7702 delegation designator seen in `eth_getCode`: `0xef0100 || <impl>`. */
const DELEGATION_PREFIX = '0xef0100';

export function isDelegationCode(code: Hex | null | undefined): boolean {
  return typeof code === 'string' && code.toLowerCase().startsWith(DELEGATION_PREFIX);
}

export function delegationTarget(code: Hex | null | undefined): Address | null {
  if (!isDelegationCode(code)) return null;
  const body = (code as string).slice(DELEGATION_PREFIX.length);
  if (body.length < 40) return null;
  return getAddress(`0x${body.slice(0, 40)}`);
}

/**
 * Circle Paymaster v0.8 `paymasterData`: packed `[uint8 mode=0, token, maxGasUSDC,
 * permitSig]`. The mode byte is 0; the EIP-2612 permit lets the paymaster pull up
 * to `maxGasUsdc` of `usdc` for gas.
 */
export function encodeCirclePaymasterData(usdc: Address, maxGasUsdc: bigint, permitSignature: Hex): Hex {
  return encodePacked(['uint8', 'address', 'uint256', 'bytes'], [0, usdc, maxGasUsdc, permitSignature]);
}
