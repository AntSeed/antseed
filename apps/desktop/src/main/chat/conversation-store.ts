/**
 * On-disk conversation store, backed by the pi-coding-agent session files.
 *
 * Conversations are not persisted separately — a conversation *is* a pi
 * session, and the UI shape is projected out of it on read.
 */

import { existsSync } from 'node:fs';
import { mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import type { Message } from '@mariozechner/pi-ai';
import { SessionManager } from '@mariozechner/pi-coding-agent';
import { CHAT_DATA_DIR, getCurrentChatWorkspaceDir } from './workspace.js';
import { ANTSEED_PEER_CUSTOM_TYPE, resolveLatestPeerBinding } from './peer-selection.js';
import { sanitizeProviderHint } from './provider-hint.js';
import { normalizeServiceId, normalizeTokenCount } from './normalize.js';
import {
  convertPiMessagesToUi,
  deriveCost,
  deriveTitle,
  deriveUsage,
} from './message-projection.js';
import type { AiConversation, AiConversationSummary } from './conversation-types.js';

export const CHAT_SESSIONS_DIR = path.join(CHAT_DATA_DIR, 'sessions');
export const CHAT_AGENT_DIR = path.join(CHAT_DATA_DIR, 'pi-agent');

export type SessionPathInfo = {
  path: string;
  id: string;
};

export type AntseedPeerData = { peerId: string; peerLabel?: string };

export function extractPeerFromEntries(manager: SessionManager): AntseedPeerData | null {
  return resolveLatestPeerBinding(
    manager.getEntries() as Array<{ type?: string; customType?: string; data?: unknown }>,
  );
}

export class PiConversationStore {
  private readonly sessionsDir = CHAT_SESSIONS_DIR;
  private readonly ready: Promise<void>;
  private readonly pathCache = new Map<string, string>();
  private readonly pendingManagers = new Map<string, SessionManager>();

  constructor() {
    this.ready = this.ensureDirs();
  }

  private async ensureDirs(): Promise<void> {
    await mkdir(this.sessionsDir, { recursive: true });
    await mkdir(CHAT_AGENT_DIR, { recursive: true });
  }

  private async ensureWorkspaceDir(): Promise<string> {
    await this.ready;
    const workspaceDir = getCurrentChatWorkspaceDir();
    await mkdir(workspaceDir, { recursive: true });
    return workspaceDir;
  }

  private async listSessionPaths(): Promise<SessionPathInfo[]> {
    const workspaceDir = await this.ensureWorkspaceDir();
    const sessions = await SessionManager.list(workspaceDir, this.sessionsDir);
    const infos = sessions.map((entry) => ({ id: entry.id, path: entry.path }));
    this.pathCache.clear();
    for (const info of infos) {
      this.pathCache.set(info.id, info.path);
    }
    return infos;
  }

  private async buildConversationFromManager(manager: SessionManager): Promise<AiConversation> {
    const context = manager.buildSessionContext();
    const messages = convertPiMessagesToUi(context.messages as Message[]);
    const usage = deriveUsage(messages);
    const header = manager.getHeader();
    const createdAtRaw = header ? Date.parse(header.timestamp) : Date.now();
    const createdAt = Number.isFinite(createdAtRaw) && createdAtRaw > 0 ? Math.floor(createdAtRaw) : Date.now();
    const latestMessageAt = messages.reduce((max, message) => {
      const ts = normalizeTokenCount(message.createdAt);
      return ts > max ? ts : max;
    }, 0);

    let updatedAt = Math.max(createdAt, latestMessageAt);
    const sessionPath = manager.getSessionFile();
    if (sessionPath && existsSync(sessionPath)) {
      try {
        const fileStat = await stat(sessionPath);
        updatedAt = Math.max(updatedAt, Math.floor(fileStat.mtimeMs));
      } catch {
        // Keep the computed updatedAt when stat fails.
      }
    } else {
      updatedAt = Math.max(updatedAt, Date.now());
    }

    const peerData = extractPeerFromEntries(manager);
    // SessionManager reads the cwd persisted in the session file; restoration
    // across app restarts depends on that value reflecting the session workspace.
    const sessionCwd = manager.getCwd() || undefined;
    return {
      id: manager.getSessionId(),
      title: manager.getSessionName() || deriveTitle(messages),
      service: normalizeServiceId(context.model?.modelId),
      provider: sanitizeProviderHint(context.model?.provider) ?? undefined,
      messages,
      createdAt,
      updatedAt,
      usage,
      ...(peerData?.peerId ? { peerId: peerData.peerId } : {}),
      ...(peerData?.peerLabel ? { peerLabel: peerData.peerLabel } : {}),
      ...(sessionCwd ? { workspacePath: sessionCwd } : {}),
    };
  }

  private async resolvePath(id: string): Promise<string | null> {
    await this.ready;
    const cached = this.pathCache.get(id);
    if (cached && existsSync(cached)) {
      return cached;
    }
    const all = await this.listSessionPaths();
    const found = all.find((entry) => entry.id === id);
    return found?.path ?? null;
  }

  private async readConversationFromPath(sessionPath: string): Promise<AiConversation | null> {
    try {
      const manager = SessionManager.open(sessionPath, this.sessionsDir);
      return await this.buildConversationFromManager(manager);
    } catch {
      return null;
    }
  }

  async list(): Promise<AiConversationSummary[]> {
    const sessionPaths = await this.listSessionPaths();
    const summaryById = new Map<string, AiConversationSummary>();
    for (const info of sessionPaths) {
      const conversation = await this.readConversationFromPath(info.path);
      if (!conversation) {
        continue;
      }
      const totalTokens = normalizeTokenCount(conversation.usage.inputTokens) + normalizeTokenCount(conversation.usage.outputTokens);
      summaryById.set(conversation.id, {
        id: conversation.id,
        title: conversation.title,
        service: conversation.service,
        provider: conversation.provider,
        messageCount: conversation.messages.length,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        usage: conversation.usage,
        totalTokens,
        totalEstimatedCostUsd: deriveCost(conversation.messages),
        ...(conversation.peerId ? { peerId: conversation.peerId } : {}),
        ...(conversation.peerLabel ? { peerLabel: conversation.peerLabel } : {}),
        ...(conversation.workspacePath ? { workspacePath: conversation.workspacePath } : {}),
      });
    }

    for (const [conversationId, manager] of this.pendingManagers.entries()) {
      if (summaryById.has(conversationId)) {
        continue;
      }
      const conversation = await this.buildConversationFromManager(manager);
      const totalTokens = normalizeTokenCount(conversation.usage.inputTokens) + normalizeTokenCount(conversation.usage.outputTokens);
      summaryById.set(conversation.id, {
        id: conversation.id,
        title: conversation.title,
        service: conversation.service,
        provider: conversation.provider,
        messageCount: conversation.messages.length,
        createdAt: conversation.createdAt,
        updatedAt: conversation.updatedAt,
        usage: conversation.usage,
        totalTokens,
        totalEstimatedCostUsd: deriveCost(conversation.messages),
        ...(conversation.peerId ? { peerId: conversation.peerId } : {}),
        ...(conversation.peerLabel ? { peerLabel: conversation.peerLabel } : {}),
        ...(conversation.workspacePath ? { workspacePath: conversation.workspacePath } : {}),
      });
    }

    return [...summaryById.values()].sort((left, right) => right.updatedAt - left.updatedAt);
  }

  async get(id: string): Promise<AiConversation | null> {
    const pending = this.pendingManagers.get(id);
    if (pending) {
      return await this.buildConversationFromManager(pending);
    }
    const sessionPath = await this.resolvePath(id);
    if (!sessionPath) {
      return null;
    }
    return await this.readConversationFromPath(sessionPath);
  }

  async create(service?: string, provider?: string, peerId?: string, peerLabel?: string): Promise<AiConversation> {
    const workspaceDir = await this.ensureWorkspaceDir();
    const manager = SessionManager.create(workspaceDir, this.sessionsDir);
    // Persist '' (not the local proxy sentinel) when no real upstream
    // provider is known. The sentinel used to leak through to the
    // `x-antseed-provider` header on send and trip the buyer proxy's
    // pinned-peer provider check, returning a confusing 502.
    const providerId = sanitizeProviderHint(provider) ?? '';
    manager.appendModelChange(providerId, normalizeServiceId(service));
    const trimmedPeerId = peerId?.trim() ?? '';
    if (trimmedPeerId) {
      manager.appendCustomEntry(ANTSEED_PEER_CUSTOM_TYPE, {
        peerId: trimmedPeerId,
        ...(peerLabel ? { peerLabel } : {}),
      } satisfies AntseedPeerData);
    }
    const sessionPath = manager.getSessionFile();
    if (!sessionPath) {
      throw new Error('Failed to create persisted pi session');
    }
    const conversation = await this.buildConversationFromManager(manager);
    this.pendingManagers.set(conversation.id, manager);
    this.pathCache.set(conversation.id, sessionPath);
    return conversation;
  }

  async setPeer(id: string, peerId: string, peerLabel?: string): Promise<void> {
    const manager = await this.openSessionManager(id);
    if (!manager) return;
    manager.appendCustomEntry(ANTSEED_PEER_CUSTOM_TYPE, { peerId, peerLabel } satisfies AntseedPeerData);
  }

  /** Persist an in-conversation model switch. Without this the rebinding only
      lives in renderer memory and the next conversation-list refresh reverts
      the thread to the model it was created with. */
  async setModel(id: string, provider: string | undefined, service: string | undefined): Promise<void> {
    const manager = await this.openSessionManager(id);
    if (!manager) return;
    manager.appendModelChange(sanitizeProviderHint(provider) ?? '', normalizeServiceId(service));
  }

  async clearPeer(id: string): Promise<void> {
    const manager = await this.openSessionManager(id);
    if (!manager) return;
    manager.appendCustomEntry(ANTSEED_PEER_CUSTOM_TYPE, {});
  }

  async delete(id: string): Promise<void> {
    const pending = this.pendingManagers.get(id);
    const pendingPath = pending?.getSessionFile() ?? null;
    this.pendingManagers.delete(id);

    const sessionPath = (await this.resolvePath(id)) ?? pendingPath;
    if (!sessionPath) {
      this.pathCache.delete(id);
      return;
    }
    try {
      await unlink(sessionPath);
    } catch {
      // Session may already be deleted.
    }
    this.pathCache.delete(id);
  }

  async openSessionManager(id: string): Promise<SessionManager | null> {
    const pending = this.pendingManagers.get(id);
    if (pending) {
      return pending;
    }
    const sessionPath = await this.resolvePath(id);
    if (!sessionPath) {
      return null;
    }
    return SessionManager.open(sessionPath, this.sessionsDir);
  }

  markPersistedIfAvailable(id: string): void {
    const pending = this.pendingManagers.get(id);
    if (!pending) {
      return;
    }
    const sessionPath = pending.getSessionFile();
    if (!sessionPath) {
      return;
    }
    if (!existsSync(sessionPath)) {
      return;
    }
    this.pendingManagers.delete(id);
    this.pathCache.set(id, sessionPath);
  }
}
