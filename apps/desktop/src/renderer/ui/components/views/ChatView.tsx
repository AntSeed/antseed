import { useRef, useEffect, useState, useCallback, useMemo, useId } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  ArrowUp02Icon,
  ArrowRight01Icon,
  RepeatIcon,
  BrowserIcon,
  Folder01Icon,
  GitBranchIcon
} from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import { ChatBubble } from '../chat/ChatBubble';
import { isToolResultOnlyMessage } from '../chat/chat-utils.js';
import { WalkingAnt } from '../chat/WalkingAnt';
import { SessionApprovalCard } from '../chat/SessionApprovalCard';
import { LowBalanceWarning } from '../chat/LowBalanceWarning';
import { BrowserPreview } from '../BrowserPreview';
import type { ChatMessage } from '../chat/chat-shared';
import { buildDisplayMessages } from '../chat/chat-shared';
import type { ChatWorkspaceGitStatus } from '../../../types/bridge';
import { AntStationStackedLogo } from '../AntStationLogo';

import styles from './ChatView.module.scss';

const MAX_INPUT_HEIGHT = 220;
const PREVIEW_MIN_WIDTH = 280;
const CHAT_MIN_WIDTH = 320;
const DEFAULT_PREVIEW_FRACTION = 0.5;

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

function getPathTail(value: string | null | undefined): string {
  const trimmed = String(value || '').trim().replace(/[\\/]+$/, '');
  if (!trimmed) {
    return 'Workspace';
  }
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function getGitChangeCount(status: ChatWorkspaceGitStatus): number {
  return status.stagedFiles + status.modifiedFiles + status.untrackedFiles;
}

function getGitStatusSummary(status: ChatWorkspaceGitStatus): string {
  if (!status.available) {
    return status.error ? 'Git unavailable' : 'No repo';
  }

  const parts: string[] = [];
  if (status.ahead > 0) parts.push(`+${status.ahead}`);
  if (status.behind > 0) parts.push(`-${status.behind}`);

  const changes = getGitChangeCount(status);
  parts.push(changes > 0 ? `${changes} dirty` : 'clean');
  return parts.join(' ');
}

function getGitStatusTitle(status: ChatWorkspaceGitStatus): string {
  if (!status.available) {
    return status.error || 'Git status for the selected workspace. This workspace is shared across chats.';
  }

  const details = [
    'Git status for the selected workspace. This workspace is shared across chats.',
    status.rootPath ? `Repo: ${status.rootPath}` : null,
    `Staged: ${status.stagedFiles}`,
    `Modified: ${status.modifiedFiles}`,
    `Untracked: ${status.untrackedFiles}`,
    `Ahead: ${status.ahead}`,
    `Behind: ${status.behind}`,
  ].filter(Boolean);

  return details.join('\n');
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
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFraction, setPreviewFraction] = useState(DEFAULT_PREVIEW_FRACTION);
  const [previewTargetUrl, setPreviewTargetUrl] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const fileInputId = useId();
  const prevInputDisabled = useRef<boolean>(snap.chatInputDisabled);
  const isUserScrolledUp = useRef(false);
  const isDragging = useRef(false);
  const visibleMessages = useMemo(() => {
    const msgs = Array.isArray(snap.chatMessages) ? (snap.chatMessages as ChatMessage[]) : [];
    return buildDisplayMessages(msgs).filter((msg) => !isToolResultOnlyMessage(msg));
  }, [snap.chatMessages]);

  const previewUrl = snap.browserPreviewUrl;
  const previewRequestId = snap.browserPreviewRequestId;
  useEffect(() => {
    if (previewUrl) {
      setPreviewTargetUrl(previewUrl);
      setPreviewOpen(true);
    }
  }, [previewUrl, previewRequestId]);

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

  // Re-focus the input when it transitions from disabled → enabled
  useEffect(() => {
    const wasDisabled = prevInputDisabled.current;
    const isDisabled = snap.chatInputDisabled;
    prevInputDisabled.current = isDisabled;
    if (wasDisabled && !isDisabled && inputRef.current) {
      inputRef.current.focus();
    }
  }, [snap.chatInputDisabled]);

  // --- Divider drag (pointer capture — no orphaned listeners) ---
  const handleDividerPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    isDragging.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  }, []);

  const handleDividerPointerMove = useCallback((e: React.PointerEvent) => {
    if (!isDragging.current) return;
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const totalWidth = rect.width;
    const chatWidth = e.clientX - rect.left;
    const clamped = Math.max(CHAT_MIN_WIDTH, Math.min(totalWidth - PREVIEW_MIN_WIDTH, chatWidth));
    setPreviewFraction(1 - clamped / totalWidth);
  }, []);

  const handleDividerPointerUp = useCallback(() => {
    isDragging.current = false;
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
  }, []);

  const handleOpenPreview = useCallback((url: string) => {
    setPreviewTargetUrl(url);
    setPreviewOpen(true);
  }, []);

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

  const handleFileDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOver(true);
  }, []);

  const handleFileDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!e.currentTarget.contains(e.relatedTarget as Node)) {
      setIsDragOver(false);
    }
  }, []);

  const handleFileDrop = useCallback((e: React.DragEvent<HTMLDivElement>) => {
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

  const handleClosePreview = useCallback(() => {
    setPreviewOpen(false);
  }, []);

  const handleElementSelected = useCallback((info: { selector: string; tagName: string; text: string; attributes: Record<string, string> }) => {
    const textSnippet = info.text.length > 80 ? info.text.slice(0, 80) + '...' : info.text;
    const elementRef = `[Element: <${info.tagName}> "${textSnippet}" (${info.selector})]`;
    setInputValue((prev) => prev ? `${prev}\n${elementRef}\n` : `${elementRef}\n`);
    if (inputRef.current) inputRef.current.focus();

    // Also send via bridge for providers that handle element selection
    const bridge = (window as unknown as { antseedDesktop?: { sendBrowserPreviewElementSelected?: (data: unknown) => void } }).antseedDesktop;
    bridge?.sendBrowserPreviewElementSelected?.(info);
  }, []);

  const showWelcome =
    snap.chatConversationsLoaded &&
    !snap.chatActiveConversation &&
    visibleMessages.length === 0 &&
    !snap.chatStreamingMessage;

  const workspacePath = snap.chatWorkspacePath || snap.chatWorkspaceDefaultPath;
  const workspaceLabel = workspacePath
    ? workspacePath.split('/').pop() || workspacePath
    : 'No workspace';
  const gitStatus = snap.chatWorkspaceGitStatus;
  const gitStatusSummary = getGitStatusSummary(gitStatus);
  const gitStatusBranch = gitStatus.available
    ? (gitStatus.branch || (gitStatus.isDetached ? 'detached' : 'no-branch'))
    : 'No git repo';
  const gitStatusRepoLabel = gitStatus.rootPath
    ? getPathTail(gitStatus.rootPath)
    : getPathTail(workspacePath);
  const gitStatusDetailLabel = gitStatus.available
    ? `${gitStatusBranch} · ${gitStatusSummary}`
    : gitStatusSummary;
  const gitStatusToneClass = !gitStatus.available
    ? styles.gitStatusPillMissing
    : getGitChangeCount(gitStatus) > 0 || gitStatus.behind > 0
      ? styles.gitStatusPillDirty
      : styles.gitStatusPillClean;
  const gitStatusTitle = getGitStatusTitle(gitStatus);

  // Compute widths for split view
  const chatStyle = previewOpen
    ? { flex: `0 0 ${(1 - previewFraction) * 100}%`, minWidth: CHAT_MIN_WIDTH }
    : undefined;
  const previewStyle = previewOpen
    ? { flex: `0 0 ${previewFraction * 100}%`, minWidth: PREVIEW_MIN_WIDTH }
    : undefined;

  return (
    <section className={`view view-chat${active ? ' active' : ''}`} role="tabpanel">
      <div className={styles.pageHeader}>
        <div className={styles.pageHeaderLeft}>
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
        {snap.chatActiveConversation && (
          <div className={styles.sessionMeta}>
            {/* {snap.chatRoutedPeerId && (
              <span className={styles.sessionMetaItem} title={snap.chatRoutedPeerId}>
                {snap.chatRoutedPeerId.slice(0, 10)}...
              </span>
            )} */}
            {snap.chatSessionReservedUsdc && (
              <span className={styles.sessionMetaItem}>
                reserve ${snap.chatSessionReservedUsdc}
              </span>
            )}
            {snap.chatSessionAccumulatedCostUsd && (
              <span className={styles.sessionMetaItem}>
                used ${snap.chatSessionAccumulatedCostUsd}
              </span>
            )}
            {snap.chatSessionTotalTokens && (
              <span className={styles.sessionMetaItem}>
                {snap.chatSessionTotalTokens} tok
              </span>
            )}
            {snap.chatLifetimeSpentUsdc && (
              <span className={styles.sessionMetaItem} title="Total spent across all sessions with this peer">
                total ${snap.chatLifetimeSpentUsdc}
              </span>
            )}
            {snap.chatLifetimeTotalTokens && (
              <span className={styles.sessionMetaItem} title="Total tokens across all sessions">
                total {snap.chatLifetimeTotalTokens} tok
              </span>
            )}
            {snap.chatSessionStarted && (
              <span className={styles.sessionMetaItem}>{snap.chatSessionStarted}</span>
            )}
          </div>
        )}
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

      <div className={styles.chatContainer} ref={containerRef}>
        <div
          className={styles.chatMain}
          style={chatStyle}
          onDragOver={handleFileDragOver}
          onDragLeave={handleFileDragLeave}
          onDrop={handleFileDrop}
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
                <ChatBubble key={getMessageKey(msg, i)} message={msg} onOpenPreview={handleOpenPreview} />
              ))
            )}
            {snap.chatStreamingMessage ? (
              <ChatBubble
                key={`streaming:${snap.chatActiveConversation || 'new'}`}
                message={snap.chatStreamingMessage as ChatMessage}
                streaming
                onOpenPreview={handleOpenPreview}
              />
            ) : null}
            {snap.chatSending && snap.chatSendingConversationId === snap.chatActiveConversation && (
              <WalkingAnt elapsedMs={snap.chatThinkingElapsedMs} />
            )}
            <SessionApprovalCard
              visible={snap.chatPaymentApprovalVisible}
              peerName={snap.chatPaymentApprovalPeerName}
              amount={snap.chatPaymentApprovalAmount}
              peerInfo={snap.chatPaymentApprovalPeerInfo}
              error={snap.chatPaymentApprovalError}
              onAddCredits={() => actions.openPaymentsPortal?.()}
              onCancel={() => actions.rejectPaymentSession()}
            />
          </div>


          <div className={styles.chatInputArea}>
            {snap.chatError && <div className={styles.chatError}>{snap.chatError}</div>}
            <LowBalanceWarning
              visible={snap.chatLowBalanceWarning}
              availableUsdc={snap.creditsAvailableUsdc}
              onAddCredits={() => actions.openPaymentsPortal?.()}
            />

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
                placeholder="Message Community Peers..."
                rows={1}
                disabled={snap.chatInputDisabled}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
              />
              <div className={styles.chatInputBottom}>
                <button
                  className={styles.chatAttachBtn}
                  title="Attach image"
                  disabled={snap.chatInputDisabled}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <HugeiconsIcon icon={Add01Icon} size={18} strokeWidth={2} />
                </button>
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
            <div className={styles.chatInputMeta}>
              <button
                type="button"
                className={`${styles.gitStatusPill} ${gitStatusToneClass}`}
                onClick={() => void actions.refreshWorkspaceGitStatus()}
                title={gitStatusTitle}
              >
                <HugeiconsIcon icon={GitBranchIcon} size={14} strokeWidth={1.5} />
                {/* <span className={styles.gitStatusBranch}>{gitStatusRepoLabel}</span> */}
                <span className={styles.gitStatusSummary}>{gitStatusDetailLabel}</span>
              </button>
              <button
                className={styles.workspaceButton}
                onClick={() => void actions.chooseWorkspace()}
                title={workspacePath || 'Choose workspace'}
              >
                <HugeiconsIcon icon={Folder01Icon} size={14} strokeWidth={1.5} />
                <span className={styles.workspaceLabel}>{workspaceLabel}</span>
              </button>
            </div>
          </div>
        </div>
        {previewOpen && (
          <>
            <div
              className={styles.divider}
              onPointerDown={handleDividerPointerDown}
              onPointerMove={handleDividerPointerMove}
              onPointerUp={handleDividerPointerUp}
            />
            <div style={previewStyle}>
              <BrowserPreview
                url={previewTargetUrl}
                onClose={handleClosePreview}
                onNavigate={setPreviewTargetUrl}
                onElementSelected={handleElementSelected}
              />
            </div>
          </>
        )}
      </div>
    </section>
  );
}
