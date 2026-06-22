export { GaslessDepositsClient, type GaslessDepositsConfig, type GaslessDepositResult } from './gasless-deposits-client.js';
export { isDelegationCode, delegationTarget, encodeCirclePaymasterData } from './codec.js';
export { AutoDepositManager, planDeposit, isDeterministicError } from './manager.js';
export type {
  AutoDepositState, AutoDepositStatus, AutoDepositReader, AutoDepositExecutor,
  AutoDepositManagerConfig, AutoDepositConsentView, DepositPlan,
} from './manager.js';
export {
  createAutoDepositManager,
  createAutoDepositService,
  gaslessConfigFromChain,
  toServiceStatus,
} from './factory.js';
export { AUTO_DEPOSIT_CHAINS, type AutoDepositChainConfig } from './chains.js';
export type { FundingChainContext } from './chain-context.js';
export { autoDepositPlugin, default } from './plugin.js';
