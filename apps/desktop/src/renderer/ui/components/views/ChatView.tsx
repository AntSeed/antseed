import { useRef, useEffect, useState, useCallback, useMemo, useId } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon } from '@hugeicons/core-free-icons';
import { ArrowUp02Icon } from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import { ChatBubble, isToolResultOnlyMessage } from '../chat/ChatBubble';
import { ModelDropdown } from '../chat/ModelDropdown';
import type { ChatModelOptionEntry } from '../../../core/state';

type ChatMessage = {
  role: string;
  content: unknown;
  createdAt?: number;
  meta?: Record<string, unknown>;
};

function getMessageContentKey(content: unknown): string {
  if (typeof content === 'string') {
    return content.slice(0, 48);
  }
  if (Array.isArray(content)) {
    return `${content.length}:${content
      .map((block) => {
        if (!block || typeof block !== 'object') return 'x';
        const typedBlock = block as { type?: unknown; text?: unknown; name?: unknown };
        return `${String(typedBlock.type || 'x')}:${String(typedBlock.name || typedBlock.text || '').slice(0, 24)}`;
      })
      .join('|')}`;
  }
  return String(content ?? '');
}

function getMessageKey(message: ChatMessage, index: number): string {
  const routeRequestId =
    typeof message.meta?.routeRequestId === 'string' ? message.meta.routeRequestId : '';
  if (routeRequestId) {
    return `${message.role}:${routeRequestId}:${index}`;
  }
  const createdAt = Number(message.createdAt) || 0;
  return `${message.role}:${createdAt}:${getMessageContentKey(message.content)}:${index}`;
}

type ChatViewProps = {
  active: boolean;
};

export function ChatView({ active }: ChatViewProps) {
  const snap = useUiSnapshot();
  const actions = useActions();
  const [inputValue, setInputValue] = useState('');
  const [attachedImage, setAttachedImage] = useState<{ base64: string; mimeType: string; previewUrl: string } | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputId = useId();
  const prevInputDisabled = useRef<boolean>(snap.chatInputDisabled);

  const visibleMessages = useMemo(() => {
    const msgs = Array.isArray(snap.chatMessages) ? (snap.chatMessages as ChatMessage[]) : [];
    return msgs.filter((msg) => !isToolResultOnlyMessage(msg));
  }, [snap.chatMessages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [snap.chatMessages]);

  // Re-focus the input when it transitions from disabled → enabled (e.g. after AI response completes)
  useEffect(() => {
    const wasDisabled = prevInputDisabled.current;
    const isDisabled = snap.chatInputDisabled;
    prevInputDisabled.current = isDisabled;
    if (wasDisabled && !isDisabled && inputRef.current) {
      inputRef.current.focus();
    }
  }, [snap.chatInputDisabled]);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text && !attachedImage) return;
    setInputValue('');
    setAttachedImage(null);
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.focus();
    }
    actions.sendMessage(text, attachedImage?.base64, attachedImage?.mimeType);
  }, [inputValue, attachedImage, actions]);

  const handleImageAttach = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const [header, base64] = dataUrl.split(',');
      const mimeType = header.replace('data:', '').replace(';base64', '');
      setAttachedImage({ base64, mimeType, previewUrl: dataUrl });
    };
    reader.readAsDataURL(file);
    // Reset so the same file can be re-attached
    e.target.value = '';
  }, []);

  const handleRemoveImage = useCallback(() => {
    setAttachedImage(null);
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const handleInput = useCallback(() => {
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.height = `${Math.min(inputRef.current.scrollHeight, 150)}px`;
    }
  }, []);

  const conversations = Array.isArray(snap.chatConversations) ? snap.chatConversations : [];
  const showOnboarding =
    conversations.length === 0 && !snap.chatActiveConversation && visibleMessages.length === 0;
  const showWelcome = !showOnboarding && visibleMessages.length === 0;

  return (
    <section className={`view view-chat${active ? ' active' : ''}`} role="tabpanel">
      <div className="page-header">
        <div className="page-header-left">
          <ModelDropdown
            options={snap.chatModelOptions}
            value={snap.chatSelectedModelValue}
            disabled={snap.chatModelSelectDisabled}
            onChange={actions.handleModelChange}
            onFocus={actions.handleModelFocus}
            onBlur={actions.handleModelBlur}
          />
        </div>
        <div className="page-header-right">
          {snap.chatRoutedPeer && (
            <>
              <span className="chat-routed-label">Routed to:</span>
              <span className="chat-routed-peer">{snap.chatRoutedPeer}</span>
            </>
          )}
        </div>
      </div>

      <div className="chat-container">
        <div className="chat-main">
          <div className="chat-messages" ref={scrollRef} data-chat-scroll>
            {showOnboarding ? (
              <ChatOnboarding
                options={snap.chatModelOptions}
                selectedValue={snap.chatSelectedModelValue}
                onModelChange={actions.handleModelChange}
                onStart={() => void actions.createNewConversation()}
              />
            ) : showWelcome ? (
              <div className="chat-welcome">
                <div className="chat-welcome-title">AntSeed AI Chat</div>
                <div className="chat-welcome-subtitle">
                  Send messages through the P2P marketplace to inference providers.
                </div>
                <div className="chat-welcome-subtitle">
                  Buyer runtime auto-connects to the local proxy. Create a new conversation to
                  begin.
                </div>
              </div>
            ) : (
              visibleMessages.map((msg, i) => (
                <ChatBubble key={getMessageKey(msg, i)} message={msg} />
              ))
            )}
            <div data-chat-stream />
          </div>

          <div className="chat-input-area">
            {attachedImage && (
              <div className="chat-image-attach-preview">
                <img src={attachedImage.previewUrl} alt="Attached" className="chat-image-attach-thumb" />
                <button className="chat-image-remove-btn" onClick={handleRemoveImage} title="Remove image">✕</button>
              </div>
            )}
            <div className="chat-input-row">
              <input
                ref={fileInputRef}
                id={fileInputId}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp"
                style={{ display: 'none' }}
                onChange={handleImageAttach}
              />
              <textarea
                ref={inputRef}
                className="chat-text-input"
                placeholder="Type a message... (Shift+Enter for newline)"
                rows={1}
                disabled={snap.chatInputDisabled}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
              />
              <div className="chat-input-bottom">
                <div className="chat-input-bottom-left">
                  <button
                    className="chat-attach-btn"
                    title="Attach image"
                    disabled={snap.chatInputDisabled}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <HugeiconsIcon icon={Add01Icon} size={18} strokeWidth={2} />
                  </button>
                </div>
                {snap.chatAbortVisible ? (
                  <button className="chat-abort-btn" onClick={() => void actions.abortChat()}>
                    Stop
                  </button>
                ) : (
                  <button className="chat-send-btn" disabled={snap.chatSendDisabled && !attachedImage} onClick={handleSend}>
                    <HugeiconsIcon icon={ArrowUp02Icon} size={18} strokeWidth={2.5} />
                  </button>
                )}
              </div>
            </div>
          </div>

          {snap.chatError && <div className="chat-error">{snap.chatError}</div>}
        </div>
      </div>
    </section>
  );
}

type ChatOnboardingProps = {
  options: ChatModelOptionEntry[];
  selectedValue: string;
  onModelChange?: (value: string) => void;
  onStart?: () => void;
};

function ChatOnboarding({ options, selectedValue, onModelChange, onStart }: ChatOnboardingProps) {
  const hasModels = options.length > 0;

  return (
    <div className="chat-welcome">
      <div className="chat-welcome-title">Start your first chat</div>
      <div className="chat-welcome-subtitle">
        Select a model from the network API and create a conversation.
      </div>
      <div
        style={{
          display: 'flex',
          gap: '8px',
          alignItems: 'center',
          flexWrap: 'wrap',
          justifyContent: 'center',
        }}
      >
        <select
          className="form-input chat-model-select"
          value={selectedValue}
          disabled={!hasModels}
          onChange={(e) => onModelChange?.(e.target.value)}
        >
          {hasModels ? (
            options.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))
          ) : (
            <option value="">No models available</option>
          )}
        </select>
        <button disabled={!hasModels} onClick={onStart}>
          Start chat
        </button>
      </div>
      {!hasModels && (
        <div className="chat-welcome-subtitle">
          No models available yet. Ensure Buyer runtime/proxy is online.
        </div>
      )}
    </div>
  );
}
