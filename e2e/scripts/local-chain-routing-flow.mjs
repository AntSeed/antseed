import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { AntseedNode, ChannelsClient, loadOrCreateIdentity, makeDepositsDomain, signSetOperator } from '@antseed/node';
import { BuyerProxy } from '../../apps/cli/dist/proxy/buyer-proxy.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const deployerKey = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
const temporary = await mkdtemp(join(tmpdir(), 'antseed-routing-chain-'));
const reservation = createServer();
reservation.listen(0, '127.0.0.1');
await once(reservation, 'listening');
const port = reservation.address().port;
await new Promise((resolve) => reservation.close(resolve));
const rpcUrl = `http://127.0.0.1:${port}`;
const anvil = spawn('anvil', ['--host', '127.0.0.1', '--port', String(port), '--chain-id', '31337', '--silent'], { stdio: ['ignore', 'ignore', 'pipe'] });
let anvilFailure;
anvil.on('error', (error) => { anvilFailure = error; });
anvil.stderr.on('data', () => {});
const nodes = [];
let proxy;

function run(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', timeout: 600_000 });
  if (result.status !== 0) throw new Error(`${command} failed: ${result.stderr}\n${result.stdout}`);
  return `${result.stdout}\n${result.stderr}`;
}

async function waitFor(check, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  let lastError;
  while (Date.now() < end) {
    try { const result = await check(); if (result) return result; }
    catch (error) { lastError = error; }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for ${label}: ${lastError ?? ''}`);
}

function provider(serviceId, content, inputTokens, outputTokens) {
  return {
    name: 'openai', services: [serviceId], maxConcurrency: 1, calls: 0,
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
    serviceApiProtocols: { [serviceId]: ['openai-chat-completions'] },
    getCapacity() { return { current: 0, max: 1 }; },
    async handleRequest(request) {
      this.calls++;
      assert.equal(JSON.parse(new TextDecoder().decode(request.body)).model, serviceId);
      return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ id: request.requestId, object: 'chat.completion', model: serviceId,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } })) };
    },
  };
}

try {
  await waitFor(async () => {
    if (anvilFailure) throw anvilFailure;
    const response = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }) });
    return (await response.json()).result === '0x7a69';
  }, 'isolated Anvil');
  console.log('[routing-flow] deploying contracts on isolated Anvil');
  const deployment = run('forge', ['script', 'script/Deploy.s.sol', '--rpc-url', rpcUrl, '--broadcast', '--slow', '--non-interactive',
    '--skip', 'test', '--skip', 'Upgrade', '--skip', 'DeployBaseMainnet', '--skip', 'DeployBaseSepolia', '--skip', 'DeployDiemStakingProxy'], join(root, 'packages/contracts'));
  const address = (name) => {
    const match = deployment.match(new RegExp(`${name}:\\s+(0x[0-9a-fA-F]{40})`));
    assert.ok(match, `deployment address for ${name}`);
    return match[1];
  };
  const addresses = { usdc: address('MockUSDC'), identity: address('MockERC8004Registry'),
    staking: address('AntseedStaking'), deposits: address('AntseedDeposits'), channels: address('AntseedChannels') };
  const send = (args, key = deployerKey) => run('cast', ['send', '--rpc-url', rpcUrl, '--private-key', key, ...args]);
  const buyerDir = join(temporary, 'buyer');
  const buyerIdentity = await loadOrCreateIdentity(buyerDir);
  const buyerAddress = buyerIdentity.wallet.address;
  send([buyerAddress, '--value', '2ether']);
  send([addresses.usdc, 'mint(address,uint256)', buyerAddress, '10000000']);
  const operatorSignature = await signSetOperator(buyerIdentity.wallet, makeDepositsDomain(31337, addresses.deposits), { operator: buyerAddress, nonce: 0n });
  send([addresses.deposits, 'setOperator(address,address,uint256,bytes)', buyerAddress, buyerAddress, '0', operatorSignature], buyerIdentity.wallet.privateKey);
  send([addresses.usdc, 'approve(address,uint256)', addresses.deposits, '10000000'], buyerIdentity.wallet.privateKey);
  send([addresses.deposits, 'deposit(address,uint256)', buyerAddress, '10000000'], buyerIdentity.wallet.privateKey);

  const commonPayments = { enabled: true, paymentMethod: 'crypto', rpcUrl, chainId: 31337,
    depositsAddress: addresses.deposits, channelsAddress: addresses.channels, stakingAddress: addresses.staking,
    identityRegistryAddress: addresses.identity, usdcAddress: addresses.usdc, minBudgetPerRequest: '1',
    maxPerRequestUsdc: '100000', maxReserveAmountUsdc: '1000000', settlementIdleMs: 300_000 };
  const fixtureProviders = [provider('route-classifier', 'fixture-model', 100, 20), provider('fixture-model', 'fixture answer', 200, 30)];
  const peers = [];
  const sellerIdentities = [];
  for (const [index, fixture] of fixtureProviders.entries()) {
    const dataDir = join(temporary, `seller-${index}`);
    const identity = await loadOrCreateIdentity(dataDir);
    sellerIdentities.push(identity);
    send([identity.wallet.address, '--value', '2ether']);
    send([addresses.usdc, 'mint(address,uint256)', identity.wallet.address, '50000000']);
    send([addresses.identity, 'register()'], identity.wallet.privateKey);
    send([addresses.usdc, 'approve(address,uint256)', addresses.staking, '50000000'], identity.wallet.privateKey);
    send([addresses.staking, 'stake(uint256,uint256)', String(index + 1), '50000000'], identity.wallet.privateKey);
    const node = new AntseedNode({ role: 'seller', dataDir, dhtPort: 0, signalingPort: 0,
      bootstrapNodes: [], noOfficialBootstrap: true, allowPrivateIPs: true, payments: commonPayments });
    node.registerProvider(fixture);
    nodes.push(node);
    await node.start();
    const serviceId = fixture.services[0];
    peers.push({ peerId: node.peerId, lastSeen: Date.now(), providers: ['openai'], services: [serviceId],
      evmAddress: identity.wallet.address, publicAddress: `127.0.0.1:${node.signalingPort}`, reputationScore: 100,
      providerPricing: { openai: { defaults: fixture.pricing.defaults, services: { [serviceId]: fixture.pricing.defaults } } },
      providerServiceApiProtocols: { openai: { services: { [serviceId]: ['openai-chat-completions'] } } } });
  }
  const buyer = new AntseedNode({ role: 'buyer', dataDir: buyerDir, dhtPort: 0, bootstrapNodes: [], noOfficialBootstrap: true,
    allowPrivateIPs: true, payments: commonPayments });
  nodes.push(buyer);
  const fakeRouter = {
    selectPeer() { return null; }, onResult() {},
    async selectRoute(request, available, _conversation, _preferences, _default, context) {
      if (JSON.parse(new TextDecoder().decode(request.body)).model !== 'fixture-auto') return null;
      assert.equal(context.candidates.length, 1);
      const response = await context.invokeService([{ role: 'user', content: 'Choose a model for this fixture' }]);
      const model = JSON.parse(new TextDecoder().decode(response.body)).choices[0].message.content;
      const choice = context.candidates.find((candidate) => candidate.serviceId === model);
      assert.ok(choice);
      return [{ ...choice, peer: available.find((peer) => peer.peerId === choice.peerId), request,
        reputation: 0, hasCachedInputPricing: false, minImageUsdPerImage: null }];
    },
  };
  buyer.setRouter(fakeRouter);
  await buyer.start();
  const events = [];
  buyer.on('payment:spend', (event) => events.push(event));
  proxy = new BuyerProxy({ node: buyer, port: 0, dataDir: buyerDir, routerKey: 'plugin:fixture', autoRouteServiceId: 'fixture-auto',
    routerTimeoutMs: 60_000, routingPreferences: { preferFreePeers: false, maxInputUsdPerMillion: 100, minTrustScore: 0,
      allowedPeerIds: [], blockedPeerIds: [], routerEnabled: true, dayPassOnDemandEnabled: false },
    maxPricing: { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } },
    routingService: { routerKey: 'plugin:fixture', peerId: peers[0].peerId, provider: 'openai', serviceId: 'route-classifier',
      allowPromptSharing: true, maxInputUsdPerMillion: 1, maxOutputUsdPerMillion: 2, maxCachedInputUsdPerMillion: 1,
      maxAdditionalAuthorizationUsdc: '1000', maxRequestsPerMinute: 2, maxInputBytes: 4096, maxOutputTokens: 32 } });
  proxy._getPeers = async () => peers;
  await proxy.start();
  console.log('[routing-flow] requesting router selection and downstream inference through the buyer proxy');
  const response = await fetch(`http://127.0.0.1:${proxy._server.address().port}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'fixture-auto', messages: [{ role: 'user', content: 'fixture prompt' }], max_tokens: 32 }),
    signal: AbortSignal.timeout(90_000),
  });
  const responseText = await response.text();
  assert.equal(response.status, 200, responseText);
  assert.equal(JSON.parse(responseText).choices[0].message.content, 'fixture answer');
  assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [1, 1]);
  await waitFor(() => events.some((event) => event.purpose === 'routing' && event.amountUsdc === '140'), 'routing authorization of 140 micro-USDC');
  const routeEvent = events.find((event) => event.purpose === 'routing' && event.amountUsdc === '140');
  assert.notEqual(routeEvent.requestId, routeEvent.parentRequestId);
  const routingChannel = buyer.buyerPaymentManager.getActiveSession(peers[0].peerId);
  assert.equal(routingChannel.authMax, '140');
  const records = (await readFile(join(buyerDir, 'routing-operations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(records.some((record) => record.parentRequestId === routeEvent.parentRequestId && record.outcome === 'succeeded'));
  const channels = new ChannelsClient({ rpcUrl, contractAddress: addresses.channels, evmChainId: 31337 });
  await waitFor(async () => (await channels.getSession(routingChannel.sessionId)).deposit > 0n, 'on-chain routing reserve');
  await channels.settle(sellerIdentities[0].wallet, routingChannel.sessionId, BigInt(routingChannel.authMax),
    routingChannel.latestMetadata, routingChannel.latestSpendingAuthSig);
  const settled = await channels.getSession(routingChannel.sessionId);
  assert.equal(settled.settled, 140n);
  console.log(JSON.stringify({ routingTokens: { input: 100, output: 20 }, routingSettledMicroUsdc: settled.settled.toString(),
    routingRequestId: routeEvent.requestId, inferenceRequestId: routeEvent.parentRequestId,
    providerCalls: fixtureProviders.map((fixture) => fixture.calls) }, null, 2));
  channels.destroy?.();
} finally {
  await proxy?.stop().catch(() => {});
  for (const node of nodes.reverse()) await node.stop().catch(() => {});
  anvil.kill('SIGTERM');
  await rm(temporary, { recursive: true, force: true });
}
