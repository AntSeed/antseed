#!/usr/bin/env node

import { spawn, spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import {
  Contract,
  ContractFactory,
  JsonRpcProvider,
  Wallet,
  getAddress,
} from 'ethers'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..', '..')
const contractsDir = join(repoRoot, 'packages', 'contracts')
const rpcUrl = process.env.AUDIT_E2E_RPC_URL ?? 'http://127.0.0.1:18545'
const rpc = new URL(rpcUrl)
const anvilPort = rpc.port || '18545'

function step(message) {
  console.log(`\n[audit-e2e] ${message}`)
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

function asBytesSignature(signature) {
  return signature.startsWith('0x') ? signature : `0x${signature}`
}

async function main() {
  requireCommand('anvil')
  requireCommand('forge')
  requireCommand('pnpm')

  step('building the three TypeScript layers and Solidity artifacts')
  run('pnpm', ['--filter', '@antseed/fingerprints', 'run', 'build'])
  run('pnpm', ['--filter', '@antseed/node', 'run', 'build'])
  run('pnpm', ['--filter', '@antseed/cli', 'run', 'build'])
  run('forge', ['build'], contractsDir)

  const [{
    VerifierRegistryClient,
    buildResponseAuthSigningBytes,
    createResponseAuthPayload,
    serviceHash,
  }, fingerprints, auditVerify, auditCommand, packWriter] = await Promise.all([
    import('@antseed/node'),
    import('@antseed/fingerprints'),
    import('../../apps/cli/dist/verifier/audit-verify.js'),
    import('../../apps/cli/dist/cli/commands/audit/verify.js'),
    import('../../apps/cli/dist/verifier/pack-writer.js'),
  ])

  const anvil = spawn('anvil', ['--host', rpc.hostname, '--port', anvilPort, '--silent'], {
    cwd: repoRoot,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const provider = new JsonRpcProvider(rpcUrl)
  const tempDir = await mkdtemp(join(tmpdir(), 'antseed-audit-e2e-'))

  try {
    await waitForRpc(provider)
    const owner = await provider.getSigner(0)
    const verifierAddress = await owner.getAddress()

    step('deploying registry, identity, deposits, epoch clock, and verifier registry')
    const central = await deploy(owner, 'AntseedRegistry.sol/AntseedRegistry.json')
    const identityRegistry = await deploy(owner, 'MockERC8004Registry.sol/MockERC8004Registry.json')
    const deposits = await deploy(owner, 'MockDeposits.sol/MockDeposits.json')
    const epochClock = await deploy(owner, 'MockEpochClock.sol/MockEpochClock.json')
    const verifierRegistry = await deploy(
      owner,
      'AntseedVerifierRegistry.sol/AntseedVerifierRegistry.json',
      [await central.getAddress()],
    )

    await (await central.setIdentityRegistry(await identityRegistry.getAddress())).wait()
    await (await central.setDeposits(await deposits.getAddress())).wait()
    await (await central.setEmissions(await epochClock.getAddress())).wait()
    await (await verifierRegistry.setVerifier(verifierAddress, true)).wait()
    await (await verifierRegistry.setMinProbeCount(1)).wait()
    await (await verifierRegistry.setAuditCooldown(0)).wait()

    const buyer = Wallet.createRandom().connect(provider)
    const operator = Wallet.createRandom().connect(provider)
    const sellers = Array.from({ length: 3 }, () => Wallet.createRandom().connect(provider))
    for (const wallet of [buyer, operator, ...sellers]) {
      await provider.send('anvil_setBalance', [wallet.address, '0x56bc75e2d63100000'])
    }
    await (await deposits.setOperator(buyer.address, operator.address)).wait()

    const agentIds = []
    for (const seller of sellers) {
      const identityAsSeller = new Contract(
        await identityRegistry.getAddress(),
        (await artifact('MockERC8004Registry.sol/MockERC8004Registry.json')).abi,
        seller,
      )
      const agentId = await identityAsSeller.getFunction('register()').staticCall()
      await (await identityAsSeller.getFunction('register()')()).wait()
      agentIds.push(Number(agentId))
    }

    const service = 'audit-e2e-model'
    const probes = [
      { id: 'p1', name: 'alpha', domain: 'math', template: 'What is one? ___', consensus: 1, range: [0, 2], tolerance: { mode: 'absolute', value: 0.01 } },
      { id: 'p2', name: 'beta', domain: 'math', template: 'What is two? ___', consensus: 2, range: [1, 3], tolerance: { mode: 'absolute', value: 0.01 } },
      { id: 'p3', name: 'gamma', domain: 'math', template: 'What is three? ___', consensus: 3, range: [2, 4], tolerance: { mode: 'absolute', value: 0.01 } },
    ]
    const probeSet = {
      probeSetId: fingerprints.computeProbeSetId(service, probes),
      service,
      probes,
      nonce: 'audit-e2e-nonce-'.padEnd(64, '0'),
      createdAt: new Date().toISOString(),
    }
    const probeCommitment = fingerprints.computeProbeCommitment(probeSet)
    const plans = fingerprints.buildStealthChatRequests(service, probeSet, { maxProbesPerRequest: 3 })
    if (plans.length !== 1) throw new Error(`Expected one stealth request plan, received ${plans.length}`)

    const client = new VerifierRegistryClient({
      rpcUrl,
      contractAddress: await verifierRegistry.getAddress(),
    })

    step('committing probes, producing real seller signatures, and anchoring one batch')
    await client.commitProbeSet(owner, probeCommitment)
    await provider.send('evm_increaseTime', [1])
    await provider.send('evm_mine', [])

    const records = []
    const signingPayloads = []
    const observations = []
    const evidenceSellers = []
    const responseText = '1 2 3'
    const responseBody = new TextEncoder().encode(JSON.stringify({
      choices: [{ message: { role: 'assistant', content: responseText } }],
    }))

    for (let index = 0; index < sellers.length; index += 1) {
      const seller = sellers[index]
      const requestId = `audit-e2e-${index}`
      const requestBody = { ...plans[0].body, max_tokens: 64 }
      const request = {
        requestId,
        method: 'POST',
        path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(requestBody)),
      }
      const response = {
        requestId,
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        body: responseBody,
      }
      const auth = createResponseAuthPayload({
        request,
        response,
        buyerPeerId: buyer.address,
        sellerPeerId: seller.address,
        advertisedService: service,
        provider: 'audit-e2e',
        responseStartedAt: 1_800_000_000_000 + index,
        responseCompletedAt: 1_800_000_000_100 + index,
      }, seller)
      const { signature: _signature, ...unsigned } = auth
      const answers = fingerprints.extractAnswersFreeText(responseText, probes)
      records.push({
        agentId: BigInt(agentIds[index]),
        requestHash: auth.requestHash,
        responseHash: auth.responseHash,
        responseAuthSig: asBytesSignature(auth.signature),
      })
      signingPayloads.push(buildResponseAuthSigningBytes(unsigned))
      observations.push({
        sellerPeerId: seller.address,
        agentId: agentIds[index],
        answers,
        requestIds: [requestId],
        responseAuthHashes: [{ requestHash: auth.requestHash, responseHash: auth.responseHash }],
      })
      evidenceSellers.push({ requestId, request, response, auth, answers })
    }

    const anchor = await client.anchorExchangeBatch(owner, {
      probeCommitment,
      records,
      signingPayloads,
      recordProbeCounts: [3, 3, 3],
    })

    const cohortOptions = {
      alpha: 0.05,
      minConsensusProbes: 1,
      minCoverage: 1,
      epsilon: 0.02,
      minConsensusSellers: 3,
    }
    const cohort = fingerprints.computeCohortVerdicts(observations, probes, cohortOptions)
    if (cohort.verdicts.some((entry) => entry.verdict !== 'SAME')) {
      throw new Error(`Expected SAME cohort verdicts: ${JSON.stringify(cohort.verdicts)}`)
    }

    const pack = {
      version: 1,
      service,
      verifierAddress,
      probeSet,
      sellers: observations.map((observation, index) => {
        const run = evidenceSellers[index]
        const verdict = cohort.verdicts.find((entry) => entry.agentId === observation.agentId)
        return {
          ...observation,
          verdict: verdict.verdict,
          cohortVerdict: verdict.verdict,
          stats: verdict.stats,
          carrierCount: 1,
          fullyAuthenticated: true,
          exchanges: [{
            requestId: run.requestId,
            request: {
              method: run.request.method,
              path: run.request.path,
              headers: run.request.headers,
              bodyBase64: Buffer.from(run.request.body).toString('base64'),
            },
            response: {
              statusCode: run.response.statusCode,
              headers: run.response.headers,
              bodyBase64: Buffer.from(run.response.body).toString('base64'),
            },
            responseAuth: run.auth,
          }],
        }
      }),
      cohort,
      cohortOptions,
      maxProbesPerRequest: 3,
      createdAt: new Date().toISOString(),
    }
    const evidenceHash = fingerprints.computeEvidenceHash(pack)
    const packPath = await packWriter.writeAuditPack(tempDir, probeCommitment, pack)

    step('submitting three attestations, revealing probes, and claiming carrier credits')
    for (const agentId of agentIds) {
      await client.submitAttestation(owner, {
        agentId,
        serviceHash: serviceHash(service),
        verdict: 1,
        evidenceHash,
        probeCommitment,
        batchRoot: anchor.batchRoot,
        probeCount: 3,
        cohortSize: 3,
      })
    }
    const revealTx = await client.revealProbeSet(owner, {
      probeCommitment,
      probeSetJson: fingerprints.canonicalProbeSetJson(probeSet),
      packUri: 'https://packs.example.com/audit-e2e.json',
    })
    await client.claimDelegateCredits(operator, {
      verifier: verifierAddress,
      probeCommitment,
      buyer: buyer.address,
    })

    const accrued = await client.commitmentDelegateAccrued(verifierAddress, probeCommitment, buyer.address)
    const claimed = await client.commitmentDelegateClaimed(verifierAddress, probeCommitment, buyer.address)
    const delegateCredits = await client.epochDelegateCredits(1, operator.address)
    if (accrued !== 9 || claimed !== 9 || delegateCredits !== 9) {
      throw new Error(`Unexpected delegate credits: accrued=${accrued}, claimed=${claimed}, epoch=${delegateCredits}`)
    }

    step('decoding chain calldata and independently recomputing the complete audit')
    const { anchor: fetchedAnchor, reveal } = await auditCommand.fetchAnchorAndReveal(
      provider,
      await verifierRegistry.getAddress(),
      { txHash: anchor.txHash, fromBlock: 0 },
    )
    if (getAddress(fetchedAnchor.verifier) !== getAddress(verifierAddress)) {
      throw new Error('Decoded verifier address mismatch')
    }
    if (reveal.packUri !== 'https://packs.example.com/audit-e2e.json') {
      throw new Error('Decoded pack URI mismatch')
    }
    const attestations = await auditCommand.fetchLatestAttestations(client, pack.sellers, service)
    const report = auditVerify.verifyAudit({
      probeCommitment,
      records: fetchedAnchor.records,
      onChainBatchRoot: fetchedAnchor.batchRoot,
      revealedProbeSetJson: reveal.probeSetJson,
      pack,
      attestations,
    })
    if (!report.ok) {
      throw new Error(`Independent audit verification failed: ${JSON.stringify(report, null, 2)}`)
    }

    console.log(`\n[audit-e2e] PASS: ${records.length} signed exchanges, ${agentIds.length} attestations, 9 delegate credits`)
    console.log(`[audit-e2e] pack: ${packPath}`)
    console.log(`[audit-e2e] anchor tx: ${anchor.txHash}`)
    console.log(`[audit-e2e] reveal tx: ${revealTx}`)
  } finally {
    await provider.destroy()
    anvil.kill('SIGTERM')
    await rm(tempDir, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack : error)
  process.exitCode = 1
})
