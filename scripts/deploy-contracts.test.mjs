import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { parseBroadcast, runForgeScript } from './deployments/runtime/foundry.mjs';

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
  DEFAULT_RELEASE_BPS,
  migration as m002,
  validateM002Baseline,
  validateM002Options,
} from './deployments/m002.mjs';
import { writeJsonAtomic, writeJsonOnce } from './deployments/runtime/artifacts.mjs';
import { currentRelease, historyRecordExists, loadContext, readCheckpoint, validateArtifacts } from './deployments/runtime/ledger.mjs';
import { executePhases, runMigration } from './deployments/runtime/runner.mjs';
import { withAnvilFork } from './deployments/runtime/anvil.mjs';
import { resolveRehearsal, runRehearsal } from './deployments/runtime/rehearsal.mjs';
import { CANONICAL_DEPLOYMENTS_ROOT } from './deployments/runtime/paths.mjs';
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

const REHEARSAL_FORK = { rpcEnv: 'ANTSEED_TEST_FORK_RPC_URL', forkBlockNumber: 123, chainId: 8453 };
const REHEARSAL_OPTIONS = { migration: 'M004', network: 'base-mainnet', mode: 'fork-test', signers: {} };

function rehearsalMigration(id, prerequisites = [], fork) {
  return { id, rehearsal: { prerequisites, fork, async run() {} } };
}

test('resolves rehearsal prerequisites once, in order, inheriting the pinned fork', () => {
  const first = rehearsalMigration('M001', [], REHEARSAL_FORK);
  const second = rehearsalMigration('M002', ['M001']);
  const third = rehearsalMigration('M003', ['M001']);
  const target = rehearsalMigration('M004', ['M002', 'M003']);
  const registry = new Map([first, second, third, target].map((entry) => [entry.id, entry]));
  const result = resolveRehearsal(target, REHEARSAL_OPTIONS, registry);
  assert.deepEqual(result.migrations.map((entry) => entry.id), ['M001', 'M002', 'M003', 'M004']);
  assert.deepEqual(result.fork, REHEARSAL_FORK);
  assert.deepEqual(resolveRehearsal(first, REHEARSAL_OPTIONS, registry).migrations, [first]);
});

test('rejects invalid rehearsal declarations before loading environment or starting Anvil', async () => {
  const first = rehearsalMigration('M001', [], REHEARSAL_FORK);
  const registry = new Map([[first.id, first]]);
  const cases = [
    [rehearsalMigration('M002', ['M009']), /unknown rehearsal prerequisite M009/],
    [rehearsalMigration('M002', ['M002']), /Cyclic rehearsal prerequisite/],
    [{ id: 'M002' }, /no rehearsal hook/],
    [rehearsalMigration('M002', 'M001'), /prerequisites must be an array/],
    [rehearsalMigration('M002'), /no rehearsal fork configuration/],
    [rehearsalMigration('M002', [], { ...REHEARSAL_FORK, forkBlockNumber: undefined }), /pinned rehearsal fork/],
    [rehearsalMigration('M002', ['M001'], { ...REHEARSAL_FORK, chainId: 1 }), /fork conflicts/],
  ];
  for (const [target, expected] of cases) {
    registry.set(target.id, target);
    await assert.rejects(runRehearsal(target, REHEARSAL_OPTIONS, {
      registry,
      runMigration() { assert.fail('must not drive a migration'); },
    }, {
      loadDotEnv() { assert.fail('must validate before loading environment'); },
      withAnvilFork() { assert.fail('must not start Anvil'); },
    }), expected);
  }
  first.rehearsal.prerequisites = ['M002'];
  const target = rehearsalMigration('M002', ['M001']);
  registry.set(target.id, target);
  assert.throws(() => resolveRehearsal(target, REHEARSAL_OPTIONS, registry), /Cyclic rehearsal prerequisite/);
});

test('validates the network for prerequisite rehearsals and preserves M001 standalone configuration', () => {
  const target = rehearsalMigration('M002', ['M001']);
  const registry = new Map([[migration.id, migration]]);
  assert.throws(() => resolveRehearsal(target, {
    ...REHEARSAL_OPTIONS, network: 'base-sepolia',
  }, registry), /Base Sepolia.*Base mainnet.*fork-test/);
  const result = resolveRehearsal(migration, { ...REHEARSAL_OPTIONS, migration: 'M001' }, registry);
  assert.deepEqual(result.migrations, [migration]);
  assert.equal(result.fork.rpcEnv, 'BASE_MAINNET_RPC_URL');
  assert.equal(result.fork.forkBlockNumber, 50_571_469);
  assert.equal(result.fork.chainId, 8453);
});

test('M001 rehearsal retains its fixtures, epoch advancement, activation, and no-op check', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'antseed-m001-hook-'));
  const calls = [];
  const driven = [];
  const previousRegistry = process.env.WASH_TRADING_REGISTRY;
  delete process.env.WASH_TRADING_REGISTRY;
  t.after(async () => {
    if (previousRegistry === undefined) delete process.env.WASH_TRADING_REGISTRY;
    else process.env.WASH_TRADING_REGISTRY = previousRegistry;
    await rm(directory, { recursive: true, force: true });
  });
  await writeJsonAtomic(path.join(directory, 'base-mainnet', 'current.json'), {
    network: 'base-mainnet',
    contracts: Object.fromEntries(['registry', 'antsToken', 'channels', 'emissions', 'staking']
      .map((key) => [key, { address: ADDRESS.registry }])),
  });
  mockCast(t, (args) => {
    assert.ok(args.includes('http://127.0.0.1:9999'));
    calls.push(args);
    if (args.includes('--create')) return JSON.stringify({ contractAddress: ADDRESS.channels });
    return ADDRESS.registry;
  });
  await migration.rehearsal.run({
    rpcUrl: 'http://127.0.0.1:9999',
    outputRoot: directory,
    network: 'base-mainnet',
    async runMigration(overrides) {
      driven.push(overrides);
      return driven.length === 1
        ? { state: 'awaiting-epoch', deployment: { checkpoint: { cutoverTimestamp: 2000 } } }
        : { state: 'active' };
    },
  });
  assert.equal(driven.length, 3);
  assert.ok(driven.every((overrides) => overrides === driven[0]));
  assert.equal(driven[0].environment.WASH_TRADING_REGISTRY, ADDRESS.channels);
  assert.deepEqual(Object.keys(driven[0].signers), [
    'deployer', 'registryOwner', 'channelsOwner', 'sellerRewardsPoolOwner', 'diemStaker',
  ]);
  assert.ok(Object.values(driven[0].signers).every((signer) => signer.startsWith('unlocked:')));
  assert.equal(calls.filter((args) => args.includes('transferOwnership(address)')).length, 5);
  assert.ok(calls.some((args) => args[1] === 'anvil_setNextBlockTimestamp' && args[2] === '2001'));
  assert.ok(calls.some((args) => args[1] === 'anvil_impersonateAccount'
    && `unlocked:${args[2]}` === driven[0].signers.diemStaker));
});

for (const failPrerequisite of [false, true]) {
  test(`rehearsals isolate their ledger and clean up Anvil on ${failPrerequisite ? 'failure' : 'success'}`, async (t) => {
    const canonicalRoot = await mkdtemp(path.join(tmpdir(), 'antseed-rehearsal-baseline-'));
    const logs = [];
    const calls = [];
    let outputRoot;
    let stopped = false;
    let environmentLoaded = false;
    const previousRpc = process.env[REHEARSAL_FORK.rpcEnv];
    delete process.env[REHEARSAL_FORK.rpcEnv];
    t.mock.method(console, 'log', (message) => logs.push(message));
    t.after(async () => {
      if (previousRpc === undefined) delete process.env[REHEARSAL_FORK.rpcEnv];
      else process.env[REHEARSAL_FORK.rpcEnv] = previousRpc;
      await rm(canonicalRoot, { recursive: true, force: true });
      if (outputRoot) await rm(outputRoot, { recursive: true, force: true });
    });
    const baseline = { release: '000-baseline', network: 'base-mainnet' };
    const canonicalFile = path.join(canonicalRoot, 'base-mainnet', 'current.json');
    await writeJsonAtomic(canonicalFile, baseline);
    const first = rehearsalMigration('M001', [], REHEARSAL_FORK);
    const second = rehearsalMigration('M002', ['M001']);
    for (const current of [first, second]) {
      current.expectedState = (canonical) => canonical;
      current.rehearsal.run = async (context) => {
        outputRoot ??= context.outputRoot;
        assert.equal(context.outputRoot, outputRoot);
        assert.equal(context.rpcUrl, 'http://127.0.0.1:9999');
        assert.equal(context.network, 'base-mainnet');
        await context.runMigration({
          signers: { deployer: `unlocked:${ADDRESS.registry}` },
          environment: { FIXTURE: current.id },
          rpcUrl: 'https://must-not-be-used',
          outputRoot: canonicalRoot,
          canonicalRoot,
          forkTest: false,
        });
        if (failPrerequisite && current.id === 'M001') throw new Error('prerequisite failed');
      };
    }
    const run = runRehearsal(second, {
      ...REHEARSAL_OPTIONS, migration: 'M002', signers: { deployer: 'account:live-wallet' },
    }, {
      registry: new Map([[first.id, first], [second.id, second]]),
      async runMigration(current, options, overrides) {
        assert.equal(environmentLoaded, true);
        assert.equal(options.mode, 'broadcast');
        assert.equal(options.migration, current.id);
        assert.deepEqual(options.signers, {});
        assert.equal(overrides.rpcUrl, 'http://127.0.0.1:9999');
        assert.equal(overrides.forkTest, true);
        assert.equal(overrides.outputRoot, outputRoot);
        assert.equal(overrides.canonicalRoot, outputRoot);
        assert.notEqual(outputRoot, canonicalRoot);
        assert.equal(overrides.environment.FIXTURE, current.id);
        assert.deepEqual(overrides.signers, { deployer: `unlocked:${ADDRESS.registry}` });
        const context = await loadContext(current, options.network, overrides);
        assert.equal(context.canonical.release, calls.length ? 'M001-active' : '000-baseline');
        if (calls.length) {
          assert.equal(await historyRecordExists(context, 'M001-active'), true);
        }
        calls.push(current.id);
        await writeJsonAtomic(path.join(outputRoot, options.network, 'current.json'), { release: `${current.id}-active` });
        await writeJsonOnce(path.join(outputRoot, options.network, 'history', `${current.id}-active.json`), { release: `${current.id}-active` });
      },
    }, {
      canonicalRoot,
      async loadDotEnv() {
        environmentLoaded = true;
        process.env[REHEARSAL_FORK.rpcEnv] = 'https://test-fork-source';
      },
      withAnvilFork: (request, body) => withAnvilFork(request, body, {
        availablePort: async () => 9999,
        spawn(command, args) {
          assert.equal(environmentLoaded, true);
          assert.equal(command, 'anvil');
          assert.ok(args.includes('https://test-fork-source'));
          assert.ok(args.includes('123'));
          return { kill(signal) { assert.equal(signal, 'SIGTERM'); stopped = true; } };
        },
        waitForAnvil: async () => {},
      }),
    });
    if (failPrerequisite) await assert.rejects(run, /prerequisite failed/);
    else await run;
    assert.equal(stopped, true);
    assert.deepEqual(calls, failPrerequisite ? ['M001'] : ['M001', 'M002']);
    assert.deepEqual(JSON.parse(await readFile(canonicalFile, 'utf8')), baseline);
    assert.equal(JSON.parse(await readFile(path.join(outputRoot, 'base-mainnet', 'current.json'), 'utf8')).release,
      failPrerequisite ? 'M001-active' : 'M002-active');
    assert.ok(logs.some((message) => message.includes(outputRoot)));
    assert.equal(logs.some((message) => message.includes('fork test passed')), !failPrerequisite);
  });
}

test('temporary canonical roots never regenerate repository chain configuration', (t) => {
  const calls = [];
  t.mock.method(childProcess, 'spawnSync', (command, args, options) => {
    calls.push({ command, args, root: options.env.CONTRACT_DEPLOYMENTS_ROOT });
    return { status: 0, stdout: '', stderr: '' };
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const temporary = path.join(tmpdir(), 'rehearsal-ledger');
  validateArtifacts({ outputRoot: temporary, canonicalRoot: temporary });
  assert.deepEqual(calls, [{ command: 'node', args: ['scripts/validate-contract-deployments.mjs'], root: temporary }]);
  calls.length = 0;
  validateArtifacts({ outputRoot: CANONICAL_DEPLOYMENTS_ROOT, canonicalRoot: CANONICAL_DEPLOYMENTS_ROOT });
  assert.deepEqual(calls.map((entry) => entry.args[0]), [
    'scripts/generate-contract-chain-config.mjs', 'scripts/validate-contract-deployments.mjs',
  ]);
});

for (const mode of ['dry-run', 'broadcast']) {
  test(`${mode} does not resolve or execute rehearsal prerequisites`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'antseed-non-rehearsal-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await writeJsonAtomic(path.join(directory, 'base-mainnet', 'current.json'), { release: 'active' });
    const current = {
      ...rehearsalMigration('M002', ['MISSING']),
      expectedState: (canonical) => canonical,
      observe: async () => ({ state: 'active' }),
      phases: [],
      printStatus() {},
      idleMessage: () => 'already active',
    };
    current.rehearsal.run = () => assert.fail('must not rehearse during ordinary deployment');
    const result = await runMigration(current, { ...REHEARSAL_OPTIONS, mode }, {
      canonicalRoot: directory, outputRoot: directory, rpcUrl: 'http://unused',
    });
    assert.equal(result.state, 'active');
  });
}

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
  assert.deepEqual(current.registryBefore, {
    emissions: ADDRESS.legacyEmissions,
    staking: ADDRESS.legacyStaking,
  });
  applyActiveContracts(current, structuredClone(activeContracts));
  assert.equal(current.registryBefore.emissions, ADDRESS.legacyEmissions);
  assert.equal(current.registryBefore.staking, ADDRESS.legacyStaking);
});

for (const broadcast of [true, false]) {
  test(`Foundry ${broadcast ? 'broadcasts are sequential' : 'simulations do not enable broadcasting'}`, (t) => {
    const calls = [];
    t.mock.method(childProcess, 'spawnSync', (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: '', stderr: '' };
    });
    syncBuiltinESMExports();
    t.after(() => {
      t.mock.restoreAll();
      syncBuiltinESMExports();
    });
    for (const verify of [true, false]) {
      runForgeScript({
        target: 'script/Example.s.sol:Example',
        rpcUrl: 'http://unused',
        broadcast,
        verify,
        etherscanApiKey: 'test-key',
        walletArgs: ['--account', 'operator'],
        env: {},
      });
      assert.deepEqual(calls.at(-1), {
        command: 'forge',
        args: [
          'script', 'script/Example.s.sol:Example', '--rpc-url', 'http://unused', '--via-ir',
          '--account', 'operator',
          ...(broadcast ? ['--broadcast', '--slow'] : []),
          ...(broadcast && verify
            ? ['--verify', '--etherscan-api-key', 'test-key', '--etherscan-api-version', 'v2']
            : []),
        ],
      });
    }
  });
}

function mockCast(t, reply) {
  t.mock.method(childProcess, 'spawnSync', (command, args) => {
    assert.equal(command, 'cast', 'no deployment commands may run');
    return { status: 0, stdout: reply(args), stderr: '' };
  });
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

for (const creationType of ['CREATE', 'CREATE2', null]) {
  test(`preserves creation provenance with ${creationType ?? 'CALL-only'} broadcasts`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'antseed-broadcast-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const codeHash = `0x${'ab'.repeat(32)}`;
    mockCast(t, (args) => {
      if (args[0] === 'codehash') return codeHash;
      assert.deepEqual(args.slice(0, 3), ['call', ADDRESS.sellerRegistry, 'owner()(address)']);
      return ADDRESS.registry;
    });
    const creation = {
      hash: `0x${'11'.repeat(32)}`,
      transactionType: creationType,
      contractName: 'AntseedSellerPools',
      contractAddress: ADDRESS.sellerRegistry,
      arguments: [ADDRESS.ants, ADDRESS.registry],
    };
    const configuration = {
      ...creation,
      hash: `0x${'22'.repeat(32)}`,
      transactionType: 'CALL',
      function: 'setRewardStaker(address,bool)',
      arguments: [ADDRESS.channels, true],
    };
    const transactions = creationType ? [creation, configuration] : [configuration];
    const file = path.join(directory, 'run-latest.json');
    await writeJsonAtomic(file, {
      transactions,
      receipts: transactions.map((transaction, index) => ({
        transactionHash: transaction.hash,
        status: '0x1',
        blockNumber: `0x${(100 + index).toString(16)}`,
        from: ADDRESS.registry,
        to: transaction.transactionType === 'CALL' ? ADDRESS.sellerRegistry : null,
      })),
    });
    const parsed = await parseBroadcast(file, 'http://unused', { AntseedSellerPools: 'sellerPools' });
    assert.equal(parsed.transactions.length, transactions.length);
    assert.equal(parsed.transactions.at(-1).action, configuration.function);
    if (!creationType) {
      assert.deepEqual(parsed.contracts, {});
      return;
    }
    assert.equal(parsed.transactions[0].action, 'deploy AntseedSellerPools');
    assert.deepEqual(parsed.contracts.sellerPools, {
      address: ADDRESS.sellerRegistry,
      deploymentBlock: 100,
      transactionHash: creation.hash,
      runtimeCodeHash: codeHash,
      version: '1',
      external: false,
      deployedInRelease: true,
      constructorArguments: creation.arguments,
      owner: ADDRESS.registry,
    });
  });
}

for (const cached of [true, false]) {
  test(`recognizes activation from disk ${cached ? 'with' : 'without'} a local checkpoint`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'antseed-activated-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const emissionsGate = '0x0000000000000000000000000000000000000008';
    const pointsPolicyRegistry = '0x0000000000000000000000000000000000000009';
    const contracts = Object.fromEntries(Object.entries({
      usageAccounting: ADDRESS.usageAccounting,
      sellerRegistry: ADDRESS.sellerRegistry,
      emissionsGate,
      pointsPolicyRegistry,
    }).map(([key, address]) => [key, { address }]));
    const checkpoint = {
      chainId: 8453,
      effectiveEpoch: 11,
      cutoverTimestamp: 2100,
      contracts,
      verificationConfiguration: {
        verificationMinterController: ADDRESS.channels,
        emissionsGateOwner: ADDRESS.registry,
        pointsPolicyRegistryOwner: ADDRESS.registry,
      },
    };
    const current = {
      network: 'base-mainnet',
      chainId: 8453,
      release: migration.releases[1],
      contracts: Object.fromEntries(Object.entries({
        registry: ADDRESS.registry,
        antsToken: ADDRESS.ants,
        channels: ADDRESS.channels,
        emissions: ADDRESS.legacyEmissions,
        staking: ADDRESS.legacyStaking,
      }).map(([key, address]) => [key, { address }])),
    };
    applyActiveContracts(current, contracts);
    const currentPath = path.join(directory, current.network, 'current.json');
    const checkpointFile = path.join(directory, '.deployments', 'checkpoint.json');
    await writeJsonAtomic(currentPath, current);
    await writeJsonAtomic(path.join(directory, current.network, 'history', `${migration.releases[0]}.json`), checkpoint);
    await writeJsonAtomic(path.join(directory, current.network, 'history', `${migration.releases[1]}.json`), { release: current.release });
    if (cached) await writeJsonAtomic(checkpointFile, checkpoint);
    mockCast(t, (args) => {
      if (args[0] === 'chain-id') return '8453';
      if (args[0] === 'code') return '0x1234';
      assert.equal(args[0], 'call', 'restart must only read chain state');
      const [, address, signature] = args;
      if (signature === 'registry()(address)') {
        assert.ok([ADDRESS.ants, ADDRESS.legacyEmissions].includes(address), 'never call the legacy ABI on the new usage accounting contract');
        return emissionsGate;
      }
      const replies = {
        'antsToken()(address)': ADDRESS.ants,
        'channels()(address)': ADDRESS.channels,
        'emissions()(address)': ADDRESS.usageAccounting,
        'staking()(address)': ADDRESS.sellerRegistry,
        'paused()(bool)': 'false',
        'currentEpoch()(uint256)': '12',
        'emissionsGate()(address)': emissionsGate,
        'pointsPolicy()(address)': pointsPolicyRegistry,
        'minters(bytes32)(address,uint32,bool)': JSON.stringify([ADDRESS.channels, 10000, true]),
        'policyCount()(uint256)': '0',
        'owner()(address)': ADDRESS.registry,
        'genesis()(uint256)': '1000',
        'epochDuration()(uint256)': '100',
      };
      assert.ok(Object.hasOwn(replies, signature), `unexpected call: ${signature}`);
      return replies[signature];
    });
    const canonical = JSON.parse(await readFile(currentPath, 'utf8'));
    const context = {
      canonical,
      expected: migration.expectedState(canonical),
      network: canonical.network,
      outputRoot: directory,
      checkpointFile,
      rpcUrl: 'http://unused',
    };
    const result = await executePhases(migration, { mode: 'broadcast', signers: {} }, {}, context);
    assert.equal(result.state, 'active');
    assert.equal(context.expected.legacyEmissions, ADDRESS.legacyEmissions);
    assert.equal(context.expected.legacyStaking, ADDRESS.legacyStaking);
    assert.equal(migration.idleMessage(result), 'M001 is already active; no transactions required.');
    assert.deepEqual(JSON.parse(await readFile(currentPath, 'utf8')), current);
  });
}

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

test('M002 defaults to ten percent of cumulative locked rewards', () => {
  assert.equal(DEFAULT_RELEASE_BPS, 1000);
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
      washTradingRegistry: contract(ADDRESS.channels),
      legacyEmissionsEscrow: contract(ADDRESS.sellerRegistry),
    },
  };
  assert.doesNotThrow(() => validateM002Baseline(activated));
  assert.equal(m002.expectedState(activated).washTradingRegistry, ADDRESS.channels);
  assert.throws(
    () => validateM002Baseline({ ...activated, contracts: { ...activated.contracts, emissions: contract(ADDRESS.legacyEmissions) } }),
    /run M001 first/,
  );
  const { washTradingRegistry, ...withoutWashTradingRegistry } = activated.contracts;
  assert.throws(() => validateM002Baseline({ ...activated, contracts: withoutWashTradingRegistry }), /missing: washTradingRegistry/);
});

test('M002 observes the ledger wash registry without a PositionInit getter', async (t) => {
  const responses = {
    'legacyEmissions()(address)': ADDRESS.legacyEmissions,
    'sellerRewardsPool()(address)': M002_ADDRESS.pool,
    'owner()(address)': ADDRESS.ants,
    'sellerClaimPolicy()(address)': M002_ADDRESS.zero,
    'totalLockedRewards()(uint256)': '1000',
    'emissionsGate()(address)': ADDRESS.channels,
    'effectiveEpoch()(uint256)': '22',
    'MIGRATION_EPOCH()(uint256)': '4',
    'antsToken()(address)': ADDRESS.ants,
    'emissions()(address)': ADDRESS.usageAccounting,
    'transfersEnabled()(bool)': 'false',
    'transferWhitelist(address)(bool)': 'false',
  };
  mockCast(t, (args) => {
    if (args[0] === 'chain-id') return '8453';
    if (args[0] === 'code') return '0x01';
    assert.equal(args[0], 'call');
    assert.ok(Object.hasOwn(responses, args[2]), `unexpected getter: ${args[2]}`);
    return responses[args[2]];
  });
  const observation = await m002.observe({
    rpcUrl: 'http://127.0.0.1:0',
    network: 'base-mainnet',
    canonical: { chainId: 8453 },
    expected: {
      registry: ADDRESS.registry,
      antsToken: ADDRESS.ants,
      usageAccounting: ADDRESS.usageAccounting,
      legacyEmissionsEscrow: ADDRESS.sellerRegistry,
      washTradingRegistry: ADDRESS.channels,
      recordedPolicy: null,
    },
  });
  assert.equal(observation.state, 'ready');
  assert.equal(observation.washTradingRegistry, ADDRESS.channels);
});

test('enforces M002 release invariants', () => {
  const validate = (record) => m002.recordErrors(record).length === 0;
  const verificationConfiguration = {
    sellerRewardsPool: M002_ADDRESS.pool,
    sellerClaimPolicy: M002_ADDRESS.policy,
    poolCanTransfer: true,
    lastLockedEpoch: 41,
    releaseBps: 1000,
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

test('M002 rehearses through the framework with M001 as its prerequisite', () => {
  assert.deepEqual(m002.rehearsal.prerequisites, ['M001']);
  assert.equal(m002.rehearsal.fork, undefined);
  const result = resolveRehearsal(m002, { ...REHEARSAL_OPTIONS, migration: 'M002' }, deploymentMigrations);
  assert.deepEqual(result.migrations.map((entry) => entry.id), ['M001', 'M002']);
  assert.deepEqual(result.fork, migration.rehearsal.fork);
});

test('M002 rehearsal checks activation and an idempotent second apply', async () => {
  for (const states of [['active', 'active'], ['ready'], ['active', 'ready']]) {
    const driven = [];
    const run = m002.rehearsal.run({
      network: 'base-mainnet',
      async runMigration(overrides) {
        driven.push(overrides);
        return { state: states[driven.length - 1] };
      },
    });
    if (states.every((state) => state === 'active')) await run;
    else await assert.rejects(run, /Expected M002 active|not an active no-op/);
    assert.equal(driven.length, states.length);
    assert.deepEqual(Object.keys(driven[0].signers), ['deployer', 'sellerRewardsPoolOwner']);
    assert.ok(Object.values(driven[0].signers).every((signer) => signer.startsWith('unlocked:')));
  }
});
