import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createInitialUiState } from '../core/state.js';
import { initChatModule } from './chat.js';
import type { DesktopBridge } from '../types/bridge.js';

const SEP = '\u0001';

function installDomTimers(): void {
  const g = globalThis as unknown as {
    window?: unknown;
    requestAnimationFrame?: (cb: () => void) => unknown;
  };
  g.window = {
    setInterval: globalThis.setInterval,
    clearInterval: globalThis.clearInterval,
  };
  g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0);
}

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Promise<void> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (predicate()) {
        resolve();
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error('Timed out waiting for condition'));
        return;
      }
      setTimeout(tick, 5);
    };
    tick();
  });
}

function createDeferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

type WorkspaceSetResult =
  | { ok: true; data: { current: string; default: string } }
  | { ok: false; error: string };

type Conversation = {
  id: string;
  title: string;
  service: string;
  provider: string;
  peerId: string;
  messages: unknown[];
  createdAt: number;
  updatedAt: number;
  usage: { inputTokens: number; outputTokens: number };
};

test('discover rows are marked loaded only after a successful catalog response', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  const catalog = createDeferred<{ ok: true; data: unknown[] }>();
  const bridge: DesktopBridge = {
    chatAiListDiscoverRows: async () => catalog.promise,
  };

  initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  await waitFor(() => uiState.chatServiceSelectDisabled);
  assert.equal(uiState.chatDiscoverRowsLoaded, false);

  catalog.resolve({
    ok: true,
    data: [
      {
        peerId: 'peer-a',
        serviceId: 'model-a',
      },
    ],
  });

  await waitFor(() => uiState.chatDiscoverRowsLoaded && !uiState.chatServiceSelectDisabled);
  assert.equal(uiState.discoverRows[0]?.peerId, 'peer-a');
});

test('empty successful discover response still settles catalog loading', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  const bridge: DesktopBridge = {
    chatAiListDiscoverRows: async () => ({ ok: true, data: [] }),
  };

  initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  await waitFor(() => uiState.chatDiscoverRowsLoaded && !uiState.chatServiceSelectDisabled);
  assert.equal(uiState.discoverRows.length, 0);
  assert.equal(uiState.chatServiceStatus.label, 'No services available');
});

test('failed discover response does not mark catalog loaded', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  const bridge: DesktopBridge = {
    chatAiListDiscoverRows: async () => ({ ok: false, error: 'offline' }),
  };

  initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  await waitFor(() => !uiState.chatServiceSelectDisabled && uiState.chatServiceStatus.label === 'offline');
  assert.equal(uiState.chatDiscoverRowsLoaded, false);
});

test('opening a conversation tracks the loading gap before peer binding is restored', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatConversations = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const conversation: Conversation = {
    id: 'conv-a',
    title: 'Conversation A',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const conversationLoad = createDeferred<{ ok: true; data: Conversation }>();
  const bridge: DesktopBridge = {
    chatAiGetConversation: async () => conversationLoad.promise,
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  const openPromise = api.openConversation('conv-a');

  await waitFor(() => uiState.chatOpeningConversationId === 'conv-a');
  assert.equal(uiState.chatActiveConversation, 'conv-a');
  assert.equal(uiState.chatSelectedPeerId, '');

  conversationLoad.resolve({ ok: true, data: conversation });
  await openPromise;

  assert.equal(uiState.chatOpeningConversationId, null);
  assert.equal(uiState.chatSelectedPeerId, 'peer-a');
});

test('new chat created while previous response is pending sends to its own peer', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.appSetupComplete = true;
  uiState.chatServiceOptions = [
    {
      id: 'model-a',
      label: 'Model A',
      provider: 'openai',
      protocol: 'openai-chat-completions',
      count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`,
      peerId: 'peer-a',
      peerDisplayName: 'Peer A',
      peerLabel: 'Peer A',
      inputUsdPerMillion: null,
      outputUsdPerMillion: null,
      cachedInputUsdPerMillion: null,
      categories: [],
      description: '',
    },
    {
      id: 'model-b',
      label: 'Model B',
      provider: 'openai',
      protocol: 'openai-chat-completions',
      count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`,
      peerId: 'peer-b',
      peerDisplayName: 'Peer B',
      peerLabel: 'Peer B',
      inputUsdPerMillion: null,
      outputUsdPerMillion: null,
      cachedInputUsdPerMillion: null,
      categories: [],
      description: '',
    },
  ];
  uiState.chatSelectedServiceValue = `openai${SEP}model-a${SEP}peer-a`;
  uiState.chatSelectedPeerId = 'peer-a';

  const conversations: Conversation[] = [];
  const sends: Array<{
    conversationId: string;
    message: string;
    service?: string;
    provider?: string;
    peerId?: string;
  }> = [];
  const streamDoneHandlers: Array<(data: { conversationId: string }) => void> = [];
  let resolveFirstSend: ((value: { ok: true }) => void) | null = null;

  const bridge: DesktopBridge = {
    chatAiCreateConversation: async (service, provider, peerId) => {
      const now = Date.now();
      const id = `conv-${conversations.length + 1}`;
      conversations.push({
        id,
        title: id,
        service,
        provider: provider ?? '',
        peerId: peerId ?? '',
        messages: [],
        createdAt: now,
        updatedAt: now,
        usage: { inputTokens: 0, outputTokens: 0 },
      });
      return { ok: true, data: conversations[conversations.length - 1] };
    },
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (conversationId, message, service, provider, _attachments, peerId) => {
      sends.push({ conversationId, message, service, provider, peerId });
      // Keep the first request pending long enough to reproduce the race where
      // the user opens/sends a second conversation before the first responds.
      if (conversationId === 'conv-1') {
        return await new Promise<{ ok: true }>((resolve) => {
          resolveFirstSend = resolve;
        });
      }
      return { ok: true };
    },
    onChatAiStreamDone: (handler) => {
      streamDoneHandlers.push(handler);
      return () => undefined;
    },
  };

  const api = initChatModule({
    bridge,
    uiState,
    appendSystemLog: () => undefined,
  });

  api.sendMessage('first message');
  await waitFor(() => sends.length === 1);
  assert.deepEqual(sends[0], {
    conversationId: 'conv-1',
    message: 'first message',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
  });
  assert.deepEqual(uiState.chatSendingConversationIds, ['conv-1']);

  // Mirrors Discover's order: reset draft, then pin the chosen service/peer.
  api.startNewChat();
  api.handleServiceChange(`openai${SEP}model-b${SEP}peer-b`, 'peer-b');
  api.sendMessage('second message');

  await waitFor(() => sends.length === 2);
  assert.deepEqual(sends[1], {
    conversationId: 'conv-2',
    message: 'second message',
    service: 'model-b',
    provider: 'openai',
    peerId: 'peer-b',
  });
  assert.equal(conversations[0]!.peerId, 'peer-a');
  assert.equal(conversations[1]!.peerId, 'peer-b');
  assert.equal(uiState.chatActiveConversation, 'conv-2');
  assert.equal(uiState.chatRoutedPeerId, 'peer-b');
  assert.equal(uiState.chatRoutedPeer, 'Peer B');
  assert.equal(uiState.chatConversationTitle, 'conv-2');

  await api.openConversation('conv-1');
  assert.equal(uiState.chatActiveConversation, 'conv-1');
  assert.equal(uiState.chatRoutedPeerId, 'peer-a');
  assert.equal(uiState.chatRoutedPeer, 'Peer A');
  assert.equal(uiState.chatConversationTitle, 'conv-1');

  resolveFirstSend?.({ ok: true });
  for (const handler of streamDoneHandlers) {
    handler({ conversationId: 'conv-1' });
    handler({ conversationId: 'conv-2' });
  }
  await waitFor(() => uiState.chatSendingConversationIds.length === 0);
});


test('stream errors clear when switching conversations', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
    {
      id: 'model-b', label: 'Model B', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`, peerId: 'peer-b', peerDisplayName: 'Peer B', peerLabel: 'Peer B',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
  ];

  const conversations: Conversation[] = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-b',
      title: 'Conversation B',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const streamErrorHandlers: Array<NonNullable<Parameters<NonNullable<DesktopBridge['onChatAiStreamError']>>[0]>> = [];
  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    onChatAiStreamError: (handler) => {
      streamErrorHandlers.push(handler);
      return () => undefined;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  streamErrorHandlers[0]?.({
    conversationId: 'conv-a',
    error: 'Upstream refused the request',
    stopReason: {
      kind: 'http_error',
      source: 'upstream',
      retryable: false,
      message: 'Upstream refused the request',
      statusCode: 500,
    },
  });

  assert.equal(uiState.chatError, 'Upstream refused the request');

  await api.openConversation('conv-b');
  assert.equal(uiState.chatError, null);

  await api.openConversation('conv-a');
  assert.equal(uiState.chatError, null);
});

test('payment-required card clears when switching conversations or models', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
    {
      id: 'model-b', label: 'Model B', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`, peerId: 'peer-b', peerDisplayName: 'Peer B', peerLabel: 'Peer B',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
  ];

  const conversations: Conversation[] = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [{ role: 'user', content: 'paywalled prompt', createdAt: Date.now() - 1_000 }],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-b',
      title: 'Conversation B',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  let creditsCalls = 0;
  const sends: Array<{ conversationId: string; message: string; service?: string; provider?: string; peerId?: string }> = [];
  const streamErrorHandlers: Array<NonNullable<Parameters<NonNullable<DesktopBridge['onChatAiStreamError']>>[0]>> = [];
  const streamDoneHandlers: Array<(data: { conversationId: string }) => void> = [];
  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    creditsGetInfo: async () => {
      creditsCalls += 1;
      return {
        ok: true,
        data: {
          evmAddress: null,
          operatorAddress: null,
          balanceUsdc: '0',
          reservedUsdc: '0',
          availableUsdc: '0',
          creditLimitUsdc: '0',
        },
        error: null,
      };
    },
    onChatAiStreamError: (handler) => {
      streamErrorHandlers.push(handler);
      return () => undefined;
    },
    onChatAiStreamDone: (handler) => {
      streamDoneHandlers.push(handler);
      return () => undefined;
    },
    chatAiSendStream: async (conversationId, message, service, provider, _attachments, peerId) => {
      sends.push({ conversationId, message, service, provider, peerId });
      return { ok: true };
    },
    chatAiSelectPeer: async () => ({ ok: true }),
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  const emitPaymentRequired = () => streamErrorHandlers[0]?.({
    conversationId: 'conv-a',
    error: 'payment_required:1000000',
    stopReason: {
      kind: 'payment_required',
      source: 'billing',
      retryable: false,
      message: 'Payment required',
      statusCode: 402,
      errorCode: 'payment_required',
    },
  });

  emitPaymentRequired();
  await waitFor(() => creditsCalls === 1);
  await waitFor(() => uiState.chatPaymentApprovalVisible === true);
  assert.equal(uiState.chatPaymentApprovalPeerId, 'peer-a');

  api.retryAfterPayment();
  await waitFor(() => sends.length === 1);
  assert.deepEqual(sends[0], {
    conversationId: 'conv-a',
    message: 'paywalled prompt',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
  });
  assert.equal(uiState.chatPaymentApprovalVisible, true);
  assert.equal(uiState.chatPaymentApprovalPeerId, 'peer-a');

  streamDoneHandlers[0]?.({ conversationId: 'conv-a' });
  assert.equal(uiState.chatPaymentApprovalVisible, true);
  assert.equal(uiState.chatPaymentApprovalPeerId, 'peer-a');

  await api.openConversation('conv-b');
  assert.equal(uiState.chatPaymentApprovalVisible, false);
  assert.equal(uiState.chatPaymentApprovalPeerId, null);

  await api.openConversation('conv-a');
  emitPaymentRequired();
  await waitFor(() => creditsCalls === 2);
  await waitFor(() => uiState.chatPaymentApprovalVisible === true);

  api.handleServiceChange(`openai${SEP}model-b${SEP}peer-b`, 'peer-b');
  assert.equal(uiState.chatPaymentApprovalVisible, false);
  assert.equal(uiState.chatPaymentApprovalPeerId, null);
});

test('discover-selected draft keeps its peer if another discover chat is opened before create finishes', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
    {
      id: 'model-b', label: 'Model B', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`, peerId: 'peer-b', peerDisplayName: 'Peer B', peerLabel: 'Peer B',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
  ];

  const conversations: Conversation[] = [];
  const sends: Array<{ conversationId: string; service?: string; provider?: string; peerId?: string }> = [];
  const streamDoneHandlers: Array<(data: { conversationId: string }) => void> = [];
  let resolveFirstCreate: ((value: { ok: true; data: Conversation }) => void) | null = null;

  const bridge: DesktopBridge = {
    chatAiCreateConversation: async (service, provider, peerId) => {
      const now = Date.now();
      const conversation: Conversation = {
        id: `conv-${conversations.length + 1}`,
        title: `conv-${conversations.length + 1}`,
        service,
        provider: provider ?? '',
        peerId: peerId ?? '',
        messages: [],
        createdAt: now,
        updatedAt: now,
        usage: { inputTokens: 0, outputTokens: 0 },
      };
      conversations.push(conversation);
      if (conversation.id === 'conv-1') {
        return await new Promise<{ ok: true; data: Conversation }>((resolve) => {
          resolveFirstCreate = resolve;
        });
      }
      return { ok: true, data: conversation };
    },
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (conversationId, _message, service, provider, _attachments, peerId) => {
      sends.push({ conversationId, service, provider, peerId });
      return { ok: true };
    },
    onChatAiStreamDone: (handler) => {
      streamDoneHandlers.push(handler);
      return () => undefined;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  api.startNewChat();
  api.handleServiceChange(`openai${SEP}model-a${SEP}peer-a`, 'peer-a');
  api.sendMessage('first');

  await waitFor(() => conversations.length === 1);

  api.startNewChat();
  api.handleServiceChange(`openai${SEP}model-b${SEP}peer-b`, 'peer-b');
  assert.equal(uiState.chatSelectedServiceValue, `openai${SEP}model-b${SEP}peer-b`);
  assert.equal(uiState.chatSelectedPeerId, 'peer-b');

  api.sendMessage('second');
  await waitFor(() => sends.some((send) => send.conversationId === 'conv-2'));

  resolveFirstCreate?.({ ok: true, data: conversations[0]! });
  await waitFor(() => sends.length === 2);

  assert.deepEqual(sends.find((send) => send.conversationId === 'conv-1'), {
    conversationId: 'conv-1',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
  });
  assert.deepEqual(sends.find((send) => send.conversationId === 'conv-2'), {
    conversationId: 'conv-2',
    service: 'model-b',
    provider: 'openai',
    peerId: 'peer-b',
  });
  assert.equal(conversations[0]!.peerId, 'peer-a');
  assert.equal(conversations[1]!.peerId, 'peer-b');
  assert.equal(uiState.chatActiveConversation, 'conv-2');
  assert.equal(uiState.chatSelectedServiceValue, `openai${SEP}model-b${SEP}peer-b`);
  assert.equal(uiState.chatSelectedPeerId, 'peer-b');
  assert.equal(uiState.chatRoutedPeerId, 'peer-b');
  assert.equal(uiState.chatRoutedPeer, 'Peer B');

  await api.openConversation('conv-1');
  assert.equal(uiState.chatRoutedPeerId, 'peer-a');
  assert.equal(uiState.chatRoutedPeer, 'Peer A');

  for (const handler of streamDoneHandlers) {
    handler({ conversationId: 'conv-1' });
    handler({ conversationId: 'conv-2' });
  }
  await waitFor(() => uiState.chatSendingConversationIds.length === 0);
});

test('queued send targets its original conversation after switching chats', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, categories: [], description: '',
    },
    {
      id: 'model-b', label: 'Model B', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`, peerId: 'peer-b', peerDisplayName: 'Peer B', peerLabel: 'Peer B',
      inputUsdPerMillion: null, outputUsdPerMillion: null, categories: [], description: '',
    },
  ];

  const conversations: Conversation[] = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-b',
      title: 'Conversation B',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];
  const sends: Array<{ conversationId: string; message: string; service?: string; provider?: string; peerId?: string }> = [];
  const streamDoneHandlers: Array<(data: { conversationId: string }) => void> = [];

  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (conversationId, message, service, provider, _attachments, peerId) => {
      sends.push({ conversationId, message, service, provider, peerId });
      return { ok: true };
    },
    onChatAiStreamDone: (handler) => {
      streamDoneHandlers.push(handler);
      return () => undefined;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();
  await api.openConversation('conv-b');

  // Mirrors ChatView's pending queue flush: the draft was authored in conv-a,
  // but the user has since opened conv-b. It must still route to conv-a's peer.
  api.sendMessageToConversation('conv-a', 'queued for a');
  await waitFor(() => sends.length === 1);

  assert.deepEqual(sends[0], {
    conversationId: 'conv-a',
    message: 'queued for a',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
  });
  assert.equal(uiState.chatActiveConversation, 'conv-b');
  assert.equal(uiState.chatRoutedPeerId, 'peer-b');
  assert.deepEqual(uiState.chatSendingConversationIds, ['conv-a']);

  for (const handler of streamDoneHandlers) {
    handler({ conversationId: 'conv-a' });
  }
  await waitFor(() => uiState.chatSendingConversationIds.length === 0);
});

test('sending from reopened conversation ignores unrelated global dropdown peer', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
    {
      id: 'model-b', label: 'Model B', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`, peerId: 'peer-b', peerDisplayName: 'Peer B', peerLabel: 'Peer B',
      inputUsdPerMillion: null, outputUsdPerMillion: null, cachedInputUsdPerMillion: null, categories: [], description: '',
    },
  ];
  uiState.chatSelectedServiceValue = `openai${SEP}model-b${SEP}peer-b`;
  uiState.chatSelectedPeerId = 'peer-b';

  const conversation: Conversation = {
    id: 'conv-a',
    title: 'Conversation A',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  };
  const sends: Array<{ service?: string; provider?: string; peerId?: string }> = [];
  const streamDoneHandlers: Array<(data: { conversationId: string }) => void> = [];

  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [conversation] }),
    chatAiGetConversation: async () => ({ ok: true, data: { ...conversation, messages: [] } }),
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (_conversationId, _message, service, provider, _attachments, peerId) => {
      sends.push({ service, provider, peerId });
      return { ok: true };
    },
    onChatAiStreamDone: (handler) => {
      streamDoneHandlers.push(handler);
      return () => undefined;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.openConversation('conv-a');

  // Simulate the user/global selector moving to another peer after the thread
  // is open. The thread itself must remain pinned to conv-a's persisted peer.
  uiState.chatSelectedServiceValue = `openai${SEP}model-b${SEP}peer-b`;
  uiState.chatSelectedPeerId = 'peer-b';

  api.sendMessage('still for peer a');
  await waitFor(() => sends.length === 1);

  assert.deepEqual(sends[0], {
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
  });
  assert.equal(uiState.chatActiveConversation, 'conv-a');
  assert.equal(uiState.chatRoutedPeerId, 'peer-a');
  assert.equal(uiState.chatRoutedPeer, 'Peer A');
  assert.equal(uiState.chatConversationTitle, 'Conversation A');

  for (const handler of streamDoneHandlers) {
    handler({ conversationId: 'conv-a' });
  }
  await waitFor(() => uiState.chatSendingConversationIds.length === 0);
});

test('opening a conversation restores its workspace path', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.appSetupComplete = true;
  uiState.chatWorkspacePath = '/default/workspace';

  const conversations: Conversation[] = [
    {
      id: 'conv-project-a',
      title: 'Project A Chat',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-project-b',
      title: 'Project B Chat',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const workspaceCallLog: string[] = [];

  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetWorkspace: async () => ({ ok: true, data: { current: '/default/workspace', default: '/default' } }),
    chatAiGetWorkspaceGitStatus: async () => ({
      ok: true,
      data: {
        available: true,
        rootPath: '/default/workspace',
        branch: 'main',
        isDetached: false,
        ahead: 0,
        behind: 0,
        stagedFiles: 0,
        modifiedFiles: 0,
        untrackedFiles: 0,
        error: null,
      },
    }),
    chatAiGetConversation: async (id) => {
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return { ok: false, error: 'not found' };
      // Simulate that conv-a was created in /project-a and conv-b in /project-b
      const workspacePath = id === 'conv-project-a' ? '/project-a' : '/project-b';
      return { ok: true, data: { ...conv, messages: [], workspacePath } };
    },
    chatAiSetWorkspace: async (workspacePath: string) => {
      workspaceCallLog.push(workspacePath);
      uiState.chatWorkspacePath = workspacePath;
      return { ok: true, data: { current: workspacePath, default: '/default' } };
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();

  // Before opening any conversation, workspace is the default
  assert.equal(uiState.chatWorkspacePath, '/default/workspace');

  // Open conv-project-a — should restore workspace to /project-a
  await api.openConversation('conv-project-a');

  // Wait for the async restoreWorkspace call
  await waitFor(() => workspaceCallLog.length >= 1, 2_000);
  assert.equal(workspaceCallLog[0], '/project-a');
  assert.equal(uiState.chatWorkspacePath, '/project-a');

  // Open conv-project-b — should restore workspace to /project-b
  workspaceCallLog.length = 0;
  await api.openConversation('conv-project-b');

  await waitFor(() => workspaceCallLog.length >= 1, 2_000);
  assert.equal(workspaceCallLog[0], '/project-b');
  assert.equal(uiState.chatWorkspacePath, '/project-b');
});

test('rapid conversation switches keep the latest workspace selected', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.appSetupComplete = true;
  uiState.chatWorkspacePath = '/default/workspace';

  const conversations: Conversation[] = [
    {
      id: 'conv-project-a',
      title: 'Project A Chat',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-project-b',
      title: 'Project B Chat',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const workspaceCallLog: string[] = [];
  const pendingWorkspaceSets = new Map<
    string,
    ReturnType<typeof createDeferred<WorkspaceSetResult>>
  >();

  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetWorkspaceGitStatus: async () => ({
      ok: true,
      data: {
        available: true,
        rootPath: uiState.chatWorkspacePath,
        branch: 'main',
        isDetached: false,
        ahead: 0,
        behind: 0,
        stagedFiles: 0,
        modifiedFiles: 0,
        untrackedFiles: 0,
        error: null,
      },
    }),
    chatAiGetConversation: async (id) => {
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return { ok: false, error: 'not found' };
      const workspacePath = id === 'conv-project-a' ? '/project-a' : '/project-b';
      return { ok: true, data: { ...conv, messages: [], workspacePath } };
    },
    chatAiSetWorkspace: async (workspacePath: string) => {
      workspaceCallLog.push(workspacePath);
      const deferred = createDeferred<WorkspaceSetResult>();
      pendingWorkspaceSets.set(`${workspacePath}:${workspaceCallLog.length}`, deferred);
      return deferred.promise;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();

  await api.openConversation('conv-project-a');
  await waitFor(() => workspaceCallLog.length === 1);
  assert.equal(workspaceCallLog[0], '/project-a');

  await api.openConversation('conv-project-b');
  await waitFor(() => workspaceCallLog.length === 2);
  assert.equal(workspaceCallLog[1], '/project-b');

  // Let the latest switch finish first.
  pendingWorkspaceSets.get('/project-b:2')?.resolve({
    ok: true,
    data: { current: '/project-b', default: '/default' },
  });
  await waitFor(() => uiState.chatWorkspacePath === '/project-b');

  // Now a stale earlier switch finishes. The module should re-apply /project-b
  // because the stale IPC call may have changed persisted main-process state.
  pendingWorkspaceSets.get('/project-a:1')?.resolve({
    ok: true,
    data: { current: '/project-a', default: '/default' },
  });
  await waitFor(() => workspaceCallLog.length === 3);
  assert.equal(workspaceCallLog[2], '/project-b');
  pendingWorkspaceSets.get('/project-b:3')?.resolve({
    ok: true,
    data: { current: '/project-b', default: '/default' },
  });

  await waitFor(() => uiState.chatWorkspacePath === '/project-b');
  assert.equal(uiState.chatActiveConversation, 'conv-project-b');
});

test('stale manual workspace failure does not overwrite the latest desired conversation workspace', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.appSetupComplete = true;
  uiState.chatWorkspacePath = '/current';

  const conversations: Conversation[] = [
    {
      id: 'conv-project-a',
      title: 'Project A Chat',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
    {
      id: 'conv-project-b',
      title: 'Project B Chat',
      service: 'model-b',
      provider: 'openai',
      peerId: 'peer-b',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const workspaceCallLog: string[] = [];
  const pendingWorkspaceSets = new Map<
    string,
    ReturnType<typeof createDeferred<WorkspaceSetResult>>
  >();

  const bridge: DesktopBridge = {
    pickDirectory: async () => ({ ok: true, path: '/manual' }),
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetWorkspaceGitStatus: async () => ({
      ok: true,
      data: {
        available: true,
        rootPath: uiState.chatWorkspacePath,
        branch: 'main',
        isDetached: false,
        ahead: 0,
        behind: 0,
        stagedFiles: 0,
        modifiedFiles: 0,
        untrackedFiles: 0,
        error: null,
      },
    }),
    chatAiGetConversation: async (id) => {
      const conv = conversations.find((c) => c.id === id);
      if (!conv) return { ok: false, error: 'not found' };
      const workspacePath = id === 'conv-project-a' ? '/project-a' : '/project-b';
      return { ok: true, data: { ...conv, messages: [], workspacePath } };
    },
    chatAiSetWorkspace: async (workspacePath: string) => {
      workspaceCallLog.push(workspacePath);
      const deferred = createDeferred<WorkspaceSetResult>();
      pendingWorkspaceSets.set(`${workspacePath}:${workspaceCallLog.length}`, deferred);
      return deferred.promise;
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();

  await api.openConversation('conv-project-a');
  await waitFor(() => workspaceCallLog.length === 1);
  assert.equal(workspaceCallLog[0], '/project-a');

  const chooseWorkspacePromise = api.chooseWorkspace();
  await waitFor(() => workspaceCallLog.length === 2);
  assert.equal(workspaceCallLog[1], '/manual');

  await api.openConversation('conv-project-b');
  await waitFor(() => workspaceCallLog.length === 3);
  assert.equal(workspaceCallLog[2], '/project-b');

  pendingWorkspaceSets.get('/manual:2')?.resolve({ ok: false, error: 'manual failed' });
  await chooseWorkspacePromise;

  // If the stale manual failure reset desiredWorkspacePath, this older stale
  // completion would not re-apply /project-b.
  pendingWorkspaceSets.get('/project-a:1')?.resolve({
    ok: true,
    data: { current: '/project-a', default: '/default' },
  });
  await waitFor(() => workspaceCallLog.length === 4);
  assert.equal(workspaceCallLog[3], '/project-b');

  pendingWorkspaceSets.get('/project-b:3')?.resolve({
    ok: true,
    data: { current: '/project-b', default: '/default' },
  });
  pendingWorkspaceSets.get('/project-b:4')?.resolve({
    ok: true,
    data: { current: '/project-b', default: '/default' },
  });
  await waitFor(() => uiState.chatWorkspacePath === '/project-b');
});

test('opening a conversation does not switch workspace if it matches the current one', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.appSetupComplete = true;
  uiState.chatWorkspacePath = '/project-a';

  const conversation: Conversation = {
    id: 'conv-project-a',
    title: 'Project A Chat',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
    messages: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  const workspaceCallLog: string[] = [];

  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [conversation] }),
    chatAiGetConversation: async () => ({
      ok: true,
      data: { ...conversation, messages: [], workspacePath: '/project-a' },
    }),
    chatAiSetWorkspace: async (workspacePath: string) => {
      workspaceCallLog.push(workspacePath);
      return { ok: true, data: { current: workspacePath, default: '/default' } };
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();

  // The conversation's workspacePath matches current workspace (/project-a)
  // so chatAiSetWorkspace should NOT be called
  await api.openConversation('conv-project-a');

  // Give a tick for any potential async calls
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(workspaceCallLog.length, 0, 'should not call chatAiSetWorkspace when workspace already matches');
});

test('switching service mid-conversation routes the next send to the new model', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, categories: [], description: '',
    },
    {
      id: 'model-b', label: 'Model B', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-b${SEP}peer-b`, peerId: 'peer-b', peerDisplayName: 'Peer B', peerLabel: 'Peer B',
      inputUsdPerMillion: null, outputUsdPerMillion: null, categories: [], description: '',
    },
  ];

  const conversations: Conversation[] = [
    {
      id: 'conv-a',
      title: 'Conversation A',
      service: 'model-a',
      provider: 'openai',
      peerId: 'peer-a',
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
      usage: { inputTokens: 0, outputTokens: 0 },
    },
  ];

  const sends: Array<{
    conversationId: string;
    message: string;
    service?: string;
    provider?: string;
    peerId?: string;
  }> = [];
  const streamDoneHandlers: Array<(data: { conversationId: string }) => void> = [];

  const bridge: DesktopBridge = {
    chatAiListConversations: async () => ({ ok: true, data: [...conversations] }),
    chatAiGetConversation: async (id) => {
      const conversation = conversations.find((c) => c.id === id);
      return conversation
        ? { ok: true, data: { ...conversation, messages: [...conversation.messages] } }
        : { ok: false, error: 'not found' };
    },
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (conversationId, message, service, provider, _attachments, peerId) => {
      sends.push({ conversationId, message, service, provider, peerId });
      return { ok: true };
    },
    onChatAiStreamDone: (handler) => {
      streamDoneHandlers.push(handler);
      return () => undefined;
    },
    chatAiSelectPeer: async () => ({ ok: true }),
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });
  await api.refreshChatConversations();
  await api.openConversation('conv-a');

  api.sendMessage('hello from model a');
  await waitFor(() => sends.length === 1);
  assert.deepEqual(sends[0], {
    conversationId: 'conv-a',
    message: 'hello from model a',
    service: 'model-a',
    provider: 'openai',
    peerId: 'peer-a',
  });

  for (const handler of streamDoneHandlers) {
    handler({ conversationId: 'conv-a' });
  }
  await waitFor(() => uiState.chatSendingConversationIds.length === 0);

  api.handleServiceChange(`openai${SEP}model-b${SEP}peer-b`, 'peer-b');
  assert.equal(uiState.chatSelectedServiceValue, `openai${SEP}model-b${SEP}peer-b`);
  assert.equal(uiState.chatSelectedPeerId, 'peer-b');

  api.sendMessage('hello from model b');
  await waitFor(() => sends.length === 2);
  assert.deepEqual(sends[1], {
    conversationId: 'conv-a',
    message: 'hello from model b',
    service: 'model-b',
    provider: 'openai',
    peerId: 'peer-b',
  });

  const summary = (uiState.chatConversations as { id: string; service?: string; peerId?: string }[])
    .find((c) => c.id === 'conv-a');
  assert.equal(summary?.service, 'model-b');
  assert.equal(summary?.peerId, 'peer-b');

  for (const handler of streamDoneHandlers) {
    handler({ conversationId: 'conv-a' });
  }
  await waitFor(() => uiState.chatSendingConversationIds.length === 0);
});
