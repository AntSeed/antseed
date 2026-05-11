import { parseAbi } from 'viem';

export const EMISSIONS_CLAIM_ABI = parseAbi([
  'function claimSellerEmissions(uint256[] epochs) external',
  'function claimBuyerEmissions(address buyer, uint256[] epochs) external',
]);
