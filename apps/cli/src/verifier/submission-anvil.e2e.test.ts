import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createReferenceQueryProfile } from '@antseed/fingerprints'
import { VerificationStorage } from '@antseed/node'
import {
  VERIFIER_VERDICT_DIFF,
  VERIFIER_VERDICT_UNDETERMINED,
  VerifierClient,
} from '@antseed/node/payments'
import {
  modelAuditsDirectory,
  writeModelAuditSummary,
  writeVerifierRunManifest,
  type ModelAuditSummaryV1,
  type VerifierRunManifestV1,
} from './audit-artifacts.js'
import { bankPath } from './probe-bank.js'
import {
  emptyAuditCostSummary,
  writeProxyAuditEvidence,
  type ProxyAuditEvidenceV1,
} from './proxy-evidence.js'
import { submissionLedgerPath, type SubmissionLedgerV1 } from './submission-ledger.js'

const RUN_ANVIL_E2E = process.env['ANTSEED_RUN_VERIFIER_ANVIL_E2E'] === '1'
const DEPLOYER_PRIVATE_KEY = 'ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const VERIFIER_ADDRESS = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const SELLER_ADDRESSES = [
  '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
  '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC',
  '0x90F79bf6EB2c4f870365E785982E1f101E93b906',
  '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65',
] as const
const MODELS = ['model-a', 'model-b', 'model-c'] as const

const compiledTestDirectory = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(compiledTestDirectory, '../../../..')
const contractsDirectory = join(repoRoot, 'packages', 'contracts')
const cliEntry = join(repoRoot, 'apps', 'cli', 'dist', 'cli', 'index.js')

interface CommandResult {
  status: number
  output: string
}

interface WrittenAudit {
  path: string
  evidenceHash: string
  result: ModelAuditSummaryV1['results'][number]
}

test('verifier submit sends per-model bundles to Anvil with retry-safe accounting', {
  skip: !RUN_ANVIL_E2E,
  timeout: 240_000,
}, async () => {
  requireCommand('anvil')
  requireCommand('cast')
  requireCommand('forge')

  const directory = await mkdtemp(join(tmpdir(), 'antseed-verifier-submit-e2e-'))
  const port = await availablePort()
  const rpcUrl = `http://127.0.0.1:${port}`
  const anvil = startAnvil(port)
  try {
    await waitForRpcReady(rpcUrl, anvil)
    const registryAddress = deployContract(rpcUrl, 'core/AntseedRegistry.sol:AntseedRegistry')
    const identityRegistryAddress = deployContract(
      rpcUrl,
      'test/mocks/MockERC8004Registry.sol:MockERC8004Registry',
    )
    const emissionsGateAddress = deployContract(
      rpcUrl,
      'emissions/AntseedEmissionsGate.sol:AntseedEmissionsGate',
      [SELLER_ADDRESSES[0], SELLER_ADDRESSES[1], '15000', '15000'],
    )
    const verificationAddress = deployContract(
      rpcUrl,
      'verification/AntseedVerification.sol:AntseedVerification',
      [registryAddress, emissionsGateAddress],
    )
    castSend(rpcUrl, registryAddress, 'setIdentityRegistry(address)', [identityRegistryAddress])
    castSend(rpcUrl, verificationAddress, 'setVerifier(address,bool)', [VERIFIER_ADDRESS, 'true'])
    for (const [index, sellerAddress] of SELLER_ADDRESSES.entries()) {
      castSend(rpcUrl, identityRegistryAddress, 'setOwner(uint256,address)', [String(index + 1), sellerAddress])
    }

    const dataDir = join(directory, 'data')
    const evidenceDir = join(dataDir, 'verifier', 'evidence')
    const banksDir = join(dataDir, 'verifier', 'banks')
    const configPath = join(directory, 'config.json')
    await mkdir(dataDir, { recursive: true })
    await writeFile(join(dataDir, 'identity.key'), `${DEPLOYER_PRIVATE_KEY}\n`, { mode: 0o600 })
    await writeFile(configPath, JSON.stringify({
      payments: {
        preferredMethod: 'crypto',
        crypto: {
          chainId: 'base-local',
          rpcUrl,
          verificationContractAddress: verificationAddress,
          identityRegistryAddress,
        },
      },
      verifier: { evidenceDir, banksDir },
    }))
    const storage = new VerificationStorage(join(dataDir, 'verification.db'))
    storage.close()

    const verifierClient = createVerifierClient(rpcUrl, verificationAddress)
    const epochWindow = await verifierClient.currentEpochWindow()
    const runId = 'anvil-bundle-run'
    const timestamps = {
      epochStartedAt: new Date(epochWindow.startedAt * 1_000).toISOString(),
      epochEndsAt: new Date(epochWindow.endsAt * 1_000).toISOString(),
      startedAt: new Date((epochWindow.startedAt + 60) * 1_000).toISOString(),
      completedAt: new Date((epochWindow.startedAt + 120) * 1_000).toISOString(),
    }

    const modelA = await writeModelFixture({
      evidenceDir,
      banksDir,
      epoch: epochWindow.epoch.toString(),
      runId,
      model: MODELS[0],
      timestamps,
      referenceCostUsdMicros: '200000',
      audits: [
        { agentId: '1', peerId: '11'.repeat(20), verdict: 'SAME', telemetryUsd: 0.6 },
        { agentId: '2', peerId: '22'.repeat(20), verdict: 'DIFF', telemetryUsd: 0.4 },
      ],
    })
    const modelB = await writeModelFixture({
      evidenceDir,
      banksDir,
      epoch: epochWindow.epoch.toString(),
      runId,
      model: MODELS[1],
      timestamps,
      referenceCostUsdMicros: '1000000',
      audits: [
        { agentId: '3', peerId: '33'.repeat(20), verdict: 'UNDETERMINED', telemetryUsd: 99.4 },
      ],
    })
    const modelC = await writeModelFixture({
      evidenceDir,
      banksDir,
      epoch: epochWindow.epoch.toString(),
      runId,
      model: MODELS[2],
      timestamps,
      referenceCostUsdMicros: '100000',
      audits: [
        { agentId: '4', peerId: '44'.repeat(20), verdict: 'SAME', telemetryUsd: 0.1 },
      ],
    })
    const manifest: VerifierRunManifestV1 = {
      version: 1,
      kind: 'antseed-verifier-run-manifest',
      runId,
      state: 'completed',
      epoch: epochWindow.epoch.toString(),
      epochSource: 'onchain',
      ...timestamps,
      summaryPath: join(evidenceDir, 'epochs', epochWindow.epoch.toString(), 'summary.json'),
      modelOrder: [...MODELS],
      models: [modelA, modelB, modelC].map((fixture) => ({
        model: fixture.model,
        summaryPath: fixture.summaryPath,
        resultCount: fixture.resultCount,
        failureCount: 0,
        skippedCount: 0,
        cost: emptyAuditCostSummary(),
      })),
      failureCount: 0,
    }
    await writeVerifierRunManifest(evidenceDir, manifest)

    const dryRun = runCli(dataDir, configPath, rpcUrl, runId, ['--dry-run'])
    assert.equal(dryRun.status, 0, dryRun.output)
    assert.match(dryRun.output, /Dry run complete/)
    assert.equal((await createVerifierClient(rpcUrl, verificationAddress).queryBundles()).length, 0)

    const originalModelBEvidence = await readFile(modelB.audits[0]!.path, 'utf8')
    await writeFile(modelB.audits[0]!.path, `${originalModelBEvidence} `)
    const partialSubmit = runCli(dataDir, configPath, rpcUrl, runId, ['--yes'])
    assert.equal(partialSubmit.status, 1, partialSubmit.output)
    assert.match(partialSubmit.output, /model-b: preflight failed: no valid seller results remain/)
    assert.match(partialSubmit.output, /Submitted: 2; skipped: 0; failed: 1/)
    assert.equal((await createVerifierClient(rpcUrl, verificationAddress).queryBundles()).length, 2)
    assert.equal(
      await createVerifierClient(rpcUrl, verificationAddress)
        .epochCreditUsdMicros(epochWindow.epoch, VERIFIER_ADDRESS),
      1_400_000n,
    )

    await writeFile(modelB.audits[0]!.path, originalModelBEvidence)
    const retry = runCli(dataDir, configPath, rpcUrl, runId, ['--yes'])
    assert.equal(retry.status, 0, retry.output)
    assert.match(retry.output, /model-a: bundle already submitted/)
    assert.match(retry.output, /model-c: bundle already submitted/)
    assert.match(retry.output, /model-b: submitted 1 seller result/)

    const readClient = createVerifierClient(rpcUrl, verificationAddress)
    const bundles = await readClient.queryBundles()
    assert.equal(bundles.length, 3)
    const costs = new Map(bundles.map((event) => [event.totalAuditCostUsdMicros.toString(), event]))
    assert.equal(costs.get('1200000')?.awardedCreditUsdMicros, 1_200_000n)
    assert.equal(costs.get('200000')?.awardedCreditUsdMicros, 200_000n)
    assert.equal(costs.get('100400000')?.awardedCreditUsdMicros, 98_600_000n)
    assert.equal(await readClient.epochCreditUsdMicros(epochWindow.epoch, VERIFIER_ADDRESS), 100_000_000n)
    assert.equal(await readClient.epochTotalCreditUsdMicros(epochWindow.epoch), 100_000_000n)

    const diff = await readClient.queryAttestations(2n)
    assert.equal(diff.length, 1)
    assert.equal(diff[0]!.verdict, VERIFIER_VERDICT_DIFF)
    assert.equal(diff[0]!.modelShareBps, 0)
    const undetermined = await readClient.queryAttestations(3n)
    assert.equal(undetermined.length, 1)
    assert.equal(undetermined[0]!.verdict, VERIFIER_VERDICT_UNDETERMINED)
    assert.equal(bundles.reduce((total, event) => total + event.resultCount, 0), 4)

    const ledgerFile = submissionLedgerPath(evidenceDir, 31_337n, verificationAddress, runId)
    const ledger = JSON.parse(await readFile(ledgerFile, 'utf8')) as SubmissionLedgerV1
    assert.deepEqual(Object.keys(ledger.models).sort(), [...MODELS].sort())
    for (const model of MODELS) {
      const entry = ledger.models[model]!
      assert.ok(['submitted', 'skipped'].includes(entry.status))
      assert.ok(entry.transactionHash)
      const bank = JSON.parse(await readFile(bankPath(banksDir, model), 'utf8')) as {
        referenceCosts: Array<{ status: string; claimedTransactionHash: string | null }>
      }
      assert.equal(bank.referenceCosts[0]?.status, 'claimed')
      assert.equal(bank.referenceCosts[0]?.claimedTransactionHash, entry.transactionHash)
    }

    const beforeFinalRetry = bundles.map((event) => event.transactionHash).sort()
    const finalRetry = runCli(dataDir, configPath, rpcUrl, runId, ['--yes'])
    assert.equal(finalRetry.status, 0, finalRetry.output)
    assert.match(finalRetry.output, /Submitted: 0; skipped: 3; failed: 0/)
    assert.deepEqual(
      (await createVerifierClient(rpcUrl, verificationAddress).queryBundles())
        .map((event) => event.transactionHash)
        .sort(),
      beforeFinalRetry,
    )
  } finally {
    await stopProcess(anvil)
    await rm(directory, { recursive: true, force: true })
  }
})

async function writeModelFixture(input: {
  evidenceDir: string
  banksDir: string
  epoch: string
  runId: string
  model: string
  timestamps: {
    startedAt: string
    completedAt: string
  }
  referenceCostUsdMicros: string
  audits: Array<{
    agentId: string
    peerId: string
    verdict: 'SAME' | 'DIFF' | 'UNDETERMINED'
    telemetryUsd: number
  }>
}): Promise<{
  model: string
  summaryPath: string
  resultCount: number
  audits: WrittenAudit[]
}> {
  const audits: WrittenAudit[] = []
  for (const [index, audit] of input.audits.entries()) {
    const auditId = `${input.model}-audit-${index + 1}`
    const written = await writeProxyAuditEvidence(
      modelAuditsDirectory(input.evidenceDir, input.epoch, input.model),
      auditId,
      auditEvidence({
        model: input.model,
        requestId: `${input.model}-request-${index + 1}`,
        ...audit,
      }),
    )
    audits.push({
      ...written,
      result: {
        peerId: audit.peerId,
        displayName: `${input.model}-${index + 1}`,
        agentId: audit.agentId,
        service: input.model,
        status: audit.verdict,
        auditId,
        parsedProbeCount: 1,
        probeCount: 1,
        correctProbeCount: audit.verdict === 'SAME' ? 1 : 0,
        incorrectProbeCount: audit.verdict === 'SAME' ? 0 : 1,
        correctRate: audit.verdict === 'SAME' ? 1 : 0,
        requestCount: 1,
        cost: emptyAuditCostSummary(),
        evidencePath: written.path,
        evidenceHash: written.evidenceHash,
      },
    })
  }
  const summaryPath = await writeModelAuditSummary(input.evidenceDir, input.epoch, input.model, {
    version: 1,
    kind: 'antseed-verifier-model-summary',
    runId: input.runId,
    epoch: input.epoch,
    model: input.model,
    startedAt: input.timestamps.startedAt,
    completedAt: input.timestamps.completedAt,
    results: audits.map((audit) => audit.result),
    failures: [],
    skipped: [],
    cost: emptyAuditCostSummary(),
  })
  const path = bankPath(input.banksDir, input.model)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify({
    version: 1,
    kind: 'antseed-kbf-probe-bank',
    model: input.model,
    referenceCosts: [{
      costId: `0x${String(MODELS.indexOf(input.model as typeof MODELS[number]) + 1).padStart(64, '0')}`,
      referenceId: `${input.model}-reference`,
      cost: {
        totalUsdMicros: input.referenceCostUsdMicros,
        requestCount: 1,
        models: [{
          model: input.model,
          requestCount: 1,
          inputTokens: 10,
          outputTokens: 2,
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 2,
          costUsdMicros: input.referenceCostUsdMicros,
        }],
        purposes: [{
          purpose: 'target-model',
          model: input.model,
          requestCount: 1,
          inputTokens: 10,
          outputTokens: 2,
          inputUsdPerMillion: 1,
          outputUsdPerMillion: 2,
          costUsdMicros: input.referenceCostUsdMicros,
        }],
      },
      status: 'unclaimed',
      reservedBundleId: null,
      claimedTransactionHash: null,
    }],
    createdAt: input.timestamps.startedAt,
    updatedAt: input.timestamps.completedAt,
  }))
  return { model: input.model, summaryPath, resultCount: audits.length, audits }
}

function auditEvidence(input: {
  model: string
  agentId: string
  peerId: string
  requestId: string
  verdict: 'SAME' | 'DIFF' | 'UNDETERMINED'
  telemetryUsd: number
}): ProxyAuditEvidenceV1 {
  return {
    version: 1,
    kind: 'antseed-buyer-proxy-kbf-audit',
    evidenceLevel: 'proxy-observation-with-verified-response-auth-no-payment-evidence',
    createdAt: '2026-08-06T12:00:00.000Z',
    buyerProxy: { baseUrl: 'http://127.0.0.1:8377', statePath: '/tmp/buyer.state.json', pid: 1 },
    target: {
      peerId: input.peerId,
      displayName: input.peerId,
      agentId: input.agentId,
      service: input.model,
    },
    reference: {
      referenceId: `${input.model}-reference`,
      referenceModel: input.model,
      queryProfileHash: `0x${'11'.repeat(32)}`,
      queryProfile: createReferenceQueryProfile({ upstreamModel: input.model }),
      statisticalPower: 0.99,
      statisticalPowerEvidence: { power: 0.99 },
      selfTest: { hamming: 0, total: 1, coverage: 1, errorRate: 0 },
      probes: [{
        id: `${input.model}-probe`,
        name: 'probe',
        domain: 'test',
        template: 'Value is ___.',
        consensus: 1,
        range: [0, 2],
        tolerance: { mode: 'absolute', value: 0 },
      }],
    },
    exchanges: [{
      batchIndex: 0,
      attemptCount: 1,
      requestIds: [input.requestId],
      probeIds: [`${input.model}-probe`],
      request: {
        method: 'POST',
        url: 'http://127.0.0.1:8377/v1/chat/completions',
        headers: {},
        bodyBase64: '',
        hash: `0x${'22'.repeat(32)}`,
      },
      response: {
        statusCode: 200,
        headers: {},
        bodyBase64: '',
        hash: `0x${'33'.repeat(32)}`,
      },
      timing: { startedAt: 1, completedAt: 2, responseLatencyMs: 1 },
      answers: [1],
      matches: [input.verdict === 'SAME' ? 1 : 0],
      status: 'succeeded',
      failureReason: null,
      cost: {
        inputTokens: 100,
        outputTokens: 20,
        totalTokens: 120,
        inputUsdPerMillion: 1,
        outputUsdPerMillion: 2,
        estimatedCostUsd: input.telemetryUsd,
        tokenSource: 'usage',
        provider: 'test',
        service: input.model,
      },
      responseAuth: {
        requestId: input.requestId,
        status: 'verified',
        record: null,
        signedPreimages: null,
        failureReason: null,
      },
    }],
    result: {
      selectedProbeCount: 1,
      parsedProbeCount: 1,
      matchVector: [input.verdict === 'SAME' ? 1 : 0],
      matchVectorHash: `0x${'44'.repeat(32)}`,
      stats: {
        selfHamming: 0,
        selfTotal: 1,
        targetHamming: input.verdict === 'SAME' ? 0 : 1,
        targetTotal: 1,
        selfCoverage: 1,
        targetCoverage: 1,
        p0Cp99: 0.1,
        pValueBinomial: 1,
      },
      verdict: input.verdict,
      verdictReason: input.verdict === 'UNDETERMINED' ? 'authenticated coverage incomplete' : null,
      cost: emptyAuditCostSummary(),
    },
  }
}

function runCli(
  dataDir: string,
  configPath: string,
  rpcUrl: string,
  runId: string,
  submitOptions: string[],
): CommandResult {
  const result = spawnSync(process.execPath, [
    cliEntry,
    '--data-dir', dataDir,
    '--config', configPath,
    'verifier',
    'submit',
    '--run-id', runId,
    '--rpc-url', rpcUrl,
    ...submitOptions,
  ], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  return {
    status: result.status ?? 1,
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
  }
}

function createVerifierClient(rpcUrl: string, contractAddress: string): VerifierClient {
  return new VerifierClient({ rpcUrl, contractAddress, evmChainId: 31_337 })
}

function requireCommand(command: string): void {
  const result = spawnSync('which', [command], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`required command not found: ${command}`)
}

function deployContract(rpcUrl: string, contract: string, constructorArgs: string[] = []): string {
  const output = runCommand('forge', [
    'create',
    contract,
    '--rpc-url', rpcUrl,
    '--private-key', `0x${DEPLOYER_PRIVATE_KEY}`,
    '--broadcast',
    ...(constructorArgs.length > 0 ? ['--constructor-args', ...constructorArgs] : []),
  ], contractsDirectory)
  const match = output.match(/Deployed to:\s*(0x[a-fA-F0-9]{40})/)
  if (!match) throw new Error(`could not parse deployed address for ${contract}:\n${output}`)
  return match[1]!
}

function castSend(rpcUrl: string, contract: string, signature: string, args: string[]): void {
  runCommand('cast', [
    'send',
    '--rpc-url', rpcUrl,
    '--private-key', `0x${DEPLOYER_PRIVATE_KEY}`,
    contract,
    signature,
    ...args,
  ], repoRoot)
}

function runCommand(command: string, args: string[], cwd: string): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim()
  if (result.status !== 0) {
    throw new Error(`command failed: ${command} ${args.join(' ')}\n${output || '(no output)'}`)
  }
  return output
}

async function availablePort(): Promise<number> {
  const server = createServer()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('could not allocate an Anvil port')
  const port = address.port
  server.close()
  await once(server, 'close')
  return port
}

function startAnvil(port: number): ChildProcessWithoutNullStreams {
  return spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--silent'], {
    cwd: repoRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  })
}

async function waitForRpcReady(
  rpcUrl: string,
  anvil: ChildProcessWithoutNullStreams,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (anvil.exitCode !== null) throw new Error(`Anvil exited before RPC startup with code ${anvil.exitCode}`)
    try {
      const response = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
      })
      if (response.ok) return
    } catch {
      // Retry until the deadline.
    }
    await sleep(100)
  }
  throw new Error(`Anvil RPC did not start within ${timeoutMs}ms`)
}

async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([once(child, 'exit'), sleep(5_000)])
  if (child.exitCode === null) child.kill('SIGKILL')
}
