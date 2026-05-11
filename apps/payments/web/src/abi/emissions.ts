export const EMISSIONS_CLAIM_ABI = [
  'function claimSellerEmissions(uint256[] epochs) external',
  'function claimBuyerEmissions(address buyer, uint256[] epochs) external',
] as const;
