import assert from 'node:assert/strict';
import { test } from 'vitest';

import type { VprRoutingPreferences } from '../../core/state';
import type { VprPeerOption } from './tools';
import {
  buildPeerAccessRows,
  filterPeerAccessRows,
  peerAccessModeLabel,
  peerAccessStatus,
  peerAccessSummaryLabel,
} from './peer-access.js';

const basePreferences: VprRoutingPreferences = {
  autoRouting: true,
  preferFreePeers: false,
  maxInputUsdPerMillion: 25,
  minTrustScore: 0,
  allowedPeerIds: [],
  blockedPeerIds: [],
};

function peerOption(peerId: string, overrides: Partial<VprPeerOption> = {}): VprPeerOption {
  return { peerId, label: peerId.toUpperCase(), services: [], online: true, ...overrides };
}

test('with no allowlist every unlisted seller can be used', () => {
  const prefs = { ...basePreferences, blockedPeerIds: ['p2'] };

  assert.equal(peerAccessStatus('p1', prefs), 'eligible');
  assert.equal(peerAccessStatus('p2', prefs), 'blocked');
});

test('allowing one seller excludes every other unlisted seller', () => {
  const prefs = { ...basePreferences, allowedPeerIds: ['p1'] };

  assert.equal(peerAccessStatus('p1', prefs), 'allowed');
  assert.equal(peerAccessStatus('p2', prefs), 'excluded');
});

test('an explicit block still reads as blocked while an allowlist is on', () => {
  const prefs = { ...basePreferences, allowedPeerIds: ['p1'], blockedPeerIds: ['p2'] };

  assert.equal(peerAccessStatus('p2', prefs), 'blocked');
});

test('rows keep discovery order and append rules for peers discovery lost', () => {
  const prefs = { ...basePreferences, allowedPeerIds: ['p1'], blockedPeerIds: ['gone'] };
  const rows = buildPeerAccessRows([peerOption('p1'), peerOption('p2', { online: false })], prefs);

  assert.deepEqual(rows.map((row) => row.peerId), ['p1', 'p2', 'gone']);
  assert.deepEqual(rows.map((row) => row.status), ['allowed', 'excluded', 'blocked']);
  // A peer discovery no longer returns is labelled by id and marked offline.
  assert.deepEqual(rows[2], { peerId: 'gone', label: 'gone', online: false, listing: 'blocked', status: 'blocked' });
});

test('a peer on both lists is listed once', () => {
  const prefs = { ...basePreferences, allowedPeerIds: ['dup'], blockedPeerIds: ['dup'] };

  assert.deepEqual(buildPeerAccessRows([], prefs).map((row) => row.peerId), ['dup']);
});

test('search matches label or peer id, case-insensitively', () => {
  const rows = buildPeerAccessRows([peerOption('alpha'), peerOption('beta')], basePreferences);

  assert.deepEqual(filterPeerAccessRows(rows, 'ALP').map((row) => row.peerId), ['alpha']);
  assert.deepEqual(filterPeerAccessRows(rows, 'beta').map((row) => row.peerId), ['beta']);
  assert.equal(filterPeerAccessRows(rows, '  ').length, 2);
});

test('the mode banner states which rule is in force', () => {
  assert.match(peerAccessModeLabel(basePreferences), /Every seller can be used\./);
  assert.match(
    peerAccessModeLabel({ ...basePreferences, blockedPeerIds: ['p1'] }),
    /except the 1 you blocked/,
  );

  const strict = peerAccessModeLabel({ ...basePreferences, allowedPeerIds: ['p1', 'p2'] });
  assert.match(strict, /only the 2 allowed sellers can be used/);
  assert.match(strict, /Every other seller is excluded/);
});

test('peer access summary reads each rule that is in force', () => {
  assert.equal(peerAccessSummaryLabel(0, 0), 'No restrictions');
  assert.equal(peerAccessSummaryLabel(2, 0), '2 allowed');
  assert.equal(peerAccessSummaryLabel(0, 1), '1 blocked');
  assert.equal(peerAccessSummaryLabel(2, 1), '2 allowed · 1 blocked');
});
