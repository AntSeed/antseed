export const CHANNELS_ABI = [
  'function requestClose(bytes32 channelId) external',
  'function withdraw(bytes32 channelId) external',
  'function channels(bytes32 channelId) external view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)',
  'event Reserved(bytes32 indexed channelId, address indexed buyer, address indexed seller, uint128 maxAmount)',
  'event ChannelClosed(bytes32 indexed channelId, address indexed seller, uint128 finalAmount, uint256 platformFee)',
  'event ChannelWithdrawn(bytes32 indexed channelId, address indexed buyer)',
  'event CloseRequested(bytes32 indexed channelId, address indexed buyer)',
] as const;

export const DEPOSITS_OPERATOR_ABI = [
  'function setOperator(address buyer, address operator, uint256 nonce, bytes buyerSig) external',
  'function transferOperator(address buyer, address newOperator) external',
  'function getOperator(address buyer) external view returns (address)',
  'function getOperatorNonce(address buyer) external view returns (uint256)',
] as const;
