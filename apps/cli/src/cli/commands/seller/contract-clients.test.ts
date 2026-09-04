import assert from 'node:assert/strict';
import test from 'node:test';
import { Interface, ZeroAddress, type AbstractSigner } from 'ethers';
import { CliSellerPoolsClient, CliSellerPoolsRewardsClient, CliSellerRegistryClient, CliAntsTokenClient, collectPositionIds, registerSellerBinding, requireSellerBinding } from '../../seller-contract-clients.js';
import { requireCryptoConfig } from '../../payment-utils.js';
import type { AntseedConfig } from '../../../config/types.js';

const address = '0x0000000000000000000000000000000000000011';
const contractAddress = '0x0000000000000000000000000000000000000022';
const config = { rpcUrl: 'http://127.0.0.1:1', contractAddress, evmChainId: 31337 };

test('CLI reads slashing estimates directly without an SDK extension', async () => {
  const client = new CliSellerPoolsClient({ ...config, antsTokenAddress: contractAddress });
  const abi = new Interface(['function earlyExitSlashBps(uint256) view returns (uint256)']);
  Object.defineProperty(client, '_provider', { value: {
    call: async (transaction: { data: string }) => {
      const call = abi.parseTransaction(transaction)!;
      assert.equal(call.name, 'earlyExitSlashBps');
      assert.equal(call.args[0], 7n);
      return abi.encodeFunctionResult(call.name, [2500n]);
    },
  } });
  assert.ok(Object.hasOwn(CliSellerPoolsClient.prototype, 'earlyExitSlashBps'));
  assert.equal(await client.earlyExitSlashBps(7), 2500);
});

test('registration distinguishes legacy fallback, persists explicitly, and is idempotent', async () => {
  let legacy = true;
  let registered = false;
  let writes = 0;
  const registry = {
    getAgentId: async () => legacy || registered ? 7 : 0,
    isRegisteredSeller: async () => registered,
    registerSeller: async () => { writes++; registered = true; return 'confirmed'; },
  };
  await assert.rejects(requireSellerBinding(registry, address), /Run: antseed seller register/);
  assert.equal(writes, 0);
  const hashes: string[] = [];
  assert.equal(await registerSellerBinding(registry, {} as AbstractSigner, address, 7, (hash) => hashes.push(hash)), true);
  legacy = false;
  assert.equal(await requireSellerBinding(registry, address), 7);
  assert.equal(await registerSellerBinding(registry, {} as AbstractSigner, address, 7, () => {}), false);
  assert.equal(writes, 1);
  assert.deepEqual(hashes, ['confirmed']);
});

test('registration reports a confirmed transaction before verification failure', async () => {
  const hashes: string[] = [];
  await assert.rejects(registerSellerBinding({ getAgentId: async () => 7, isRegisteredSeller: async () => false, registerSeller: async () => 'confirmed' },
    {} as AbstractSigner, address, 7, (hash) => hashes.push(hash)), /could not be verified/);
  assert.deepEqual(hashes, ['confirmed']);
});

test('explicit binding reads the existing agentSeller getter, not just getAgentId', async () => {
  const client = new CliSellerRegistryClient(config);
  const abi = new Interface(['function agentSeller(uint256 agentId) view returns (address)']);
  client.getAgentId = async () => 7;
  let bound = ZeroAddress;
  Object.defineProperty(client, '_provider', { value: { call: async () => abi.encodeFunctionResult('agentSeller', [bound]) } });
  assert.equal(await client.isRegisteredSeller(address, 7), false);
  bound = address;
  assert.equal(await client.isRegisteredSeller(address, 7), true);
});

test('position pagination includes every page', async () => {
  const ids = Array.from({ length: 513 }, (_, index) => index + 1);
  assert.deepEqual(await collectPositionIds(async (offset, limit) => ids.slice(offset, offset + limit)), ids);
});

test('historical reward discovery includes burned positions and filters old owners', async () => {
  const client = new CliSellerPoolsClient({ ...config, antsTokenAddress: contractAddress });
  const active = Array.from({ length: 300 }, (_, index) => index + 1);
  client.stakerPositionIds = async (_staker, offset = 0, limit = 256) => active.slice(offset, offset + limit);
  client.position = async (id) => ({ id, owner: id === 2 ? contractAddress : address, agentId: 7, amount: 1n, weightAmount: 1n, stakeStartEpoch: 1, stakeEndEpoch: 4, closedAtEpoch: id === 301 ? 3 : 0, withdrawn: id === 301 });
  const abi = new Interface(['event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)']);
  const log = abi.encodeEventLog(abi.getEvent('Transfer')!, [address, ZeroAddress, 301]);
  Object.defineProperty(client, '_provider', { value: {
    getBlockNumber: async () => 16,
    getCode: async (_target: string, block: number) => block < 4 ? '0x' : '0x6000',
    getLogs: async (filter: { fromBlock: number }) => { assert.equal(filter.fromBlock, 4); return [{ ...log, address: contractAddress }]; },
  } });
  const positions = await client.rewardPositions(address);
  assert.equal(positions.length, 300);
  assert.equal(positions.at(-1)!.id, 301);
  assert.ok(!positions.some((position) => position.id === 2));
});

test('preview uses only existing view selectors at one block, including unindexed epochs', async () => {
  const client = new CliSellerPoolsRewardsClient(config);
  const abi = new Interface([
    'function sellerPools() view returns (address)', 'function usageAccounting() view returns (address)',
    'function positions(uint256) view returns (address,uint256,uint256,uint256,uint64,uint64,uint64,bool)',
    'function currentEpoch() view returns (uint256)', 'function positionClaimCursor(uint256) view returns (uint256)',
    'function poolRewardIndexNextEpoch(uint256) view returns (uint256)', 'function initialIndexEpoch() view returns (uint256)',
    'function positionPowerSegmentAt(uint256,uint256) view returns (uint256,uint256,uint256)',
    'function poolCumulativeRewardPerWeightAt(uint256,uint256) view returns (uint256)',
    'function poolCumulativeEpochRewardPerWeightAt(uint256,uint256) view returns (uint256)',
    'function poolWeightAtEpoch(uint256,uint256) view returns (uint256)', 'function poolEpochEmissions(uint256,uint256) view returns (bool,uint256)',
    'function weightedPoolPointsByEpoch(uint256,uint256) view returns (uint256)', 'function totalWeightedPoolPointsByEpoch(uint256) view returns (uint256)',
    'function stakerEpochBudget(uint256) view returns (uint256)',
  ]);
  let reads = 0;
  Object.defineProperty(client, '_provider', { value: {
    getBlockNumber: async () => 123,
    call: async (transaction: { data: string; blockTag: number }) => {
      assert.equal(transaction.blockTag, 123);
      reads++;
      const call = abi.parseTransaction(transaction)!;
      let result: unknown[];
      switch (call.name) {
        case 'sellerPools': case 'usageAccounting': result = [contractAddress]; break;
        case 'positions': result = [address, 7, 3, 3, 1, 4, 0, false]; break;
        case 'currentEpoch': result = [3]; break;
        case 'initialIndexEpoch': result = [1]; break;
        case 'positionPowerSegmentAt': result = [4, 0, 100]; break;
        case 'poolWeightAtEpoch': result = [call.args[1] === 1n ? 10 : 9]; break;
        case 'poolEpochEmissions': result = [false, 0]; break;
        case 'weightedPoolPointsByEpoch': case 'totalWeightedPoolPointsByEpoch': result = [1]; break;
        case 'stakerEpochBudget': result = [call.args[0] === 1n ? 100 : 101]; break;
        default: result = [0];
      }
      return abi.encodeFunctionResult(call.name, result);
    },
  } });
  assert.equal(await client.previewStakerReward(1), 157n);
  const firstReads = reads;
  assert.equal(await client.previewStakerReward(1), 157n);
  assert.equal(reads, firstReads);
});

test('confirmed reward totals count only actual incoming ANTS transfers', async () => {
  const client = new CliAntsTokenClient(config);
  const abi = new Interface(['event Transfer(address indexed from, address indexed to, uint256 value)']);
  const transfer = (target: string, recipient: string, amount: bigint) => ({ address: target, ...abi.encodeEventLog(abi.getEvent('Transfer')!, [ZeroAddress, recipient, amount]) });
  Object.defineProperty(client, '_provider', { value: { getTransactionReceipt: async () => ({ status: 1, logs: [transfer(contractAddress, address, 12n), transfer(address, address, 99n), transfer(contractAddress, contractAddress, 30n)] }) } });
  assert.equal(await client.receivedInTransaction('confirmed', address), 12n);
});

test('CLI local defaults use the registry nonce rather than the token nonce and preserve overrides', () => {
  const base = { payments: { crypto: { chainId: 'base-local' } } } as AntseedConfig;
  assert.equal(requireCryptoConfig(base).registryContractAddress, '0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9');
  assert.equal(requireCryptoConfig({ ...base, payments: { ...base.payments, crypto: { ...base.payments!.crypto!, registryContractAddress: address } } }).registryContractAddress, address);
});
