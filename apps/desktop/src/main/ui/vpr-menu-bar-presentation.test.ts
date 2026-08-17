import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MACOS_BEGIN_MENU_TRACKING_NOTIFICATION,
  presentVprMenuBarWindow,
  subscribeToMacosMenuTracking,
  VPR_MENU_BAR_WINDOW_WIDTH,
  vprMenuBarBounds,
  vprMenuBarPointerX,
  vprMenuBarWindowHeight,
} from './vpr-menu-bar-presentation.js';

function createWindowSpy(): {
  window: { show: () => void; showInactive: () => void };
  calls: string[];
} {
  const calls: string[] = [];
  return {
    window: {
      show: () => calls.push('show'),
      showInactive: () => calls.push('showInactive'),
    },
    calls,
  };
}

test('macOS presents the panel through the key-window path', () => {
  const { window, calls } = createWindowSpy();

  presentVprMenuBarWindow(window, 'darwin');

  assert.deepEqual(calls, ['show']);
});

test('other platforms preserve inactive popup presentation', () => {
  const { window, calls } = createWindowSpy();

  presentVprMenuBarWindow(window, 'win32');

  assert.deepEqual(calls, ['showInactive']);
});

test('status popover dimensions stay within the approved footprint', () => {
  assert.equal(VPR_MENU_BAR_WINDOW_WIDTH, 320);
  assert.equal(vprMenuBarWindowHeight(0, 900), 272);
  assert.equal(vprMenuBarWindowHeight(1, 900), 272);
  assert.equal(vprMenuBarWindowHeight(2, 900), 304);
  assert.equal(vprMenuBarWindowHeight(8, 900), 464);
  assert.equal(vprMenuBarWindowHeight(20, 900), 464);
  assert.equal(vprMenuBarWindowHeight(8, 400), 384);
});

test('tray anchoring starts the card beneath the icon', () => {
  assert.deepEqual(
    vprMenuBarBounds(
      { x: 700, y: 0, width: 24, height: 22 },
      { x: 0, y: 23, width: 1_440, height: 877 },
      0,
    ),
    { x: 692, y: 26, width: 320, height: 272 },
  );
});

test('tray anchoring clamps to display edges and short work areas', () => {
  const workArea = { x: 900, y: 23, width: 500, height: 400 };

  assert.deepEqual(
    vprMenuBarBounds({ x: 900, y: 0, width: 20, height: 22 }, workArea, 8),
    { x: 900, y: 26, width: 320, height: 384 },
  );
  assert.deepEqual(
    vprMenuBarBounds({ x: 1_380, y: 0, width: 20, height: 22 }, workArea, 8),
    { x: 1_080, y: 26, width: 320, height: 384 },
  );
});

test('tray anchoring preserves negative coordinates on secondary displays', () => {
  assert.deepEqual(
    vprMenuBarBounds(
      { x: -1_000, y: 0, width: 24, height: 22 },
      { x: -1_920, y: 23, width: 1_920, height: 1_057 },
      2,
    ),
    { x: -1_008, y: 26, width: 320, height: 304 },
  );
});

test('pointer tracks the tray icon and stays inside edge-clamped windows', () => {
  assert.equal(
    vprMenuBarPointerX(
      { x: 700, y: 0, width: 24, height: 22 },
      { x: 692, y: 26, width: 320, height: 272 },
    ),
    20,
  );
  assert.equal(
    vprMenuBarPointerX(
      { x: 900, y: 0, width: 20, height: 22 },
      { x: 900, y: 26, width: 320, height: 272 },
    ),
    18,
  );
  assert.equal(
    vprMenuBarPointerX(
      { x: 1_380, y: 0, width: 20, height: 22 },
      { x: 1_080, y: 26, width: 320, height: 272 },
    ),
    302,
  );
});

test('macOS menu tracking dismisses the popover and unsubscribes cleanly', () => {
  let subscribedEvent: string | null = null;
  let callback: (event: string, userInfo: Record<string, unknown>, object: string) => void = () => {
    throw new Error('Notification callback was not registered.');
  };
  let unsubscribedId: number | null = null;
  let dismissals = 0;
  const notifications = {
    subscribeNotification: (
      event: string | null,
      handler: (event: string, userInfo: Record<string, unknown>, object: string) => void,
    ) => {
      subscribedEvent = event;
      callback = handler;
      return 42;
    },
    unsubscribeNotification: (id: number) => {
      unsubscribedId = id;
    },
  };

  const unsubscribe = subscribeToMacosMenuTracking(
    notifications,
    () => { dismissals += 1; },
    'darwin',
  );

  assert.equal(subscribedEvent, MACOS_BEGIN_MENU_TRACKING_NOTIFICATION);
  callback(MACOS_BEGIN_MENU_TRACKING_NOTIFICATION, {}, 'other-menu');
  assert.equal(dismissals, 1);
  unsubscribe();
  assert.equal(unsubscribedId, 42);
});

test('menu tracking subscription is skipped outside macOS', () => {
  let subscribed = false;
  const notifications = {
    subscribeNotification: () => {
      subscribed = true;
      return 1;
    },
    unsubscribeNotification: () => {},
  };

  const unsubscribe = subscribeToMacosMenuTracking(notifications, () => {}, 'linux');
  unsubscribe();

  assert.equal(subscribed, false);
});
