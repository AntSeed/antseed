import assert from 'node:assert/strict';
import test from 'node:test';
import { Command, CommanderError } from 'commander';
import { DEFAULT_ANTS_PORT, registerAntsDashboardAction } from './dashboard.js';

test('antseed ants registers address selection, a port and --no-open', () => {
  const ants = new Command('ants');
  registerAntsDashboardAction(ants);
  const port = ants.options.find((option) => option.long === '--port');
  assert.ok(port);
  assert.equal(port.defaultValue, String(DEFAULT_ANTS_PORT));
  assert.equal(DEFAULT_ANTS_PORT, 3119);
  assert.ok(ants.options.some((option) => option.long === '--no-open'));
  assert.ok(ants.options.some((option) => option.long === '--local-address'));
  assert.ok(ants.options.some((option) => option.long === '--address'));
});

test('dashboard launch requires explicit account selection before startup', async () => {
  for (const args of [[], ['--no-open'], ['--port', '3999']]) {
    let output = '';
    const command = new Command('ants').exitOverride().configureOutput({ writeErr: text => { output += text; } });
    registerAntsDashboardAction(command);
    await assert.rejects(command.parseAsync(args, { from: 'user' }), error => error instanceof CommanderError && error.exitCode === 1);
    assert.match(output, /Select an account/);
    assert.match(output, /antseed ants --local-address/);
    assert.match(output, /antseed ants --address 0x\.\.\./);
  }
});

test('help and CLI subcommands do not require dashboard account selection', async () => {
  let output = '';
  const command = new Command('ants').exitOverride().configureOutput({ writeOut: text => { output += text; } });
  registerAntsDashboardAction(command);
  await assert.rejects(command.parseAsync(['--help'], { from: 'user' }), error => error instanceof CommanderError && error.exitCode === 0);
  assert.match(output, /--local-address/);
  assert.match(output, /--address/);
  let ran = false;
  command.command('status').action(() => { ran = true; });
  await command.parseAsync(['status'], { from: 'user' });
  assert.equal(ran, true);
});

function dashboardCommand() {
  const command = new Command('ants').exitOverride().configureOutput({ writeErr: () => {} });
  registerAntsDashboardAction(command);
  command.action(() => {});
  return command;
}

test('dashboard address selection is mutually exclusive and validates addresses', () => {
  const local = dashboardCommand().parse(['--local-address'], { from: 'user' });
  assert.equal(local.opts().localAddress, true);
  const address = '0x00000000000000000000000000000000000000ab';
  const command = dashboardCommand();
  command.parse(['--address', address], { from: 'user' });
  assert.equal(command.opts().address, '0x00000000000000000000000000000000000000AB');
  assert.throws(() => dashboardCommand().parse(['--address', address, '--local-address'], { from: 'user' }), /cannot be used with/);
  for (const value of ['bad', '0x0000000000000000000000000000000000000000']) {
    assert.throws(() => dashboardCommand().parse(['--address', value], { from: 'user' }), /non-zero Ethereum address/);
  }
});

test('dashboard selection cannot silently apply to CLI transaction subcommands', () => {
  const command = dashboardCommand();
  command.command('stake').action(() => assert.fail('Must not run a transaction subcommand'));
  assert.throws(() => command.parse(['--local-address', 'stake'], { from: 'user' }), /only apply to the dashboard/);
});
