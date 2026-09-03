import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  buildMigrationRegistry,
  buildReleaseOwners,
  deploymentMigrations,
  getDeploymentMigration,
  parseDeployArgs,
} from './deployments/index.mjs';
import {
  applyActiveContracts,
  classifyM001,
  migration,
  shouldRunM001Cutover,
  validateM001Baseline,
  validateM001Options,
} from './deployments/m001.mjs';
import {
  classifyM002,
  migration as m002,
  validateM002Baseline,
  validateM002Options,
} from './deployments/m002.mjs';
import { writeJsonAtomic, writeJsonOnce } from './deployments/runtime/artifacts.mjs';
import { currentRelease, historyRecordExists, readCheckpoint } from './deployments/runtime/ledger.mjs';
import { executePhases } from './deployments/runtime/runner.mjs';
import { withAnvilFork } from './deployments/runtime/anvil.mjs';
import { runForgeScript } from './deployments/runtime/foundry.mjs';
import {
  PAUSE_LEAD_SECONDS,
  cutoverSchedule,
  pauseDecision,
  runCutover,
  verifyPointers,
} from './deployments/m001-cutover.mjs';
import { recordErrors } from './validate-contract-deployments.mjs';
import { parseSignerSpecs, resolveSigners } from './deployments/runtime/signers.mjs';

const ADDRESS = {
  registry: '0x0000000000000000000000000000000000000001',
  ants: '0x0000000000000000000000000000000000000002',
  channels: '0x0000000000000000000000000000000000000003',
  legacyEmissions: '0x0000000000000000000000000000000000000004',
  legacyStaking: '0x0000000000000000000000000000000000000005',
  usageAccounting: '0x0000000000000000000000000000000000000006',
  sellerRegistry: '0x0000000000000000000000000000000000000007',
};

test('broadcasts Foundry transactions sequentially without changing dry runs', () => {
  for (const broadcast of [false, true]) {
    let invocation;
    runForgeScript({ target: 'Install.s.sol:Install', rpcUrl: 'http://localhost:8545', broadcast }, {
      run: (command, args) => { invocation = { command, args }; },
    });
    assert.equal(invocation.command, 'forge');
    assert.equal(invocation.args.includes('--broadcast'), broadcast);
    assert.equal(invocation.args.includes('--slow'), broadcast);
  }
});

function observation(overrides = {}) {
  return {
    expected: {
      registry: ADDRESS.registry,
      antsToken: ADDRESS.ants,
      channels: ADDRESS.channels,
      legacyEmissions: ADDRESS.legacyEmissions,
      legacyStaking: ADDRESS.legacyStaking,
    },
    registry: {
      antsToken: ADDRESS.ants,
      channels: ADDRESS.channels,
      emissions: ADDRESS.legacyEmissions,
      staking: ADDRESS.legacyStaking,
    },
    antsRegistry: ADDRESS.registry,
    legacyEmissionsRegistry: ADDRESS.registry,
    channelsPaused: false,
    currentEpoch: 10,
    deployment: null,
    ...overrides,
  };
}

function deployed(overrides = {}) {
  return {
    valid: true,
    usageAccounting: ADDRESS.usageAccounting,
    sellerRegistry: ADDRESS.sellerRegistry,
    effectiveEpoch: 11,
    ...overrides,
  };
}

test('parses the explicit deployment modes', () => {
  assert.deepEqual(parseDeployArgs(['M001', '--network', 'base-sepolia', '--dry-run']), {
    migration: 'M001',
    network: 'base-sepolia',
    mode: 'dry-run',
    signers: {},
  });
  assert.deepEqual(
    parseDeployArgs(['M001', '--network', 'base-sepolia', '--broadcast', '--signer', 'deployer=account:deployer']).signers,
    { deployer: 'account:deployer' },
  );
  assert.equal(parseDeployArgs(['m001', '--network', 'base-sepolia', '--broadcast']).mode, 'broadcast');
  assert.equal(parseDeployArgs(['--', 'M001', '--network', 'base-sepolia', '--broadcast']).mode, 'broadcast');
  assert.equal(parseDeployArgs(['M001', '--network', 'base-mainnet', '--fork-test']).mode, 'fork-test');
});

test('parses signer specs and resolves them to addresses, never keys', async () => {
  assert.deepEqual(parseSignerSpecs(['a=ledger', 'b=keystore:/k/b']), { a: 'ledger', b: 'keystore:/k/b' });
  assert.throws(() => parseSignerSpecs(['a=ledger', 'a=ledger:1']), /given twice/);
  assert.throws(() => parseSignerSpecs(['nonsense']), /<role>=<spec>/);

  await assert.rejects(resolveSigners({}, ['deployer']), /--signer deployer=<spec>/);
  await assert.rejects(resolveSigners({ x: 'vault:abc' }, ['x']), /Unknown signer spec/);
  await assert.rejects(
    resolveSigners({ a: 'ledger:0', b: 'ledger:1' }, ['a', 'b'], { rpcUrl: 'http://x' }),
    /one --ledger per run/,
  );

  const keystoreDirectory = await mkdtemp(path.join(tmpdir(), 'antseed-keystore-'));
  try {
    const file = path.join(keystoreDirectory, 'owner.json');
    await writeJsonAtomic(file, { address: '0000000000000000000000000000000000000001', crypto: {} });
    const { signers, forgeArgs } = await resolveSigners(
      { registryOwner: `keystore:${file}`, channelsOwner: `keystore:${file}`, staker: `unlocked:${ADDRESS.ants}` },
      ['registryOwner', 'channelsOwner', 'staker'],
      { rpcUrl: 'http://x' },
    );
    assert.equal(signers.registryOwner.address, ADDRESS.registry);
    assert.equal(signers.staker.address, ADDRESS.ants);
    assert.deepEqual(forgeArgs, ['--keystore', file, '--unlocked'], 'one wallet flag per distinct wallet');
    assert.deepEqual(signers.channelsOwner.castArgs, ['--keystore', file]);
    assert.equal(JSON.stringify(signers).includes('crypto'), false, 'keystore contents never leave the resolver');
  } finally {
    await rm(keystoreDirectory, { recursive: true, force: true });
  }
});

test('rejects missing and conflicting modes', () => {
  assert.throws(() => parseDeployArgs(['M001', '--network', 'base-mainnet']), /Choose exactly one/);
  assert.throws(
    () => parseDeployArgs(['M001', '--network', 'base-sepolia', '--dry-run', '--broadcast']),
    /Choose exactly one/,
  );
  assert.throws(
    () => parseDeployArgs(['M009', '--network', 'base-mainnet', '--dry-run']),
    /Unknown deployment migration M009; available: M001, M002/,
  );
});

test('allows Base Sepolia submissions and Base mainnet production or fork runs', () => {
  assert.doesNotThrow(() => validateM001Options({ network: 'base-sepolia', mode: 'dry-run' }));
  assert.doesNotThrow(() => validateM001Options({ network: 'base-sepolia', mode: 'broadcast' }));
  assert.doesNotThrow(() => validateM001Options({ network: 'base-mainnet', mode: 'dry-run' }));
  assert.doesNotThrow(() => validateM001Options({ network: 'base-mainnet', mode: 'broadcast' }));
  assert.doesNotThrow(() => validateM001Options({ network: 'base-mainnet', mode: 'fork-test' }));
  assert.throws(
    () => validateM001Options({ network: 'base-sepolia', mode: 'fork-test' }),
    /Base Sepolia.*Base mainnet.*fork-test/,
  );
});

test('uses the existing scheduler for pre-boundary broadcasts', () => {
  assert.equal(shouldRunM001Cutover('awaiting-epoch', 'broadcast'), true);
  assert.equal(shouldRunM001Cutover('cutover-ready', 'broadcast'), true);
  assert.equal(shouldRunM001Cutover('cutover-incomplete', 'broadcast'), true);
});

test('lets the cutover be reviewed before the epoch boundary', () => {
  // The cutover plan is the reviewed artifact for the most dangerous phase, so
  // a simulation must be able to produce it while the boundary is still ahead.
  assert.equal(shouldRunM001Cutover('awaiting-epoch', 'dry-run'), true);
  assert.equal(shouldRunM001Cutover('ready', 'dry-run'), false);
  assert.equal(shouldRunM001Cutover('active', 'dry-run'), false);
});

test('reports incomplete network baselines before deployment', () => {
  assert.doesNotThrow(() => validateM001Baseline({
    network: 'base-sepolia',
    contracts: {
      registry: { address: ADDRESS.registry },
      antsToken: { address: ADDRESS.ants },
      channels: { address: ADDRESS.channels },
      emissions: { address: ADDRESS.legacyEmissions },
      staking: { address: ADDRESS.legacyStaking },
    },
  }));
  assert.throws(
    () => validateM001Baseline({
      network: 'base-sepolia',
      contracts: {
        channels: { address: ADDRESS.channels },
        emissions: { address: ADDRESS.legacyEmissions },
        staking: { address: ADDRESS.legacyStaking },
      },
    }),
    /base-sepolia deployment baseline is missing: registry, antsToken/,
  );
});

test('registers migrations explicitly', () => {
  assert.equal(getDeploymentMigration('M001').id, 'M001');
  assert.deepEqual([...deploymentMigrations.keys()], ['M001', 'M002']);
  assert.equal(getDeploymentMigration('M002').id, 'M002');
});

test('rejects invalid and duplicate migration registrations', () => {
  const declared = (id) => ({ id, run() {}, phases: [{ id: 'deploy', guard() {}, run() {} }], releases: [`${id}-x`] });
  assert.throws(() => buildMigrationRegistry([declared('001')]), /Invalid deployment migration ID/);
  assert.throws(
    () => buildMigrationRegistry([declared('M001'), declared('M001')]),
    /Duplicate deployment migration/,
  );
});

test('writes mutable artifacts atomically and history records once', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'antseed-deployment-artifacts-'));
  try {
    const currentFile = path.join(directory, 'current.json');
    const historyFile = path.join(directory, 'history', '001-example.json');
    await writeJsonAtomic(currentFile, { release: '000-baseline' });
    await writeJsonAtomic(currentFile, { release: '001-example' });
    assert.deepEqual(JSON.parse(await readFile(currentFile, 'utf8')), { release: '001-example' });

    await writeJsonOnce(historyFile, { release: '001-example' });
    await writeJsonOnce(historyFile, { release: '001-example' });
    await assert.rejects(
      writeJsonOnce(historyFile, { release: '001-rewritten' }),
      /Refusing to overwrite append-only deployment record/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('reconciles history and current.json independently after an interrupted run', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'antseed-deployment-reconcile-'));
  try {
    const context = { outputRoot: directory, network: 'base-sepolia' };
    const release = '001-recognized-usage-activated';

    // Nothing written yet: recovery must run.
    assert.equal(await historyRecordExists(context, release), false);
    assert.equal(await currentRelease(context), null);

    // A crash between the two writes leaves history present but current stale.
    await writeJsonOnce(
      path.join(directory, 'base-sepolia', 'history', `${release}.json`),
      { release },
    );
    await writeJsonAtomic(
      path.join(directory, 'base-sepolia', 'current.json'),
      { release: '001-recognized-usage-deployed' },
    );
    assert.equal(await historyRecordExists(context, release), true);
    assert.notEqual(
      await currentRelease(context),
      release,
      'history alone must not imply current.json advanced',
    );

    // Once the pointer catches up, both checks agree and recovery is a no-op.
    await writeJsonAtomic(path.join(directory, 'base-sepolia', 'current.json'), { release });
    assert.equal(await currentRelease(context), release);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('updates canonical contract aliases when a migration activates', () => {
  const current = {
    contracts: {
      emissions: { address: ADDRESS.legacyEmissions, deployedInRelease: null },
      staking: { address: ADDRESS.legacyStaking, deployedInRelease: null },
    },
  };
  const activeContracts = {
    usageAccounting: { address: ADDRESS.usageAccounting, deployedInRelease: true },
    sellerRegistry: { address: ADDRESS.sellerRegistry, deployedInRelease: true },
  };

  applyActiveContracts(current, activeContracts);

  assert.equal(current.contracts.emissions.address, ADDRESS.usageAccounting);
  assert.equal(current.contracts.staking.address, ADDRESS.sellerRegistry);
  assert.notEqual(current.contracts.emissions, current.contracts.usageAccounting);
  assert.equal(current.contracts.emissions.deployedInRelease, true);
});

test('classifies the complete M001 lifecycle', () => {
  assert.equal(classifyM001(observation()), 'ready');
  assert.equal(classifyM001(observation({ deployment: deployed() })), 'awaiting-epoch');
  assert.equal(classifyM001(observation({ deployment: deployed(), currentEpoch: 11 })), 'cutover-ready');
  assert.equal(classifyM001(observation({
    deployment: deployed(),
    currentEpoch: 11,
    registry: {
      antsToken: ADDRESS.ants,
      channels: ADDRESS.channels,
      emissions: ADDRESS.usageAccounting,
      staking: ADDRESS.legacyStaking,
    },
  })), 'cutover-incomplete');
  assert.equal(classifyM001(observation({
    deployment: deployed(),
    currentEpoch: 11,
    registry: {
      antsToken: ADDRESS.ants,
      channels: ADDRESS.channels,
      emissions: ADDRESS.usageAccounting,
      staking: ADDRESS.sellerRegistry,
    },
  })), 'active');
});

test('rejects unknown pointers and missing deployment checkpoints', () => {
  assert.equal(classifyM001(observation({
    registry: {
      antsToken: ADDRESS.ants,
      channels: ADDRESS.channels,
      emissions: ADDRESS.usageAccounting,
      staking: ADDRESS.legacyStaking,
    },
  })), 'invalid');
  assert.equal(classifyM001(observation({ deployment: deployed({ valid: false }) })), 'invalid');
});

test('treats a paused deployed migration as an incomplete cutover', () => {
  assert.equal(classifyM001(observation({
    deployment: deployed(),
    channelsPaused: true,
    currentEpoch: 11,
  })), 'cutover-incomplete');
});

test('requires migrations to declare phases and releases', () => {
  const base = { id: 'M002', run() {}, phases: [{ id: 'deploy', guard() {}, run() {} }], releases: ['002-x'] };
  assert.doesNotThrow(() => buildMigrationRegistry([base]));
  assert.throws(() => buildMigrationRegistry([{ ...base, phases: [] }]), /at least one phase/);
  assert.throws(
    () => buildMigrationRegistry([{ ...base, phases: [{ id: 'deploy' }] }]),
    /require an id, a guard, and a run function/,
  );
  assert.throws(() => buildMigrationRegistry([{ ...base, releases: [] }]), /must declare the releases it writes/);
});

test('maps every declared release to exactly one owning migration', () => {
  const owners = buildReleaseOwners(deploymentMigrations);
  assert.equal(owners.get('001-recognized-usage-deployed').id, 'M001');
  assert.equal(owners.get('001-recognized-usage-activated').id, 'M001');

  const registry = buildMigrationRegistry([
    { id: 'M002', run() {}, phases: [{ id: 'a', guard() {}, run() {} }], releases: ['shared'] },
    { id: 'M003', run() {}, phases: [{ id: 'a', guard() {}, run() {} }], releases: ['shared'] },
  ]);
  assert.throws(() => buildReleaseOwners(registry), /claimed by M002 and M003/);
});

test('selects the deploy phase before deployment and the cutover phase after it', () => {
  const [deployPhase, cutoverPhase] = migration.phases;
  assert.equal(deployPhase.id, 'deploy');
  assert.equal(cutoverPhase.id, 'cutover');

  assert.equal(deployPhase.guard({ state: 'ready' }, 'broadcast'), true);
  assert.equal(deployPhase.guard({ state: 'cutover-ready' }, 'broadcast'), false);

  assert.equal(cutoverPhase.guard({ state: 'cutover-ready' }, 'dry-run'), true);
  assert.equal(cutoverPhase.guard({ state: 'awaiting-epoch' }, 'broadcast'), true);
  // A simulation selects the cutover before the boundary so its plan is reviewable.
  assert.equal(cutoverPhase.guard({ state: 'awaiting-epoch' }, 'dry-run'), true);
  assert.equal(cutoverPhase.guard({ state: 'active' }, 'broadcast'), false);
});

test('passes phase run results into async plans and preserves transaction order', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'antseed-runner-plan-'));
  const simulationFile = path.join(directory, 'simulation.json');
  await writeJsonAtomic(simulationFile, {
    transactions: [{
      transactionType: 'CALL',
      function: 'performChange()',
      transaction: { to: ADDRESS.registry, from: ADDRESS.ants, value: '0x0', input: '0x1234' },
    }],
  });
  const context = {
    migrationId: 'M999',
    network: 'test-network',
    outputRoot: directory,
    canonical: { chainId: 999 },
    rpcUrl: 'http://127.0.0.1:1',
  };
  let planSawRunResult = false;
  const migrationUnderTest = {
    id: 'M999',
    phases: [{
      id: 'change',
      guard: () => true,
      signers: () => ['actor'],
      async run(_context, _mode, environment, _observation, wallet) {
        assert.equal(environment.ACTOR, ADDRESS.ants, 'the runner passes signer ADDRESSES to the phase');
        assert.deepEqual(wallet.forgeArgs, ['--unlocked']);
        return { simulationFile, marker: 'phase-result' };
      },
      async plan(_context, _observation, runResult) {
        planSawRunResult = runResult.marker === 'phase-result';
        return {
          release: '999-test-release',
          phaseId: 'change',
          simulationFile: runResult.simulationFile,
          beforeTransactions: [{
            action: 'pause example',
            to: ADDRESS.channels,
            function: 'pause()',
            condition: 'when traffic must stop',
          }],
          afterTransactions: [{
            action: 'resume example',
            to: ADDRESS.channels,
            function: 'unpause()',
            condition: 'only after verification',
          }],
        };
      },
    }],
    observe: async () => ({ state: 'ready' }),
    printStatus() {},
    environment: (_context, _observation, signerAddresses) => ({ ACTOR: signerAddresses.actor }),
    verifyRoles() {},
    expectedSigner: () => ADDRESS.ants,
  };

  try {
    await executePhases(migrationUnderTest, { mode: 'dry-run' }, {}, context);
    const plan = JSON.parse(await readFile(
      path.join(directory, 'test-network', 'pending', '999-test-release.plan.json'),
      'utf8',
    ));
    assert.equal(planSawRunResult, true);
    assert.deepEqual(plan.transactions.map((transaction) => transaction.function), [
      'pause()',
      'performChange()',
      'unpause()',
    ]);
    assert.equal(plan.transactions[0].condition, 'when traffic must stop');
    assert.equal(plan.transactions[2].condition, 'only after verification');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('always terminates disposable Anvil forks after success or failure', async () => {
  const children = [];
  const advances = [];
  const dependencies = {
    availablePort: async () => 18545,
    spawn: (_command, args) => {
      const child = { args, killed: false, kill() { this.killed = true; } };
      children.push(child);
      return child;
    },
    waitForAnvil: async () => {},
    advanceTimeTo: (rpcUrl, timestamp) => advances.push({ rpcUrl, timestamp }),
  };

  const result = await withAnvilFork(
    { forkUrl: 'https://rpc.example', chainId: 999, timestamp: 1234 },
    async ({ rpcUrl }) => rpcUrl,
    dependencies,
  );
  assert.equal(result, 'http://127.0.0.1:18545');
  assert.equal(children[0].killed, true);
  assert.equal(children[0].args.includes('--fork-block-number'), false, 'latest block is used when none is pinned');
  assert.deepEqual(advances, [{ rpcUrl: result, timestamp: 1234 }]);

  await assert.rejects(
    withAnvilFork(
      { forkUrl: 'https://rpc.example', forkBlockNumber: 42, chainId: 999 },
      async () => { throw new Error('simulation failed'); },
      dependencies,
    ),
    /simulation failed/,
  );
  assert.equal(children[1].killed, true);
  assert.equal(children[1].args.includes('42'), true);
});

test('rebuilds a missing checkpoint from the committed history record', async () => {
  const outputRoot = await mkdtemp(path.join(tmpdir(), 'antseed-checkpoint-'));
  const context = {
    outputRoot,
    network: 'base-sepolia',
    checkpointFile: path.join(outputRoot, '.deployments', 'm001-base-sepolia.json'),
  };
  const release = '001-recognized-usage-deployed';
  try {
    assert.equal(await readCheckpoint(context, release, () => { throw new Error('unreachable'); }), null);

    await writeJsonOnce(path.join(outputRoot, 'base-sepolia', 'history', `${release}.json`), { release, effectiveEpoch: 7 });
    const rebuilt = await readCheckpoint(context, release, (record) => ({ fromRecord: record.effectiveEpoch }));
    assert.deepEqual(rebuilt, { fromRecord: 7 });
    assert.deepEqual(JSON.parse(await readFile(context.checkpointFile, 'utf8')), rebuilt, 'the rebuilt checkpoint is cached');

    // Once cached, the local checkpoint wins and history is not consulted again.
    await writeJsonAtomic(context.checkpointFile, { fromRecord: 7, cutoverStarted: true });
    const cached = await readCheckpoint(context, release, () => { throw new Error('unreachable'); });
    assert.equal(cached.cutoverStarted, true);
  } finally {
    await rm(outputRoot, { recursive: true, force: true });
  }
});

test('permits only the phase-one record to be dirty during a cutover broadcast', () => {
  assert.deepEqual(migration.allowedDirtyReleases({ state: 'ready' }), []);
  assert.deepEqual(migration.allowedDirtyReleases({ state: 'cutover-ready' }), ['001-recognized-usage-deployed']);
});

test('enforces M001 release invariants', () => {
  const validate = (record) => migration.recordErrors(record).length === 0;
  const verificationConfiguration = {
    verificationMinterController: ADDRESS.registry,
    verificationMinterShareBps: 10_000,
    verificationMinterEditable: true,
    pointsPolicyCount: 0,
    emissionsGateOwner: ADDRESS.ants,
    pointsPolicyRegistryOwner: ADDRESS.channels,
  };

  assert.equal(validate({ verificationConfiguration }), true);
  assert.equal(validate({}), false, 'verificationConfiguration is required');
  assert.equal(
    validate({ verificationConfiguration: { ...verificationConfiguration, verificationMinterShareBps: 5000 } }),
    false,
    'the verification bucket must stay at 10%',
  );
  assert.equal(
    validate({ verificationConfiguration: { ...verificationConfiguration, pointsPolicyCount: 1 } }),
    false,
    'M001 must not activate a points policy',
  );
  assert.equal(
    validate({ verificationConfiguration: { ...verificationConfiguration, verificationMinterEditable: false } }),
    false,
    'the verification minter must remain editable',
  );
});

test('accepts the shared record shape for baselines and executed releases alike', () => {
  const validate = (record) => recordErrors(record).length === 0;
  const baseline = {
    network: 'base-sepolia',
    chainId: 84532,
    release: '000-legacy-baseline',
    status: 'baseline',
    sourceCommit: null,
    transactions: [],
    contracts: { channels: { address: ADDRESS.channels, external: false } },
  };
  assert.equal(validate(baseline), true, 'a reconstructed baseline needs no transactions');
  assert.equal(
    validate({ ...baseline, sourceCommit: 'a'.repeat(40) }),
    false,
    'a record with known provenance must list its transactions',
  );
  assert.equal(
    validate({ ...baseline, status: 'deployed', sourceCommit: 'A'.repeat(40) }),
    false,
    'source commits must be lowercase',
  );
  assert.equal(
    validate({
      ...baseline,
      contracts: { channels: { address: ADDRESS.channels, deployedInRelease: true } },
    }),
    false,
    'a contract deployed in this release needs full provenance',
  );
});

test('never adopts a pause somebody else took', () => {
  assert.equal(pauseDecision({ simulation: true, isPaused: false }), 'skip-simulation');
  assert.equal(pauseDecision({ simulation: false, isPaused: false }), 'pause');
  assert.equal(pauseDecision({ simulation: false, isPaused: true, canAdopt: true }), 'adopt');
  assert.equal(pauseDecision({ simulation: false, isPaused: true, canAdopt: false }), 'foreign');
});

test('rejects a cutover whose registry pointers did not reach the new stack', () => {
  const expected = { expectedEmissions: ADDRESS.usageAccounting, expectedStaking: ADDRESS.sellerRegistry };
  assert.deepEqual(
    verifyPointers({ emissions: ADDRESS.usageAccounting, staking: ADDRESS.sellerRegistry, ...expected }),
    [],
  );
  assert.deepEqual(
    verifyPointers({ emissions: ADDRESS.usageAccounting.toUpperCase().replace('0X', '0x'), staking: ADDRESS.sellerRegistry, ...expected }),
    [],
    'address comparison is case-insensitive',
  );
  assert.equal(
    verifyPointers({ emissions: ADDRESS.legacyEmissions, staking: ADDRESS.sellerRegistry, ...expected }).length,
    1,
  );
  assert.equal(
    verifyPointers({ emissions: ADDRESS.legacyEmissions, staking: ADDRESS.legacyStaking, ...expected }).length,
    2,
  );
});

test('pauses one minute before the epoch boundary', () => {
  const schedule = cutoverSchedule({ genesis: 1_000, epochDuration: 100, effectiveEpoch: 5 });
  assert.equal(schedule.target, 1_500);
  assert.equal(schedule.pauseAt, 1_500 - PAUSE_LEAD_SECONDS);
});

test('leaves channels paused and explains recovery when the flip fails', async () => {
  const reads = {
    'emissionsGate()(address)': ADDRESS.ants,
    'genesis()(uint256)': '0',
    'epochDuration()(uint256)': '100',
    'effectiveEpoch()(uint256)': '1',
    'currentEpoch()(uint256)': '5',
    'channels()(address)': ADDRESS.channels,
    'paused()(bool)': 'false',
    // The flip "runs" but never moves the pointers.
    'emissions()(address)': ADDRESS.legacyEmissions,
    'staking()(address)': ADDRESS.legacyStaking,
  };
  const sent = [];
  const errors = [];
  const originalError = console.error;
  console.error = (message) => errors.push(message);

  try {
    await assert.rejects(
      runCutover(
        {
          rpcUrl: 'http://127.0.0.1:0',
          registry: ADDRESS.registry,
          usageAccounting: ADDRESS.usageAccounting,
          sellerRegistry: ADDRESS.sellerRegistry,
          simulation: false,
          pauseKey: '0xkey',
        },
        {
          log() {},
          now: () => 10_000,
          read: (_address, signature) => reads[signature],
          send: async ({ signature }) => { sent.push(signature); },
          runScript() {},
        },
      ),
      /Cutover verification FAILED/,
    );
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(sent, ['pause()'], 'channels are paused but never unpaused after a failed flip');
  assert.match(errors.join('\n'), /REMAINS PAUSED/);
});

test('unpauses after a verified flip', async () => {
  const reads = {
    'emissionsGate()(address)': ADDRESS.ants,
    'genesis()(uint256)': '0',
    'epochDuration()(uint256)': '100',
    'effectiveEpoch()(uint256)': '1',
    'currentEpoch()(uint256)': '5',
    'channels()(address)': ADDRESS.channels,
    'paused()(bool)': 'false',
    'emissions()(address)': ADDRESS.usageAccounting,
    'staking()(address)': ADDRESS.sellerRegistry,
  };
  const sent = [];
  const result = await runCutover(
    {
      rpcUrl: 'http://127.0.0.1:0',
      registry: ADDRESS.registry,
      usageAccounting: ADDRESS.usageAccounting,
      sellerRegistry: ADDRESS.sellerRegistry,
      simulation: false,
      pauseKey: '0xkey',
    },
    {
      log() {},
      now: () => 10_000,
      read: (_address, signature) => reads[signature],
      send: async ({ signature }) => { sent.push(signature); },
      runScript() {},
    },
  );

  assert.deepEqual(sent, ['pause()', 'unpause()']);
  assert.equal(result.endStateVerified, true);
  assert.equal(result.pauseOwned, false);
});

test('a dry run uses only a disposable fork and neither pauses nor verifies live state', async () => {
  const reads = {
    'emissionsGate()(address)': ADDRESS.ants,
    'genesis()(uint256)': '0',
    'epochDuration()(uint256)': '100',
    'effectiveEpoch()(uint256)': '1',
    'currentEpoch()(uint256)': '5',
    'channels()(address)': ADDRESS.channels,
    'paused()(bool)': 'false',
  };
  const sent = [];
  const forkRequests = [];
  const scriptRpcs = [];
  const result = await runCutover(
    {
      rpcUrl: 'http://127.0.0.1:0',
      registry: ADDRESS.registry,
      usageAccounting: ADDRESS.usageAccounting,
      sellerRegistry: ADDRESS.sellerRegistry,
      chainId: 84532,
      simulation: true,
      pauseOwner: ADDRESS.ants,
    },
    {
      log() {},
      now: () => 10_000,
      read: (_address, signature) => reads[signature],
      send: async ({ signature }) => { sent.push(signature); },
      withFork: async (request, body) => {
        forkRequests.push(request);
        return body({ rpcUrl: 'http://127.0.0.1:9999' });
      },
      runScript({ rpcUrl }) { scriptRpcs.push(rpcUrl); },
    },
  );

  assert.deepEqual(sent, [], 'a simulation never sends a transaction');
  assert.equal(result.endStateVerified, false);
  assert.equal(forkRequests[0].forkUrl, 'http://127.0.0.1:0');
  assert.equal(forkRequests[0].timestamp, undefined);
  assert.deepEqual(scriptRpcs, ['http://127.0.0.1:9999']);
  assert.equal(result.beforeTransactions[0].function, 'pause()');
  assert.equal(result.afterTransactions[0].function, 'unpause()');
});

test('a dry run before the epoch boundary simulates instead of waiting', async () => {
  const reads = {
    'emissionsGate()(address)': ADDRESS.ants,
    'genesis()(uint256)': '0',
    'epochDuration()(uint256)': '100',
    'effectiveEpoch()(uint256)': '10',
    // The boundary is still far ahead: a broadcast would block here.
    'currentEpoch()(uint256)': '1',
    'channels()(address)': ADDRESS.channels,
    'paused()(bool)': 'false',
  };
  const sent = [];
  const waited = [];
  const forkRequests = [];
  const scriptRpcs = [];

  const result = await runCutover(
    {
      rpcUrl: 'http://127.0.0.1:0',
      registry: ADDRESS.registry,
      usageAccounting: ADDRESS.usageAccounting,
      sellerRegistry: ADDRESS.sellerRegistry,
      chainId: 84532,
      simulation: true,
      pauseOwner: ADDRESS.ants,
    },
    {
      log() {},
      now: () => 0,
      read: (_address, signature) => reads[signature],
      send: async ({ signature }) => { sent.push(signature); },
      waitUntil: async (deadline) => { waited.push(deadline); },
      withFork: async (request, body) => {
        forkRequests.push(request);
        return body({ rpcUrl: 'http://127.0.0.1:9998' });
      },
      runScript({ rpcUrl }) { scriptRpcs.push(rpcUrl); },
    },
  );

  assert.deepEqual(waited, [], 'a simulation never waits for the epoch boundary');
  assert.deepEqual(sent, [], 'a simulation never sends a transaction');
  assert.equal(forkRequests[0].timestamp, 1001, 'only the disposable fork advances past the boundary');
  assert.deepEqual(scriptRpcs, ['http://127.0.0.1:9998']);
  assert.equal(result.endStateVerified, false);
});

// ---------------------------------------------------------------------------
// M002 — legacy seller claims
// ---------------------------------------------------------------------------

const M002_ADDRESS = {
  pool: '0x0000000000000000000000000000000000000010',
  policy: '0x0000000000000000000000000000000000000011',
  foreignPolicy: '0x0000000000000000000000000000000000000012',
  zero: '0x0000000000000000000000000000000000000000',
};

function m002Observation(overrides = {}) {
  return {
    expected: {
      registry: ADDRESS.registry,
      antsToken: ADDRESS.ants,
      usageAccounting: ADDRESS.usageAccounting,
      recordedPolicy: null,
    },
    registry: { antsToken: ADDRESS.ants, emissions: ADDRESS.usageAccounting },
    legacyEmissionsV2: ADDRESS.legacyEmissions,
    token: { owner: ADDRESS.ants, transfersEnabled: false, poolWhitelisted: false },
    pool: {
      address: M002_ADDRESS.pool,
      owner: ADDRESS.channels,
      sellerClaimPolicy: M002_ADDRESS.zero,
      policyMatchesRecord: true,
    },
    lastLockedEpochValid: true,
    ...overrides,
  };
}

test('classifies the M002 lifecycle', () => {
  assert.equal(classifyM002(m002Observation()), 'ready');
  // Half-applied installs stay `ready` so the idempotent script finishes them.
  assert.equal(classifyM002(m002Observation({
    token: { transfersEnabled: false, poolWhitelisted: true },
  })), 'ready');
  assert.equal(classifyM002(m002Observation({
    pool: { ...m002Observation().pool, sellerClaimPolicy: M002_ADDRESS.policy },
  })), 'ready');
  assert.equal(classifyM002(m002Observation({
    token: { transfersEnabled: false, poolWhitelisted: true },
    pool: { ...m002Observation().pool, sellerClaimPolicy: M002_ADDRESS.policy },
  })), 'active');
  // Globally enabled transfers make the whitelist unnecessary.
  assert.equal(classifyM002(m002Observation({
    token: { transfersEnabled: true, poolWhitelisted: false },
    pool: { ...m002Observation().pool, sellerClaimPolicy: M002_ADDRESS.policy },
  })), 'active');
});

test('M002 refuses to run before M001 activates or over a foreign policy', () => {
  assert.equal(classifyM002(m002Observation({
    registry: { antsToken: ADDRESS.ants, emissions: ADDRESS.legacyEmissions },
  })), 'invalid', 'registry.emissions() still legacy');
  assert.equal(classifyM002(m002Observation({ pool: null })), 'not-applicable', 'V1-only legacy emissions, no pool');
  assert.equal(classifyM002(m002Observation({ legacyEmissionsV2: null })), 'invalid', 'escrow points at nothing');
  assert.equal(classifyM002(m002Observation({ lastLockedEpochValid: false })), 'invalid', 'effective epoch <= migration');
  assert.equal(classifyM002(m002Observation({
    pool: { ...m002Observation().pool, sellerClaimPolicy: M002_ADDRESS.foreignPolicy, policyMatchesRecord: false },
  })), 'invalid', 'a policy this ledger did not install');
});

test('M002 supports the same networks and modes as M001', () => {
  assert.doesNotThrow(() => validateM002Options({ network: 'base-sepolia', mode: 'dry-run' }));
  assert.doesNotThrow(() => validateM002Options({ network: 'base-mainnet', mode: 'fork-test' }));
  assert.throws(() => validateM002Options({ network: 'base-sepolia', mode: 'fork-test' }), /M002 supports/);
  assert.throws(() => validateM002Options({ network: 'base-local', mode: 'dry-run' }), /M002 supports/);
});

test('M002 requires an activated M001 baseline', () => {
  const contract = (address) => ({ address });
  const activated = {
    network: 'base-mainnet',
    contracts: {
      registry: contract(ADDRESS.registry),
      antsToken: contract(ADDRESS.ants),
      emissions: contract(ADDRESS.usageAccounting),
      usageAccounting: contract(ADDRESS.usageAccounting),
      positionInit: contract(ADDRESS.channels),
      legacyEmissionsEscrow: contract(ADDRESS.sellerRegistry),
    },
  };
  assert.doesNotThrow(() => validateM002Baseline(activated));
  assert.throws(
    () => validateM002Baseline({ ...activated, contracts: { ...activated.contracts, emissions: contract(ADDRESS.legacyEmissions) } }),
    /run M001 first/,
  );
  const { positionInit, ...withoutPositionInit } = activated.contracts;
  assert.throws(() => validateM002Baseline({ ...activated, contracts: withoutPositionInit }), /missing: positionInit/);
});

test('enforces M002 release invariants', () => {
  const validate = (record) => m002.recordErrors(record).length === 0;
  const verificationConfiguration = {
    sellerRewardsPool: M002_ADDRESS.pool,
    sellerClaimPolicy: M002_ADDRESS.policy,
    poolCanTransfer: true,
    lastLockedEpoch: 41,
    releaseBps: 1538,
    vestStart: 0,
    vestEpochs: 0,
    washTradingRegistry: ADDRESS.channels,
    policyOwner: ADDRESS.channels,
  };
  const contracts = { legacySellerClaimPolicy: { address: M002_ADDRESS.policy } };

  assert.equal(validate({ verificationConfiguration, contracts }), true);
  assert.equal(validate({}), false, 'verificationConfiguration is required');
  assert.equal(validate({ verificationConfiguration }), false, 'the deployed policy must be recorded');
  assert.equal(
    validate({ verificationConfiguration: { ...verificationConfiguration, poolCanTransfer: false }, contracts }),
    false,
    'the pool must be able to send ANTS',
  );
  assert.equal(
    validate({ verificationConfiguration: { ...verificationConfiguration, releaseBps: 0 }, contracts }),
    false,
    'a zero release is a frozen pool',
  );
  assert.equal(
    validate({
      verificationConfiguration,
      contracts: { legacySellerClaimPolicy: { address: M002_ADDRESS.foreignPolicy } },
    }),
    false,
    'the recorded contract must be the installed policy',
  );
});

test('M002 has a single idempotent install phase owned by two signers', () => {
  assert.deepEqual(m002.releases, ['002-legacy-seller-claims']);
  assert.deepEqual(m002.phases.map((phase) => phase.id), ['install']);
  assert.deepEqual(m002.phases[0].signers(), ['deployer', 'sellerRewardsPoolOwner']);
  assert.equal(m002.phases[0].guard({ state: 'ready' }), true);
  assert.equal(m002.phases[0].guard({ state: 'active' }), false);
  assert.deepEqual(m002.allowedDirtyReleases({ state: 'ready' }), []);
  assert.deepEqual(buildReleaseOwners().get('002-legacy-seller-claims'), m002);
});
