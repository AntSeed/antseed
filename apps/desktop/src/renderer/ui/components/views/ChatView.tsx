import { useRef, useEffect, useState, useCallback, useMemo, useId } from 'react';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import { ChatBubble, isToolResultOnlyMessage } from '../chat/ChatBubble';
import type { ChatModelOptionEntry } from '../../../core/state';

type ChatMessage = {
  role: string;
  content: unknown;
  createdAt?: number;
  meta?: Record<string, unknown>;
};

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

  const visibleMessages = useMemo(() => {
    const msgs = Array.isArray(snap.chatMessages) ? (snap.chatMessages as ChatMessage[]) : [];
    return msgs.filter((msg) => !isToolResultOnlyMessage(msg));
  }, [snap.chatMessages]);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [snap.chatMessages]);

  // Re-focus the input whenever it becomes enabled (e.g. after AI response completes)
  useEffect(() => {
    if (!snap.chatInputDisabled && inputRef.current) {
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
        <h2>AI Chat</h2>
        <div className="page-header-right">
          <select
            className="form-input chat-model-select"
            value={snap.chatSelectedModelValue}
            disabled={snap.chatModelSelectDisabled}
            onChange={(e) => actions.handleModelChange(e.target.value)}
            onFocus={() => actions.handleModelFocus()}
            onBlur={() => actions.handleModelBlur()}
          >
            {snap.chatModelOptions.length === 0 ? (
              <option value="">No models available</option>
            ) : (
              snap.chatModelOptions.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))
            )}
          </select>
          <div className={`connection-badge badge-${snap.chatModelStatus.tone}`}>
            {snap.chatModelStatus.label}
          </div>
          <div className={`connection-badge badge-${snap.chatProxyStatus.tone}`}>
            {snap.chatProxyStatus.label}
          </div>
        </div>
      </div>

      <div className="chat-container">
        <div className="chat-main">
          <div className="chat-thread-header">
            <div className="chat-thread-title">
              <span className="chat-thread-peer">{snap.chatConversationTitle}</span>
              <span className="chat-thread-meta">{snap.chatThreadMeta}</span>
            </div>
            {snap.chatDeleteVisible && (
              <button
                className="btn-icon chat-delete-btn"
                title="Delete conversation"
                onClick={() => void actions.deleteConversation()}
              >
                Delete
              </button>
            )}
          </div>

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
                <ChatBubble key={`msg-${msg.createdAt || 0}-${i}`} message={msg} />
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
              <button
                className="chat-attach-btn"
                title="Attach image"
                disabled={snap.chatInputDisabled}
                onClick={() => fileInputRef.current?.click()}
              >
                📎
              </button>
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
              {snap.chatAbortVisible ? (
                <button className="chat-abort-btn" onClick={() => void actions.abortChat()}>
                  Stop
                </button>
              ) : (
                <button disabled={snap.chatSendDisabled && !attachedImage} onClick={handleSend}>
                  Send
                </button>
              )}
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
