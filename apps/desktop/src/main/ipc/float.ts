/**
 * IPC surface for the floating pill window and the conversation list it shows.
 */
import { ipcMain } from 'electron';
import {
  APP_ICON_PATH,
  APP_NAME,
  isDev,
  rendererUrl,
} from '../app-context.js';
import {
  resolveBuyerProxyPort,
} from '../runtime/active-config.js';
import {
  closeFloatWindow,
  getFloatWindow,
  getFloatWindowCompact,
  getMainWindow,
  moveFloatWindowBy,
  openFloatWindow,
  setFloatWindowCompact,
  setFloatWindowExpanded,
} from '../ui/window.js';

/** Last payload pushed to the pill, replayed when it reopens. */
let lastVprFloatData: unknown;

export function registerFloatIpc(): void {
  ipcMain.handle('vpr-float:open', (_event, data: unknown) => {
    if (data !== undefined) lastVprFloatData = data;
    openFloatWindow(
      { appName: APP_NAME, appIconPath: APP_ICON_PATH, isDev, rendererUrl },
      lastVprFloatData,
    );
    return { ok: true };
  });

  ipcMain.handle('vpr-float:close', () => {
    closeFloatWindow();
    return { ok: true };
  });

  ipcMain.handle('vpr-float:is-open', () => Boolean(getFloatWindow()));

  ipcMain.handle('vpr-float:get-compact', () => getFloatWindowCompact());

  // Manual window drag for the compact chip's center button: it must stay a
  // click target (flip/expand), so it can't be a -webkit-app-region drag
  // handle — the renderer streams pointer deltas instead.
  ipcMain.on('vpr-float:move-by', (_event, dx: unknown, dy: unknown) => {
    if (typeof dx !== 'number' || typeof dy !== 'number') return;
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    moveFloatWindowBy(dx, dy);
  });

  ipcMain.on('vpr-float:update', (_event, data: unknown) => {
    lastVprFloatData = data;
    getFloatWindow()?.webContents.send('vpr-float:data', data);
  });

  // Grow/shrink the pill while one of its custom dropdowns is open.
  ipcMain.on('vpr-float:set-expanded', (_event, expanded: unknown) => {
    setFloatWindowExpanded(expanded === true);
  });

  // Conversations seen by the buyer (per-chat routing). The renderer cannot
  // call the buyer's loopback control endpoints directly (CORS), so the main
  // process proxies list/update. Returns null (not []) when the buyer is
  // unreachable — e.g. still starting up — so the UI can show a loading state
  // instead of a wrong "no chats" one.
  ipcMain.handle('buyer:conversations-list', async () => {
    try {
      const buyerPort = await resolveBuyerProxyPort();
      const response = await fetch(`http://127.0.0.1:${buyerPort}/_antseed/conversations`, {
        signal: AbortSignal.timeout(3_000),
      });
      const parsed = await response.json() as { conversations?: unknown[] };
      return Array.isArray(parsed.conversations) ? parsed.conversations : [];
    } catch {
      return null;
    }
  });

  ipcMain.handle('buyer:conversations-update', async (_event, opts: unknown) => {
    // Validate renderer-supplied parameters at the trust boundary.
    const record = (opts && typeof opts === 'object' && !Array.isArray(opts)) ? opts as Record<string, unknown> : {};
    const id = typeof record.id === 'string' ? record.id : '';
    if (!id) return { ok: false, error: 'id is required' };
    const payload: Record<string, unknown> = { id };
    if (record.delete === true) payload.delete = true;
    if ('label' in record) payload.label = typeof record.label === 'string' ? record.label : null;
    if ('pinnedModel' in record) payload.pinnedModel = typeof record.pinnedModel === 'string' ? record.pinnedModel : '';
    if (record.peerSource === 'user' || record.peerSource === 'auto') payload.peerSource = record.peerSource;
    try {
      const buyerPort = await resolveBuyerProxyPort();
      const response = await fetch(`http://127.0.0.1:${buyerPort}/_antseed/conversations/update`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(3_000),
      });
      return await response.json() as { ok: boolean };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.on('vpr-float:action', (_event, action: unknown) => {
    if (action === 'open-main') {
      const win = getMainWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        // Always land on the home screen, wherever the window was left.
        win.webContents.send('desktop:navigate-view', 'home');
      }
      return;
    }
    if (
      typeof action === 'object' && action !== null
      && (action as { type?: unknown }).type === 'open-deposit'
    ) {
      const win = getMainWindow();
      if (win) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        win.webContents.send('desktop:navigate-view', 'deposit');
      }
      return;
    }
    if (
      typeof action === 'object' && action !== null
      && (action as { type?: unknown }).type === 'set-compact'
    ) {
      setFloatWindowCompact((action as { compact?: unknown }).compact === true);
      return;
    }
    // Structured actions (e.g. model selection) are handled by the main
    // window's renderer, which owns routing state.
    getMainWindow()?.webContents.send('vpr-float:action', action);
  });
}
