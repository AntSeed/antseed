/**
 * Types shared between `engine.ts` and the pieces split out of it.
 *
 * They live here rather than in `engine.ts` so `streaming-run.ts` can name the
 * engine state it borrows without importing the engine back — that cycle is
 * what forced these three types out of their original home.
 */
import type { IpcMain } from 'electron';
import type { AgentSession } from '@mariozechner/pi-coding-agent';
import type { ChatStreamStopReason } from './stream-stop.js';

export type RegisterPiChatHandlersOptions = {
  ipcMain: IpcMain;
  sendToRenderer: (channel: string, payload: unknown) => void;
  configPath: string;
  isBuyerRuntimeRunning: () => boolean;
  ensureBuyerRuntimeStarted?: () => Promise<boolean>;
  appendSystemLog: (line: string) => void;
};

export type ChatStreamErrorPayload = {
  conversationId: string;
  error: string;
  stopReason: ChatStreamStopReason;
};

/** A streaming run currently in flight for one conversation. */
export type ActiveRun = {
  conversationId: string;
  session: AgentSession;
  unsubscribe: () => void;
};
