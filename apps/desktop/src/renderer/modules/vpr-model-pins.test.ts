import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  clearVprModelPin,
  clearVprPinsForPeer,
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

test('blank peer ids are not stored', () => {
  assert.deepEqual(setVprModelPin({}, 'openai', 'gpt-test', '   '), {});
});
