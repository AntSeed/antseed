import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { Wallet, ZeroAddress } from 'ethers';
import { registerBuyerSetOperatorCommand, setBuyerOperator, validateOperatorAddress } from './set-operator.js';

const operator = '0x1111111111111111111111111111111111111111';
const buyer = '0x2222222222222222222222222222222222222222';
const contract = '0x3333333333333333333333333333333333333333';
const wallet = new Wallet('0x' + '01'.repeat(32));
const context = { wallet, address: buyer };

function fixture(current = ZeroAddress) {
  const calls: unknown[][] = [];
  return {
    calls,
    input: {
      operator, context, evmChainId: 8453, depositsContractAddress: contract,
      client: {
        getOperator: async (address: string) => { calls.push(['getOperator', address]); return current; },
        getOperatorNonce: async (address: string) => { calls.push(['getOperatorNonce', address]); return 9007199254740993n; },
        setOperator: async (...args: unknown[]) => { calls.push(['setOperator', ...args]); return '0xtx'; },
      },
      sign: async (...args: unknown[]) => { calls.push(['sign', ...args]); return '0xsig'; },
    },
  };
}

test('validates and checksums a nonzero address; rejects malformed, ENS, zero and bad checksum inputs', () => {
  assert.equal(validateOperatorAddress('0x52908400098527886e0f7030069857d2e4169ee7'), '0x52908400098527886E0F7030069857D2E4169EE7');
  for (const value of ['', 'alice.eth', '0x123', '11'.repeat(20), ZeroAddress, '0x52908400098527886E0F7030069857D2E4169Ee7']) {
    assert.throws(() => validateOperatorAddress(value), /address|wallet/);
  }
});

test('signs the live nonce for the configured deposits domain and submits with buyer identity', async () => {
  const { input, calls } = fixture();
  assert.equal(await setBuyerOperator(input), '0xtx');
  assert.deepEqual(calls, [
    ['getOperator', buyer], ['getOperatorNonce', buyer],
    ['sign', wallet, 8453, contract, operator, 9007199254740993n],
    ['setOperator', wallet, buyer, operator, 9007199254740993n, '0xsig'],
  ]);
});

test('same operator is an idempotent no-op without signing or sending', async () => {
  const { input, calls } = fixture(operator);
  assert.equal(await setBuyerOperator(input), null);
  assert.deepEqual(calls, [['getOperator', buyer]]);
});

test('existing different operator cannot be replaced by the buyer', async () => {
  const { input, calls } = fixture(contract);
  await assert.rejects(setBuyerOperator(input), /Only that wallet can transfer authorization/);
  assert.deepEqual(calls, [['getOperator', buyer]]);
});

test('invalid address fails before reading chain state', async () => {
  const { input, calls } = fixture();
  await assert.rejects(setBuyerOperator({ ...input, operator: ZeroAddress }));
  assert.deepEqual(calls, []);
});

test('RPC, signing and transaction failures propagate without retries', async () => {
  for (const stage of ['getOperator', 'getOperatorNonce', 'sign', 'setOperator'] as const) {
    const { input, calls } = fixture();
    const fail = async () => { throw new Error(`${stage} failed`); };
    if (stage === 'sign') input.sign = fail;
    else input.client[stage] = fail;
    await assert.rejects(setBuyerOperator(input), new RegExp(`${stage} failed`));
    assert.ok(calls.filter(([name]) => name === 'setOperator').length === 0);
  }
});

test('command help explains gas and initial-only authorization; address is required', async () => {
  const program = new Command().exitOverride().configureOutput({ writeErr: () => {} });
  const buyerCmd = program.command('buyer');
  registerBuyerSetOperatorCommand(buyerCmd);
  const command = buyerCmd.commands[0]!;
  assert.equal(command.name(), 'set-operator');
  assert.match(command.description(), /initial authorized wallet.*ETH gas/);
  await assert.rejects(program.parseAsync(['buyer', 'set-operator'], { from: 'user' }), /missing required argument/);
});
