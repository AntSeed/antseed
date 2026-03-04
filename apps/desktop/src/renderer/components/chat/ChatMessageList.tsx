import React from 'react';
import { createComponent } from '@lit/react';
import { AgentInterface, setAppStorage } from '@mariozechner/pi-web-ui';
import '@mariozechner/pi-web-ui/app.css';
import type { ChatRenderableMessage } from './types';

const AgentInterfaceReact = createComponent({
  react: React,
  tagName: 'agent-interface',
  elementClass: AgentInterface,
  events: {},
});

function safeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function safeRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
}

let appStorageInitialized = false;

function ensurePiStorage(): void {
  if (appStorageInitialized) return;
  setAppStorage({
    settings: {
      get: async (key: string) => {
        if (key === 'proxy.enabled') return false;
        if (key === 'proxy.url') return '';
        return undefined;
      },
    },
    providerKeys: {
      get: async () => 'antseed-local',
    },
    sessions: {
      get: async () => null,
      set: async () => {},
    },
    backend: {
      getQuotaInfo: async () => null,
      requestPersistence: async () => false,
    },
  } as never);
  appStorageInitialized = true;
}

function normalizeAssistantContent(content: unknown): { chunks: Array<Record<string, unknown>>; toolResults: Array<Record<string, unknown>> } {
  const chunks: Array<Record<string, unknown>> = [];
  const toolResults: Array<Record<string, unknown>> = [];
  if (!Array.isArray(content)) {
    const text = safeString(content, '');
    if (text.length > 0) {
      chunks.push({ type: 'text', text });
    }
    return { chunks, toolResults };
  }

  let lastToolCallId: string | null = null;
  for (let index = 0; index < content.length; index += 1) {
    const block = safeRecord(content[index]);
    const type = safeString(block.type, '');
    if (type === 'text') {
      const text = safeString(block.text, '');
      if (text.length > 0) {
        chunks.push({ type: 'text', text });
      }
      continue;
    }
    if (type === 'thinking') {
      const thinking = safeString(block.thinking, '');
      if (thinking.length > 0) {
        chunks.push({ type: 'thinking', thinking });
      }
      continue;
    }
    if (type === 'tool_use') {
      const id = safeString(block.id, `tool-${index}`);
      lastToolCallId = id;
      chunks.push({
        type: 'toolCall',
        id,
        name: safeString(block.name, 'tool'),
        arguments: safeRecord(block.input),
      });
      continue;
    }
    if (type === 'tool_result') {
      const toolCallId = safeString(block.tool_use_id, '') || lastToolCallId || `tool-${index}`;
      toolResults.push({
        role: 'toolResult',
        toolCallId,
        toolName: safeString(block.name, 'tool'),
        isError: Boolean(block.is_error),
        content: [
          {
            type: 'text',
            text: safeString(block.content, ''),
          },
        ],
        timestamp: Date.now() + index,
      });
    }
  }

  return { chunks, toolResults };
}

function toPiMessages(messages: ChatRenderableMessage[]): Array<Record<string, unknown>> {
  const mapped: Array<Record<string, unknown>> = [];
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]!;
    if (message.role === 'user') {
      mapped.push({
        role: 'user',
        content: safeString(message.content, ''),
        timestamp: Date.now() + index,
      });
      continue;
    }
    const { chunks, toolResults } = normalizeAssistantContent(message.content);
    mapped.push({
      role: 'assistant',
      content: chunks,
      timestamp: Date.now() + index,
    });
    if (toolResults.length > 0) {
      mapped.push(...toolResults);
    }
  }
  return mapped;
}

function extractPromptText(value: unknown): string {
  if (typeof value === 'string') return value;
  const payload = safeRecord(value);
  if (typeof payload.content === 'string') {
    return payload.content;
  }
  return '';
}

type SessionLike = {
  state: {
    model: Record<string, unknown>;
    messages: Array<Record<string, unknown>>;
    tools: unknown[];
    pendingToolCalls: Set<string>;
    isStreaming: boolean;
    thinkingLevel: 'off' | 'minimal' | 'low' | 'medium' | 'high';
  };
  subscribe: (handler: (event: { type: string; message?: Record<string, unknown> }) => void) => () => void;
  prompt: (input: unknown) => Promise<void>;
  abort: () => Promise<void>;
  setModel: (model: Record<string, unknown>) => void;
  setThinkingLevel: () => void;
  streamFn?: unknown;
  getApiKey?: unknown;
};

type ChatMessageListProps = {
  messages: ChatRenderableMessage[];
  isStreaming: boolean;
  modelId: string;
  onSendPrompt: (prompt: string) => Promise<void>;
  onAbort: () => Promise<void>;
  onModelChange: (modelId: string) => void;
};

export function ChatMessageList({
  messages,
  isStreaming,
  modelId,
  onSendPrompt,
  onAbort,
  onModelChange,
}: ChatMessageListProps) {
  ensurePiStorage();
  const piMessages = React.useMemo(() => toPiMessages(messages), [messages]);
  const session = React.useMemo<SessionLike>(() => ({
    state: {
      model: {
        id: modelId,
        provider: 'antseed',
        reasoning: false,
      },
      messages: piMessages,
      tools: [],
      pendingToolCalls: new Set<string>(),
      isStreaming,
      thinkingLevel: 'off',
    },
    subscribe: () => () => {},
    prompt: async (input) => {
      const promptText = extractPromptText(input).trim();
      if (promptText.length === 0) return;
      await onSendPrompt(promptText);
    },
    abort: async () => {
      await onAbort();
    },
    setModel: (model) => {
      const nextModelId = safeString(model.id, '').trim();
      if (nextModelId.length === 0) return;
      onModelChange(nextModelId);
    },
    setThinkingLevel: () => {},
  }), [isStreaming, modelId, onAbort, onModelChange, onSendPrompt, piMessages]);

  const agentRef = React.useRef<AgentInterface | null>(null);
  React.useEffect(() => {
    const host = agentRef.current;
    if (!host) return;
    const scrollContainer = host.querySelector('.overflow-y-auto');
    if (!scrollContainer) return;
    scrollContainer.scrollTop = scrollContainer.scrollHeight;
  }, [isStreaming, piMessages]);

  return (
    <AgentInterfaceReact
      ref={agentRef}
      session={session as unknown as AgentInterface['session']}
      enableAttachments={false}
      enableThinkingSelector={false}
      enableModelSelector={false}
      showThemeToggle={false}
      onApiKeyRequired={async () => true}
    />
  );
}
