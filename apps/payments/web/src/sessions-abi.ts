export const SESSIONS_ABI = [
  'function requestClose(bytes32 channelId) external',
  'function withdraw(bytes32 channelId) external',
  'function setOperator(address buyer, address operator, uint256 nonce, bytes buyerSig) external',
  'function transferOperator(address buyer, address newOperator) external',
  'function sessions(bytes32 channelId) external view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)',
  'function operators(address buyer) external view returns (address)',
  'function operatorNonces(address buyer) external view returns (uint256)',
  'event Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 maxAmount)',
  'event SessionClosed(bytes32 indexed channelId, address indexed seller, uint128 finalAmount, uint256 platformFee)',
  'event SessionWithdrawn(bytes32 indexed channelId, address indexed buyer)',
  'event CloseRequested(bytes32 indexed channelId, address indexed buyer)',
] as const;
