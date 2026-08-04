#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { Contract, JsonRpcProvider } from 'ethers'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const contractsDir = join(repoRoot, 'packages', 'contracts')
const rpcUrl = process.env.DIRECT_VERIFIER_E2E_RPC_URL ?? 'http://127.0.0.1:18545'
const rpc = new URL(rpcUrl)
const anvilPort = rpc.port || '18545'
const chainId = 31337
const deployerPrivateKey = process.env.DEPLOYER_PRIVATE_KEY
  ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const service = 'gpt-test'
const sellerStakeUsdc = 50_000_000n
const verifierDepositUsdc = 10_000_000n
const actorFundingUsdc = 100_000_000n
const auditTimestamp = 1_785_758_400 // August 3, 2026 12:00:00 UTC
const deploymentTimestamp = auditTimestamp - 7 * 24 * 60 * 60

function step(message) {
  console.log(`\n[direct-verifier-e2e] ${message}`)
}

function check(condition, message) {
  if (!condition) throw new Error(message)
}

function requireCommand(command) {
  const result = spawnSync('which', [command], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Required command not found: ${command}`)
}

function run(command, args, cwd = repoRoot, env = {}) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  return `${result.stdout ?? ''}${result.stderr ?? ''}`
}

function castSend(privateKey, address, signature, ...args) {
  run('cast', [
    'send',
    '--rpc-url', rpcUrl,
    '--private-key', privateKey,
    address,
    signature,
    ...args.map(String),
  ])
}

async function waitForRpc(provider, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      await provider.getBlockNumber()
      return
    } catch {
      await sleep(200)
    }
  }
  throw new Error(`Anvil did not become ready at ${rpcUrl}`)
}

async function waitForValue(getValue, label, timeoutMs = 30_000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await getValue()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await sleep(intervalMs)
  }
  const suffix = lastError instanceof Error ? `: ${lastError.message}` : ''
  throw new Error(`Timed out waiting for ${label}${suffix}`)
}

async function stopProcess(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  const stopped = await Promise.race([
    once(child, 'exit').then(() => true),
    sleep(5_000).then(() => false),
  ])
  if (!stopped && child.exitCode === null) {
    child.kill('SIGKILL')
    await once(child, 'exit').catch(() => undefined)
  }
}

async function artifact(relativePath) {
  return JSON.parse(await readFile(join(contractsDir, 'out', relativePath), 'utf8'))
}

async function contractAt(signer, relativePath, address) {
  const compiled = await artifact(relativePath)
  return new Contract(address, compiled.abi, signer)
}

async function setTimestamp(provider, timestamp) {
  await provider.send('evm_setNextBlockTimestamp', [Number(timestamp)])
  await provider.send('evm_mine', [])
}

async function fundGas(provider, address) {
  await provider.send('anvil_setBalance', [address, `0x${(100n * 10n ** 18n).toString(16)}`])
}

async function send(txPromise) {
  const tx = await txPromise
  const receipt = await tx.wait()
  if (!receipt) throw new Error('transaction receipt missing')
  return receipt.hash
}

async function deployedAddresses() {
  const path = join(contractsDir, 'broadcast', 'Deploy.s.sol', String(chainId), 'run-latest.json')
  const broadcast = JSON.parse(await readFile(path, 'utf8'))
  const wanted = new Set([
    'MockUSDC',
    'MockERC8004Registry',
    'ANTSToken',
    'AntseedRegistry',
    'AntseedStaking',
    'AntseedDeposits',
    'AntseedChannels',
    'AntseedSellerRegistry',
    'AntseedEmissionsGate',
    'AntseedVerifierRegistry',
    'AntseedVerifierRewards',
    'AntseedVerifierPointsPolicy',
  ])
  const addresses = {}
  for (const transaction of broadcast.transactions ?? []) {
    if (transaction.transactionType === 'CREATE' && wanted.has(transaction.contractName)) {
      addresses[transaction.contractName] = transaction.contractAddress
    }
  }
  const missing = [...wanted].filter((name) => !addresses[name])
  if (missing.length > 0) throw new Error(`deployment missing contracts: ${missing.join(', ')}`)
  return addresses
}

function buildReference(fingerprints) {
  const probes = Array.from({ length: 100 }, (_unused, index) => ({
    id: `probe-${String(index).padStart(3, '0')}`,
    name: `probe-${index}`,
    domain: 'direct-verifier-e2e',
    template: `The direct verifier value ${index} is ___.`,
    consensus: index + 100,
    range: [0, 100_000],
    tolerance: { mode: 'absolute', value: 0 },
    advisoryConsensus: false,
  }))
  const power = fingerprints.computeBinomialPower({
    selfHamming: 0,
    selfTotal: probes.length,
    minimumMismatchDelta: 0.1,
  })
  const reference = {
    version: 1,
    kind: 'kbf',
    referenceId: '',
    referenceModel: service,
    serviceAliases: [service],
    createdAt: '2026-08-03T12:00:00.000Z',
    source: 'generated',
    generator: { name: 'direct-verifier-e2e', version: '1', verifierKind: 'kbf', params: {} },
    queryProfile: fingerprints.createReferenceQueryProfile({ upstreamModel: service }),
    selfTest: {
      hamming: 0,
      total: probes.length,
      coverage: 1,
      errorRate: 0,
      outcomes: probes.map((probe) => ({ probeId: probe.id, answer: probe.consensus, match: 1 })),
    },
    probes,
    selectedProbeCount: probes.length,
    minimumMismatchDelta: 0.1,
    statisticalPower: power.power,
    statisticalPowerEvidence: {
      test: 'one-sided-binomial',
      alpha: 0.05,
      clopperPearsonConfidence: 0.99,
      selfHamming: 0,
      selfTotal: probes.length,
      p0UpperBound: power.p0,
      alternativeMismatchRate: power.p1,
      criticalMismatchCount: power.criticalMismatchCount,
      power: power.power,
    },
    contrasts: [],
  }
  reference.referenceId = fingerprints.computeReferenceId(reference)
  return fingerprints.validateKbfReferenceV1(reference)
}

class DirectKbfProvider {
  constructor() {
    this.name = 'mock-openai'
    this.services = [service]
    this.pricing = {
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
    }
    this.maxConcurrency = 4
    this.requestCount = 0
    this._active = 0
  }

  async handleRequest(request) {
    this._active += 1
    this.requestCount += 1
    try {
      const body = JSON.parse(new TextDecoder().decode(request.body))
      const prompt = body.messages?.at(-1)?.content
      if (typeof prompt !== 'string') throw new Error('missing KBF prompt')
      const indices = [...prompt.matchAll(/direct verifier value (\d+) is ___/g)]
        .map((match) => Number(match[1]))
      if (indices.length !== 10) throw new Error(`expected 10 probes, received ${indices.length}`)
      const content = indices.map((index, ordinal) => `(${ordinal + 1}) ${index + 101}`).join('\n')
      return {
        requestId: request.requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({
          id: `chatcmpl-${request.requestId}`,
          object: 'chat.completion',
          model: service,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
        })),
      }
    } finally {
      this._active -= 1
    }
  }

  getCapacity() {
    return { current: this._active, max: this.maxConcurrency }
  }
}

async function main() {
  for (const command of ['anvil', 'forge', 'pnpm']) requireCommand(command)

  step('building fingerprints, node, CLI, and Solidity artifacts')
  run('pnpm', ['--filter', '@antseed/fingerprints', 'run', 'build'])
  run('pnpm', ['--filter', '@antseed/node', 'run', 'build'])
  run('pnpm', ['--filter', '@antseed/cli', 'run', 'build'])
  run('forge', ['build'], contractsDir)

  const [node, payments, fingerprints, auditRunner, directEvidence] = await Promise.all([
    import('@antseed/node'),
    import('@antseed/node/payments'),
    import('@antseed/fingerprints'),
    import('../../apps/cli/dist/verifier/audit-runner.js'),
    import('../../apps/cli/dist/verifier/direct-evidence.js'),
  ])

  const anvil = spawn('anvil', [
    '--host', rpc.hostname,
    '--port', anvilPort,
    '--chain-id', String(chainId),
    '--timestamp', String(deploymentTimestamp),
    '--silent',
  ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  anvil.stdout?.on('data', () => undefined)
  anvil.stderr?.on('data', () => undefined)
  const provider = new JsonRpcProvider(rpcUrl)
  const tempDir = await mkdtemp(join(tmpdir(), 'antseed-direct-verifier-e2e-'))
  const sellerDir = join(tempDir, 'seller')
  const verifierDir = join(tempDir, 'verifier')
  const evidenceDir = join(tempDir, 'evidence')
  let bootstrap = null
  let sellerNode = null
  let verifierNode = null

  try {
    await waitForRpc(provider)
    step('deploying the simplified contract topology')
    run('forge', [
      'script',
      'script/Deploy.s.sol',
      '--rpc-url', rpcUrl,
      '--broadcast',
    ], contractsDir, { DEPLOYER_PRIVATE_KEY: deployerPrivateKey })
    const addresses = await deployedAddresses()
    const owner = await provider.getSigner(0)
    const usdc = await contractAt(owner, 'MockUSDC.sol/MockUSDC.json', addresses.MockUSDC)
    const identity = await contractAt(owner, 'MockERC8004Registry.sol/MockERC8004Registry.json', addresses.MockERC8004Registry)
    const legacyStaking = await contractAt(owner, 'AntseedStaking.sol/AntseedStaking.json', addresses.AntseedStaking)
    const sellerRegistry = await contractAt(owner, 'AntseedSellerRegistry.sol/AntseedSellerRegistry.json', addresses.AntseedSellerRegistry)
    const verifierRegistryContract = await contractAt(
      owner,
      'AntseedVerifierRegistry.sol/AntseedVerifierRegistry.json',
      addresses.AntseedVerifierRegistry,
    )
    const gate = await contractAt(owner, 'AntseedEmissionsGate.sol/AntseedEmissionsGate.json', addresses.AntseedEmissionsGate)
    const antsToken = await contractAt(owner, 'ANTSToken.sol/ANTSToken.json', addresses.ANTSToken)

    const registryClient = new node.VerifierRegistryClient({
      rpcUrl,
      contractAddress: addresses.AntseedVerifierRegistry,
      evmChainId: chainId,
    })
    const rewardsClient = new node.VerifierRewardsClient({
      rpcUrl,
      contractAddress: addresses.AntseedVerifierRewards,
      evmChainId: chainId,
    })
    const rewardedEpoch = await rewardsClient.firstRewardedEpoch()
    const genesis = BigInt(await gate.GENESIS())
    const epochDuration = BigInt(await gate.EPOCH_DURATION())
    await setTimestamp(provider, BigInt(auditTimestamp))
    check(await registryClient.currentEpoch() === rewardedEpoch, 'audit timestamp is not in the first rewarded epoch')

    step('starting an isolated bootstrap, seller, and buyer-role verifier')
    bootstrap = new node.DHTNode({
      peerId: node.toPeerId('0'.repeat(40)),
      port: 0,
      bootstrapNodes: [],
      reannounceIntervalMs: 60_000,
      operationTimeoutMs: 5_000,
      allowPrivateIPs: true,
    })
    await bootstrap.start()
    const bootstrapNodes = [{ host: '127.0.0.1', port: bootstrap.getPort() }]
    const paymentConfig = {
      enabled: true,
      paymentMethod: 'crypto',
      settlementIdleMs: 60_000,
      closeIdleMs: 120_000,
      defaultDepositAmountUSDC: '1000000',
      platformFeeRate: 0.05,
      rpcUrl,
      depositsAddress: addresses.AntseedDeposits,
      channelsAddress: addresses.AntseedChannels,
      stakingAddress: addresses.AntseedSellerRegistry,
      identityRegistryAddress: addresses.MockERC8004Registry,
      usdcAddress: addresses.MockUSDC,
      verifierRegistryAddress: addresses.AntseedVerifierRegistry,
      verifierPointsPolicyAddress: addresses.AntseedVerifierPointsPolicy,
      chainId,
      minBudgetPerRequest: '1',
      maxPerRequestUsdc: '1000000',
      maxReserveAmountUsdc: '10000000',
    }
    const sellerProvider = new DirectKbfProvider()
    sellerNode = new node.AntseedNode({
      role: 'seller',
      dataDir: sellerDir,
      dhtPort: 0,
      signalingPort: 0,
      bootstrapNodes,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      payments: paymentConfig,
    })
    sellerNode.registerProvider(sellerProvider)
    await sellerNode.start()
    verifierNode = new node.AntseedNode({
      role: 'buyer',
      dataDir: verifierDir,
      dhtPort: 0,
      bootstrapNodes,
      allowPrivateIPs: true,
      noOfficialBootstrap: true,
      requestTimeoutMs: 120_000,
      metadataFetchTimeoutMs: 5_000,
      payments: paymentConfig,
      verification: { sampleRate: 1 },
    })
    await verifierNode.start()
    check(sellerNode.identity, 'seller identity unavailable')
    check(verifierNode.identity, 'verifier identity unavailable')
    check(verifierNode.verificationStorage, 'verifier storage unavailable')

    const sellerAddress = sellerNode.identity.wallet.address
    const verifierAddress = verifierNode.identity.wallet.address
    await fundGas(provider, sellerAddress)
    await fundGas(provider, verifierAddress)
    await send(usdc.mint(sellerAddress, actorFundingUsdc))
    await send(usdc.mint(verifierAddress, actorFundingUsdc))
    await send(verifierRegistryContract.setVerifier(verifierAddress, true))

    step('registering and staking the seller, then funding the verifier buyer deposit')
    const agentId = 1n
    const sellerPrivateKey = sellerNode.identity.wallet.privateKey
    castSend(sellerPrivateKey, addresses.MockERC8004Registry, 'register()')
    castSend(sellerPrivateKey, addresses.MockUSDC, 'approve(address,uint256)', addresses.AntseedStaking, sellerStakeUsdc)
    castSend(sellerPrivateKey, addresses.AntseedStaking, 'stake(uint256,uint256)', agentId, sellerStakeUsdc)
    castSend(sellerPrivateKey, addresses.AntseedSellerRegistry, 'registerSeller(uint256)', agentId)
    check((await identity.ownerOf(agentId)).toLowerCase() === sellerAddress.toLowerCase(), 'seller identity owner mismatch')
    check(await legacyStaking.getAgentId(sellerAddress) === agentId, 'seller legacy stake binding mismatch')
    check(await sellerRegistry.getAgentId(sellerAddress) === agentId, 'seller registry binding mismatch')
    const buyerPaymentManager = verifierNode.buyerPaymentManager
    check(buyerPaymentManager, 'verifier buyer payment manager unavailable')
    await buyerPaymentManager.deposit(verifierDepositUsdc)

    step('discovering the registered seller service')
    let target
    try {
      target = await waitForValue(async () => {
        await sellerNode._announcer?.announce?.().catch(() => undefined)
        const peers = await verifierNode.discoverPeers(service)
        const discovered = peers.find((peer) => peer.peerId === sellerNode.peerId)
        return discovered?.onChainAgentId === Number(agentId) ? discovered : null
      }, 'seller discovery and on-chain enrichment')
    } catch {
      target = {
        peerId: sellerNode.peerId,
        lastSeen: Date.now(),
        providers: [sellerProvider.name],
        publicAddress: `127.0.0.1:${sellerNode.signalingPort}`,
        defaultInputUsdPerMillion: 1,
        defaultOutputUsdPerMillion: 1,
        onChainAgentId: Number(agentId),
      }
      step(`DHT enrichment timed out; using direct seller address ${target.publicAddress}`)
    }

    step('running 100 paid direct probes without a registry write')
    const reference = buildReference(fingerprints)
    const runId = auditRunner.createDirectAuditRunId({
      verifierAddress,
      targetPeerId: target.peerId,
      agentId: Number(agentId),
      service,
    })
    let observed
    try {
      observed = await auditRunner.executeDirectAuditObservation({
        node: verifierNode,
        storage: verifierNode.verificationStorage,
        verifierAddress,
        verifierPeerId: verifierNode.peerId,
        evidenceDir,
        minAuthenticatedProbeCount: 100,
        minimumStatisticalPower: 0.9,
        probeRequestTimeoutMs: 120_000,
        maxConcurrentProbeRequests: 2,
        warn: (message) => console.warn(`[direct-verifier-e2e] ${message}`),
      }, {
        runId,
        source: 'manual',
        epoch: rewardedEpoch,
        target,
        service,
        reference,
      })
    } catch (error) {
      const failures = verifierNode.verificationStorage.listDirectAuditProbes(runId)
        .filter((probe) => probe.failureReason)
        .reduce((counts, probe) => {
          counts[probe.failureReason] = (counts[probe.failureReason] ?? 0) + 1
          return counts
        }, {})
      console.error('[direct-verifier-e2e] discovered target capabilities:', target.capabilities ?? [])
      console.error('[direct-verifier-e2e] probe failure summary:', failures)
      throw error
    }
    check(await registryClient.epochCredits(rewardedEpoch, verifierAddress) === 0n, 'observation unexpectedly wrote a verifier credit')
    const preAttestationEvents = await registryClient.queryAttestations(Number(agentId), 0, 'latest')
    check(preAttestationEvents.length === 0, 'observation unexpectedly submitted an attestation')

    step('explicitly attesting the completed observation')
    const result = await auditRunner.attestCompletedDirectAudit({
      registryClient,
      storage: verifierNode.verificationStorage,
      signer: verifierNode.identity.wallet,
      warn: (message) => console.warn(`[direct-verifier-e2e] ${message}`),
      resolveTrafficShare: async ({ sellerAddress, serviceHash, epochWindow }) => ({
        source: 'direct-verifier-e2e',
        epoch: epochWindow.epoch,
        windowStartedAt: epochWindow.startedAt,
        windowEndedAt: epochWindow.endsAt,
        indexedBlock: 0,
        sellerAddress,
        serviceHash,
        serviceVolumeUsdc: 1n,
        sellerVolumeUsdc: 1n,
        modelShareBps: 10_000,
      }),
    }, observed.auditId)
    check(result.verdict === node.VERIFIER_VERDICT_DIFF, `expected DIFF, received ${result.verdict}`)
    check(result.credited === true, 'direct attestation did not receive an epoch credit')
    check(result.authenticatedProbeCount === 100, 'not all probes were authenticated and paid')
    check(sellerProvider.requestCount === 10, `expected 10 paid batches, received ${sellerProvider.requestCount}`)
    check(result.exchanges.every((exchange) => exchange.payment && exchange.responseAuth), 'evidence lacks payment or ResponseAuth records')
    const evidence = await directEvidence.verifyDirectAuditEvidenceFile(result.evidencePath, result.evidenceHash)
    check(evidence.result.verdict === 'DIFF', 'canonical evidence verdict mismatch')
    check(evidence.exchanges.length === 10, 'canonical evidence did not record every paid batch')

    const attestation = await registryClient.getAttestation(result.auditId)
    check(attestation.verifier.toLowerCase() === verifierAddress.toLowerCase(), 'attestation verifier mismatch')
    check(attestation.agentId === agentId, 'attestation agent mismatch')
    check(attestation.probeCount === 100, 'attestation probe count mismatch')
    check(await registryClient.epochCredits(rewardedEpoch, verifierAddress) === 1n, 'verifier epoch credit missing')
    const penaltyBps = await registryClient.servicePointsPenaltyBps(agentId, node.serviceHash(service))
    check(penaltyBps === 10_000, `expected full DIFF penalty, received ${penaltyBps}`)

    step('confirming event-backed routing visibility and settling seller payment')
    const routed = await waitForValue(async () => {
      await sellerNode._announcer?.announce?.().catch(() => undefined)
      const peers = await verifierNode.discoverPeers(service)
      const discovered = peers.find((peer) => peer.peerId === sellerNode.peerId)
      const verification = discovered?.modelVerification?.[service]
      return verification?.lastVerdict === node.VERIFIER_VERDICT_DIFF ? { discovered, verification } : null
    }, 'routing enrichment for the direct attestation')
    check(routed.verification.lifecycle === 'flagged', `unexpected routing lifecycle ${routed.verification.lifecycle}`)
    check(routed.verification.modelShareBps === 10_000, 'routing penalty did not match the direct attestation')
    await waitForValue(() => {
      const session = buyerPaymentManager.getActiveSession(target.peerId)
      return session && BigInt(session.authMax) > 0n ? session : null
    }, 'buyer receipt acknowledgement')
    const sellerPaymentManager = sellerNode._sellerPaymentManager
    check(sellerPaymentManager, 'seller payment manager unavailable')
    await sellerPaymentManager.settleSession(verifierNode.peerId)
    const depositsClient = new payments.DepositsClient({
      rpcUrl,
      contractAddress: addresses.AntseedDeposits,
      usdcAddress: addresses.MockUSDC,
      evmChainId: chainId,
    })
    const sellerPayout = await waitForValue(async () => {
      const balance = await depositsClient.getUSDCBalance(sellerAddress)
      return balance > 0n ? balance : null
    }, 'seller payout settlement')

    step('finalizing the epoch and claiming the verifier-only ANTS reward')
    await setTimestamp(provider, genesis + (rewardedEpoch + 1n) * epochDuration + 1n)
    const pendingReward = await rewardsClient.pendingVerifierReward(rewardedEpoch, verifierAddress)
    check(pendingReward > 0n, 'verifier reward is not pending after epoch finalization')
    const rewardTxHash = await rewardsClient.claimVerifierReward(verifierNode.identity.wallet, rewardedEpoch)
    const verifierAnts = BigInt(await antsToken.balanceOf(verifierAddress))
    check(verifierAnts === pendingReward, 'claimed ANTS balance does not match pending verifier reward')

    step('direct verifier lifecycle complete')
    console.log(JSON.stringify({
      rpcUrl,
      contracts: addresses,
      seller: { peerId: sellerNode.peerId, address: sellerAddress, agentId: agentId.toString() },
      verifier: { peerId: verifierNode.peerId, address: verifierAddress },
      audit: {
        auditId: result.auditId,
        verdict: 'DIFF',
        modelShareBps: result.modelShareBps,
        probeCount: result.probeCount,
        authenticatedProbeCount: result.authenticatedProbeCount,
        evidencePath: result.evidencePath,
        attestationTxHash: result.attestationTxHash,
        credited: result.credited,
      },
      routing: routed.verification,
      payments: { sellerPayoutUsdc: sellerPayout.toString() },
      rewards: {
        epoch: rewardedEpoch.toString(),
        pending: pendingReward.toString(),
        claimed: verifierAnts.toString(),
        txHash: rewardTxHash,
      },
    }, null, 2))
  } finally {
    if (verifierNode) await verifierNode.stop().catch(() => undefined)
    if (sellerNode) await sellerNode.stop().catch(() => undefined)
    if (bootstrap) await bootstrap.stop().catch(() => undefined)
    await rm(tempDir, { recursive: true, force: true })
    await stopProcess(anvil)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
