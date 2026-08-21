import { app, ipcMain } from 'electron';
import type { LogEvent } from '../runtime/log-parser.js';
import { resolveFeedbackTelegramConfig } from '../feedback/config.js';
import { submitTelegramFeedback } from '../feedback/service.js';

export function registerFeedbackIpc(deps: { logBuffer: readonly LogEvent[] }): void {
  ipcMain.handle('feedback:get-status', () => {
    const resolution = resolveFeedbackTelegramConfig();
    return resolution.configured
      ? { configured: true }
      : { configured: false, error: resolution.error };
  });

  ipcMain.handle('feedback:submit', async (_event, request: unknown) => {
    const resolution = resolveFeedbackTelegramConfig();
    if (!resolution.configured) {
      return { ok: false, error: resolution.error };
    }
    return submitTelegramFeedback({
      config: resolution.config,
      request,
      logs: deps.logBuffer,
      appVersion: app.getVersion(),
    });
  });
}

