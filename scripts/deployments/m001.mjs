import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

import { sourceCommit } from './runtime/exec.mjs';
import {
  booleanValue,
  call,
  callJson,
  chainId,
  hasCode,
  normalizeAddress,
  numberValue,
  sameAddress,
} from './runtime/chain.mjs';
import { advanceTimeTo, impersonatedSend, withAnvilFork } from './runtime/anvil.mjs';
import { privateKeyAddress } from './runtime/chain.mjs';
import { requireEnvironment } from './runtime/env.mjs';
import { fileExists } from './runtime/fsx.mjs';
import {
  broadcastIsLive,
  broadcastPath,
  parseBroadcast,
  readReceiptFile,
  receiptFileIsLive,
  runForgeScript,
  simulationPath,
} from './runtime/foundry.mjs';
import {
  assertCheckpointSourceCommit,
  currentRelease,
  historyRecordExists,
  loadContext,
  readCheckpoint,
  writeCheckpoint,
  writeCurrent,
  writeHistoryRecord,
} from './runtime/ledger.mjs';
import { runCutover } from './m001-cutover.mjs';
import { runMigration } from './runtime/runner.mjs';

const VERIFICATION_MINTER_ID = '0xd8018a5ea0ce31650e6d51e87c96f1d258a180b37e42ce66e7adf1c8ac666b57';
const BASE_MAINNET_FORK_BLOCK = 50_571_469;
const BASE_MAINNET_DIEM_PROXY = '0x1f228613116E2d08014DfdCC198377C8dedf18C9';
const ANVIL_KEY_0 = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const ANVIL_KEY_1 = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';
const ANVIL_ACCOUNT_0 = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266';
const ANVIL_ACCOUNT_1 = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8';
const M001_TESTNET = 'base-sepolia';
const M001_ANVIL_FORK = 'base-mainnet';

const DEPLOYED_RELEASE = '001-recognized-usage-deployed';
const ACTIVATED_RELEASE = '001-recognized-usage-activated';

const DEPLOYED_CONTRACT_NAMES = {
  AntseedEmissionsGate: 'emissionsGate',
  AntseedSellerPools: 'sellerPools',
  AntseedSellerRegistry: 'sellerRegistry',
  AntseedPositionInit: 'positionInit',
  AntseedUsageAccounting: 'usageAccounting',
  AntseedPointsPolicyRegistry: 'pointsPolicyRegistry',
  AntseedSellerPoolsRewards: 'sellerPoolsRewards',
  AntseedUsageRewards: 'usageRewards',
  AntseedLegacyEmissionsEscrow: 'legacyEmissionsEscrow',
  AntseedLegacyRewardsPoolRegistry: 'legacyRewardsPoolRegistry',
};

const REQUIRED_DEPLOYED_CONTRACTS = ['usageAccounting', 'sellerRegistry', 'emissionsGate', 'pointsPolicyRegistry'];

// ---------------------------------------------------------------------------
// Pure state logic
// ---------------------------------------------------------------------------

export function classifyM001(observation) {
  const pointers = observation.registry;
  const expected = observation.expected;
  if (!sameAddress(pointers.antsToken, expected.antsToken) || !sameAddress(pointers.channels, expected.channels)) {
    return 'invalid';
  }

  if (!observation.deployment) {
    if (!sameAddress(pointers.emissions, expected.legacyEmissions)
      || !sameAddress(pointers.staking, expected.legacyStaking)) {
      return 'invalid';
    }
    if (!sameAddress(observation.antsRegistry, expected.registry)
      || !sameAddress(observation.legacyEmissionsRegistry, expected.registry)) {
      return 'invalid';
    }
    return 'ready';
  }

  if (!observation.deployment.valid) return 'invalid';
  const emissionsLegacy = sameAddress(pointers.emissions, expected.legacyEmissions);
  const emissionsActive = sameAddress(pointers.emissions, observation.deployment.usageAccounting);
  const stakingLegacy = sameAddress(pointers.staking, expected.legacyStaking);
  const stakingActive = sameAddress(pointers.staking, observation.deployment.sellerRegistry);
  if ((!emissionsLegacy && !emissionsActive) || (!stakingLegacy && !stakingActive)) return 'invalid';

  if (emissionsActive && stakingActive && !observation.channelsPaused) return 'active';
  if (emissionsActive || stakingActive || observation.channelsPaused) return 'cutover-incomplete';
  if (observation.currentEpoch >= observation.deployment.effectiveEpoch) return 'cutover-ready';
  return 'awaiting-epoch';
}

/**
 * The cutover is the most dangerous phase, so its plan must be reviewable before
 * the epoch boundary rather than only once the scheduler is already running.
 * `awaiting-epoch` therefore selects the phase for a simulation too; the runner
 * only sends transactions when the mode is `broadcast`.
 */
export function shouldRunM001Cutover(state) {
  return state === 'cutover-ready'
    || state === 'cutover-incomplete'
    || state === 'awaiting-epoch';
}

export function validateM001Options(options) {
  const testnetRun = options.network === M001_TESTNET && options.mode !== 'fork-test';
  const mainnetRun = options.network === M001_ANVIL_FORK;
  if (testnetRun || mainnetRun) return;
  throw new Error(
    'M001 supports Base Sepolia --dry-run/--broadcast and Base mainnet --dry-run/--broadcast/--fork-test',
  );
}

export function validateM001Baseline(canonical) {
  const required = ['registry', 'antsToken', 'channels', 'emissions', 'staking'];
  const missing = required.filter((name) => !canonical.contracts?.[name]?.address);
  if (missing.length) {
    throw new Error(`M001 ${canonical.network} deployment baseline is missing: ${missing.join(', ')}`);
  }
}

export function applyActiveContracts(current, activeContracts) {
  for (const contract of Object.values(current.contracts)) contract.deployedInRelease = false;
  Object.assign(current.contracts, activeContracts);
  current.contracts.emissions = { ...activeContracts.usageAccounting };
  current.contracts.staking = { ...activeContracts.sellerRegistry };
  return current;
}

/**
 * M001-specific ledger assertions, expressed as a JSON Schema that lives beside
 * the shared one. The generic validator reaches this through the migration
 * registry, so release-specific rules never leak into shared code.
 */
export const recordSchema = JSON.parse(
  readFileSync(new URL('../../packages/contracts/deployments/schema.m001.json', import.meta.url), 'utf8'),
);

// ---------------------------------------------------------------------------
// Observation
// ---------------------------------------------------------------------------

function expectedState(canonical) {
  return {
    registry: canonical.contracts.registry.address,
    antsToken: canonical.contracts.antsToken.address,
    channels: canonical.contracts.channels.address,
    legacyEmissions: canonical.contracts.emissions.address,
    legacyStaking: canonical.contracts.staking.address,
  };
}

function checkpointMatchesChain(context, checkpoint, liveChainId) {
  const { rpcUrl } = context;
  const address = (name) => checkpoint.contracts?.[name]?.address;
  if (checkpoint.chainId !== liveChainId) return false;
  if (!REQUIRED_DEPLOYED_CONTRACTS.every(address)) return false;
  if (!REQUIRED_DEPLOYED_CONTRACTS.every((name) => hasCode(rpcUrl, address(name)))) return false;

  const usageAccounting = address('usageAccounting');
  const emissionsGate = address('emissionsGate');
  const pointsPolicyRegistry = address('pointsPolicyRegistry');
  const expected = checkpoint.verificationConfiguration;
  if (!expected) return false;

  if (!sameAddress(call(rpcUrl, usageAccounting, 'emissionsGate()(address)'), emissionsGate)) return false;
  if (!sameAddress(call(rpcUrl, usageAccounting, 'pointsPolicy()(address)'), pointsPolicyRegistry)) return false;

  const minter = callJson(rpcUrl, emissionsGate, 'minters(bytes32)(address,uint32,bool)', [VERIFICATION_MINTER_ID]);
  if (!sameAddress(minter[0], expected.verificationMinterController)) return false;
  if (Number(minter[1]) !== 10_000) return false;
  if (!booleanValue(minter[2])) return false;
  if (numberValue(call(rpcUrl, pointsPolicyRegistry, 'policyCount()(uint256)')) !== 0) return false;
  if (!sameAddress(call(rpcUrl, emissionsGate, 'owner()(address)'), expected.emissionsGateOwner)) return false;
  if (!sameAddress(call(rpcUrl, pointsPolicyRegistry, 'owner()(address)'), expected.pointsPolicyRegistryOwner)) {
    return false;
  }
  return true;
}

async function observeM001(context) {
  const { rpcUrl, expected } = context;
  const liveChainId = chainId(rpcUrl);
  if (liveChainId !== context.canonical.chainId) {
    throw new Error(`RPC chain ID ${liveChainId} does not match ${context.network} (${context.canonical.chainId})`);
  }
  const observation = {
    chainId: liveChainId,
    expected,
    registry: {
      antsToken: call(rpcUrl, expected.registry, 'antsToken()(address)'),
      channels: call(rpcUrl, expected.registry, 'channels()(address)'),
      emissions: call(rpcUrl, expected.registry, 'emissions()(address)'),
      staking: call(rpcUrl, expected.registry, 'staking()(address)'),
    },
    antsRegistry: call(rpcUrl, expected.antsToken, 'registry()(address)'),
    legacyEmissionsRegistry: call(rpcUrl, expected.legacyEmissions, 'registry()(address)'),
    channelsPaused: call(rpcUrl, expected.channels, 'paused()(bool)') === 'true',
    deployment: null,
    currentEpoch: numberValue(call(rpcUrl, expected.legacyEmissions, 'currentEpoch()(uint256)')),
  };

  const checkpoint = await readCheckpoint(context);
  if (checkpoint) {
    const valid = checkpointMatchesChain(context, checkpoint, liveChainId);
    observation.deployment = {
      valid,
      checkpoint,
      usageAccounting: checkpoint.contracts?.usageAccounting?.address,
      sellerRegistry: checkpoint.contracts?.sellerRegistry?.address,
      effectiveEpoch: checkpoint.effectiveEpoch,
    };
    if (valid) {
      observation.currentEpoch = numberValue(
        call(rpcUrl, checkpoint.contracts.emissionsGate.address, 'currentEpoch()(uint256)'),
      );
    }
  }

  observation.state = classifyM001(observation);
  return observation;
}

function printStatus(observation) {
  console.log(`M001 state: ${observation.state}`);
  console.log(`Registry emissions: ${observation.registry.emissions}`);
  console.log(`Registry staking:   ${observation.registry.staking}`);
  if (observation.deployment) {
    console.log(`Effective epoch:    ${observation.deployment.effectiveEpoch}`);
    console.log(`Current epoch:      ${observation.currentEpoch}`);
    console.log(`Cutover time:       ${new Date(observation.deployment.checkpoint.cutoverTimestamp * 1000).toISOString()}`);
  }
}

// ---------------------------------------------------------------------------
// Environment and role keys
// ---------------------------------------------------------------------------

function migrationEnvironment(context, observation, extra = {}) {
  const checkpoint = observation.deployment?.checkpoint ?? null;
  const environment = {
    ...process.env,
    BASE_MAINNET_RPC_URL: context.rpcUrl,
    BASE_SEPOLIA_RPC_URL: context.rpcUrl,
    ANTSEED_REGISTRY: context.expected.registry,
    EXPECTED_ANTS_TOKEN: context.expected.antsToken,
    EXPECTED_CHANNELS: context.expected.channels,
    EXPECTED_LEGACY_EMISSIONS: context.expected.legacyEmissions,
    EXPECTED_LEGACY_STAKING: context.expected.legacyStaking,
    REGISTRY_OWNER_PRIVATE_KEY: process.env.REGISTRY_OWNER_PRIVATE_KEY ?? process.env.DEPLOYER_PRIVATE_KEY,
    ...(context.network === 'base-mainnet' ? { DIEM_STAKING_PROXY: BASE_MAINNET_DIEM_PROXY } : {}),
    ...extra,
  };
  if (checkpoint) {
    environment.USAGE_ACCOUNTING = checkpoint.contracts.usageAccounting.address;
    environment.SELLER_REGISTRY = checkpoint.contracts.sellerRegistry.address;
  }
  if (!environment.REGISTRY_OWNER_PRIVATE_KEY) environment.REGISTRY_OWNER_PRIVATE_KEY = environment.DEPLOYER_PRIVATE_KEY;
  if (!environment.CHANNELS_OWNER_PRIVATE_KEY) environment.CHANNELS_OWNER_PRIVATE_KEY = environment.DIEM_STAKER_PRIVATE_KEY;
  if (!environment.SELLER_REWARDS_POOL_OWNER_PRIVATE_KEY) {
    environment.SELLER_REWARDS_POOL_OWNER_PRIVATE_KEY = environment.DIEM_STAKER_PRIVATE_KEY;
  }
  return environment;
}

function verifyRoleKeys(context, observation, env) {
  requireEnvironment(['DEPLOYER_PRIVATE_KEY', 'VERIFICATION_WALLET'], env);
  if (!context.forkTest) requireEnvironment(['BASESCAN_API_KEY'], env);
  const deployer = privateKeyAddress(env.DEPLOYER_PRIVATE_KEY);
  if (observation.state === 'ready') {
    if (!sameAddress(call(context.rpcUrl, context.expected.antsToken, 'owner()(address)'), deployer)) {
      throw new Error('DEPLOYER_PRIVATE_KEY is not the ANTSToken owner');
    }
    if (!sameAddress(call(context.rpcUrl, context.expected.legacyEmissions, 'owner()(address)'), deployer)) {
      throw new Error('DEPLOYER_PRIVATE_KEY is not the legacy emissions owner');
    }
    return;
  }
  requireEnvironment(['REGISTRY_OWNER_PRIVATE_KEY', 'CHANNELS_OWNER_PRIVATE_KEY'], env);
  if (!sameAddress(call(context.rpcUrl, context.expected.registry, 'owner()(address)'), privateKeyAddress(env.REGISTRY_OWNER_PRIVATE_KEY))) {
    throw new Error('REGISTRY_OWNER_PRIVATE_KEY is not the Registry owner');
  }
  if (!sameAddress(call(context.rpcUrl, context.expected.channels, 'owner()(address)'), privateKeyAddress(env.CHANNELS_OWNER_PRIVATE_KEY))) {
    throw new Error('CHANNELS_OWNER_PRIVATE_KEY is not the Channels owner');
  }
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

async function verificationConfiguration(context, contracts, fallbackController) {
  const minter = callJson(
    context.rpcUrl,
    contracts.emissionsGate.address,
    'minters(bytes32)(address,uint32,bool)',
    [VERIFICATION_MINTER_ID],
  );
  return {
    verificationMinterController: minter[0] ?? fallbackController,
    verificationMinterShareBps: Number(minter[1] ?? 0),
    verificationMinterEditable: booleanValue(minter[2]),
    pointsPolicyCount: numberValue(call(context.rpcUrl, contracts.pointsPolicyRegistry.address, 'policyCount()(uint256)')),
    emissionsGateOwner: call(context.rpcUrl, contracts.emissionsGate.address, 'owner()(address)'),
    pointsPolicyRegistryOwner: call(context.rpcUrl, contracts.pointsPolicyRegistry.address, 'owner()(address)'),
  };
}

async function recordDeployment(context, environment) {
  const parsed = await parseBroadcast(
    broadcastPath('Deploy.s.sol', context.canonical.chainId),
    context.rpcUrl,
    DEPLOYED_CONTRACT_NAMES,
  );
  const gate = parsed.contracts.emissionsGate;
  if (!gate || !REQUIRED_DEPLOYED_CONTRACTS.every((name) => parsed.contracts[name])) {
    throw new Error('Foundry receipt did not contain all required M001 contracts');
  }
  const effectiveEpoch = numberValue(call(context.rpcUrl, gate.address, 'effectiveEpoch()(uint256)'));
  const genesis = numberValue(call(context.rpcUrl, gate.address, 'genesis()(uint256)'));
  const epochDuration = numberValue(call(context.rpcUrl, gate.address, 'epochDuration()(uint256)'));
  const verification = await verificationConfiguration(context, parsed.contracts, environment.VERIFICATION_WALLET);

  const checkpoint = {
    network: context.network,
    chainId: context.canonical.chainId,
    sourceCommit: sourceCommit(),
    effectiveEpoch,
    cutoverTimestamp: genesis + effectiveEpoch * epochDuration,
    contracts: parsed.contracts,
    deployTransactions: parsed.transactions,
    verificationConfiguration: verification,
    cutoverStarted: false,
  };
  await writeCheckpoint(context, checkpoint);

  await writeHistoryRecord(context, DEPLOYED_RELEASE, {
    $schema: '../../schema.json',
    network: context.network,
    chainId: context.canonical.chainId,
    release: DEPLOYED_RELEASE,
    status: 'deployed',
    sourceCommit: checkpoint.sourceCommit,
    effectiveEpoch,
    transactions: parsed.transactions,
    verificationConfiguration: verification,
    contracts: parsed.contracts,
  });
  return checkpoint;
}

async function captureCutoverBroadcast(context, checkpoint) {
  const broadcastFile = broadcastPath('Cutover.s.sol', context.canonical.chainId);
  if (!(await fileExists(broadcastFile))) return false;
  const parsed = await parseBroadcast(broadcastFile, context.rpcUrl, DEPLOYED_CONTRACT_NAMES);
  if (parsed.transactions.length === 0) return false;
  const merged = new Map(
    [...(checkpoint.cutoverTransactions ?? []), ...parsed.transactions]
      .map((transaction) => [transaction.hash.toLowerCase(), transaction]),
  );
  checkpoint.cutoverTransactions = [...merged.values()];
  checkpoint.cutoverContracts = { ...checkpoint.cutoverContracts, ...parsed.contracts };
  await writeCheckpoint(context, checkpoint);
  return true;
}

/**
 * Writes the activation history record and `current.json`. Each write is guarded
 * by its own check so an interrupted run can be resumed: `writeHistoryRecord` is
 * append-only and idempotent for identical content, and `current.json` is
 * refreshed whenever it has not yet advanced to the activated release.
 */
async function recordActivation(context, checkpoint) {
  await captureCutoverBroadcast(context, checkpoint);
  if (!(checkpoint.cutoverTransactions?.length > 0)) {
    throw new Error('Confirmed Foundry cutover receipts are required to finalize M001 activation records');
  }
  const transactions = [
    ...await readReceiptFile(path.join(context.receiptDirectory, 'pause.json'), 'pause channels'),
    ...checkpoint.cutoverTransactions,
    ...await readReceiptFile(path.join(context.receiptDirectory, 'unpause.json'), 'unpause channels'),
  ];
  const activeContracts = { ...checkpoint.contracts, ...checkpoint.cutoverContracts };
  const registryAfter = {
    emissions: checkpoint.contracts.usageAccounting.address,
    staking: checkpoint.contracts.sellerRegistry.address,
  };
  const verification = await verificationConfiguration(context, activeContracts, process.env.VERIFICATION_WALLET);

  if (!(await historyRecordExists(context, ACTIVATED_RELEASE))) {
    await writeHistoryRecord(context, ACTIVATED_RELEASE, {
      $schema: '../../schema.json',
      network: context.network,
      chainId: context.canonical.chainId,
      release: ACTIVATED_RELEASE,
      status: 'active',
      sourceCommit: checkpoint.sourceCommit,
      effectiveEpoch: checkpoint.effectiveEpoch,
      transactions,
      registryBefore: { emissions: context.expected.legacyEmissions, staking: context.expected.legacyStaking },
      registryAfter,
      verificationConfiguration: verification,
      contracts: checkpoint.cutoverContracts ?? {},
    });
  }

  if (await currentRelease(context) === ACTIVATED_RELEASE) return;

  const current = structuredClone(context.canonical);
  current.release = ACTIVATED_RELEASE;
  current.sourceCommit = checkpoint.sourceCommit;
  current.effectiveEpoch = checkpoint.effectiveEpoch;
  current.transactions = transactions;
  current.registryAfter = registryAfter;
  current.verificationConfiguration = verification;
  applyActiveContracts(current, activeContracts);
  await writeCurrent(context, current);
}

/** Rebuilds the checkpoint when a broadcast landed on chain but the local record was lost. */
async function recoverDeployment(context, observation) {
  if (observation.deployment) return false;
  const broadcastFile = broadcastPath('Deploy.s.sol', context.canonical.chainId);
  if (!(await broadcastIsLive(broadcastFile, context.rpcUrl))) return false;
  const parsed = await parseBroadcast(broadcastFile, context.rpcUrl, DEPLOYED_CONTRACT_NAMES);
  const gate = parsed.contracts.emissionsGate?.address;
  const escrow = parsed.contracts.legacyEmissionsEscrow?.address;
  if (!gate || !escrow) return false;
  if (!sameAddress(call(context.rpcUrl, context.expected.antsToken, 'registry()(address)'), gate)) return false;
  if (!sameAddress(call(context.rpcUrl, context.expected.legacyEmissions, 'registry()(address)'), escrow)) return false;
  await recordDeployment(context, { VERIFICATION_WALLET: process.env.VERIFICATION_WALLET });
  console.log('Recovered the M001 deployment checkpoint from confirmed Foundry receipts.');
  return true;
}

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

const deployPhase = {
  id: 'deploy',
  guard: (observation) => observation.state === 'ready',
  plan: (context) => ({
    release: DEPLOYED_RELEASE,
    phaseId: 'deploy',
    simulationFile: simulationPath('Deploy.s.sol', context.canonical.chainId),
    pointerChanges: {
      'ANTSToken.registry': { before: context.expected.registry, after: 'AntseedEmissionsGate (deployed by this phase)' },
      'legacyEmissions.registry': { before: context.expected.registry, after: 'AntseedLegacyEmissionsEscrow (deployed by this phase)' },
    },
  }),
  async run(context, mode, environment) {
    runForgeScript({
      target: 'script/migrations/M001RecognizedUsage/Deploy.s.sol:M001DeployRecognizedUsage',
      rpcUrl: context.rpcUrl,
      broadcast: mode === 'broadcast',
      verify: !context.forkTest,
      etherscanApiKey: environment.BASESCAN_API_KEY,
      env: environment,
    });
    if (mode !== 'broadcast') return;
    const checkpoint = await recordDeployment(context, environment);
    console.log(`M001 deployment complete. Cutover available at ${new Date(checkpoint.cutoverTimestamp * 1000).toISOString()}.`);
    console.log('Rerun the same command after that time.');
  },
};

const cutoverPhase = {
  id: 'cutover',
  guard: (observation) => shouldRunM001Cutover(observation.state),
  plan: (context, observation, runResult) => ({
    release: ACTIVATED_RELEASE,
    phaseId: 'cutover',
    simulationFile: runResult?.simulationFile
      ?? simulationPath('Cutover.s.sol', context.canonical.chainId),
    beforeTransactions: runResult?.beforeTransactions ?? [],
    afterTransactions: runResult?.afterTransactions ?? [],
    pointerChanges: {
      'registry.emissions': {
        before: observation.registry.emissions,
        after: observation.deployment?.checkpoint?.contracts?.usageAccounting?.address ?? null,
      },
      'registry.staking': {
        before: observation.registry.staking,
        after: observation.deployment?.checkpoint?.contracts?.sellerRegistry?.address ?? null,
      },
    },
  }),
  announce: (observation, mode) => {
    if (observation.state !== 'awaiting-epoch') return null;
    return mode === 'broadcast'
      ? 'The existing cutover scheduler will pause Channels before the epoch boundary and wait to continue.'
      : 'The effective epoch has not started; simulating the cutover now so its plan can be reviewed before the boundary.';
  },
  async preflight(context, observation) {
    if (!observation.channelsPaused || !observation.deployment) return;
    const pauseReceipt = path.join(context.receiptDirectory, 'pause.json');
    if (!(await receiptFileIsLive(pauseReceipt, context.rpcUrl))) {
      throw new Error('Channels is paused without a confirmed M001 pause receipt; refusing to adopt the pause');
    }
  },
  async run(context, mode, environment, observation) {
    const checkpoint = observation.deployment.checkpoint;
    if (mode === 'broadcast') await mkdir(context.receiptDirectory, { recursive: true });
    if (mode === 'broadcast' && !checkpoint.cutoverStarted) {
      checkpoint.cutoverStarted = true;
      checkpoint.cutoverStartedAt = new Date().toISOString();
      await writeCheckpoint(context, checkpoint);
    }
    const canAdoptPause = mode === 'broadcast'
      && await receiptFileIsLive(path.join(context.receiptDirectory, 'pause.json'), context.rpcUrl);
    let result;
    try {
      result = await runCutover({
        rpcUrl: context.rpcUrl,
        chainId: context.canonical.chainId,
        registry: context.expected.registry,
        usageAccounting: checkpoint.contracts.usageAccounting.address,
        sellerRegistry: checkpoint.contracts.sellerRegistry.address,
        receiptDirectory: context.receiptDirectory,
        simulation: mode === 'dry-run',
        canAdoptPause,
        pauseKey: environment.CHANNELS_OWNER_PRIVATE_KEY ?? environment.DIEM_STAKER_PRIVATE_KEY,
        pauseOwner: privateKeyAddress(environment.CHANNELS_OWNER_PRIVATE_KEY ?? environment.DIEM_STAKER_PRIVATE_KEY),
        etherscanApiKey: environment.BASESCAN_API_KEY,
        forkTest: context.forkTest,
        pollSeconds: environment.POLL_SECS ? Number(environment.POLL_SECS) : undefined,
        environment,
      });
    } finally {
      if (mode === 'broadcast') await captureCutoverBroadcast(context, checkpoint);
    }
    if (mode !== 'broadcast') return result;
    await recordActivation(context, checkpoint);
    return result;
  },
};

/**
 * Writes activation records when the flip landed on chain but recording did not
 * finish. History and `current.json` are checked independently: a crash between
 * the two writes leaves history present but the pointer stale, so the presence
 * of history alone must never short-circuit recovery.
 */
async function finalize(context, observation, mode) {
  if (observation.state !== 'active') return false;
  if (mode !== 'broadcast' || !observation.deployment) return false;
  const historyWritten = await historyRecordExists(context, ACTIVATED_RELEASE);
  const currentWritten = await currentRelease(context) === ACTIVATED_RELEASE;
  if (historyWritten && currentWritten) return false;
  assertCheckpointSourceCommit(context, observation.deployment.checkpoint);
  await recordActivation(context, observation.deployment.checkpoint);
  console.log(historyWritten
    ? 'Recovered M001 current.json from confirmed on-chain state; the history record already existed.'
    : 'Recovered M001 activation records from confirmed on-chain state and Foundry receipts.');
  return true;
}

function idleMessage(observation) {
  if (observation.state === 'active') return 'M001 is already active; no transactions required.';
  return 'The effective epoch has not started; no transactions required.';
}

// ---------------------------------------------------------------------------
// Fork test
// ---------------------------------------------------------------------------

function prepareForkOwners(context) {
  const { rpcUrl, expected } = context;
  const rewardsPool = call(rpcUrl, expected.legacyEmissions, 'sellerRewardsPool()(address)');
  for (const [contract, recipient] of [
    [expected.registry, ANVIL_ACCOUNT_0],
    [expected.antsToken, ANVIL_ACCOUNT_0],
    [expected.legacyEmissions, ANVIL_ACCOUNT_0],
    [expected.channels, ANVIL_ACCOUNT_1],
    [rewardsPool, ANVIL_ACCOUNT_1],
  ]) {
    const owner = call(rpcUrl, contract, 'owner()(address)');
    impersonatedSend(rpcUrl, owner, contract, 'transferOwnership(address)', [recipient]);
  }
}

function fundForkCutoverEpoch(context, checkpoint) {
  const proxy = process.env.DIEM_STAKING_PROXY ?? BASE_MAINNET_DIEM_PROXY;
  const targetEpoch = checkpoint.effectiveEpoch - 1;
  const backlog = callJson(context.rpcUrl, proxy, 'syncBacklog()(uint32,uint32,uint32)');
  const remaining = Number(backlog[2] ?? 0);
  if (remaining > 0) {
    impersonatedSend(context.rpcUrl, ANVIL_ACCOUNT_0, proxy, 'syncRewardEpochs(uint32)', [String(remaining)]);
  }
  const reward = callJson(context.rpcUrl, proxy, 'rewardEpochs(uint32)(uint256,uint256,uint256,bool)', [String(targetEpoch)]);
  if (booleanValue(reward[3]) || BigInt(reward[1] ?? 0) === 0n) return;
  const historicalStaker = '0x48F4142F4AbF7b77a03f0cDffcd511eDD9B6d54a';
  impersonatedSend(context.rpcUrl, historicalStaker, proxy, 'claimAnts(uint32[])', [`[${targetEpoch}]`]);
}

async function forkTest(options, { runMigration: drive }) {
  const forkUrl = process.env.BASE_MAINNET_RPC_URL;
  if (!forkUrl) throw new Error('BASE_MAINNET_RPC_URL is required for --fork-test');
  const outputRoot = await mkdtemp(path.join(tmpdir(), 'antseed-m001-deployments-'));

  await withAnvilFork({ forkUrl, forkBlockNumber: BASE_MAINNET_FORK_BLOCK, chainId: 8453 }, async ({ rpcUrl }) => {
    const context = await loadContext(migration, options.network, { rpcUrl, outputRoot, forkTest: true });
    prepareForkOwners(context);
    const environment = {
      DEPLOYER_PRIVATE_KEY: ANVIL_KEY_0,
      REGISTRY_OWNER_PRIVATE_KEY: ANVIL_KEY_0,
      CHANNELS_OWNER_PRIVATE_KEY: ANVIL_KEY_1,
      DIEM_STAKER_PRIVATE_KEY: ANVIL_KEY_1,
      SELLER_REWARDS_POOL_OWNER_PRIVATE_KEY: ANVIL_KEY_1,
      VERIFICATION_WALLET: ANVIL_ACCOUNT_1,
      DIEM_STAKING_PROXY: BASE_MAINNET_DIEM_PROXY,
      ANTSEED_DEPLOY_CONFIRM: options.network,
    };
    const overrides = { rpcUrl, outputRoot, forkTest: true, environment };
    const broadcast = { ...options, mode: 'broadcast' };

    let observation = await drive(migration, broadcast, overrides);
    if (observation.state !== 'awaiting-epoch') throw new Error(`Expected awaiting-epoch, got ${observation.state}`);

    const checkpoint = observation.deployment.checkpoint;
    advanceTimeTo(rpcUrl, checkpoint.cutoverTimestamp + 1);
    fundForkCutoverEpoch(context, checkpoint);

    observation = await drive(migration, broadcast, overrides);
    if (observation.state !== 'active') throw new Error(`Expected active, got ${observation.state}`);

    observation = await drive(migration, broadcast, overrides);
    if (observation.state !== 'active') throw new Error('Repeated broadcast was not an active no-op');

    console.log(`M001 fork test passed. Temporary records: ${outputRoot}`);
  });
}

// ---------------------------------------------------------------------------
// Migration declaration
// ---------------------------------------------------------------------------

export const migration = {
  id: 'M001',
  networks: [M001_TESTNET, M001_ANVIL_FORK],
  releases: [DEPLOYED_RELEASE, ACTIVATED_RELEASE],
  phases: [deployPhase, cutoverPhase],
  validateOptions: validateM001Options,
  validateBaseline: validateM001Baseline,
  expectedState,
  observe: observeM001,
  printStatus,
  environment: migrationEnvironment,
  verifyRoleKeys,
  recover: recoverDeployment,
  finalize,
  idleMessage,
  recordSchema,
  allowedDirtyReleases: (observation) => (observation.state === 'ready' ? [] : [DEPLOYED_RELEASE]),
  forkTest,
  run: (options, overrides) => runMigration(migration, options, overrides),
};
