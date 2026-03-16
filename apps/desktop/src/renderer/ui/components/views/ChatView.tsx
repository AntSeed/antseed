import { useRef, useEffect, useState, useCallback, useMemo, useId } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon } from '@hugeicons/core-free-icons';
import { ArrowUp02Icon } from '@hugeicons/core-free-icons';
import { ComputerTerminal01Icon } from '@hugeicons/core-free-icons';
import { ArrowRight01Icon } from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import { ChatBubble } from '../chat/ChatBubble';
import { isToolResultOnlyMessage } from '../chat/chat-utils.js';
import { HtmlPreviewContext } from '../chat/HtmlPreviewContext';
import { WalkingAnt } from '../chat/WalkingAnt';
import { ServiceDropdown } from '../chat/ServiceDropdown';
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
  const [attachedHtml, setAttachedHtml] = useState<{ name: string; content: string } | null>(null);
  const [previewHtml, setPreviewHtml] = useState<string | null>(null);
  const [previewWidthPct, setPreviewWidthPct] = useState(50);
  const [isDragOver, setIsDragOver] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileInputId = useId();
  const prevInputDisabled = useRef<boolean>(snap.chatInputDisabled);
  const isUserScrolledUp = useRef(false);
  const prevMessageCount = useRef(0);

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
    if (!text && !attachedImage && !attachedHtml) return;
    const finalText = attachedHtml
      ? `${text ? text + '\n\n' : ''}Here is the HTML file "${attachedHtml.name}":\n\n\`\`\`html\n${attachedHtml.content}\n\`\`\``
      : text;
    setInputValue('');
    setAttachedImage(null);
    setAttachedHtml(null);
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.overflowY = 'hidden';
      inputRef.current.focus();
    }
    actions.sendMessage(finalText, attachedImage?.base64, attachedImage?.mimeType);
  }, [inputValue, attachedImage, attachedHtml, actions]);

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

  const handleFileAttach = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.name.endsWith('.html') || file.name.endsWith('.htm') || file.type === 'text/html') {
      const reader = new FileReader();
      reader.onload = () => {
        setAttachedHtml({ name: file.name, content: reader.result as string });
      };
      reader.readAsText(file);
    } else {
      attachImageFile(file);
    }
    // Reset so the same file can be re-attached
    e.target.value = '';
  }, [attachImageFile]);

  const handleRemoveImage = useCallback(() => {
    setAttachedImage(null);
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const handleRemoveHtml = useCallback(() => {
    setAttachedHtml(null);
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

  const handlePreviewHtml = useCallback((html: string) => {
    setPreviewHtml(html);
  }, []);

  const handleOpenPreviewInBrowser = useCallback(() => {
    if (!previewHtml) return;
    const bridge = (window as unknown as { antseedDesktop?: { openHtmlInBrowser?: (html: string) => Promise<{ ok: boolean }> } }).antseedDesktop;
    if (bridge?.openHtmlInBrowser) {
      void bridge.openHtmlInBrowser(previewHtml);
    }
  }, [previewHtml]);

  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const container = containerRef.current;
    if (!container) return;

    const startX = e.clientX;
    const containerRect = container.getBoundingClientRect();
    const containerWidth = containerRect.width;
    const startChatPct = 100 - previewWidthPct;

    const onMouseMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX;
      const newChatPct = Math.min(80, Math.max(20, startChatPct + (dx / containerWidth) * 100));
      setPreviewWidthPct(100 - newChatPct);
    };

    const onMouseUp = (): void => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Un-block pointer events on the iframe
      const iframe = container.querySelector('iframe');
      if (iframe) iframe.style.pointerEvents = '';
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    // Block pointer events on the iframe so mousemove events aren't swallowed
    const iframe = container.querySelector('iframe');
    if (iframe) iframe.style.pointerEvents = 'none';

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
  }, [previewWidthPct]);

  const previewContextValue = useMemo(() => ({ onPreviewHtml: handlePreviewHtml }), [handlePreviewHtml]);

  const showWelcome =
    snap.chatConversationsLoaded &&
    !snap.chatActiveConversation &&
    visibleMessages.length === 0 &&
    !snap.chatStreamingMessage;

  return (
    <section className={`view view-chat${active ? ' active' : ''}`} role="tabpanel">
      <div className={styles.pageHeader}>
        <div className={styles.pageHeaderLeft}>
          <ServiceDropdown
            options={snap.chatServiceOptions}
            value={snap.chatSelectedServiceValue}
            disabled={snap.chatServiceSelectDisabled}
            onChange={actions.handleServiceChange}
            onFocus={actions.handleServiceFocus}
            onBlur={actions.handleServiceBlur}
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

      {showWelcome && (
        <button
          className={styles.chatExternalHint}
          onClick={() => onSelectView?.('external-clients')}
        >
          <span>Works with Claude Code, Codex, OpenCode, and any OpenAI-compatible tool</span>
          <HugeiconsIcon icon={ArrowRight01Icon} size={12} strokeWidth={1.5} />
        </button>
      )}

      <HtmlPreviewContext.Provider value={previewContextValue}>
        <div ref={containerRef} className={`${styles.chatContainer}${previewHtml ? ` ${styles.chatContainerSplit}` : ''}`}>
          <div
            className={styles.chatMain}
            style={previewHtml ? { width: `${100 - previewWidthPct}%` } : undefined}
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

            <div className={styles.chatInputArea}>
              {attachedImage && (
                <div className={styles.chatImageAttachPreview}>
                  <img src={attachedImage.previewUrl} alt="Attached" className={styles.chatImageAttachThumb} />
                  <button className={styles.chatImageRemoveBtn} onClick={handleRemoveImage} title="Remove image">✕</button>
                </div>
              )}
              {attachedHtml && (
                <div className={styles.chatHtmlAttachPreview}>
                  <span className={styles.chatHtmlAttachChip}>{attachedHtml.name}</span>
                  <button className={styles.chatImageRemoveBtn} onClick={handleRemoveHtml} title="Remove HTML">✕</button>
                </div>
              )}
              <div className={styles.chatInputRow}>
                <input
                  ref={fileInputRef}
                  id={fileInputId}
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp,.html,.htm"
                  style={{ display: 'none' }}
                  onChange={handleFileAttach}
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
                      title="Attach file"
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
                    <button className={styles.chatSendBtn} disabled={snap.chatSendDisabled && !attachedImage && !attachedHtml} onClick={handleSend}>
                      <HugeiconsIcon icon={ArrowUp02Icon} size={18} strokeWidth={2.5} />
                    </button>
                  )}
                </div>
              </div>
            </div>

            {snap.chatError && <div className={styles.chatError}>{snap.chatError}</div>}
          </div>

          {previewHtml && (
            <>
            <div className={styles.chatResizeHandle} onMouseDown={handleResizeStart} />
            <div className={styles.chatPreviewPanel} style={{ width: `${previewWidthPct}%` }}>
              <div className={styles.chatPreviewHeader}>
                <span className={styles.chatPreviewTitle}>HTML Preview</span>
                <div className={styles.chatPreviewActions}>
                  <button type="button" className={styles.chatPreviewActionBtn} onClick={handleOpenPreviewInBrowser}>
                    Open in Browser
                  </button>
                  <button type="button" className={styles.chatPreviewCloseBtn} onClick={() => setPreviewHtml(null)} aria-label="Close preview">
                    ✕
                  </button>
                </div>
              </div>
              <iframe
                className={styles.chatPreviewIframe}
                sandbox="allow-scripts"
                srcDoc={previewHtml}
                title="HTML Preview"
              />
            </div>
            </>
          )}
        </div>
      </HtmlPreviewContext.Provider>
    </section>
  );
}
