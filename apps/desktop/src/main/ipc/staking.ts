import { ipcMain } from 'electron';
import { stakingSessions } from '../staking/portal.js';
import { getMainWindow } from '../ui/window.js';

export function registerStakingIpc(): void {
  ipcMain.handle('staking:open', async (event, options?: { page?: unknown }) => {
    if (event.sender !== getMainWindow()?.webContents || event.senderFrame !== event.sender.mainFrame) {
      return { ok: false, error: 'Staking can only be opened from the VPR main window.' };
    }
    try {
      const page = options?.page ?? 'stake';
      if (page !== 'stake' && page !== 'rewards') return { ok: false, error: 'Unknown staking page.' };
      await stakingSessions.open(page);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
}
