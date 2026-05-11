import { parseAbi } from 'viem';

export const DEPOSITS_ABI = parseAbi([
  'function deposit(address buyer, uint256 amount) external',
  'function withdraw(address buyer, uint256 amount) external',
  'function setOperator(address buyer, address operator, uint256 nonce, bytes buyerSig) external',
  'function transferOperator(address buyer, address newOperator) external',
]);
