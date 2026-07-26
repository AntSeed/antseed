import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  clearVprModelPin,
  clearVprPinsForPeer,
  filterVprModelPins,
  modelPinKey,
  setVprModelPin,
  vprModelPinFor,
} from './vpr-model-pins.js';

test('a pin is stored and read back per model', () => {
  const pins = setVprModelPin({}, 'openai', 'gpt-test', 'peer-1');
  assert.deepEqual(pins, { [modelPinKey('openai', 'gpt-test')]: 'peer-1' });
  assert.equal(vprModelPinFor(pins, 'openai', 'gpt-test'), 'peer-1');
  assert.equal(vprModelPinFor(pins, 'openai', 'other-model'), null);
});

test('pinning one model leaves other models pinned', () => {
  let pins = setVprModelPin({}, 'openai', 'gpt-test', 'peer-1');
  pins = setVprModelPin(pins, 'anthropic', 'fable-5', 'peer-2');
  assert.equal(vprModelPinFor(pins, 'openai', 'gpt-test'), 'peer-1');
  assert.equal(vprModelPinFor(pins, 'anthropic', 'fable-5'), 'peer-2');
});

test('clearing one model does not touch the others', () => {
  let pins = setVprModelPin({}, 'openai', 'gpt-test', 'peer-1');
  pins = setVprModelPin(pins, 'anthropic', 'fable-5', 'peer-2');
  pins = clearVprModelPin(pins, 'openai', 'gpt-test');
  assert.equal(vprModelPinFor(pins, 'openai', 'gpt-test'), null);
  assert.equal(vprModelPinFor(pins, 'anthropic', 'fable-5'), 'peer-2');
});

test('blocking a peer drops every model pinned to it', () => {
  let pins = setVprModelPin({}, 'openai', 'gpt-test', 'peer-1');
  pins = setVprModelPin(pins, 'anthropic', 'fable-5', 'peer-1');
  pins = setVprModelPin(pins, 'openai', 'gpt-other', 'peer-2');
  pins = clearVprPinsForPeer(pins, 'peer-1');
  assert.deepEqual(pins, { [modelPinKey('openai', 'gpt-other')]: 'peer-2' });
});

test('canonical service variants share the same pin', () => {
  const pins = setVprModelPin({}, 'openai', 'openai/gpt-test-latest', 'peer-1');
  assert.equal(vprModelPinFor(pins, 'other-provider', 'gpt-test'), 'peer-1');
});

test('filtering pins removes every peer rejected by the current rules', () => {
  let pins = setVprModelPin({}, 'openai', 'gpt-test', 'peer-1');
  pins = setVprModelPin(pins, 'anthropic', 'fable-5', 'peer-2');
  assert.deepEqual(filterVprModelPins(pins, (peerId) => peerId === 'peer-2'), {
    [modelPinKey('anthropic', 'fable-5')]: 'peer-2',
  });
});

test('blank peer ids are not stored', () => {
  assert.deepEqual(setVprModelPin({}, 'openai', 'gpt-test', '   '), {});
});
