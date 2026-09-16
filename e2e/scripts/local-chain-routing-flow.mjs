import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { AntseedNode, ChannelsClient, createPerCallBillingModel, loadOrCreateIdentity, makeDepositsDomain, signSetOperator } from '@antseed/node';
import { BuyerProxy } from '../../apps/cli/dist/proxy/buyer-proxy.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const perCall = process.argv.includes('--per-call');
const invalidRoute = process.argv.includes('--invalid-route');
const routingFee = perCall ? 5000n : 140n;
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
      if (this.failureStatus) {
        const statusCode = this.failureStatus;
        this.failureStatus = undefined;
        return { requestId: request.requestId, statusCode, headers: {}, body: new TextEncoder().encode('{}') };
      }
      if (this.invalidClassification) {
        const body = this.invalidClassification;
        this.invalidClassification = undefined;
        return { requestId: request.requestId, statusCode: 200, headers: {}, body: new TextEncoder().encode(body) };
      }
      assert.equal(JSON.parse(new TextDecoder().decode(request.body)).model, serviceId);
      return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify({ id: request.requestId, object: 'chat.completion', model: serviceId,
          choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
          ...(this.omitUsage ? {} : { usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }) })) };
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
  if (perCall) {
    fixtureProviders[0].pricing = { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } };
    fixtureProviders[0].serviceUnitBillingModels = { 'route-classifier': { 'openai-chat-completions': createPerCallBillingModel('5000') } };
    fixtureProviders[0].omitUsage = true;
  }
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
      ...(fixture.serviceUnitBillingModels ? { providerServiceUnitBillingModels: { openai: { services: fixture.serviceUnitBillingModels } } } : {}),
      providerServiceApiProtocols: { openai: { services: { [serviceId]: ['openai-chat-completions'] } } } });
  }
  const buyer = new AntseedNode({ role: 'buyer', dataDir: buyerDir, dhtPort: 0, bootstrapNodes: [], noOfficialBootstrap: true,
    allowPrivateIPs: true, payments: commonPayments });
  nodes.push(buyer);
  const fakeRouter = {
    selectPeer() { return null; }, onResult() {},
    async selectRoute(request, _available, _conversation, _preferences, _default, context) {
      if (JSON.parse(new TextDecoder().decode(request.body)).model !== 'fixture-auto') return null;
      if (!context.routing.shouldRoute && context.routing.previousRoute) return [context.routing.previousRoute];
      assert.equal(context.candidates.length, 1);
      const parseResponse = (response) => {
        const model = JSON.parse(new TextDecoder().decode(response.body)).choices[0].message.content;
        const choice = context.candidates.find((candidate) => candidate.serviceId === model);
        return [{ peerId: choice?.peerId ?? peers[1].peerId, serviceId: model }];
      };
      const response = await context.invokeService([{ role: 'user', content: 'Choose a model for this fixture' }], parseResponse);
      return parseResponse(response);
    },
  };
  buyer.setRouter(fakeRouter);
  await buyer.start();
  const events = [];
  buyer.on('payment:spend', (event) => events.push(event));
  proxy = new BuyerProxy({ node: buyer, port: 0, dataDir: buyerDir, routerKey: 'plugin:fixture', autoRouteServiceId: 'fixture-auto',
    routerTimeoutMs: 60_000, routingPreferences: { preferFreePeers: false, maxInputUsdPerMillion: 100, minTrustScore: 0,
      allowedPeerIds: [], blockedPeerIds: [], routerEnabled: true },
    maxPricing: { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } },
    routingService: { routerKey: 'plugin:fixture', peerId: peers[0].peerId, provider: 'openai', serviceId: 'route-classifier',
      ...(perCall ? { billing: { kind: 'per_call', maxAmountMicroUsdc: '5000' } } : {}),
      allowPromptSharing: true, maxInputUsdPerMillion: 1, maxOutputUsdPerMillion: 2, maxCachedInputUsdPerMillion: 1,
      maxAdditionalAuthorizationUsdc: perCall ? '20000' : '1000', maxRequestsPerMinute: 10, maxInputBytes: 4096, maxOutputTokens: 32 } });
  proxy._getPeers = async () => peers;
  await proxy.start();
  console.log('[routing-flow] requesting router selection and downstream inference through the buyer proxy');
  const sendInference = async (messages, headers = {}, expectedStatus = 200) => {
    const response = await fetch(`http://127.0.0.1:${proxy._server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-vpr-session-id': 'routing-fixture', ...headers },
      body: JSON.stringify({ model: 'fixture-auto', messages, max_tokens: 32 }), signal: AbortSignal.timeout(90_000),
    });
    const responseText = await response.text();
    assert.equal(response.status, expectedStatus, responseText);
    if (expectedStatus === 200) assert.equal(JSON.parse(responseText).choices[0].message.content, 'fixture answer');
  };
  const initial = [{ role: 'user', content: 'fixture prompt' }];
  await sendInference(initial);
  assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [1, 1]);
  await waitFor(() => events.some((event) => event.purpose === 'routing' && event.amountUsdc === String(routingFee)), 'routing authorization');
  const routeEvent = events.find((event) => event.purpose === 'routing' && event.amountUsdc === String(routingFee));
  assert.notEqual(routeEvent.requestId, routeEvent.parentRequestId);
  const routingChannel = buyer.buyerPaymentManager.getActiveSession(peers[0].peerId);
  assert.equal(routingChannel.authMax, String(routingFee));
  const toolContinuation = [...initial, { role: 'assistant', content: 'working' }, { role: 'tool', tool_call_id: 'one', content: 'result' }];
  await sendInference(toolContinuation);
  assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [1, 2]);
  assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, String(routingFee));
  await sendInference([...toolContinuation, { role: 'assistant', content: 'fixture answer' }, { role: 'user', content: 'fixture continuation' }]);
  assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [2, 3]);
  assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, String(routingFee * 2n));
  const rewritten = [{ role: 'system', content: 'compacted summary' }, { role: 'user', content: 'fixture continuation' }];
  await sendInference(rewritten, { 'x-antseed-context-revision': '2' });
  assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [3, 4]);
  await sendInference(rewritten, { 'x-antseed-context-revision': '2', 'x-antseed-route-refresh': 'true' });
  assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [4, 5]);
  await waitFor(() => buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax === String(routingFee * 4n), 'four routing authorizations');
  await proxy._routingLog.flush();
  const records = (await readFile(join(buyerDir, 'routing-operations.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.ok(records.some((record) => record.parentRequestId === routeEvent.parentRequestId && record.outcome === 'succeeded'));
  const decisions = records.filter((record) => record.kind === 'selection');
  assert.deepEqual(decisions.map((record) => record.trigger), ['new-session', 'continuation', 'new-turn', 'context-rewrite', 'explicit']);
  assert.equal(decisions.length, 5);
  const operations = records.filter((record) => record.purpose === 'routing' && record.outcome === 'succeeded');
  assert.equal(operations.length, 4);
  assert.equal(new Set(operations.map((record) => record.requestId)).size, 4);
  assert.equal(new Set(operations.map((record) => record.parentRequestId)).size, 4);
  assert.ok(operations.every((record) => record.requestId !== record.parentRequestId));
  assert.doesNotMatch(JSON.stringify(records), /fixture prompt|compacted summary|fixture continuation/);
  if (perCall) {
    fixtureProviders[0].failureStatus = 503;
    await sendInference(rewritten, { 'x-vpr-session-id': 'routing-failure' }, 502);
    assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [5, 5]);
    assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, '20000');
    assert.equal(events.filter((event) => event.purpose === 'routing' && BigInt(event.amountUsdc) > 0n).length, 4);
    await sendInference(rewritten, { 'x-vpr-session-id': 'routing-failure' });
    assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, '25000');
    assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [6, 6]);
    fixtureProviders[0].invalidClassification = invalidRoute
      ? JSON.stringify({ choices: [{ message: { content: 'unadvertised-model' } }] }) : 'not-json';
    await sendInference(rewritten, { 'x-vpr-session-id': 'routing-invalid' }, 502);
    assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [7, 6]);
    assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, '25000');
    await sendInference(rewritten, { 'x-vpr-session-id': 'routing-invalid' }, 502);
    assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [7, 6]);
    assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, '25000');
    assert.equal(events.filter((event) => event.purpose === 'routing' && BigInt(event.amountUsdc) > 0n).length, 5);
  }
  const billableRoutingCalls = perCall ? 5 : 4;
  const settlementChannel = buyer.buyerPaymentManager.getActiveSession(peers[0].peerId);
  const channels = new ChannelsClient({ rpcUrl, contractAddress: addresses.channels, evmChainId: 31337 });
  await waitFor(async () => (await channels.getSession(routingChannel.sessionId)).deposit > 0n, 'on-chain routing reserve');
  await channels.settle(sellerIdentities[0].wallet, routingChannel.sessionId, BigInt(settlementChannel.authMax),
    settlementChannel.latestMetadata, settlementChannel.latestSpendingAuthSig);
  const settled = await channels.getSession(routingChannel.sessionId);
  assert.equal(settled.settled, routingFee * BigInt(billableRoutingCalls));
  console.log(JSON.stringify({ billingKind: perCall ? 'per_call' : 'token', billableRoutingCalls,
    routingTokens: perCall ? null : { input: 100, output: 20 }, routingSettledMicroUsdc: settled.settled.toString(),
    routingRequestId: routeEvent.requestId, inferenceRequestId: routeEvent.parentRequestId,
    providerCalls: fixtureProviders.map((fixture) => fixture.calls) }, null, 2));
  channels.destroy?.();
} finally {
  await proxy?.stop().catch(() => {});
  for (const node of nodes.reverse()) await node.stop().catch(() => {});
  anvil.kill('SIGTERM');
  await rm(temporary, { recursive: true, force: true });
}
