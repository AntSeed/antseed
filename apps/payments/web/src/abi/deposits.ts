export const DEPOSITS_ABI = [
  'function deposit(address buyer, uint256 amount) external',
  'function withdraw(address buyer, uint256 amount) external',
  'function setOperator(address buyer, address operator, uint256 nonce, bytes buyerSig) external',
  'function transferOperator(address buyer, address newOperator) external',
] as const;
