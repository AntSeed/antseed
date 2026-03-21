import { useRef, useEffect, useState, useCallback, useMemo, useId } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon } from '@hugeicons/core-free-icons';
import { ArrowUp02Icon } from '@hugeicons/core-free-icons';
import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { RepeatIcon } from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import { ChatBubble } from '../chat/ChatBubble';
import { isToolResultOnlyMessage } from '../chat/chat-utils.js';
import { WalkingAnt } from '../chat/WalkingAnt';
import { SessionApprovalCard } from '../chat/SessionApprovalCard';
import { LowBalanceWarning } from '../chat/LowBalanceWarning';

import { AntStationStackedLogo } from '../AntStationLogo';
import styles from './ChatView.module.scss';
import type { ChatMessage } from '../chat/chat-shared';
import { buildDisplayMessages } from '../chat/chat-shared';

const MAX_INPUT_HEIGHT = 220;

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
  onSelectView?: (view: import('../../types').ViewName) => void;
};

export function ChatView({ active, onSelectView }: ChatViewProps) {
  const snap = useUiSnapshot();
  const actions = useActions();
  const [inputValue, setInputValue] = useState('');
  const [attachedImage, setAttachedImage] = useState<{ base64: string; mimeType: string; previewUrl: string } | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputId = useId();
  const prevInputDisabled = useRef<boolean>(snap.chatInputDisabled);
  const isUserScrolledUp = useRef(false);
  const visibleMessages = useMemo(() => {
    const msgs = Array.isArray(snap.chatMessages) ? (snap.chatMessages as ChatMessage[]) : [];
    return buildDisplayMessages(msgs).filter((msg) => !isToolResultOnlyMessage(msg));
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

  // Keep the view pinned to the bottom while the user is already at the bottom.
  // This covers streaming updates, tool diffs, and other in-place content growth.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || isUserScrolledUp.current) {
      return;
    }

    const scrollToBottom = (): void => {
      el.scrollTop = el.scrollHeight;
    };

    scrollToBottom();

    if (typeof ResizeObserver === 'undefined') {
      return;
    }

    const observer = new ResizeObserver(() => {
      if (!isUserScrolledUp.current) {
        scrollToBottom();
      }
    });

    observer.observe(el);
    Array.from(el.children).forEach((child) => observer.observe(child));

    return () => observer.disconnect();
  }, [visibleMessages, snap.chatStreamingMessage, snap.chatSending]);

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
      inputRef.current.style.overflowY = 'hidden';
      inputRef.current.focus();
    }
    actions.sendMessage(text, attachedImage?.base64, attachedImage?.mimeType);
  }, [inputValue, attachedImage, actions]);

  const ALLOWED_PASTE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

  const attachImageFile = useCallback((file: File) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const [header, base64] = dataUrl.split(',');
      const mimeType = header.replace('data:', '').replace(';base64', '');
      setAttachedImage({ base64, mimeType, previewUrl: dataUrl });
    };
    reader.readAsDataURL(file);
  }, []);

  const handleImageAttach = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    attachImageFile(file);
    // Reset so the same file can be re-attached
    e.target.value = '';
  }, [attachImageFile]);

  const handleRemoveImage = useCallback(() => {
    setAttachedImage(null);
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!ALLOWED_PASTE_MIME_TYPES.has(item.type)) continue;
      const file = item.getAsFile();
      if (!file) continue;
      e.preventDefault();
      attachImageFile(file);
      return;
    }
  }, [attachImageFile]);

  const handleDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file && ALLOWED_PASTE_MIME_TYPES.has(file.type)) attachImageFile(file);
  }, [attachImageFile]);


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
      const newHeight = Math.min(inputRef.current.scrollHeight, MAX_INPUT_HEIGHT);
      inputRef.current.style.height = `${newHeight}px`;
      inputRef.current.style.overflowY = inputRef.current.scrollHeight > MAX_INPUT_HEIGHT ? 'auto' : 'hidden';
    }
  }, []);

  const showWelcome =
    snap.chatConversationsLoaded &&
    !snap.chatActiveConversation &&
    visibleMessages.length === 0 &&
    !snap.chatStreamingMessage;

  return (
    <section className={`view view-chat${active ? ' active' : ''}`} role="tabpanel">
      <div className={styles.pageHeader}>
        <div className={styles.pageHeaderLeft} />
        <div className={styles.pageHeaderRight}>
          {snap.chatRoutedPeer ? (
            <button
              className={styles.peerServiceIndicator}
              onClick={() => { actions.clearPinnedPeer(); onSelectView?.('discover'); }}
            >
              <span className={styles.peerName}>{snap.chatRoutedPeer}</span>
              <span className={styles.serviceSeparator}>·</span>
              <span className={styles.serviceName}>
                {snap.chatServiceOptions.find((o) => o.value === snap.chatSelectedServiceValue)?.label || snap.chatSelectedServiceValue || 'Service'}
              </span>
              <HugeiconsIcon icon={RepeatIcon} size={14} strokeWidth={1.5} />
            </button>
          ) : (
            <span className={styles.serviceLabel}>
              {snap.chatServiceOptions.find((o) => o.value === snap.chatSelectedServiceValue)?.label || 'No peer selected'}
            </span>
          )}
        </div>
      </div>

      {showWelcome && (
        <button
          className={styles.chatExternalHint}
          onClick={() => onSelectView?.('external-clients')}
        >
          <span>Works with Claude Code, Codex, OpenCode, and any OpenAI-compatible tool</span>
          <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={1.5} />
        </button>
      )}

      <div className={styles.chatContainer}>
        <div
          className={styles.chatMain}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {isDragOver && (
            <div className={styles.chatDropOverlay}>
              <div className={styles.chatDropOverlayInner}>
                <span>Drop image here</span>
              </div>
            </div>
          )}
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
            {snap.chatStreamingMessage ? (
              <ChatBubble
                key={`streaming:${snap.chatActiveConversation || 'new'}`}
                message={snap.chatStreamingMessage as ChatMessage}
                streaming
              />
            ) : null}
            {snap.chatSending && snap.chatSendingConversationId === snap.chatActiveConversation && (
              <WalkingAnt elapsedMs={snap.chatThinkingElapsedMs} />
            )}
          </div>

          <SessionApprovalCard
            visible={snap.chatPaymentApprovalVisible}
            peerName={snap.chatPaymentApprovalPeerName}
            amount={snap.chatPaymentApprovalAmount}
            peerInfo={snap.chatPaymentApprovalPeerInfo}
            loading={snap.chatPaymentApprovalLoading}
            error={snap.chatPaymentApprovalError}
            onApprove={() => actions.approveSessionPayment?.()}
            onCancel={() => actions.cancelSessionPayment?.()}
          />
          <LowBalanceWarning
            visible={snap.chatLowBalanceWarning}
            availableUsdc={snap.creditsAvailableUsdc}
            onAddCredits={() => actions.openPaymentsPortal?.()}
          />

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
                onPaste={handlePaste}
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
