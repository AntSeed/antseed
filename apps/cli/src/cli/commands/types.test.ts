import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { getGlobalOptions } from './types.js';

test('getGlobalOptions reads root options from a nested subcommand', () => {
  const program = new Command();
  program
    .option('-c, --config <path>')
    .option('--data-dir <path>')
    .option('-v, --verbose');

  const sellerCmd = program.command('seller');
  const startCmd = sellerCmd.command('start');

  program.parse(['--config', '/tmp/custom-config.json', '--data-dir', '/tmp/custom-data', '--verbose', 'seller', 'start'], {
    from: 'user',
  });

  const options = getGlobalOptions(startCmd);

  assert.equal(options.config, '/tmp/custom-config.json');
  assert.equal(options.dataDir, '/tmp/custom-data');
  assert.equal(options.verbose, true);
});
