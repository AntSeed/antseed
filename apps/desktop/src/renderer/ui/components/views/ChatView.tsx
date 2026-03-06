import { useRef, useEffect, useState, useCallback, useMemo, useId } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon } from '@hugeicons/core-free-icons';
import { ArrowUp02Icon } from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import { ChatBubble, isToolResultOnlyMessage } from '../chat/ChatBubble';
import { WalkingAnt } from '../chat/WalkingAnt';
import { ModelDropdown } from '../chat/ModelDropdown';
import { AntStationStackedLogo } from '../AntStationLogo';
import styles from './ChatView.module.scss';

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
  const isUserScrolledUp = useRef(false);
  const prevMessageCount = useRef(0);

  const visibleMessages = useMemo(() => {
    const msgs = Array.isArray(snap.chatMessages) ? (snap.chatMessages as ChatMessage[]) : [];
    return msgs.filter((msg) => !isToolResultOnlyMessage(msg));
  }, [snap.chatMessages]);

  // Track whether the user has scrolled away from the bottom
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const handleScroll = () => {
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
      isUserScrolledUp.current = !atBottom;
    };
    el.addEventListener('scroll', handleScroll, { passive: true });
    return () => el.removeEventListener('scroll', handleScroll);
  }, []);

  // Auto-scroll only when new messages arrive and user hasn't scrolled up
  useEffect(() => {
    const count = visibleMessages.length;
    const isNew = count > prevMessageCount.current;
    prevMessageCount.current = count;
    if (isNew && !isUserScrolledUp.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [visibleMessages]);

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

  const showWelcome = !snap.chatActiveConversation && visibleMessages.length === 0;

  return (
    <section className={`view view-chat${active ? ' active' : ''}`} role="tabpanel">
      <div className={styles.pageHeader}>
        <div className={styles.pageHeaderLeft}>
          <ModelDropdown
            options={snap.chatModelOptions}
            value={snap.chatSelectedModelValue}
            disabled={snap.chatModelSelectDisabled}
            onChange={actions.handleModelChange}
            onFocus={actions.handleModelFocus}
            onBlur={actions.handleModelBlur}
          />
        </div>
        <div className={styles.pageHeaderRight}>
          {snap.chatRoutedPeer && (
            <>
              <span className={styles.chatRoutedLabel}>Routed to:</span>
              <span className={styles.chatRoutedPeer}>{snap.chatRoutedPeer}</span>
            </>
          )}
        </div>
      </div>

      <div className={styles.chatContainer}>
        <div className={styles.chatMain}>
          <div className={styles.chatMessages} ref={scrollRef} data-chat-scroll>
            {showWelcome ? (
              <div className={styles.chatWelcome}>
                <AntStationStackedLogo height={72} />
                <div className={styles.chatWelcomeSubtitle}>
                  Start typing. Best provider auto-selected by reputation.
                </div>
              </div>
            ) : (
              visibleMessages.map((msg, i) => (
                <ChatBubble key={getMessageKey(msg, i)} message={msg} />
              ))
            )}
            <div data-chat-stream />
            {snap.chatSending && <WalkingAnt elapsedMs={snap.chatThinkingElapsedMs} />}
          </div>

          <div className={styles.chatInputArea}>
            {attachedImage && (
              <div className={styles.chatImageAttachPreview}>
                <img src={attachedImage.previewUrl} alt="Attached" className={styles.chatImageAttachThumb} />
                <button className={styles.chatImageRemoveBtn} onClick={handleRemoveImage} title="Remove image">✕</button>
              </div>
            )}
            <div className={styles.chatInputRow}>
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
                className={styles.chatTextInput}
                placeholder="Type a message... (Shift+Enter for newline)"
                rows={1}
                disabled={snap.chatInputDisabled}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
              />
              <div className={styles.chatInputBottom}>
                <div className={styles.chatInputBottomLeft}>
                  <button
                    className={styles.chatAttachBtn}
                    title="Attach image"
                    disabled={snap.chatInputDisabled}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <HugeiconsIcon icon={Add01Icon} size={18} strokeWidth={2} />
                  </button>
                </div>
                {snap.chatAbortVisible ? (
                  <button className={styles.chatAbortBtn} onClick={() => void actions.abortChat()}>
                    Stop
                  </button>
                ) : (
                  <button className={styles.chatSendBtn} disabled={snap.chatSendDisabled && !attachedImage} onClick={handleSend}>
                    <HugeiconsIcon icon={ArrowUp02Icon} size={18} strokeWidth={2.5} />
                  </button>
                )}
              </div>
            </div>
          </div>

          {snap.chatError && <div className={styles.chatError}>{snap.chatError}</div>}
        </div>
      </div>
    </section>
  );
}
