import { useRef, useEffect, useState, useCallback, useMemo, useId } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  Add01Icon,
  ArrowUp02Icon,
  ArrowRight01Icon,
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
import { ServiceDropdown } from '../chat/ServiceDropdown';
import { SwitchServiceDialog } from '../chat/SwitchServiceDialog';
import { ServiceSwitchTooltip } from '../chat/ServiceSwitchTooltip';
import { AttachmentViewer, type ViewerAttachment } from '../chat/AttachmentViewer';
import { BrowserPreview } from '../BrowserPreview';
import type { ChatMessage } from '../chat/chat-shared';
import { buildDisplayMessages } from '../chat/chat-shared';
import type { ChatWorkspaceGitStatus, RawChatAttachment } from '../../../types/bridge';
import { AntStationStackedLogo } from '../AntStationLogo';

const SWITCH_DIALOG_DISMISSED_KEY = 'antseed:switchServiceConfirmDismissed';
const SWITCH_TOOLTIP_DISMISSED_KEY = 'antseed:serviceSwitchTooltipDismissed';

import styles from './ChatView.module.scss';
import bubbleStyles from '../chat/ChatBubble.module.scss';

const MAX_INPUT_HEIGHT = 220;
const PREVIEW_MIN_WIDTH = 280;
const CHAT_MIN_WIDTH = 320;
const DEFAULT_PREVIEW_FRACTION = 0.5;
const MAX_ATTACHMENTS = 5;
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_TOTAL_ATTACHMENT_BYTES = 50 * 1024 * 1024;

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
  const [attachedFiles, setAttachedFiles] = useState<RawChatAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [attachmentWarning, setAttachmentWarning] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewFraction, setPreviewFraction] = useState(DEFAULT_PREVIEW_FRACTION);
  const [previewTargetUrl, setPreviewTargetUrl] = useState<string | null>(null);
  const [switchDialogOpen, setSwitchDialogOpen] = useState(false);
  const [pendingSwitchValue, setPendingSwitchValue] = useState<string | null>(null);
  // While the LLM is streaming we still let the user type/paste.
  // Drafts the user confirms (Enter / Send) are parked in this queue as
  // cards above the composer and ship one-per-turn as soon as the current
  // stream ends (naturally or via Stop). See issue #59.
  type PendingDraft = {
    id: string;
    text: string;
    attachments: RawChatAttachment[];
  };
  const [pendingQueue, setPendingQueue] = useState<PendingDraft[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<ViewerAttachment | null>(null);
  const [tooltipDismissed, setTooltipDismissed] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem(SWITCH_TOOLTIP_DISMISSED_KEY) === 'true';
  });

  const handleDismissTooltip = useCallback(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(SWITCH_TOOLTIP_DISMISSED_KEY, 'true');
    }
    setTooltipDismissed(true);
  }, []);
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

  // Re-focus the input when it transitions from disabled → enabled, and if a
  // draft is queued, ship the head of the queue as its own turn. Each draft
  // stays a distinct message so the model can reason/respond between them
  // (matches CLI-style turn-by-turn flow).
  // Dispatch is inlined (rather than delegating to handleSend) so the effect
  // isn't coupled to handleSend's stale closure over chatInputDisabled.
  useEffect(() => {
    const wasDisabled = prevInputDisabled.current;
    const isDisabled = snap.chatInputDisabled;
    prevInputDisabled.current = isDisabled;
    if (!wasDisabled || isDisabled) return;
    if (inputRef.current) inputRef.current.focus();
    if (pendingQueue.length === 0) return;
    const [head, ...rest] = pendingQueue;
    setPendingQueue(rest);
    actions.sendMessage(head.text, head.attachments);
  }, [snap.chatInputDisabled, pendingQueue, actions]);

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

  // Services filtered to the currently-routed peer — lets the user switch
  // between services offered by the same peer without going back to Discover.
  const currentPeerId = snap.chatRoutedPeerId || snap.chatSelectedPeerId || '';
  const peerServiceOptions = useMemo(
    () =>
      currentPeerId
        ? snap.chatServiceOptions.filter((o) => o.peerId === currentPeerId)
        : [],
    [snap.chatServiceOptions, currentPeerId],
  );
  const currentServiceOption = useMemo(
    () => snap.chatServiceOptions.find((o) => o.value === snap.chatSelectedServiceValue),
    [snap.chatServiceOptions, snap.chatSelectedServiceValue],
  );
  const supportsMultimodal = currentServiceOption?.categories?.includes('multimodal') ?? false;
  const hasAttachedImages = useMemo(
    () => attachedFiles.some((file) => isImageAttachmentLike(file.name, file.mimeType)),
    [attachedFiles],
  );
  const peerDisplayName =
    snap.chatRoutedPeer || currentServiceOption?.peerDisplayName || currentServiceOption?.peerLabel || '';

  const applyServiceChange = useCallback(
    (value: string) => {
      const option = snap.chatServiceOptions.find((o) => o.value === value);
      actions.handleServiceChange(value, option?.peerId);
    },
    [actions, snap.chatServiceOptions],
  );

  const handleServiceSwitch = useCallback(
    (nextValue: string) => {
      if (!nextValue || nextValue === snap.chatSelectedServiceValue) return;
      const hasMessages =
        Boolean(snap.chatActiveConversation) && visibleMessages.length > 0;
      const dismissed =
        typeof window !== 'undefined' &&
        window.localStorage.getItem(SWITCH_DIALOG_DISMISSED_KEY) === 'true';
      if (!hasMessages || dismissed) {
        applyServiceChange(nextValue);
        return;
      }
      setPendingSwitchValue(nextValue);
      setSwitchDialogOpen(true);
    },
    [snap.chatSelectedServiceValue, snap.chatActiveConversation, visibleMessages.length, applyServiceChange],
  );

  const persistDismissed = useCallback((dontShowAgain: boolean) => {
    if (dontShowAgain && typeof window !== 'undefined') {
      window.localStorage.setItem(SWITCH_DIALOG_DISMISSED_KEY, 'true');
    }
  }, []);

  const handleSwitchContinue = useCallback(
    (dontShowAgain: boolean) => {
      persistDismissed(dontShowAgain);
      if (pendingSwitchValue) applyServiceChange(pendingSwitchValue);
      setSwitchDialogOpen(false);
      setPendingSwitchValue(null);
    },
    [pendingSwitchValue, applyServiceChange, persistDismissed],
  );

  const handleSwitchStartNew = useCallback(
    (dontShowAgain: boolean) => {
      persistDismissed(dontShowAgain);
      if (pendingSwitchValue) applyServiceChange(pendingSwitchValue);
      actions.startNewChat();
      setSwitchDialogOpen(false);
      setPendingSwitchValue(null);
    },
    [pendingSwitchValue, applyServiceChange, actions, persistDismissed],
  );

  const handleSwitchCancel = useCallback(() => {
    setSwitchDialogOpen(false);
    setPendingSwitchValue(null);
  }, []);

  const pendingSwitchOption = useMemo(
    () =>
      pendingSwitchValue
        ? snap.chatServiceOptions.find((o) => o.value === pendingSwitchValue)
        : null,
    [pendingSwitchValue, snap.chatServiceOptions],
  );

  const resetComposer = useCallback(() => {
    setInputValue('');
    setAttachedFiles([]);
    setAttachmentError(null);
    setAttachmentWarning(null);
    if (inputRef.current) {
      inputRef.current.style.height = 'auto';
      inputRef.current.style.overflowY = 'hidden';
      inputRef.current.focus();
    }
  }, []);

  const handleSend = useCallback(() => {
    const text = inputValue.trim();
    if (!text && attachedFiles.length === 0) return;
    // If the current turn is still streaming, park the draft as a pending
    // card above the composer and clear the input so the user can keep
    // typing the next one. The disabled→enabled effect flushes the queue
    // head once the stream ends.
    if (snap.chatInputDisabled) {
      const id =
        typeof crypto !== 'undefined' && crypto.randomUUID
          ? crypto.randomUUID()
          : `pending-${String(Date.now())}-${String(Math.random())}`;
      setPendingQueue((prev) => [...prev, { id, text, attachments: attachedFiles }]);
      resetComposer();
      return;
    }
    const filesToSend = attachedFiles;
    resetComposer();
    actions.sendMessage(text, filesToSend);
  }, [inputValue, attachedFiles, actions, snap.chatInputDisabled, resetComposer]);

  const handleRemovePending = useCallback((id: string) => {
    setPendingQueue((prev) => prev.filter((item) => item.id !== id));
  }, []);

  const handleStop = useCallback(() => {
    // Deliberately leave pendingQueue intact: aborting is how the user asks
    // to move on to the queued drafts, so the disabled→enabled effect should
    // begin flushing the queue as soon as the abort lands.
    void actions.abortChat();
  }, [actions]);

  const readRawAttachment = useCallback((file: File): Promise<RawChatAttachment> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error(`Could not read ${file.name || 'attachment'}`));
      reader.onload = () => {
        resolve({
          id: typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
          name: file.name || 'attachment',
          mimeType: file.type || 'application/octet-stream',
          size: file.size,
          base64: String(reader.result || ''),
        });
      };
      reader.readAsDataURL(file);
    });
  }, []);

  const attachFiles = useCallback(async (files: FileList | File[]) => {
    const incoming = Array.from(files);
    if (incoming.length === 0) return;
    const accepted: File[] = [];
    let totalBytes = attachedFiles.reduce((sum, file) => sum + file.size, 0);
    let blockedImageCount = 0;
    let nextError: string | null = null;

    for (const file of incoming) {
      if (!supportsMultimodal && isImageAttachmentLike(file.name, file.type)) {
        blockedImageCount += 1;
        nextError = "Selected model doesn't support images. Switch to a multimodal model to attach image files.";
        continue;
      }
      if (attachedFiles.length + accepted.length >= MAX_ATTACHMENTS) {
        nextError = `Only ${MAX_ATTACHMENTS} attachments are allowed per message.`;
        break;
      }
      if (file.size > MAX_ATTACHMENT_BYTES) {
        nextError = `${file.name || 'Attachment'} exceeds the 25 MiB per-file limit.`;
        continue;
      }
      if (totalBytes + file.size > MAX_TOTAL_ATTACHMENT_BYTES) {
        nextError = 'Attachments exceed the 50 MiB per-message limit.';
        continue;
      }
      accepted.push(file);
      totalBytes += file.size;
    }

    if (blockedImageCount > 0 && accepted.length > 0) {
      nextError = `${nextError ? `${nextError} ` : ''}${blockedImageCount} image attachment${blockedImageCount === 1 ? '' : 's'} ${blockedImageCount === 1 ? 'was' : 'were'} skipped.`;
    }
    if (accepted.length === 0) {
      setAttachmentError(nextError);
      return;
    }

    try {
      const raw = await Promise.all(accepted.map(readRawAttachment));
      setAttachedFiles((prev) => [...prev, ...raw].slice(0, MAX_ATTACHMENTS));
      setAttachmentError(nextError);
    } catch (error) {
      setAttachmentError(error instanceof Error ? error.message : String(error));
    }
  }, [attachedFiles, readRawAttachment, supportsMultimodal]);

  useEffect(() => {
    if (supportsMultimodal || !hasAttachedImages) {
      setAttachmentWarning(null);
      return;
    }
    setAttachmentWarning("Selected model doesn't support images. Attached images will be omitted when you send this message.");
  }, [supportsMultimodal, hasAttachedImages]);

  useEffect(() => {
    if (supportsMultimodal && attachmentError?.includes("doesn't support images")) {
      setAttachmentError(null);
    }
  }, [supportsMultimodal, attachmentError]);

  const handleFileAttach = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (files) void attachFiles(files);
    e.target.value = '';
  }, [attachFiles]);

  const handleRemoveAttachment = useCallback((id: string) => {
    setAttachedFiles((prev) => prev.filter((file) => file.id !== id));
    setAttachmentError(null);
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const file = item.getAsFile();
      if (file) files.push(file);
    }
    if (files.length === 0) return;
    e.preventDefault();
    void attachFiles(files);
  }, [attachFiles]);

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
    if (e.dataTransfer.files.length > 0) void attachFiles(e.dataTransfer.files);
  }, [attachFiles]);


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
          {peerDisplayName && (
            <>
              <span className={styles.peerName}>{peerDisplayName}</span>
            </>
          )}
          {peerServiceOptions.length > 0 ? (
            <div className={styles.serviceSwitcherAnchor}>
              <ServiceDropdown
                options={peerServiceOptions}
                value={snap.chatSelectedServiceValue}
                disabled={snap.chatInputDisabled || snap.chatSending}
                onChange={handleServiceSwitch}
              />
              {!tooltipDismissed && peerServiceOptions.length >= 2 && (
                <ServiceSwitchTooltip
                  modelCount={peerServiceOptions.length}
                  onDismiss={handleDismissTooltip}
                />
              )}
            </div>
          ) : (
            <span className={styles.serviceLabel}>
              {currentServiceOption?.label || 'No peer selected'}
            </span>
          )}
        </div>
        {snap.chatActiveConversation && (
          <ChatSessionStats
            sessionCost={snap.chatSessionAccumulatedCostUsd}
            sessionTokens={snap.chatSessionTotalTokens}
            lifetimeCost={snap.chatLifetimeSpentUsdc}
            lifetimeTokens={snap.chatLifetimeTotalTokens}
            reserved={snap.chatSessionReservedUsdc}
            started={snap.chatSessionStarted}
          />
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
                <span>
                  {supportsMultimodal ? 'Drop files here' : 'Drop files here (images are unavailable for this model)'}
                </span>
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
                <ChatBubble
                  key={getMessageKey(msg, i)}
                  message={msg}
                  onOpenPreview={handleOpenPreview}
                  conversationId={snap.chatActiveConversation || undefined}
                />
              ))
            )}
            {snap.chatStreamingMessage ? (
              <ChatBubble
                key={`streaming:${snap.chatActiveConversation || 'new'}`}
                message={snap.chatStreamingMessage as ChatMessage}
                streaming
                onOpenPreview={handleOpenPreview}
                conversationId={snap.chatActiveConversation || undefined}
              />
            ) : null}
            {snap.chatSending && snap.chatSendingConversationId === snap.chatActiveConversation && (
              <WalkingAnt
                elapsedMs={snap.chatThinkingElapsedMs}
                phaseLabel={snap.chatThinkingPhase}
              />
            )}
            {pendingQueue.map((item) => (
              <div
                key={`pending-${item.id}`}
                className={`${bubbleStyles.chatBubble} ${bubbleStyles.own}`}
                style={{ opacity: 0.7 }}
                title="Will send when the current response finishes"
              >
                <span
                  className={bubbleStyles.chatBubbleStats}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}
                >
                  pending
                  <button
                    type="button"
                    aria-label="Remove queued message"
                    title="Remove queued message"
                    onClick={() => handleRemovePending(item.id)}
                    style={{
                      background: 'transparent',
                      border: 'none',
                      color: 'inherit',
                      cursor: 'pointer',
                      padding: 0,
                      fontSize: 14,
                      lineHeight: 1,
                      opacity: 0.6,
                    }}
                  >
                    ×
                  </button>
                </span>
                <div>
                  {item.text || <em style={{ opacity: 0.7 }}>(attachments only)</em>}
                  {item.attachments.length > 0 && (
                    <span style={{ marginLeft: 6, opacity: 0.7 }}>
                      · {item.attachments.length} file{item.attachments.length === 1 ? '' : 's'}
                    </span>
                  )}
                </div>
              </div>
            ))}
            <SessionApprovalCard
              visible={snap.chatPaymentApprovalVisible}
              peerName={snap.chatPaymentApprovalPeerName}
              amount={snap.chatPaymentApprovalAmount}
              peerInfo={snap.chatPaymentApprovalPeerInfo}
              error={snap.chatPaymentApprovalError}
              onAddCredits={() => actions.openPaymentsPortal?.()}
              onRetry={() => actions.retryAfterPayment()}
              onCancel={() => actions.rejectPaymentSession()}
            />
          </div>


          <div className={styles.chatInputArea}>
            {snap.chatError && <div className={styles.chatError}>{snap.chatError}</div>}
            {attachmentError && <div className={styles.chatError}>{attachmentError}</div>}
            {attachmentWarning && <div className={styles.chatWarning}>{attachmentWarning}</div>}
            <LowBalanceWarning
              visible={snap.chatLowBalanceWarning}
              availableUsdc={snap.creditsAvailableUsdc}
              onAddCredits={() => actions.openPaymentsPortal?.()}
            />

            {attachedFiles.length > 0 && (
              <div className={styles.chatAttachmentTray}>
                {attachedFiles.map((file) => {
                  const isImage = file.mimeType.startsWith('image/');
                  const openPreview = () => {
                    setPreviewAttachment({
                      name: file.name,
                      mimeType: file.mimeType,
                      size: file.size,
                      dataUrl: file.base64,
                    });
                  };
                  return (
                    <div className={styles.chatAttachmentChip} key={file.id} title={`${file.name} (${formatAttachmentSize(file.size)})${isImage ? ' — click to preview' : ''}`}>
                      {isImage ? (
                        <img
                          src={file.base64}
                          alt=""
                          className={styles.chatAttachmentThumb}
                          onClick={openPreview}
                          style={{ cursor: 'zoom-in' }}
                        />
                      ) : (
                        <span className={styles.chatAttachmentFileIcon}>
                          {getAttachmentExtension(file.name)}
                        </span>
                      )}
                      <span
                        className={styles.chatAttachmentName}
                        onClick={isImage ? openPreview : undefined}
                        style={isImage ? { cursor: 'pointer' } : undefined}
                      >
                        {file.name}
                      </span>
                      <span className={styles.chatAttachmentSize}>{formatAttachmentSize(file.size)}</span>
                      <button
                        className={styles.chatAttachmentRemoveBtn}
                        onClick={() => handleRemoveAttachment(file.id)}
                        title="Remove attachment"
                        type="button"
                      >
                        x
                      </button>
                    </div>
                  );
                })}
              </div>
            )}

            <div className={styles.chatInputRow}>
              <input
                ref={fileInputRef}
                id={fileInputId}
                type="file"
                accept="image/jpeg,image/png,image/gif,image/webp,.pdf,.docx,.pptx,.xlsx,.odt,.odp,.ods,.rtf,.zip,.txt,.md,.json,.csv,.js,.ts,.tsx,.jsx,.html,.css,.py,.rs,.go,.java,.rb,.sh,.yaml,.yml,.xml,.svg"
                multiple
                style={{ display: 'none' }}
                onChange={handleFileAttach}
              />
              <textarea
                ref={inputRef}
                className={styles.chatTextInput}
                placeholder={
                  snap.chatInputDisabled
                    ? 'Type your next message — it will send when the current response finishes…'
                    : 'Type a message... (Shift+Enter for newline)'
                }
                rows={1}
                value={inputValue}
                onChange={(e) => setInputValue(e.target.value)}
                onInput={handleInput}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
              />
              <div className={styles.chatInputBottom}>
                <button
                  className={`${styles.chatAttachBtn} ${supportsMultimodal ? '' : styles.chatAttachBtnLimited}`}
                  title={supportsMultimodal ? 'Attach files' : "Attach files (images unavailable for selected model)"}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <HugeiconsIcon icon={Add01Icon} size={18} strokeWidth={2} />
                </button>
                {snap.chatAbortVisible ? (
                  <button className={styles.chatAbortBtn} onClick={handleStop}>
                    Stop
                  </button>
                ) : (
                  <button className={styles.chatSendBtn} disabled={snap.chatSendDisabled && attachedFiles.length === 0} onClick={handleSend}>
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
      <SwitchServiceDialog
        visible={switchDialogOpen}
        currentLabel={currentServiceOption?.label || 'current service'}
        nextLabel={pendingSwitchOption?.label || 'new service'}
        onContinue={handleSwitchContinue}
        onStartNew={handleSwitchStartNew}
        onCancel={handleSwitchCancel}
      />
      {previewAttachment && (
        <AttachmentViewer
          attachment={previewAttachment}
          onClose={() => setPreviewAttachment(null)}
        />
      )}
    </section>
  );
}

function compactTokensFromFormatted(formatted: string): string {
  const n = Number(formatted.replace(/[^0-9.]/g, ''));
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(0)}k`;
  return String(Math.floor(n));
}

function compactUsd(raw: string): string {
  const n = Number(raw);
  if (!Number.isFinite(n)) return `$${raw}`;
  if (n === 0) return '$0.00';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}

function formatAttachmentSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function isImageAttachmentLike(name: string, mimeType: string): boolean {
  if (mimeType.startsWith('image/')) return true;
  return /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|ico|tiff?)$/i.test(name);
}

function getAttachmentExtension(name: string): string {
  const ext = name.split('.').pop()?.trim();
  return ext && ext !== name ? ext.slice(0, 4).toUpperCase() : 'FILE';
}

function ChatSessionStats({
  sessionCost,
  sessionTokens,
  lifetimeCost,
  lifetimeTokens,
  reserved,
  started,
}: {
  sessionCost: string;
  sessionTokens: string;
  lifetimeCost: string;
  lifetimeTokens: string;
  reserved: string;
  started: string;
}) {
  const hasSession = Boolean(sessionCost || sessionTokens);
  const sessionCostLabel = sessionCost ? compactUsd(sessionCost) : '$0.00';
  const sessionTokenLabel = sessionTokens ? compactTokensFromFormatted(sessionTokens) : '0';
  const reservedMaxNum = Number(reserved);
  const sessionCostNum = Number(sessionCost);
  const hasReserveCeiling = Number.isFinite(reservedMaxNum) && reservedMaxNum > 0;
  const reserveRemainingNum = hasReserveCeiling
    ? Math.max(0, reservedMaxNum - (Number.isFinite(sessionCostNum) ? sessionCostNum : 0))
    : 0;
  return (
    <div className={styles.sessionStats} tabIndex={0} aria-label="Usage stats">
      <svg
        className={styles.sessionStatsIcon}
        width="12" height="12" viewBox="0 0 16 16" fill="none"
        aria-hidden="true"
      >
        <path d="M2.5 13.5V10M6.5 13.5V6M10.5 13.5V8M14 13.5V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
      </svg>
      <span className={styles.sessionStatsSummary}>
        {hasSession ? (
          <>
            {sessionCostLabel}
            <span className={styles.sessionStatsDot} />
            {sessionTokenLabel} tok
          </>
        ) : (
          'Usage'
        )}
      </span>
      <div className={styles.sessionStatsPopover} role="tooltip">
        <div className={styles.sessionStatsGroup}>
          <div className={styles.sessionStatsGroupLabel}>Current payment channel</div>
          <div className={styles.sessionStatsRow}>
            <span>Cost</span>
            <span>{sessionCost ? `$${sessionCost}` : '—'}</span>
          </div>
          <div className={styles.sessionStatsRow}>
            <span>Tokens</span>
            <span>{sessionTokens || '—'}</span>
          </div>
        </div>
        <div className={styles.sessionStatsGroup}>
          <div className={styles.sessionStatsGroupLabel}>All-time with peer</div>
          <div className={styles.sessionStatsRow}>
            <span>Cost</span>
            <span>{lifetimeCost ? `$${lifetimeCost}` : '—'}</span>
          </div>
          <div className={styles.sessionStatsRow}>
            <span>Tokens</span>
            <span>{lifetimeTokens || '—'}</span>
          </div>
        </div>
        <div className={styles.sessionStatsFooter}>
          {hasReserveCeiling && (
            <div className={styles.sessionStatsRow}>
              <span>Reserve remaining</span>
              <span>{compactUsd(String(reserveRemainingNum))} / {compactUsd(reserved)}</span>
            </div>
          )}
          {started && (
            <div className={styles.sessionStatsRow}>
              <span>Started</span>
              <span>{started}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
