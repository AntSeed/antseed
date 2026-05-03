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

test('discover-selected draft keeps its peer if another discover chat is opened before create finishes', async () => {
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

test('sending from reopened conversation ignores unrelated global dropdown peer', async () => {
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

test('startNewChat clears payment approval state', () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatActiveConversation = 'conv-a';
  uiState.chatPaymentApprovalVisible = true;
  uiState.chatPaymentApprovalPeerId = 'peer-a';
  uiState.chatPaymentApprovalPeerName = 'Peer A';
  uiState.chatPaymentApprovalPeerInfo = {
    reputation: 100,
    channelCount: 1,
    disputeCount: 0,
    networkAgeDays: 2,
    evmAddress: '0xabc',
  };
  uiState.chatPaymentApprovalLoading = true;
  uiState.chatPaymentApprovalError = 'previous error';

  const api = initChatModule({
    uiState,
    appendSystemLog: () => undefined,
  });

  api.startNewChat();

  assert.equal(uiState.chatActiveConversation, null);
  assert.equal(uiState.chatPaymentApprovalVisible, false);
  assert.equal(uiState.chatPaymentApprovalPeerId, null);
  assert.equal(uiState.chatPaymentApprovalPeerName, null);
  assert.equal(uiState.chatPaymentApprovalPeerInfo, null);
  assert.equal(uiState.chatPaymentApprovalLoading, false);
  assert.equal(uiState.chatPaymentApprovalError, null);
});

test('late payment_required from previous conversation does not reappear on new chat', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, categories: [], description: '',
    },
  ];
  uiState.chatSelectedServiceValue = `openai${SEP}model-a${SEP}peer-a`;
  uiState.chatSelectedPeerId = 'peer-a';

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
  const sends: string[] = [];
  let resolveSend: ((value: { ok: false; error: string }) => void) | null = null;

  const bridge: DesktopBridge = {
    chatAiCreateConversation: async () => ({ ok: true, data: conversation }),
    chatAiListConversations: async () => ({ ok: true, data: [conversation] }),
    chatAiGetConversation: async () => ({ ok: true, data: { ...conversation, messages: [] } }),
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async (conversationId) => {
      sends.push(conversationId);
      return await new Promise<{ ok: false; error: string }>((resolve) => {
        resolveSend = resolve;
      });
    },
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  api.sendMessage('needs payment');
  await waitFor(() => sends.length === 1);
  assert.equal(uiState.chatActiveConversation, 'conv-a');

  api.startNewChat();
  resolveSend?.({ ok: false, error: 'payment_required:1000000' });

  await waitFor(() => uiState.chatSendingConversationIds.length === 0);
  assert.equal(uiState.chatActiveConversation, null);
  assert.equal(uiState.chatPaymentApprovalVisible, false);
  assert.deepEqual(uiState.chatMessages, []);
});

test('payment_required for active conversation still shows approval card', async () => {
  installDomTimers();

  const uiState = createInitialUiState();
  uiState.chatServiceOptions = [
    {
      id: 'model-a', label: 'Model A', provider: 'openai', protocol: 'openai-chat-completions', count: 1,
      value: `openai${SEP}model-a${SEP}peer-a`, peerId: 'peer-a', peerDisplayName: 'Peer A', peerLabel: 'Peer A',
      inputUsdPerMillion: null, outputUsdPerMillion: null, categories: [], description: '',
    },
  ];
  uiState.chatSelectedServiceValue = `openai${SEP}model-a${SEP}peer-a`;
  uiState.chatSelectedPeerId = 'peer-a';

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

  const bridge: DesktopBridge = {
    chatAiCreateConversation: async () => ({ ok: true, data: conversation }),
    chatAiListConversations: async () => ({ ok: true, data: [conversation] }),
    chatAiGetConversation: async () => ({ ok: true, data: { ...conversation, messages: [] } }),
    chatPrepareAttachments: async () => ({ ok: true, data: [] }),
    chatAiSendStream: async () => ({ ok: false, error: 'payment_required:1000000' }),
  };

  const api = initChatModule({ bridge, uiState, appendSystemLog: () => undefined });

  api.sendMessage('needs payment');
  await waitFor(() => uiState.chatPaymentApprovalVisible);

  assert.equal(uiState.chatActiveConversation, 'conv-a');
  assert.equal(uiState.chatPaymentApprovalPeerId, 'peer-a');
  assert.equal(uiState.chatPaymentApprovalPeerName, 'Peer A');
  assert.equal(uiState.chatPaymentApprovalAmount, '1.00');
});
