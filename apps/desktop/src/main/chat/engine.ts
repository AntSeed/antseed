import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fetchNetworkStats } from '../runtime/fetch-network-stats.js';
import { type ChatStreamStopReason } from './stream-stop.js';
import {
  normalizeChatPeerSelectionRequest,
  type ChatPeerSelectionRequest,
  type ChatRouteMode,
} from './peer-selection.js';
import {
  prepareChatAttachments,
  type PreparedChatAttachment,
  type RawChatAttachment,
} from './attachments/prepare.js';
import {
  deleteConversationAttachments,
  isSafeId,
  saveAttachment,
  sweepOrphanAttachments,
} from './attachments/store.js';
import {
  CHAT_WORKSPACE_DIR,
  getWorkspaceGitStatus,
  loadChatWorkspaceDir,
  persistChatWorkspaceDir,
} from './workspace.js';
import {
  getPeerPermissionMode,
  normalizePermissionMode,
  setPeerPermissionMode,
  type ChatPermissionMode,
  type ToolApprovalDecision,
  type ToolApprovalRequest,
} from './permissions.js';
import { DEFAULT_BUYER_STATE_PATH, LOCALHOST_URL } from '../constants.js';
import { asErrorMessage } from '../utils.js';
import type { RawPeerHealth } from '../runtime/peer-cache.js';
import {
  type ChatServiceCatalogEntry,
  type ChatServiceProtocol,
} from './service-catalog.js';
import { enrichDomainVerificationLinks } from '../connected-apps/domain-site-metadata.js';
import { resolveChainConfig } from '@antseed/node';
import { collectPeerVerificationLinks } from '@antseed/node/discovery';
import { augmentChatToolPath } from './tool-env.js';
import type { AiConversation } from './conversation-types.js';
import {
  buildDiscoverRows,
  discoverChatServiceCatalog,
  isCatalogEntryAllowedByBuyerMax,
  isPriceAllowedByBuyerMax,
  limitChatServiceCatalogEntries,
  loadBuyerMaxPricingDefaults,
  normalizeChatServiceCatalogEntries,
  updateServiceProtocolMap,
  updateServiceProviderHints,
  type BuyerStateDiscoveredPeer,
  type DiscoverRowEntry,
} from './service-discovery.js';
import { isPortReachable, resolveProxyPort } from './proxy-service.js';
import {
  normalizeModelPickerSnapshot,
  type ModelPickerSnapshot,
} from '../../shared/model-picker.js';
import { PiConversationStore } from './conversation-store.js';
import { createStreamingRunner } from './streaming-run.js';
import type {
  ActiveRun,
  ChatStreamErrorPayload,
  RegisterPiChatHandlersOptions,
} from './engine-types.js';

augmentChatToolPath();

/**
 * Programmatic surface over the chat engine for non-renderer frontends
 * (currently the Telegram bridge). Events still flow through the
 * sendToRenderer callback — tee it into the chat event bus to observe them.
 */
export type PiChatEngine = {
  createConversation(service?: string, provider?: string, peerId?: string): Promise<AiConversation>;
  sendMessageStream(
    conversationId: string,
    userMessage: string,
    options?: { service?: string; peerId?: string; permissionMode?: ChatPermissionMode },
  ): Promise<{ ok: boolean; error?: string; stopReason?: ChatStreamStopReason }>;
  abort(conversationId?: string): Promise<void>;
  /** Resolves a pending tool approval; returns false when the id is unknown (already decided). */
  resolveToolApproval(id: string, decision: ToolApprovalDecision): boolean;
  getProxyPort(): Promise<number>;
  /**
   * Discovered network service catalog, sorted the way the chat UI lists
   * models and narrowed to entries within the buyer's routing policy — the
   * buyer proxy refuses pinned peers outside the pricing limits, so offering
   * them would only manufacture 502s.
   */
  discoverServiceCatalog(): Promise<ChatServiceCatalogEntry[]>;
  /**
   * Latest curated model-picker list pushed by the renderer (favorites first,
   * then recommended — the same rows as the in-app model dropdown). Null until
   * the renderer's first push after launch.
   */
  getModelPicker(): ModelPickerSnapshot | null;
  /** Rebinds a conversation's model/peer — same semantics as the chat UI's model dropdown. */
  selectPeer(request: ChatPeerSelectionRequest): Promise<{ ok: boolean; error?: string }>;
  /**
   * Sets the buyer default route (the sticky "current model" new conversations
   * inherit) and tells the renderer so the UI selection follows suit.
   */
  setDefaultRoute(peerId: string, service: string, provider?: string): Promise<{ ok: boolean; error?: string }>;
};

export function registerPiChatHandlers({
  ipcMain,
  sendToRenderer,
  configPath,
  isBuyerRuntimeRunning,
  ensureBuyerRuntimeStarted,
  appendSystemLog,
  getNetworkPeers,
}: RegisterPiChatHandlersOptions): PiChatEngine {
  void loadChatWorkspaceDir().catch(() => {});
  const store = new PiConversationStore();
  const activeRunsByConversation = new Map<string, ActiveRun>();
  const serviceProviderHints = new Map<string, string[]>();
  /** Cached payment-required info from 402 responses, keyed by conversationId. */
  const cachedPaymentRequired = new Map<string, Record<string, unknown>>();
  const serviceProtocolMap = new Map<string, ChatServiceProtocol>();
  const preferredPeerByConversationId = new Map<string, string>();
  const pendingToolApprovals = new Map<string, { conversationId: string; resolve: (decision: ToolApprovalDecision) => void }>();

  const requestToolApproval = (request: ToolApprovalRequest): Promise<ToolApprovalDecision> => {
    return new Promise((resolve) => {
      pendingToolApprovals.set(request.id, { conversationId: request.conversationId, resolve });
      sendToRenderer('chat:tool-approval-requested', request);
    });
  };

  const cancelPendingToolApprovalsForConversation = (conversationId: string): void => {
    for (const [id, pending] of pendingToolApprovals) {
      if (pending.conversationId !== conversationId) continue;
      pendingToolApprovals.delete(id);
      pending.resolve('deny');
      sendToRenderer('chat:tool-approval-cleared', { id, conversationId });
    }
  };

  ipcMain.handle('chat:peer-permission-mode-get', async (_event, peerId: unknown) => {
    try {
      const mode = await getPeerPermissionMode(typeof peerId === 'string' ? peerId : null);
      return { ok: true, mode };
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  });

  ipcMain.handle('chat:peer-permission-mode-set', async (_event, payload: { peerId?: unknown; mode?: unknown }) => {
    try {
      const peerId = typeof payload?.peerId === 'string' ? payload.peerId : null;
      const mode = normalizePermissionMode(payload?.mode);
      await setPeerPermissionMode(peerId, mode);
      return { ok: true, mode };
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  });

  const resolveToolApproval = (id: string, decision: ToolApprovalDecision): boolean => {
    const pending = pendingToolApprovals.get(id);
    if (!pending) return false;
    pendingToolApprovals.delete(id);
    pending.resolve(decision);
    // Any surface may decide first; tell the others the request is settled.
    sendToRenderer('chat:tool-approval-cleared', { id, conversationId: pending.conversationId });
    return true;
  };

  ipcMain.handle('chat:tool-approval-decision', async (_event, payload: { id?: unknown; decision?: unknown }) => {
    const id = typeof payload?.id === 'string' ? payload.id : '';
    const decision = payload?.decision === 'allow_once' || payload?.decision === 'always_allow_peer'
      ? payload.decision
      : 'deny';
    if (!resolveToolApproval(id, decision)) {
      return { ok: false, error: 'Approval request not found' };
    }
    return { ok: true };
  });

  const cacheFallbackPaymentRequired = (conversationId: string, suggestedAmount: string): void => {
    const peerId = preferredPeerByConversationId.get(conversationId) ?? null;
    if (!peerId) {
      return;
    }
    const existing = cachedPaymentRequired.get(conversationId) ?? {};
    cachedPaymentRequired.set(conversationId, {
      ...existing,
      peerId,
      suggestedAmount,
    });
  };

  const emitChatStreamError = (payload: ChatStreamErrorPayload): void => {
    sendToRenderer('chat:ai-stream-error', payload);
  };

  const emitPaymentRequiredStreamError = (
    conversationId: string,
    suggestedAmount: string,
  ): ChatStreamStopReason => {
    const stopReason: ChatStreamStopReason = {
      kind: 'payment_required',
      source: 'billing',
      retryable: false,
      message: 'Payment is required before the stream can continue.',
    };
    emitChatStreamError({
      conversationId,
      error: `payment_required:${suggestedAmount}`,
      stopReason,
    });
    return stopReason;
  };

  const clearActiveRun = (run: ActiveRun | null): void => {
    if (!run) {
      return;
    }

    cancelPendingToolApprovalsForConversation(run.conversationId);

    try {
      run.unsubscribe();
    } catch {
      // Ignore listener cleanup failures.
    }

    try {
      run.session.dispose();
    } catch {
      // Ignore disposal races.
    }

    if (activeRunsByConversation.get(run.conversationId) === run) {
      activeRunsByConversation.delete(run.conversationId);
    }
  };

  const abortAndClearActiveRun = async (run: ActiveRun | null): Promise<void> => {
    if (!run) {
      return;
    }

    try {
      await run.session.abort();
    } catch {
      // Ignore abort races.
    }

    clearActiveRun(run);
  };

  const isProxyAvailable = async (port: number): Promise<boolean> => {
    return await isPortReachable(port);
  };

  const waitForBuyerProxy = async (port: number, timeoutMs = 20_000): Promise<boolean> => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      try {
        if (await isProxyAvailable(port)) {
          return true;
        }
      } catch {
        // transient error — keep polling
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return false;
  };

  let lastServiceCatalogEntries: ChatServiceCatalogEntry[] = [];
  let lastServiceCatalogRefreshAt = 0;
  const SERVICE_CATALOG_DEBOUNCE_MS = 5_000;
  let serviceCatalogRefreshPromise: Promise<ChatServiceCatalogEntry[]> | null = null;

  const refreshServiceCatalogFromNetwork = async (): Promise<ChatServiceCatalogEntry[]> => {
    // Deduplicate concurrent calls
    if (serviceCatalogRefreshPromise) return serviceCatalogRefreshPromise;
    // Debounce rapid calls (e.g. UI refreshes)
    if (Date.now() - lastServiceCatalogRefreshAt < SERVICE_CATALOG_DEBOUNCE_MS && lastServiceCatalogEntries.length > 0) {
      return lastServiceCatalogEntries;
    }

    serviceCatalogRefreshPromise = (async () => {
      const entries = await discoverChatServiceCatalog(getNetworkPeers);
      const limited = limitChatServiceCatalogEntries(normalizeChatServiceCatalogEntries(entries));
      updateServiceProviderHints(serviceProviderHints, limited);
      updateServiceProtocolMap(serviceProtocolMap, limited);
      lastServiceCatalogRefreshAt = Date.now();
      lastServiceCatalogEntries = limited;
      return limited;
    })().finally(() => { serviceCatalogRefreshPromise = null; });

    return serviceCatalogRefreshPromise;
  };

  // The catalog offered to non-renderer frontends (Telegram): only entries
  // the buyer routing policy will actually accept. The renderer applies the
  // same filter in chat:ai-list-discover-rows; without it here, /model
  // offered peers the buyer proxy then rejected with a policy 502.
  const discoverPolicyAllowedCatalog = async (): Promise<ChatServiceCatalogEntry[]> => {
    const entries = await refreshServiceCatalogFromNetwork();
    const buyerMaxPricing = await loadBuyerMaxPricingDefaults(configPath);
    return entries.filter((entry) => isCatalogEntryAllowedByBuyerMax(entry, buyerMaxPricing));
  };

  // Curated model-picker snapshot pushed by the renderer — see
  // shared/model-picker.ts. Main only caches the latest push.
  let modelPickerSnapshot: ModelPickerSnapshot | null = null;
  ipcMain.handle('chat:sync-model-picker', (_event, payload: unknown) => {
    const normalized = normalizeModelPickerSnapshot(payload);
    if (normalized) modelPickerSnapshot = normalized;
    return { ok: normalized != null };
  });

  const resolveProtocolForSend = async (serviceId: string): Promise<ChatServiceProtocol> => {
    const normalizedServiceId = serviceId.trim().toLowerCase();
    const existing = serviceProtocolMap.get(normalizedServiceId);
    if (existing) {
      return existing;
    }

    const refreshed = await refreshServiceCatalogFromNetwork();
    return refreshed.find((entry) => entry.id.trim().toLowerCase() === normalizedServiceId)?.protocol ?? 'anthropic-messages';
  };

  // Built here rather than beside the other helpers because it needs
  // `resolveProtocolForSend`; every caller lives further down.
  const runStreamingPrompt = createStreamingRunner({
    store,
    activeRunsByConversation,
    cachedPaymentRequired,
    preferredPeerByConversationId,
    configPath,
    sendToRenderer,
    appendSystemLog,
    isBuyerRuntimeRunning,
    ensureBuyerRuntimeStarted,
    requestToolApproval,
    cacheFallbackPaymentRequired,
    emitChatStreamError,
    emitPaymentRequiredStreamError,
    clearActiveRun,
    abortAndClearActiveRun,
    isProxyAvailable,
    waitForBuyerProxy,
    resolveProtocolForSend,
    getServiceCatalogEntries: () => lastServiceCatalogEntries,
  });

  ipcMain.handle('chat:ai-get-proxy-status', async () => {
    const port = await resolveProxyPort(configPath);
    const running = await isProxyAvailable(port);
    return {
      ok: true,
      data: {
        running,
        port,
      },
    };
  });

  ipcMain.handle('api:try-proxy-request', async (
    _event,
    params: { port: number; path: string; method: string; headers: Record<string, string>; body: string },
  ) => {
    try {
      const url = `${LOCALHOST_URL}:${params.port}${params.path}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      const res = await fetch(url, {
        method: params.method || 'POST',
        headers: params.headers || {},
        body: params.body || undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      const text = await res.text();
      return { ok: true, status: res.status, body: text, error: null as string | null };
    } catch (e) {
      const err = e as Error;
      return { ok: false, status: 0, body: '', error: err?.message ?? String(e) };
    }
  });

  ipcMain.handle('chat:ai-list-discover-rows', async () => {
    try {
      const buyerMaxPricing = await loadBuyerMaxPricingDefaults(configPath);
      const entries = (await refreshServiceCatalogFromNetwork())
        .filter((entry) => isCatalogEntryAllowedByBuyerMax(entry, buyerMaxPricing));

      const buyerPort = await resolveProxyPort(configPath);
      const statsMap = new Map<string, {
        totalSessions: number;
        totalRequests: number;
        totalInputTokens: number;
        totalOutputTokens: number;
        firstSessionAt: number | null;
        lastSessionAt: number | null;
      }>();
      // Per-peer lifetime metering. The buyer-proxy exposes
      // /_antseed/metering/<peerId>; fetch in parallel for every catalog peer.
      const uniqueCatalogPeerIds = Array.from(new Set(
        entries.map((e) => e.peerId ?? '').filter((p) => p.length > 0)
      ));
      await Promise.all(uniqueCatalogPeerIds.map(async (peerId) => {
        try {
          const resp = await fetch(
            `${LOCALHOST_URL}:${buyerPort}/_antseed/metering/${encodeURIComponent(peerId)}`,
          );
          if (!resp.ok) return;
          const body = await resp.json() as Record<string, unknown> | null;
          if (!body || typeof body !== 'object') return;
          const sessions = Number(body.lifetimeSessions) || 0;
          const reqs = Number(body.lifetimeRequests) || 0;
          const inTok = Number(body.lifetimeInputTokens) || 0;
          const outTok = Number(body.lifetimeOutputTokens) || 0;
          const firstAt = typeof body.lifetimeFirstSessionAt === 'number' ? body.lifetimeFirstSessionAt : null;
          const lastAt = typeof body.lifetimeLastSessionAt === 'number' ? body.lifetimeLastSessionAt : null;
          if (sessions === 0 && reqs === 0 && inTok === 0 && outTok === 0 && firstAt == null && lastAt == null) return;
          statsMap.set(peerId, {
            totalSessions: sessions,
            totalRequests: reqs,
            totalInputTokens: inTok,
            totalOutputTokens: outTok,
            firstSessionAt: firstAt,
            lastSessionAt: lastAt,
          });
        } catch {
          // Ignore — peer simply has no metering info
        }
      }));

      // Static imports at the top of the file — see note on the
      // `discoverChatServiceCatalog` read for why these must not be
      // dynamic in packaged Windows builds.
      let discoveredPeersMap: Record<string, BuyerStateDiscoveredPeer> = {};
      let peerHealthMap: Record<string, RawPeerHealth> = {};
      try {
        const raw = await readFile(DEFAULT_BUYER_STATE_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.peerHealth && typeof parsed.peerHealth === 'object' && !Array.isArray(parsed.peerHealth)) {
          peerHealthMap = parsed.peerHealth as Record<string, RawPeerHealth>;
        }
        const arr = Array.isArray(parsed.discoveredPeers) ? parsed.discoveredPeers : [];
        const enrichmentTasks: Array<Promise<void>> = [];
        for (const p of arr) {
          if (p && typeof p === 'object' && typeof (p as { peerId?: unknown }).peerId === 'string') {
            const rec = p as Record<string, unknown>;
            const peerId = rec.peerId as string;
            const peerRecord: BuyerStateDiscoveredPeer = {
              onChainAgentId: typeof rec.onChainAgentId === 'number' ? rec.onChainAgentId : null,
              onChainStakeUsdcMicros: typeof rec.onChainStakeUsdcMicros === 'number' ? rec.onChainStakeUsdcMicros : null,
              onChainChannelCount: typeof rec.onChainChannelCount === 'number' ? rec.onChainChannelCount : null,
              onChainGhostCount: typeof rec.onChainGhostCount === 'number' ? rec.onChainGhostCount : null,
              onChainTotalVolumeUsdcMicros: typeof rec.onChainTotalVolumeUsdcMicros === 'number' ? rec.onChainTotalVolumeUsdcMicros : null,
              onChainLastSettledAtSec: typeof rec.onChainLastSettledAtSec === 'number' ? rec.onChainLastSettledAtSec : null,
              onChainReputationScore: typeof rec.onChainReputationScore === 'number' ? rec.onChainReputationScore : null,
              onChainTrustScore: typeof rec.onChainTrustScore === 'number' ? rec.onChainTrustScore : null,
              onChainSybilRisk: typeof rec.onChainSybilRisk === 'number' ? rec.onChainSybilRisk : null,
              onChainSybilFlags: Array.isArray(rec.onChainSybilFlags)
                ? rec.onChainSybilFlags.filter((f: unknown): f is string => typeof f === 'string')
                : [],
              sellerContract: typeof rec.sellerContract === 'string' ? rec.sellerContract : undefined,
              verificationLinks: collectPeerVerificationLinks({ verificationResults: rec.verificationResults }),
              peerIconUrl: null,
              providerPricing: rec.providerPricing as Record<string, {
                services?: Record<string, { cachedInputUsdPerMillion?: number }>
              }> | undefined,
            };
            discoveredPeersMap[peerId] = peerRecord;
            enrichmentTasks.push(
              enrichDomainVerificationLinks(peerRecord.verificationLinks).then((links) => {
                peerRecord.verificationLinks = links;
                peerRecord.peerIconUrl = links.find((link) => link.kind === 'domain' && link.faviconUrl)?.faviconUrl ?? null;
              }),
            );
          }
        }
        await Promise.all(enrichmentTasks);
      } catch {
        // No state file yet
      }

      // Network-wide stats from @antseed/network-stats. On non-mainnet chains and on any
      // failure this returns an empty map and buildDiscoverRows falls back to local stats.
      const networkStats = await (async () => {
        try {
          const raw = await readFile(configPath, 'utf8');
          const parsed = JSON.parse(raw) as Record<string, unknown>;
          const payments = (parsed.payments && typeof parsed.payments === 'object') ? parsed.payments as Record<string, unknown> : {};
          const overrides = (payments.crypto && typeof payments.crypto === 'object') ? payments.crypto as Record<string, unknown> : {};
          const selectedChain = (typeof overrides.chainId === 'string' && overrides.chainId.trim().length > 0)
            ? overrides.chainId
            : 'base-mainnet';
          const cc = resolveChainConfig({ chainId: selectedChain });
          return await fetchNetworkStats(cc.networkStatsUrl);
        } catch {
          return new Map<number, { requests: bigint; inputTokens: bigint; outputTokens: bigint }>();
        }
      })();

      const rows = (await buildDiscoverRows(entries, statsMap, discoveredPeersMap, networkStats, peerHealthMap))
        .filter((row) => isPriceAllowedByBuyerMax(
          row.inputUsdPerMillion,
          row.outputUsdPerMillion,
          row.cachedInputUsdPerMillion,
          buyerMaxPricing,
        ));
      return { ok: true, data: rows };
    } catch (error) {
      return { ok: false, data: [] as DiscoverRowEntry[], error: asErrorMessage(error) };
    }
  });

  ipcMain.handle('chat:ai-list-conversations', async () => {
    const conversations = await store.list();
    // Enrich summaries: prefer in-memory peer, fall back to persisted
    const enriched = conversations.map((c) => {
      const memPeerId = preferredPeerByConversationId.get(c.id);
      const peerId = memPeerId || c.peerId;
      if (peerId && !preferredPeerByConversationId.has(c.id)) {
        // Warm the in-memory cache from persisted data
        preferredPeerByConversationId.set(c.id, peerId);
      }
      return peerId ? { ...c, peerId } : c;
    });
    return { ok: true, data: enriched };
  });

  ipcMain.handle('chat:ai-get-workspace', async () => {
    const workspaceDir = await loadChatWorkspaceDir();
    return {
      ok: true,
      data: {
        current: workspaceDir,
        default: CHAT_WORKSPACE_DIR,
      },
    };
  });

  ipcMain.handle('chat:ai-get-workspace-git-status', async () => {
    try {
      const workspaceDir = await loadChatWorkspaceDir();
      return {
        ok: true,
        data: await getWorkspaceGitStatus(workspaceDir),
      };
    } catch (error) {
      return {
        ok: false,
        error: asErrorMessage(error),
      };
    }
  });

  ipcMain.handle('chat:ai-set-workspace', async (_event, workspaceDir: string) => {
    const current = await persistChatWorkspaceDir(workspaceDir);
    return {
      ok: true,
      data: {
        current,
        default: CHAT_WORKSPACE_DIR,
      },
    };
  });

  ipcMain.handle('chat:ai-get-conversation', async (_event, id: string) => {
    const conversation = await store.get(id);
    if (!conversation) {
      return { ok: false, error: 'Conversation not found' };
    }
    const peerId = preferredPeerByConversationId.get(id);
    const enriched = peerId ? { ...conversation, peerId } : conversation;
    return { ok: true, data: enriched };
  });

  const createConversation = async (
    service?: string,
    provider?: string,
    peerId?: string,
    routeMode?: ChatRouteMode,
  ): Promise<AiConversation> => {
    const trimmedPeerId = peerId?.trim() ?? '';
    const peerLabel = trimmedPeerId
      ? lastServiceCatalogEntries.find((e) => e.peerId === trimmedPeerId)?.peerLabel
      : undefined;
    const conversation = await store.create(service, provider, trimmedPeerId || undefined, peerLabel, routeMode);
    if (trimmedPeerId) {
      preferredPeerByConversationId.set(conversation.id, trimmedPeerId);
    } else {
      preferredPeerByConversationId.delete(conversation.id);
    }
    return conversation;
  };

  ipcMain.handle('chat:ai-create-conversation', async (
    _event,
    service: string,
    provider?: string,
    peerId?: string,
    routeMode?: ChatRouteMode,
  ) => {
    return {
      ok: true,
      data: await createConversation(
        service,
        provider,
        peerId,
        routeMode === 'auto' || routeMode === 'pinned' ? routeMode : undefined,
      ),
    };
  });

  ipcMain.handle('chat:ai-delete-conversation', async (_event, id: string) => {
    preferredPeerByConversationId.delete(id);
    cachedPaymentRequired.delete(id);
    await store.delete(id);
    // Best effort: wipe any raw attachment bytes we persisted for this
    // conversation. Failures are swallowed so a stuck directory doesn't
    // block the primary delete from returning ok.
    try {
      await deleteConversationAttachments(id);
    } catch (err) {
      appendSystemLog(`Failed to delete attachments for conversation ${id}: ${asErrorMessage(err)}`);
    }
    return { ok: true };
  });

  // Sweep attachment directories that no longer correspond to any
  // conversation — can happen if a previous run crashed between persist
  // and the delete handler. Cheap (directory stat-only) so we do it once
  // on handler registration.
  void (async () => {
    try {
      const summaries = await store.list();
      const known = new Set<string>(summaries.map((s) => s.id));
      const removed = await sweepOrphanAttachments(known);
      if (removed.length > 0) {
        appendSystemLog(`Swept ${removed.length} orphan attachment director${removed.length === 1 ? 'y' : 'ies'}.`);
      }
    } catch (err) {
      appendSystemLog(`Attachment orphan sweep failed: ${asErrorMessage(err)}`);
    }
  })();

  ipcMain.handle('chat:ai-rename-conversation', async (_event, id: string, title: string) => {
    const manager = await store.openSessionManager(id);
    if (!manager) {
      return { ok: false, error: 'Conversation not found' };
    }
    manager.appendSessionInfo(title.trim());
    return { ok: true };
  });

  ipcMain.handle('chat:prepare-attachments', async (_event, conversationId: string, attachments: RawChatAttachment[]) => {
    try {
      const trimmedId = typeof conversationId === 'string' ? conversationId.trim() : '';
      // Guard the filesystem boundary: only run the disk-backed storage
      // path when the renderer supplied a conversationId we can vouch for.
      // Otherwise fall back to the legacy pure-prepare behaviour — the
      // LLM pipeline still works, we just can't offer native previews.
      const storage = trimmedId && isSafeId(trimmedId)
        ? async (raw: { id: string; name: string; mimeType: string; size: number }, buffer: Buffer): Promise<string> => {
            const attachmentId = randomUUID();
            await saveAttachment(trimmedId, attachmentId, raw.name, buffer);
            return attachmentId;
          }
        : undefined;
      return {
        ok: true,
        data: await prepareChatAttachments(attachments, { ...(storage ? { storage } : {}) }),
      };
    } catch (error) {
      return { ok: false, error: asErrorMessage(error) };
    }
  });

  ipcMain.handle(
    'chat:ai-send-stream',
    async (_event, conversationId: string, userMessage: string, service?: string, _provider?: string, attachments?: PreparedChatAttachment[], peerId?: string, permissionMode?: unknown) => {
      // `_provider` is accepted for IPC ABI compatibility with older
      // renderers but ignored — the buyer proxy resolves the route plan
      // from the pinned peer + the service ID without a provider hint.
      return await runStreamingPrompt(conversationId, userMessage, service, attachments, peerId, permissionMode);
    },
  );

  ipcMain.handle(
    'chat:ai-send',
    async (_event, conversationId: string, userMessage: string, service?: string, _provider?: string, attachments?: PreparedChatAttachment[], peerId?: string, permissionMode?: unknown) => {
      // `_provider` is accepted for IPC ABI compatibility with older
      // renderers but ignored — the buyer proxy resolves the route plan
      // from the pinned peer + the service ID without a provider hint.
      return await runStreamingPrompt(conversationId, userMessage, service, attachments, peerId, permissionMode);
    },
  );

  const abortConversations = async (conversationId?: string): Promise<void> => {
    const trimmedConversationId = typeof conversationId === 'string' ? conversationId.trim() : '';
    const activeRuns = trimmedConversationId
      ? [activeRunsByConversation.get(trimmedConversationId)].filter((run): run is ActiveRun => Boolean(run))
      : Array.from(activeRunsByConversation.values());
    if (activeRuns.length === 0) {
      return;
    }
    await Promise.all(activeRuns.map((run) => abortAndClearActiveRun(run)));
  };

  ipcMain.handle('chat:ai-abort', async (_event, conversationId?: string) => {
    await abortConversations(conversationId);
    return { ok: true };
  });

  const applyPeerSelection = async (payload: ChatPeerSelectionRequest | string | null): Promise<{ ok: boolean; error?: string }> => {
    const { conversationId, peerId, service, provider, routeMode } = normalizeChatPeerSelectionRequest(payload);

    if (conversationId) {
      if (peerId) {
        preferredPeerByConversationId.set(conversationId, peerId);
        const peerLabel = lastServiceCatalogEntries.find((entry) => entry.peerId === peerId)?.peerLabel;
        await store.setPeer(conversationId, peerId, peerLabel, routeMode ?? 'pinned');
      } else {
        preferredPeerByConversationId.delete(conversationId);
        await store.clearPeer(conversationId);
      }
      if (service) {
        await store.setModel(conversationId, provider ?? undefined, service);
      }
    }

    if (!peerId) {
      return { ok: true };
    }

    // Eager connection warmup via buyer proxy
    const proxyPort = await resolveProxyPort(configPath);
    try {
      const response = await fetch(`${LOCALHOST_URL}:${proxyPort}/_antseed/connect`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ peerId }),
      });
      const result = await response.json() as { ok: boolean; error?: string };
      return { ok: result.ok, error: result.error };
    } catch (err) {
      return { ok: false, error: asErrorMessage(err) };
    }
  };

  ipcMain.handle('chat:ai-select-peer', async (_event, payload: ChatPeerSelectionRequest | string | null) => applyPeerSelection(payload));

  // Keep the buyer proxy's default route (`antseed` model alias, and the
  // route the Telegram bridge reads) on the renderer's current VPR selection.
  // Best-effort: the buyer proxy may not be running yet — the renderer calls
  // this again on its catalog poll, so the route lands once the proxy is up.
  let lastPostedDefaultRoute = '';
  const setBuyerDefaultRoute = async (peerIdRaw: unknown, serviceRaw: unknown): Promise<{ ok: boolean; error?: string }> => {
    const peerId = typeof peerIdRaw === 'string' ? peerIdRaw.trim() : '';
    const service = typeof serviceRaw === 'string' ? serviceRaw.trim() : '';
    if (!peerId || !service) return { ok: false, error: 'peerId and service are required' };
    const model = `${peerId}@${service}`;
    if (model === lastPostedDefaultRoute) return { ok: true };
    try {
      const proxyPort = await resolveProxyPort(configPath);
      const response = await fetch(`${LOCALHOST_URL}:${proxyPort}/_antseed/route`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model }),
      });
      const result = await response.json() as { ok?: boolean; error?: string };
      if (result.ok) lastPostedDefaultRoute = model;
      return { ok: result.ok ?? false, error: result.error };
    } catch (err) {
      return { ok: false, error: asErrorMessage(err) };
    }
  };

  ipcMain.handle('chat:set-buyer-default-route', async (_event, payload: { peerId?: unknown; service?: unknown }) => (
    setBuyerDefaultRoute(payload?.peerId, payload?.service)
  ));

  return {
    createConversation,
    sendMessageStream: (conversationId, userMessage, options) => runStreamingPrompt(
      conversationId,
      userMessage,
      options?.service,
      undefined,
      options?.peerId,
      options?.permissionMode,
    ),
    abort: abortConversations,
    resolveToolApproval,
    getProxyPort: () => resolveProxyPort(configPath),
    discoverServiceCatalog: discoverPolicyAllowedCatalog,
    getModelPicker: () => modelPickerSnapshot,
    selectPeer: applyPeerSelection,
    setDefaultRoute: async (peerId, service, provider) => {
      const result = await setBuyerDefaultRoute(peerId, service);
      sendToRenderer('chat:default-route-changed', { peerId, service, provider: provider ?? null });
      return result;
    },
  };
}
