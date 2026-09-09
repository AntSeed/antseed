import assert from 'node:assert/strict';
import test from 'node:test';
import { Command } from 'commander';
import { DEFAULT_ANTS_PORT, registerAntsDashboardAction } from './dashboard.js';

test('antseed ants defaults to the dashboard with a port and --no-open switch', () => {
  const ants = new Command('ants');
  registerAntsDashboardAction(ants);
  const port = ants.options.find((option) => option.long === '--port');
  assert.ok(port);
  assert.equal(port.defaultValue, String(DEFAULT_ANTS_PORT));
  assert.equal(DEFAULT_ANTS_PORT, 3119);
  assert.ok(ants.options.some((option) => option.long === '--no-open'));
});
