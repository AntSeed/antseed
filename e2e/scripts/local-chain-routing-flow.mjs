import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { AntseedNode, ChannelsClient, createRoutingServiceMetadata, createUnitBillingModel, loadOrCreateIdentity, makeDepositsDomain, signSetOperator } from '@antseed/node';
import { BuyerProxy } from '../../apps/cli/dist/proxy/buyer-proxy.js';
import localPlugin from '../../plugins/router-local/dist/index.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const perCall = process.argv.includes('--per-call');
const invalidRoute = process.argv.includes('--invalid-route');
const concurrent = process.argv.includes('--concurrent');
const samePeer = process.argv.includes('--same-peer');
const rankedFallback = process.argv.includes('--ranked-fallback');
if (rankedFallback && !samePeer) throw new Error('--ranked-fallback requires --same-peer');
const routingFee = perCall ? 5000n : 140n;
const channelTotal = (routingCalls, inferenceCalls) => routingFee * BigInt(routingCalls) + (samePeer ? 260n * BigInt(inferenceCalls) : 0n);
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
    name: 'openai', services: [serviceId], maxConcurrency: 4, calls: 0, content,
    pricing: { defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } },
    serviceApiProtocols: { [serviceId]: ['openai-chat-completions'] },
    getCapacity() { return { current: 0, max: 4 }; },
    async handleRequest(request) {
      this.calls++;
      const pause = this.pauseNext;
      this.pauseNext = undefined;
      if (pause) {
        pause.started.resolve();
        await pause.release.promise;
      }
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
      const requestBody = JSON.parse(new TextDecoder().decode(request.body));
      this.lastRequestBody = requestBody;
      assert.equal(requestBody.service ?? requestBody.model, serviceId);
      this.validateRequest?.(requestBody);
      if (this.delayMs) await sleep(this.delayMs);
      return { requestId: request.requestId, statusCode: 200, headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(request.path === '/v1/route' ? { version: 1, recommendations: JSON.parse(this.content), ...(this.omitUsage ? {} : { usage: { input_tokens: inputTokens, output_tokens: outputTokens } }) } : { id: request.requestId, object: 'chat.completion', model: serviceId,
          choices: [{ index: 0, message: { role: 'assistant', content: this.content }, finish_reason: 'stop' }],
          ...(this.omitUsage ? {} : { usage: { prompt_tokens: inputTokens, completion_tokens: outputTokens, total_tokens: inputTokens + outputTokens } }) })) };
    },
    async handleRequestStream(request, callbacks) {
      if (!JSON.parse(new TextDecoder().decode(request.body)).stream) return this.handleRequest(request);
      const response = await this.handleRequest(request);
      const body = JSON.parse(new TextDecoder().decode(response.body));
      const data = new TextEncoder().encode(`data: ${JSON.stringify({ ...body, choices: [{ index: 0, delta: { content: this.content }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`);
      const start = { ...response, headers: { 'content-type': 'text/event-stream', 'x-antseed-streaming': '1' }, body: new Uint8Array() };
      callbacks.onResponseStart(start);
      callbacks.onResponseChunk({ requestId: request.requestId, data, done: false });
      if (this.streamRelease) await this.streamRelease.promise;
      callbacks.onResponseChunk({ requestId: request.requestId, data: new Uint8Array(), done: true });
      return { ...start, body: data };
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
  fixtureProviders[0].serviceCapabilities = { 'route-classifier': { routing: true } };
  fixtureProviders[1].serviceCapabilities = { 'fixture-model': { reasoning: true, reasoningEfforts: ['high'] } };
  fixtureProviders[0].serviceApiProtocols = { 'route-classifier': ['antseed-routing'] };
  fixtureProviders[0].serviceRouting = { 'route-classifier': createRoutingServiceMetadata({ type: 'object', properties: {}, additionalProperties: false }) };
  if (perCall) {
    fixtureProviders[0].pricing = { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } };
    fixtureProviders[0].serviceUnitBillingModels = { 'route-classifier': { 'antseed-routing': createUnitBillingModel('5000') } };
    fixtureProviders[0].omitUsage = true;
  }
  const peers = [];
  const sellerIdentities = [];
  let failedInferenceCalls = 0;
  const sellerProviders = samePeer ? [{
    ...fixtureProviders[0], services: ['route-classifier', 'fixture-model', ...(rankedFallback ? ['unavailable-fixture'] : [])], maxConcurrency: 2,
    serviceCapabilities: { ...fixtureProviders[0].serviceCapabilities, ...fixtureProviders[1].serviceCapabilities },
    pricing: { defaults: fixtureProviders[0].pricing.defaults, services: {
      'route-classifier': fixtureProviders[0].pricing.defaults, 'fixture-model': fixtureProviders[1].pricing.defaults,
      ...(rankedFallback ? { 'unavailable-fixture': { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } } : {}),
    } },
    serviceApiProtocols: { 'route-classifier': ['antseed-routing'], 'fixture-model': ['openai-chat-completions'],
      ...(rankedFallback ? { 'unavailable-fixture': ['openai-chat-completions'] } : {}) },
    getCapacity() { return { current: 0, max: 2 }; },
    handleRequest(request) {
      const input = JSON.parse(new TextDecoder().decode(request.body));
      const model = input.service ?? input.model;
      if (model === 'unavailable-fixture') {
        failedInferenceCalls++;
        return { requestId: request.requestId, statusCode: 503, headers: {}, body: new TextEncoder().encode('{}') };
      }
      return fixtureProviders[model === 'route-classifier' ? 0 : 1].handleRequest(request);
    },
    handleRequestStream(request, callbacks) {
      const input = JSON.parse(new TextDecoder().decode(request.body));
      const model = input.service ?? input.model;
      if (model === 'unavailable-fixture') return this.handleRequest(request);
      return fixtureProviders[model === 'route-classifier' ? 0 : 1].handleRequestStream(request, callbacks);
    },
  }] : fixtureProviders;
  for (const [index, fixture] of sellerProviders.entries()) {
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
    peers.push({ peerId: node.peerId, lastSeen: Date.now(), providers: ['openai'], services: fixture.services,
      evmAddress: identity.wallet.address, publicAddress: `127.0.0.1:${node.signalingPort}`, reputationScore: 100,
      providerPricing: { openai: { defaults: fixture.pricing.defaults, services: fixture.pricing.services
        ?? Object.fromEntries(fixture.services.map((serviceId) => [serviceId, fixture.pricing.defaults])) } },
      ...(fixture.serviceUnitBillingModels ? { providerServiceUnitBillingModels: { openai: { services: fixture.serviceUnitBillingModels } } } : {}),
      ...(fixture.serviceCapabilities ? { providerServiceCapabilities: { openai: { services: fixture.serviceCapabilities } } } : {}),
      ...(fixture.serviceRouting ? { providerServiceRouting: { openai: { services: fixture.serviceRouting } } } : {}),
      providerServiceApiProtocols: { openai: { services: fixture.serviceApiProtocols } } });
  }
  const buyer = new AntseedNode({ role: 'buyer', dataDir: buyerDir, dhtPort: 0, bootstrapNodes: [], noOfficialBootstrap: true,
    allowPrivateIPs: true, payments: commonPayments });
  nodes.push(buyer);
  fixtureProviders[0].content = JSON.stringify([{ serviceId: 'fixture-model', inference: { reasoningEffort: 'high' } }]);
  fixtureProviders[0].validateRequest = (payload) => {
    assert.equal(payload.version, 1);
    assert.deepEqual(payload.candidates, [{ peerId: peers[samePeer ? 0 : 1].peerId, serviceId: 'fixture-model',
      reasoningEfforts: ['high'], inputUsdPerMillion: 1, cachedInputUsdPerMillion: null, outputUsdPerMillion: 2 },
      ...(rankedFallback ? [{ peerId: peers[0].peerId, serviceId: 'unavailable-fixture',
        reasoningEfforts: ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'],
        inputUsdPerMillion: 0, cachedInputUsdPerMillion: null, outputUsdPerMillion: 0 }] : [])]);
    assert.ok(payload.request.body.model === undefined || payload.request.body.model === 'fixture-model');
    assert.equal(payload.request.path, '/v1/chat/completions');
  };
  buyer.setRouter(await localPlugin.createRouter({}));
  await buyer.start();
  const events = [];
  buyer.on('payment:spend', (event) => events.push(event));
  proxy = new BuyerProxy({ node: buyer, port: 0, dataDir: buyerDir, routerKey: 'plugin:local',
    selection: { kind: 'router', service: { peerId: peers[0].peerId, provider: 'openai', serviceId: 'route-classifier' } },
    requestTimeoutMs: 60_000, routingPreferences: { preferFreePeers: false, maxInputUsdPerMillion: 100, minTrustScore: 0,
      allowedPeerIds: [], blockedPeerIds: [] },
    maxPricing: { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } },
  });
  proxy._getPeers = async () => peers;
  await proxy.start();
  console.log('[routing-flow] requesting router selection and downstream inference through the buyer proxy');
  const sendInference = async (messages, headers = {}, expectedStatus = 200, model) => {
    const response = await fetch(`http://127.0.0.1:${proxy._server.address().port}/v1/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-antseed-routing-mode': 'router', 'x-vpr-session-id': 'routing-fixture', ...headers },
      body: JSON.stringify({ model, messages, max_tokens: 32, reasoning_effort: 'low' }), signal: AbortSignal.timeout(90_000),
    });
    const responseText = await response.text();
    assert.equal(response.status, expectedStatus, responseText);
    if (expectedStatus === 200) assert.equal(JSON.parse(responseText).choices[0].message.content, 'fixture answer');
  };
  const initial = [{ role: 'user', content: 'fixture prompt' }];
  await sendInference(initial);
  assert.equal(fixtureProviders[1].lastRequestBody.reasoning_effort, 'high');
  assert.equal(fixtureProviders[1].lastRequestBody.max_tokens, 32);
  assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [1, 1]);
  await waitFor(() => events.some((event) => event.purpose === 'routing' && event.amountUsdc === String(routingFee)), 'routing authorization');
  const routeEvent = events.find((event) => event.purpose === 'routing' && event.amountUsdc === String(routingFee));
  assert.notEqual(routeEvent.requestId, routeEvent.parentRequestId);
  const routingChannel = buyer.buyerPaymentManager.getActiveSession(peers[0].peerId);
  assert.equal(routingChannel.authMax, String(channelTotal(1, 1)));
  const toolContinuation = [...initial, { role: 'assistant', content: 'working' }, { role: 'tool', tool_call_id: 'one', content: 'result' }];
  await sendInference(toolContinuation);
  assert.equal(fixtureProviders[1].lastRequestBody.reasoning_effort, 'high');
  assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [1, 2]);
  assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, String(channelTotal(1, 2)));
  await sendInference([...toolContinuation, { role: 'assistant', content: 'fixture answer' }, { role: 'user', content: 'fixture continuation' }], {}, 200, 'fixture-model');
  assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [2, 3]);
  assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, String(channelTotal(2, 3)));
  const rewritten = [{ role: 'system', content: 'compacted summary' }, { role: 'user', content: 'fixture next task' }];
  await sendInference(rewritten);
  assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [3, 4]);
  rewritten[1].content = 'fixture final task';
  await sendInference(rewritten);
  assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [4, 5]);
  await waitFor(() => buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax === String(channelTotal(4, 5)), 'four routing authorizations');
  const operations = events.filter((event) => event.purpose === 'routing' && BigInt(event.amountUsdc) > 0n);
  assert.equal(operations.length, 4);
  assert.equal(new Set(operations.map((record) => record.requestId)).size, 4);
  assert.equal(new Set(operations.map((record) => record.parentRequestId)).size, 4);
  assert.ok(operations.every((record) => record.requestId !== record.parentRequestId));
  await proxy._conversations.flush();
  const conversations = JSON.parse(await readFile(join(buyerDir, 'conversations.json'), 'utf8')).conversations;
  const conversation = conversations.find((record) => record.sessionKey === 'routing-fixture');
  assert.ok(conversation);
  assert.equal(conversation.routingSpentUsdc, String(routingFee * 4n));
  assert.equal(BigInt(conversation.spentUsdc), events.reduce((total, event) => total + BigInt(event.amountUsdc), 0n));
  assert.equal(conversation.requestCount, 5);
  if (concurrent) {
    const pause = { started: Promise.withResolvers(), release: Promise.withResolvers() };
    fixtureProviders[0].pauseNext = pause;
    const held = sendInference(rewritten, { 'x-vpr-session-id': 'concurrent-chat-a' });
    let secondFinished = false;
    let second;
    try {
      await pause.started.promise;
      second = sendInference(rewritten, { 'x-vpr-session-id': 'concurrent-chat-b' }).then(() => { secondFinished = true; });
      await waitFor(() => secondFinished, 'second classification finishing while the first remains open', 10_000);
    } finally {
      pause.release.resolve();
      await Promise.all([held, second]);
    }
    assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [6, 7]);
    assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, String(channelTotal(6, 7)));
    await proxy._conversations.flush();
    const concurrentConversations = JSON.parse(await readFile(join(buyerDir, 'conversations.json'), 'utf8')).conversations;
    for (const sessionKey of ['concurrent-chat-a', 'concurrent-chat-b']) {
      const record = concurrentConversations.find((entry) => entry.sessionKey === sessionKey);
      assert.equal(record.routingSpentUsdc, String(routingFee));
      assert.equal(record.requestCount, 1);
    }
    if (samePeer) {
      const started = Promise.withResolvers();
      fixtureProviders[1].streamRelease = Promise.withResolvers();
      let streamFinished = false;
      const streaming = buyer.sendRequestStream(peers[0], {
        requestId: 'held-inference-stream', method: 'POST', path: '/v1/chat/completions',
        headers: { 'content-type': 'application/json', 'x-antseed-provider': 'openai' },
        body: new TextEncoder().encode(JSON.stringify({ model: 'fixture-model', messages: initial, stream: true })),
      }, { onResponseStart() {}, onResponseChunk() { started.resolve(); } }).then(() => { streamFinished = true; });
      let routed;
      try {
        await Promise.race([started.promise, streaming.then(() => { throw new Error('Inference stream closed before delivering a chunk'); })]);
        let routingFinished = false;
        routed = sendInference(rewritten, { 'x-vpr-session-id': 'during-stream' }).then(() => { routingFinished = true; });
        await waitFor(() => routingFinished, 'classification finishing while same-peer inference stream remains open', 10_000);
        assert.equal(streamFinished, false);
      } finally {
        fixtureProviders[1].streamRelease.resolve();
        await Promise.all([streaming, routed]);
      }
      assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [7, 9]);
      assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, String(channelTotal(7, 9)));
    }
  }
  let billableRoutingCalls = concurrent ? (samePeer ? 7 : 6) : 4;
  if (rankedFallback) {
    const callsBefore = fixtureProviders.map((fixture) => fixture.calls);
    fixtureProviders[0].content = JSON.stringify([
      { serviceId: 'unavailable-fixture', peerId: peers[0].peerId },
      { serviceId: 'fixture-model' },
    ]);
    await sendInference(initial, { 'x-vpr-session-id': 'ranked-fallback' });
    await sendInference(toolContinuation, { 'x-vpr-session-id': 'ranked-fallback' });
    billableRoutingCalls++;
    assert.equal(failedInferenceCalls, 1);
    assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [callsBefore[0] + 1, callsBefore[1] + 2]);
    assert.equal(events.filter((event) => event.purpose === 'routing' && BigInt(event.amountUsdc) > 0n).length, billableRoutingCalls);
    assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, String(channelTotal(billableRoutingCalls, fixtureProviders[1].calls)));
  }
  if (perCall && !concurrent) {
    const [routingCallsBefore, inferenceCallsBefore] = fixtureProviders.map((fixture) => fixture.calls);
    fixtureProviders[0].failureStatus = 503;
    await sendInference(rewritten, { 'x-vpr-session-id': 'routing-failure' }, 502);
    assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [routingCallsBefore + 1, inferenceCallsBefore]);
    assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, String(channelTotal(billableRoutingCalls, inferenceCallsBefore)));
    assert.equal(events.filter((event) => event.purpose === 'routing' && BigInt(event.amountUsdc) > 0n).length, billableRoutingCalls);
    await sendInference(rewritten, { 'x-vpr-session-id': 'routing-failure' });
    billableRoutingCalls++;
    assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, String(channelTotal(billableRoutingCalls, inferenceCallsBefore + 1)));
    assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [routingCallsBefore + 2, inferenceCallsBefore + 1]);
    const invalidContent = JSON.stringify([{ serviceId: 'fixture-model' }, { serviceId: 'unadvertised-model' }]);
    fixtureProviders[0].invalidClassification = invalidRoute
      ? JSON.stringify({ version: 1, recommendations: JSON.parse(invalidContent) }) : 'not-json';
    await sendInference(rewritten, { 'x-vpr-session-id': 'routing-invalid' }, 502);
    assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [routingCallsBefore + 3, inferenceCallsBefore + 1]);
    assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, String(channelTotal(billableRoutingCalls, inferenceCallsBefore + 1)));
    await sendInference(rewritten, { 'x-vpr-session-id': 'routing-invalid' }, 502);
    assert.deepEqual(fixtureProviders.map((fixture) => fixture.calls), [routingCallsBefore + 3, inferenceCallsBefore + 1]);
    assert.equal(buyer.buyerPaymentManager.getActiveSession(peers[0].peerId).authMax, String(channelTotal(billableRoutingCalls, inferenceCallsBefore + 1)));
    assert.equal(events.filter((event) => event.purpose === 'routing' && BigInt(event.amountUsdc) > 0n).length, billableRoutingCalls);
  }
  const settlementChannel = buyer.buyerPaymentManager.getActiveSession(peers[0].peerId);
  const channels = new ChannelsClient({ rpcUrl, contractAddress: addresses.channels, evmChainId: 31337 });
  await waitFor(async () => (await channels.getSession(routingChannel.sessionId)).deposit > 0n, 'on-chain routing reserve');
  await channels.settle(sellerIdentities[0].wallet, routingChannel.sessionId, BigInt(settlementChannel.authMax),
    settlementChannel.latestMetadata, settlementChannel.latestSpendingAuthSig);
  const settled = await channels.getSession(routingChannel.sessionId);
  assert.equal(settled.settled, channelTotal(billableRoutingCalls, fixtureProviders[1].calls));
  console.log(JSON.stringify({ selectionKind: 'model-only',
    billingKind: perCall ? 'per_call' : 'token', billableRoutingCalls,
    samePeer, rankedFallback, failedInferenceCalls, routingTokens: perCall ? null : { input: 100, output: 20 }, channelSettledMicroUsdc: settled.settled.toString(),
    routingRequestId: routeEvent.requestId, inferenceRequestId: routeEvent.parentRequestId,
    providerCalls: fixtureProviders.map((fixture) => fixture.calls) }, null, 2));
  channels.destroy?.();
} finally {
  await proxy?.stop().catch(() => {});
  for (const node of nodes.reverse()) await node.stop().catch(() => {});
  anvil.kill('SIGTERM');
  await rm(temporary, { recursive: true, force: true });
}
