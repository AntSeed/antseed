import test from 'node:test';
import assert from 'node:assert/strict';
import { APPS_FOLDER_PREFIX, appsFolderPath, isAppsFolderTarget, parseStartApps } from './windows-start-menu.js';

test('parses the Name/AppID rows Get-StartApps emits', () => {
  const stdout = JSON.stringify([
    { Name: 'Claude', AppID: 'AnthropicClaude_1a2b3c4d5e!App' },
    { Name: 'Visual Studio Code', AppID: 'Microsoft.VisualStudioCode' },
  ]);
  assert.deepEqual(parseStartApps(stdout), [
    { name: 'Claude', appId: 'AnthropicClaude_1a2b3c4d5e!App' },
    { name: 'Visual Studio Code', appId: 'Microsoft.VisualStudioCode' },
  ]);
});

// ConvertTo-Json drops the array wrapper when the pipeline yields one item.
test('a single app comes back as a bare object, not an array', () => {
  const stdout = JSON.stringify({ Name: 'Claude', AppID: 'AnthropicClaude_1a2b3c4d5e!App' });
  assert.deepEqual(parseStartApps(stdout), [{ name: 'Claude', appId: 'AnthropicClaude_1a2b3c4d5e!App' }]);
});

test('the same AppID listed twice is kept once', () => {
  const stdout = JSON.stringify([
    { Name: 'Claude', AppID: 'AnthropicClaude_1a2b3c4d5e!App' },
    { Name: 'Claude (desktop)', AppID: 'AnthropicClaude_1a2b3c4d5e!App' },
  ]);
  assert.deepEqual(parseStartApps(stdout), [{ name: 'Claude', appId: 'AnthropicClaude_1a2b3c4d5e!App' }]);
});

test('a malformed row is dropped without losing the rest', () => {
  const stdout = JSON.stringify([
    { Name: 'Claude', AppID: 'AnthropicClaude_1a2b3c4d5e!App' },
    { Name: 'No id' },
    { AppID: 'No.Name' },
    null,
    'not an object',
    { Name: 'Good', AppID: 'Some.Other.App' },
  ]);
  assert.deepEqual(parseStartApps(stdout), [
    { name: 'Claude', appId: 'AnthropicClaude_1a2b3c4d5e!App' },
    { name: 'Good', appId: 'Some.Other.App' },
  ]);
});

// Not injection defence — explorer gets the value as one argv entry with no
// shell. These shapes simply cannot be AUMIDs, so seeing one means we misread
// the output and the row is worth dropping.
test('a value that could not be an AppUserModelID is refused', () => {
  for (const appId of ['has space', 'has"quote', "has'quote", 'a&b', 'a|b', 'a>b', 'a\\b', 'a/b', 'a\tb']) {
    assert.deepEqual(parseStartApps(JSON.stringify([{ Name: 'Bad', AppID: appId }])), [], appId);
  }
});

// Real package family names carry dots, dashes and underscores, and the "!"
// separates the family name from the app id — an over-strict filter here would
// silently drop exactly the apps this scan exists to find.
test('the punctuation real AppUserModelIDs use is accepted', () => {
  for (const appId of [
    'AnthropicClaude_1a2b3c4d5e!App',
    'Microsoft.VisualStudioCode',
    'some-vendor.some-app_8wekyb3d8bbwe!Tool',
  ]) {
    assert.deepEqual(
      parseStartApps(JSON.stringify([{ Name: 'Ok', AppID: appId }])),
      [{ name: 'Ok', appId }],
      appId,
    );
  }
});

test('unparseable output yields no apps rather than throwing', () => {
  assert.deepEqual(parseStartApps(''), []);
  assert.deepEqual(parseStartApps('Get-StartApps : The term is not recognized'), []);
});

test('an AppsFolder target round-trips and is recognisable', () => {
  const target = appsFolderPath('AnthropicClaude_1a2b3c4d5e!App');
  assert.equal(target, `${APPS_FOLDER_PREFIX}AnthropicClaude_1a2b3c4d5e!App`);
  assert.equal(isAppsFolderTarget(target), true);
});

test('a real file path is not an AppsFolder target', () => {
  assert.equal(isAppsFolderTarget('C:\\Program Files\\Foo\\foo.exe'), false);
  assert.equal(isAppsFolderTarget('/Applications/Foo.app'), false);
});
