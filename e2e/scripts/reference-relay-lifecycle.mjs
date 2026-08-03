#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  NonceManager,
  Wallet,
  ZeroHash,
  getAddress,
  hexlify,
  keccak256,
  randomBytes,
} from 'ethers'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const contractsDir = join(repoRoot, 'packages', 'contracts')
const rpcUrl = process.env.RELAY_E2E_RPC_URL ?? 'http://127.0.0.1:18545'
const rpc = new URL(rpcUrl)
const anvilPort = rpc.port || '18545'
const chainId = 31337
const service = 'gpt-test'
const sellerChargeUsdc = 500n
const relayDepositUsdc = 5_000_000n
const treasuryFundingUsdc = 100_000_000n
const verifierEpochDurationSecs = 48 * 60 * 60

function step(message) {
  console.log(`\n[relay-e2e] ${message}`)
}

function check(condition, message) {
  if (!condition) throw new Error(message)
}

function requireCommand(command) {
  const result = spawnSync('which', [command], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`Required command not found: ${command}`)
}

function run(command, args, cwd = repoRoot) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: process.env })
  if (result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
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

async function artifact(relativePath) {
  const parsed = JSON.parse(await readFile(join(contractsDir, 'out', relativePath), 'utf8'))
  return { abi: parsed.abi, bytecode: parsed.bytecode.object }
}

async function deploy(owner, relativePath, args = []) {
  const compiled = await artifact(relativePath)
  const contract = await new ContractFactory(compiled.abi, compiled.bytecode, owner).deploy(...args)
  await contract.waitForDeployment()
  return contract
}

async function setTimestamp(provider, timestamp) {
  await provider.send('evm_setNextBlockTimestamp', [timestamp])
  await provider.send('evm_mine', [])
}

async function dispatchAcceleratedReferenceAudit({
  provider,
  auditRunner,
  runtime,
  planned,
  connectedRelays,
  setClock,
}) {
  const scheduledTimes = [...new Set(planned.jobs.map((job) => Math.floor(job.scheduledAt / 1_000)))]
    .sort((left, right) => left - right)
  let result = null
  for (const scheduledAt of scheduledTimes) {
    await setTimestamp(provider, scheduledAt)
    setClock(scheduledAt)
    result = await auditRunner.dispatchDueReferenceAuditJobs(runtime, planned.plan, connectedRelays)
  }
  await setTimestamp(provider, planned.plan.executeBefore)
  setClock(planned.plan.executeBefore)
  result = await auditRunner.dispatchDueReferenceAuditJobs(runtime, planned.plan, connectedRelays)
  const jobs = result.jobs
  return {
    ...result,
    succeededJobs: jobs.filter((job) => job.state === 'succeeded').length,
    failedJobs: jobs.filter((job) => job.state === 'failed').length,
  }
}

async function fundWallet(provider, wallet) {
  await provider.send('anvil_setBalance', [wallet.address, '0x3635c9adc5dea00000'])
}

function peerId(wallet) {
  return wallet.address.slice(2).toLowerCase()
}

function bytes32(byte) {
  return `0x${byte.repeat(32)}`
}

function buildReference(fingerprints) {
  const probes = Array.from({ length: 100 }, (_unused, index) => ({
    id: `p-${index.toString().padStart(3, '0')}`,
    name: `probe-${index.toString().padStart(3, '0')}`,
    domain: 'relay-e2e',
    template: `The relay test value ${index} is ___.`,
    consensus: index + 100,
    range: [0, 100_000],
    tolerance: { mode: 'absolute', value: 0.1 },
    advisoryConsensus: false,
  }))
  const reference = {
    version: 1,
    kind: 'kbf',
    referenceId: '',
    referenceModel: service,
    serviceAliases: [service],
    createdAt: '2026-07-31T12:00:00.000Z',
    source: 'generated',
    generator: { name: 'relay-e2e', version: '1', verifierKind: 'kbf', params: {} },
    queryProfile: fingerprints.createReferenceQueryProfile({ upstreamModel: service }),
    selfTest: {
      hamming: 0,
      total: probes.length,
      coverage: 1,
      errorRate: 0,
      outcomes: probes.map((probe) => ({ probeId: probe.id, answer: probe.consensus, match: 1 })),
    },
    probes,
    selectedProbeCount: 100,
    minimumMismatchDelta: 0.1,
    statisticalPower: fingerprints.computeBinomialPower({
      selfHamming: 0,
      selfTotal: probes.length,
      minimumMismatchDelta: 0.1,
    }).power,
    statisticalPowerEvidence: (() => {
      const evidence = fingerprints.computeBinomialPower({
        selfHamming: 0,
        selfTotal: probes.length,
        minimumMismatchDelta: 0.1,
      })
      return {
        test: 'one-sided-binomial',
        alpha: 0.05,
        clopperPearsonConfidence: 0.99,
        selfHamming: 0,
        selfTotal: probes.length,
        p0UpperBound: evidence.p0,
        alternativeMismatchRate: evidence.p1,
        criticalMismatchCount: evidence.criticalMismatchCount,
        power: evidence.power,
      }
    })(),
    contrasts: [],
  }
  reference.referenceId = fingerprints.computeReferenceId(reference)
  return fingerprints.validateKbfReferenceV1(reference)
}

function responseFor(reference, jobIndex, behavior, requestId) {
  const start = jobIndex * 10
  if (behavior === 'unparseable') {
    return {
      requestId,
      statusCode: 200,
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: 'no numeric answers' } }] })),
    }
  }
  const text = reference.probes.slice(start, start + 10).map((probe, offset) => {
    const answer = behavior === 'diff' ? probe.consensus + 1_000 : probe.consensus
    return `(${start + offset + 1}) ${answer}`
  }).join('\n')
  return {
    requestId,
    statusCode: 200,
    headers: { 'content-type': 'application/json' },
    body: new TextEncoder().encode(JSON.stringify({ choices: [{ message: { content: text } }] })),
  }
}

function contractJob(job, sellerAddress) {
  return {
    auditId: job.auditId,
    jobIndex: job.jobIndex,
    sellerPeerId: sellerAddress,
    serviceHash: job.serviceHash,
    requestHash: job.requestHash,
    jobSalt: job.jobSalt,
    executeAfter: job.executeAfter,
    executeBefore: job.executeBefore,
  }
}

function claimFromStored(job, sellerAddress) {
  return {
    job: contractJob(job, sellerAddress),
    jobProof: job.positionalProof,
    assignment: {
      auditId: job.auditId,
      jobIndex: job.jobIndex,
      attempt: job.assignmentAttempt,
      relayBuyer: job.relayBuyerAddress,
      payoutPerJobUsdc: 1_000n,
      executeAfter: job.executeAfter,
      executeBefore: job.executeBefore,
    },
    verifierSignature: job.assignmentSignature,
    responseAuthPayload: `0x${Buffer.from(job.responseAuthPayload).toString('hex')}`,
  }
}

async function contentAddressedServer() {
  const objects = new Map()
  const server = createServer(async (request, response) => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    if (request.method === 'PUT') {
      const body = Buffer.concat(chunks)
      objects.set(request.url, body)
      response.writeHead(201).end()
      return
    }
    const body = objects.get(request.url)
    if (!body) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(body)
  })
  await new Promise((resolveReady) => server.listen(0, '127.0.0.1', resolveReady))
  const address = server.address()
  const baseUrl = `http://127.0.0.1:${address.port}`
  return {
    upload: async (bytes) => {
      const path = `/objects/${keccak256(bytes)}`
      const response = await fetch(`${baseUrl}${path}`, { method: 'PUT', body: bytes })
      if (!response.ok) throw new Error(`evidence upload failed: ${response.status}`)
      return `${baseUrl}${path}`
    },
    download: async (uri) => new Uint8Array(await (await fetch(uri)).arrayBuffer()),
    close: async () => new Promise((resolveClose) => server.close(resolveClose)),
  }
}

async function main() {
  requireCommand('anvil')
  requireCommand('forge')
  requireCommand('pnpm')

  step('building KBF, Node, CLI, and Solidity artifacts')
  run('pnpm', ['--filter', '@antseed/fingerprints', 'run', 'build'])
  run('pnpm', ['--filter', '@antseed/node', 'run', 'build'])
  run('pnpm', ['--filter', '@antseed/cli', 'run', 'build'])
  run('forge', ['build'], contractsDir)

  const [node, payments, fingerprints, auditRunner, auditDuration, attestation, relayClaims] = await Promise.all([
    import('@antseed/node'),
    import('@antseed/node/payments'),
    import('@antseed/fingerprints'),
    import('../../apps/cli/dist/verifier/audit-runner.js'),
    import('../../apps/cli/dist/verifier/audit-duration.js'),
    import('../../apps/cli/dist/verifier/attestation.js'),
    import('../../apps/cli/dist/cli/commands/relay/claims.js'),
  ])

  const anvil = spawn('anvil', [
    '--host', rpc.hostname,
    '--port', anvilPort,
    '--silent',
    '--timestamp', '1800000000',
  ], { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] })
  const provider = new JsonRpcProvider(rpcUrl)
  const tempDir = await mkdtemp(join(tmpdir(), 'antseed-reference-relay-e2e-'))
  let verifierStorage = null
  const relayStoragePaths = []
  let relayStorages = []

  try {
    await waitForRpc(provider)
    const owner = new NonceManager(await provider.getSigner(0))
    const ownerAddress = await owner.getAddress()
    const verifier = Wallet.createRandom().connect(provider)
    const seller = Wallet.createRandom().connect(provider)
    const relays = Array.from({ length: 3 }, () => Wallet.createRandom().connect(provider))
    const operators = Array.from({ length: 3 }, () => Wallet.createRandom().connect(provider))
    for (const wallet of [verifier, seller, ...relays, ...operators]) await fundWallet(provider, wallet)

    step('deploying payment, identity, verifier, and relay treasury contracts')
    const usdc = await deploy(owner, 'MockUSDC.sol/MockUSDC.json')
    const registry = await deploy(owner, 'AntseedRegistry.sol/AntseedRegistry.json')
    const identity = await deploy(owner, 'MockERC8004Registry.sol/MockERC8004Registry.json')
    const staking = await deploy(owner, 'AntseedStaking.sol/AntseedStaking.json', [await usdc.getAddress(), await registry.getAddress()])
    const deposits = await deploy(owner, 'AntseedDeposits.sol/AntseedDeposits.json', [await usdc.getAddress()])
    const channels = await deploy(owner, 'AntseedChannels.sol/AntseedChannels.json', [await registry.getAddress()])
    const initialBlock = await provider.getBlock('latest')
    const gate = await deploy(owner, 'AntseedVerifierRegistry.t.sol/VerifierTestGate.json', [
      await registry.getAddress(),
      initialBlock.timestamp - 60,
      verifierEpochDurationSecs,
    ])
    const verifierRegistryContract = await deploy(owner, 'AntseedVerifierRegistry.sol/AntseedVerifierRegistry.json', [
      await registry.getAddress(),
      await gate.getAddress(),
    ])
    const treasury = await deploy(owner, 'AntseedRelayTreasury.sol/AntseedRelayTreasury.json', [
      await usdc.getAddress(),
      await verifierRegistryContract.getAddress(),
      1_000_000,
      100_000_000,
      1_000_000_000,
    ])

    await (await registry.setIdentityRegistry(await identity.getAddress())).wait()
    await (await registry.setStaking(await staking.getAddress())).wait()
    await (await registry.setDeposits(await deposits.getAddress())).wait()
    await (await registry.setChannels(await channels.getAddress())).wait()
    await (await deposits.setRegistry(await registry.getAddress())).wait()
    await (await verifierRegistryContract.setRelayTreasury(await treasury.getAddress())).wait()
    await (await verifierRegistryContract.setVerifier(verifier.address, true)).wait()
    await (await identity.setOwner(1, seller.address)).wait()
    await (await usdc.mint(await treasury.getAddress(), treasuryFundingUsdc)).wait()
    await (await usdc.mint(seller.address, 10_000_000n)).wait()

    const stakingClient = new payments.StakingClient({
      rpcUrl,
      contractAddress: await staking.getAddress(),
      usdcAddress: await usdc.getAddress(),
      evmChainId: chainId,
    })
    const depositsClient = new payments.DepositsClient({
      rpcUrl,
      contractAddress: await deposits.getAddress(),
      usdcAddress: await usdc.getAddress(),
      evmChainId: chainId,
    })
    const channelsClient = new payments.ChannelsClient({
      rpcUrl,
      contractAddress: await channels.getAddress(),
      evmChainId: chainId,
    })
    const registryClient = new payments.VerifierRegistryClient({
      rpcUrl,
      contractAddress: await verifierRegistryContract.getAddress(),
      evmChainId: chainId,
    })
    const treasuryClient = new payments.RelayTreasuryClient({
      rpcUrl,
      contractAddress: await treasury.getAddress(),
      evmChainId: chainId,
    })

    await stakingClient.stake(seller, 1, 10_000_000n)
    const depositsDomain = payments.makeDepositsDomain(chainId, await deposits.getAddress())
    for (let index = 0; index < relays.length; index++) {
      await (await usdc.mint(relays[index].address, relayDepositUsdc)).wait()
      const nonce = await depositsClient.getOperatorNonce(relays[index].address)
      const signature = await payments.signSetOperator(relays[index], depositsDomain, {
        operator: operators[index].address,
        nonce,
      })
      await (await deposits.setOperator(
        relays[index].address,
        operators[index].address,
        nonce,
        signature,
      )).wait()
      await depositsClient.deposit(relays[index], relays[index].address, relayDepositUsdc)
      relayStoragePaths.push(join(tempDir, `relay-${index}.db`))
      relayStorages.push(new node.VerificationStorage(relayStoragePaths[index]))
    }

    const reference = buildReference(fingerprints)
    const verifierDbPath = join(tempDir, 'verifier.db')
    verifierStorage = new node.VerificationStorage(verifierDbPath)
    const relayByPeer = new Map(relays.map((wallet, index) => [peerId(wallet), { wallet, operator: operators[index], index }]))
    const verifierRegistryAddress = await verifierRegistryContract.getAddress()
    const treasuryAddress = await treasury.getAddress()
    const connectedRelays = relays.map((wallet) => ({
      peerId: peerId(wallet),
      chainId: String(chainId),
      registryAddress: verifierRegistryAddress,
      treasuryAddress,
      minPayoutPerJobUsdc: 0n,
      maxConcurrentJobs: 1,
      activeJobs: 0,
      connectedAt: Date.now(),
    }))
    const target = {
      peerId: peerId(seller),
      lastSeen: Date.now(),
      providers: ['mock'],
      onChainAgentId: 1,
      metadata: { providers: [{ provider: 'mock', services: [service] }] },
      providerPricing: {
        mock: {
          defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 },
          services: { [service]: { inputUsdPerMillion: 1, outputUsdPerMillion: 1 } },
        },
      },
    }
    const channelsDomain = payments.makeChannelsDomain(chainId, await channels.getAddress())
    const channelStates = new Map()
    let sellerTransactions = Promise.resolve()
    let clockSecs = initialBlock.timestamp

    const serializeSellerTransaction = (operation) => {
      const result = sellerTransactions.then(operation, operation)
      sellerTransactions = result.catch(() => undefined)
      return result
    }

    async function paySeller(relayInfo, offer) {
      const key = `${offer.job.auditId}:${relayInfo.wallet.address}`
      let state = channelStates.get(key)
      if (!state) {
        const salt = hexlify(randomBytes(32))
        const channelId = payments.computeChannelId(relayInfo.wallet.address, seller.address, salt)
        const maxAmount = 100_000n
        const deadline = BigInt(offer.job.executeBefore + 86_400)
        const reserveSig = await payments.signReserveAuth(relayInfo.wallet, channelsDomain, {
          channelId,
          maxAmount,
          deadline,
        })
        await serializeSellerTransaction(() => channelsClient.reserve(
          seller,
          relayInfo.wallet.address,
          salt,
          maxAmount,
          deadline,
          reserveSig,
        ))
        state = { channelId, cumulative: 0n, requests: 0n }
        channelStates.set(key, state)
      }
      state.cumulative += sellerChargeUsdc
      state.requests += 1n
      const metadata = {
        cumulativeInputTokens: state.requests * 10n,
        cumulativeOutputTokens: state.requests * 10n,
        cumulativeRequestCount: state.requests,
        services: [{
          serviceId: payments.getServiceMetadataId(service),
          cumulativeAmount: state.cumulative,
          cumulativeInputTokens: state.requests * 10n,
          cumulativeCachedInputTokens: 0n,
          cumulativeOutputTokens: state.requests * 10n,
          cumulativeRequestCount: state.requests,
        }],
      }
      const encodedMetadata = payments.encodeMetadata(metadata)
      const spendingSig = await payments.signSpendingAuth(relayInfo.wallet, channelsDomain, {
        channelId: state.channelId,
        cumulativeAmount: state.cumulative,
        metadataHash: payments.computeMetadataHash(metadata),
      })
      await serializeSellerTransaction(() => channelsClient.settle(
        seller,
        state.channelId,
        state.cumulative,
        encodedMetadata,
        spendingSig,
      ))
      return {
        channelId: state.channelId,
        spendingAuth: {
          channelId: state.channelId,
          cumulativeAmount: state.cumulative.toString(),
          metadataHash: payments.computeMetadataHash(metadata),
          metadata: encodedMetadata,
          spendingAuthSig: spendingSig,
        },
      }
    }

    async function executeRelayJob(behavior, relayPeerId, offer) {
      const relayInfo = relayByPeer.get(relayPeerId)
      if (!relayInfo) return { status: 'error', error: 'unknown_relay' }
      if (behavior === 'undetermined' && offer.job.jobIndex % 2 === 1) {
        return { status: 'error', error: 'timeout' }
      }
      const request = node.decodeHttpRequest(Buffer.from(offer.requestBytesBase64, 'base64'))
      const responseBehavior = behavior === 'undetermined' ? 'unparseable' : behavior
      const response = responseFor(reference, offer.job.jobIndex, responseBehavior, request.requestId)
      const payment = await paySeller(relayInfo, offer)
      const responseAuth = node.createResponseAuthPayload({
        request,
        response,
        buyerPeerId: relayPeerId,
        sellerPeerId: peerId(seller),
        advertisedService: service,
        provider: 'mock',
        responseStartedAt: clockSecs * 1_000 + offer.job.jobIndex,
        responseCompletedAt: clockSecs * 1_000 + offer.job.jobIndex + 10,
        channelId: payment.channelId,
      }, seller)
      const responseBytes = node.encodeHttpResponse(response)
      const responseAuthPayload = node.encodeContractResponseAuthPayload(responseAuth)
      const timestamp = Date.now()
      relayStorages[relayInfo.index].persistRelayEntitlement({
        auditId: offer.job.auditId,
        jobIndex: offer.job.jobIndex,
        relayPeerId,
        relayBuyerAddress: relayInfo.wallet.address,
        registryAddress: offer.registryAddress,
        treasuryAddress: offer.treasuryAddress,
        job: { ...offer.job },
        positionalProof: offer.jobProof,
        assignment: { ...offer.assignment },
        verifierSignature: offer.verifierSignature,
        responseBytes,
        responseAuthPayload,
        payoutUsdc: BigInt(offer.payoutPerJobUsdc),
        sellerChargeUsdc,
        paymentMetadata: { spendingAuth: payment.spendingAuth, requestHash: offer.job.requestHash },
        forceClaimAvailableAt: offer.auditSnapshot.forceClaimAvailableAt,
        forceClaimDeadline: offer.auditSnapshot.forceClaimDeadline,
        state: 'awaiting-attestation',
        claimTxHash: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      })
      return {
        status: 'ok',
        responseBytesBase64: Buffer.from(responseBytes).toString('base64'),
        responseAuthPayloadBase64: Buffer.from(responseAuthPayload).toString('base64'),
        sellerChargeUsdc: sellerChargeUsdc.toString(),
        paymentMetadata: { spendingAuth: payment.spendingAuth, requestHash: offer.job.requestHash },
      }
    }

    const scenarios = [
      { name: 'same', behavior: 'same', expected: 'SAME', shareBps: 0, omitClaim: true },
      { name: 'diff-one', behavior: 'diff', expected: 'DIFF', shareBps: 2_500 },
      { name: 'diff-two', behavior: 'diff', expected: 'DIFF', shareBps: 2_500 },
      { name: 'same-recovery', behavior: 'same', expected: 'SAME', shareBps: 0 },
      { name: 'undetermined', behavior: 'undetermined', expected: 'UNDETERMINED', shareBps: 0 },
    ]
    let firstAttestation = null
    let firstOmitted = null
    let priorPenalty = 0

    for (const scenario of scenarios) {
      step(`running ${scenario.name} reference audit`)
      const block = await provider.getBlock('latest')
      clockSecs = block.timestamp
      const runtime = {
        registryClient,
        treasuryClient,
        storage: verifierStorage,
        signer: verifier,
        chainId: String(chainId),
        registryAddress: await verifierRegistryContract.getAddress(),
        treasuryAddress: await treasury.getAddress(),
        runRelayJob: (relayPeerId, offer) => executeRelayJob(scenario.behavior, relayPeerId, offer),
        now: () => clockSecs * 1_000,
        sleep: async () => {},
      }
      const planned = await auditRunner.planAndCommitReferenceAudit(runtime, {
        target,
        service,
        reference,
        executionProfile: reference.queryProfile,
        flatRelayFeeUsdc: 1_000n,
        jobTimeoutMs: 30_000,
        durationMs: auditDuration.MIN_AUDIT_DURATION_MS,
        commitBufferSecs: auditRunner.AUDIT_COMMIT_BUFFER_SECS,
        safetyMarginSecs: 0,
      })
      const sellerBalanceBefore = await usdc.balanceOf(seller.address)
      const operatorBalancesBefore = await Promise.all(operators.map((operator) => usdc.balanceOf(operator.address)))
      const dispatched = await dispatchAcceleratedReferenceAudit({
        provider,
        auditRunner,
        runtime,
        planned,
        connectedRelays,
        setClock: (timestamp) => { clockSecs = timestamp },
      })
      const expectedSuccessfulJobs = scenario.behavior === 'undetermined' ? 5 : 10
      const failureSummary = dispatched.jobs
        .filter((job) => job.state !== 'succeeded')
        .map((job) => `${job.jobIndex}:${job.failureKind ?? 'unknown'}:${job.failureMessage ?? 'unknown'}`)
        .join(', ')
      check(
        dispatched.succeededJobs === expectedSuccessfulJobs,
        `${scenario.name}: unexpected successful job count (${dispatched.succeededJobs}/${expectedSuccessfulJobs}); ${failureSummary}`,
      )
      check(dispatched.failedJobs === 10 - expectedSuccessfulJobs, `${scenario.name}: failed committed jobs were reassigned`)
      const sellerBalanceAfterDispatch = await usdc.balanceOf(seller.address)
      check(
        sellerBalanceAfterDispatch - sellerBalanceBefore === sellerChargeUsdc * BigInt(expectedSuccessfulJobs),
        `${scenario.name}: relay-to-seller channel settlement mismatch`,
      )

      if (scenario.name === 'same') {
        const jobs = verifierStorage.listAuditJobs(planned.plan.auditId)
        const claims = jobs.map((job) => claimFromStored(job, seller.address))
        const malformedSuffix = claims[1].responseAuthPayload.endsWith('00') ? '01' : '00'
        claims[1] = {
          ...claims[1],
          responseAuthPayload: `${claims[1].responseAuthPayload.slice(0, -2)}${malformedSuffix}`,
        }
        const malformedInput = {
          auditId: planned.plan.auditId,
          agentId: 1,
          serviceHash: planned.plan.targetServiceHash,
          targetSalt: planned.plan.targetSalt,
          verdict: payments.VERIFIER_VERDICT_SAME,
          modelShareBps: 0,
          metrics: {
            windowStartedAt: planned.plan.executeAfter,
            windowEndedAt: planned.plan.executeBefore,
            eligibleAttempts: 10,
            successfulAttempts: 10,
            p50TtftMs: 0,
            p95TtftMs: 0,
            p50OutputTokensPerSecondMilli: 0,
            schemaVersion: 1,
            observationsRoot: planned.plan.auditJobRoot,
          },
          evidenceHash: bytes32('ab'),
          evidenceUri: '',
          relayClaims: claims,
        }
        await registryClient.submitAttestation(verifier, malformedInput).then(
          () => { throw new Error('malformed relay batch unexpectedly succeeded') },
          () => undefined,
        )
        check(await registryClient.relayJobPaidBitmap(planned.plan.auditId) === 0n, 'malformed batch partially paid relays')
        const afterMalformed = await Promise.all(operators.map((operator) => usdc.balanceOf(operator.address)))
        check(afterMalformed.every((balance, index) => balance === operatorBalancesBefore[index]), 'malformed batch changed operator balances')

        const omittedJob = jobs[9]
        const relayInfo = relayByPeer.get(omittedJob.relayPeerId)
        firstOmitted = { relayIndex: relayInfo.index, auditId: planned.plan.auditId, jobIndex: 9 }
      }

      verifierStorage.close()
      verifierStorage = new node.VerificationStorage(verifierDbPath)
      const storageForAttestation = {
        getAuditPlan: (...args) => verifierStorage.getAuditPlan(...args),
        listAuditJobs: (...args) => verifierStorage.listAuditJobs(...args).map((job) => (
          scenario.omitClaim && job.jobIndex === 9
            ? { ...job, state: 'null', failureKind: 'omitted-valid-claim', failureMessage: 'force-claim coverage' }
            : job
        )),
        updateAuditState: (...args) => verifierStorage.updateAuditState(...args),
        computeModelShareBps: () => scenario.shareBps,
      }
      const attested = await attestation.attestReferenceAudit({
        registryClient,
        treasuryClient,
        storage: storageForAttestation,
        signer: verifier,
        dataDir: tempDir,
        now: () => clockSecs * 1_000,
        refreshUsageAttribution: async () => true,
      }, { auditId: planned.plan.auditId, reference, wait: false })
      check(attested.verdict === scenario.expected, `${scenario.name}: expected ${scenario.expected}, got ${attested.verdict}`)

      const operatorBalancesAfter = await Promise.all(operators.map((operator) => usdc.balanceOf(operator.address)))
      const paidJobs = scenario.omitClaim ? 9 : expectedSuccessfulJobs
      const operatorDelta = operatorBalancesAfter.reduce(
        (sum, balance, index) => sum + (balance - operatorBalancesBefore[index]),
        0n,
      )
      check(operatorDelta === planned.plan.payoutPerJobUsdc * BigInt(paidJobs), `${scenario.name}: treasury payout mismatch`)
      check(await usdc.balanceOf(verifier.address) === 0n, 'verifier paid seller or received relay funds')

      const penalty = await registryClient.agentPointsPenaltyBps(1)
      if (scenario.expected === 'DIFF') check(penalty === scenario.shareBps, `${scenario.name}: points penalty mismatch`)
      if (scenario.name === 'same-recovery') check(penalty === 0, 'SAME did not clear the points penalty')
      if (scenario.name === 'undetermined') check(penalty === priorPenalty, 'UNDETERMINED changed the current points penalty')
      priorPenalty = penalty

      const events = await registryClient.queryAttestations(1)
      const lifecycle = node.derivePeerModelVerification(planned.plan.targetServiceHash, events)
      if (scenario.name === 'diff-one') check(lifecycle.lifecycle === 'flagged', 'first DIFF did not flag the service')
      if (scenario.name === 'diff-two') check(lifecycle.lifecycle === 'suspended', 'second DIFF did not suspend the service')
      if (scenario.name === 'same-recovery') check(lifecycle.lifecycle === 'verified', 'later SAME did not restore routing')
      if (scenario.name === 'undetermined') check(lifecycle.lifecycle === 'verified', 'UNDETERMINED changed routing lifecycle')
      if (scenario.name === 'same') firstAttestation = attested
    }

    step('restarting relay storage and force-claiming the omitted valid job')
    const omittedStorage = relayStorages[firstOmitted.relayIndex]
    omittedStorage.close()
    relayStorages[firstOmitted.relayIndex] = new node.VerificationStorage(relayStoragePaths[firstOmitted.relayIndex])
    const reopenedRelayStorage = relayStorages[firstOmitted.relayIndex]
    const omittedEntitlement = reopenedRelayStorage.getRelayEntitlement(firstOmitted.auditId, firstOmitted.jobIndex)
    check(omittedEntitlement, 'omitted relay entitlement did not survive restart')
    const latestBlock = await provider.getBlock('latest')
    const forceAt = Math.max(latestBlock.timestamp + 1, omittedEntitlement.forceClaimAvailableAt + 1)
    await setTimestamp(provider, forceAt)
    clockSecs = forceAt
    await relayClaims.reconcileRelayEntitlements(reopenedRelayStorage, registryClient, forceAt)
    check(
      reopenedRelayStorage.getRelayEntitlement(firstOmitted.auditId, firstOmitted.jobIndex).state === 'challenge-available',
      'relay entitlement did not recover to challenge-available',
    )
    await relayClaims.forceClaimEntitlement(
      reopenedRelayStorage,
      registryClient,
      operators[firstOmitted.relayIndex],
      omittedEntitlement,
      forceAt,
    )
    check(await registryClient.isRelayJobPaid(firstOmitted.auditId, firstOmitted.jobIndex), 'force claim did not pay omitted job')

    step('publishing canonical evidence through a content-addressed local server')
    const contentServer = await contentAddressedServer()
    try {
      const published = await attestation.publishEvidenceOnce({
        runtime: {
          registryClient,
          treasuryClient,
          storage: {
            getAuditPlan: (...args) => verifierStorage.getAuditPlan(...args),
            updateAuditState: (...args) => verifierStorage.updateAuditState(...args),
          },
          signer: verifier,
          dataDir: tempDir,
        },
        auditId: firstAttestation.plan.auditId,
        evidence: firstAttestation.evidence,
        upload: contentServer.upload,
        download: contentServer.download,
      })
      check(published.uri.includes('/objects/0x'), 'evidence URI is not content-addressed')
      await attestation.publishEvidenceOnce({
        runtime: {
          registryClient,
          treasuryClient,
          storage: {
            getAuditPlan: (...args) => verifierStorage.getAuditPlan(...args),
            updateAuditState: (...args) => verifierStorage.updateAuditState(...args),
          },
          signer: verifier,
          dataDir: tempDir,
        },
        auditId: firstAttestation.plan.auditId,
        evidence: firstAttestation.evidence,
        upload: contentServer.upload,
        download: contentServer.download,
      }).then(
        () => { throw new Error('evidence published more than once') },
        (error) => check(/already published/.test(error.message), 'unexpected second-publication failure'),
      )
    } finally {
      await contentServer.close()
    }

    step('proving treasury underfunding aborts before commitment and relay dispatch')
    const availableTreasuryBalance = await treasury.availableBalance()
    check(availableTreasuryBalance > 0n, 'treasury has no unlocked balance for underfunding test')
    await (await treasury.withdraw(ownerAddress, availableTreasuryBalance)).wait()
    let dispatchCount = 0
    const underfundedRuntime = {
      registryClient,
      treasuryClient,
      storage: verifierStorage,
      signer: verifier,
      chainId: String(chainId),
      registryAddress: await verifierRegistryContract.getAddress(),
      treasuryAddress: await treasury.getAddress(),
      runRelayJob: async () => {
        dispatchCount += 1
        return { status: 'error', error: 'unexpected_dispatch' }
      },
      now: () => clockSecs * 1_000,
      sleep: async () => {},
    }
    await auditRunner.planAndCommitReferenceAudit(underfundedRuntime, {
      target,
      service,
      reference,
      executionProfile: reference.queryProfile,
      flatRelayFeeUsdc: 1_000n,
      jobTimeoutMs: 30_000,
      durationMs: auditDuration.MIN_AUDIT_DURATION_MS,
      commitBufferSecs: auditRunner.AUDIT_COMMIT_BUFFER_SECS,
      safetyMarginSecs: 0,
    }).then(
      () => { throw new Error('underfunded audit unexpectedly committed') },
      (error) => check(/treasury|balance|fund/i.test(error.message), `unexpected underfunding failure: ${error.message}`),
    )
    check(dispatchCount === 0, 'underfunded audit dispatched seller traffic')

    console.log('\n[relay-e2e] PASS')
    console.log(JSON.stringify({
      scenarios: scenarios.map(({ name, expected }) => ({ name, expected })),
      forceClaimAuditId: firstOmitted.auditId,
      verifier: verifier.address,
      seller: seller.address,
      relayBuyers: relays.map((wallet) => wallet.address),
      relayOperators: operators.map((wallet) => wallet.address),
      contracts: {
        registry: await verifierRegistryContract.getAddress(),
        treasury: await treasury.getAddress(),
        deposits: await deposits.getAddress(),
        channels: await channels.getAddress(),
      },
    }, null, 2))
  } finally {
    verifierStorage?.close()
    for (const storage of relayStorages) {
      try { storage.close() } catch {}
    }
    await provider.destroy()
    anvil.kill('SIGTERM')
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
