import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, ArrowUp02Icon, Folder01Icon, GitBranchIcon } from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import type { DesktopBridge, StudioIntent, StudioRunReference } from '../../../types/bridge';
import {
  buildStudioProxyRequest,
  buildStudioRunRequest,
  isStudioServiceCandidate,
  parseStudioProxyTransportResult,
  supportsStudioIntent,
} from '../../../modules/studio-run';
import styles from './StudioView.module.scss';

type StudioAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  base64: string;
  previewUrl: string;
};

type StudioMediaResult = {
  key: string;
  url: string;
  kind: 'image' | 'video';
  createdAt: number;
};

type StudioRunHistoryEntry = {
  id: string;
  status: string;
  intent: StudioIntent;
  serviceLabel: string;
  prompt: string;
  createdAt: number;
  outputs: StudioMediaResult[];
  error?: string;
};

type StudioDraft = {
  intent: StudioIntent;
  prompt: string;
  selectedServiceValue: string;
  showHistory: boolean;
};

const STUDIO_INTENTS: StudioIntent[] = ['image-edit', 'image-generate', 'video-generate'];
const STUDIO_DRAFT_STORAGE_KEY = 'antseed:studio-draft-v1';
const STUDIO_RUN_HISTORY_STORAGE_KEY = 'antseed:studio-runs-v1';

const STUDIO_INTENT_LABELS: Record<StudioIntent, string> = {
  'image-edit': 'Image Edit',
  'image-generate': 'Image Generation',
  'video-generate': 'Video Generation',
};

const STUDIO_INTENT_REFERENCE_REQUIRED: Record<StudioIntent, boolean> = {
  'image-edit': true,
  'image-generate': false,
  'video-generate': false,
};

const MAX_ATTACHMENTS = 8;
const MAX_STUDIO_RUN_HISTORY = 30;
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const DEFAULT_STUDIO_DRAFT: StudioDraft = {
  intent: 'image-edit',
  prompt: '',
  selectedServiceValue: '',
  showHistory: false,
};

function normalizeStudioIntent(value: unknown): StudioIntent {
  return value === 'image-generate' || value === 'video-generate' ? value : 'image-edit';
}

function loadStudioDraft(): StudioDraft {
  try {
    const raw = localStorage.getItem(STUDIO_DRAFT_STORAGE_KEY);
    if (!raw) return DEFAULT_STUDIO_DRAFT;
    const parsed = JSON.parse(raw) as Partial<StudioDraft> | null;
    if (!parsed || typeof parsed !== 'object') return DEFAULT_STUDIO_DRAFT;
    return {
      intent: normalizeStudioIntent(parsed.intent),
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      selectedServiceValue: typeof parsed.selectedServiceValue === 'string' ? parsed.selectedServiceValue : '',
      showHistory: parsed.showHistory === true,
    };
  } catch {
    return DEFAULT_STUDIO_DRAFT;
  }
}

function persistStudioDraft(draft: StudioDraft): void {
  try {
    localStorage.setItem(STUDIO_DRAFT_STORAGE_KEY, JSON.stringify(draft));
  } catch {
    // Ignore persistence failures in restricted environments.
  }
}

function loadStudioRunHistory(): StudioRunHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STUDIO_RUN_HISTORY_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    const runs: StudioRunHistoryEntry[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== 'object') continue;
      const record = entry as Record<string, unknown>;
      const id = typeof record.id === 'string' ? record.id : '';
      const status = typeof record.status === 'string' ? record.status : 'unknown';
      const intent = normalizeStudioIntent(record.intent);
      const serviceLabel = typeof record.serviceLabel === 'string' ? record.serviceLabel : 'Unknown service';
      const prompt = typeof record.prompt === 'string' ? record.prompt : '';
      const createdAt = typeof record.createdAt === 'number' ? record.createdAt : Date.now();
      const outputs = Array.isArray(record.outputs)
        ? record.outputs
          .map((output, index) => {
            if (!output || typeof output !== 'object') return null;
            const outputRecord = output as Record<string, unknown>;
            const url = typeof outputRecord.url === 'string' ? outputRecord.url : null;
            if (!url) return null;
            const kind = outputRecord.kind === 'video' ? 'video' : 'image';
            const outputCreatedAt = typeof outputRecord.createdAt === 'number' ? outputRecord.createdAt : createdAt;
            const key = typeof outputRecord.key === 'string' ? outputRecord.key : `${id}:${String(index)}:${url}`;
            return {
              key,
              url,
              kind,
              createdAt: outputCreatedAt,
            } satisfies StudioMediaResult;
          })
          .filter((output): output is StudioMediaResult => output !== null)
        : [];
      if (!id) continue;
      runs.push({
        id,
        status,
        intent,
        serviceLabel,
        prompt,
        createdAt,
        outputs,
        ...(typeof record.error === 'string' ? { error: record.error } : {}),
      });
    }
    return runs.slice(0, MAX_STUDIO_RUN_HISTORY);
  } catch {
    return [];
  }
}

function persistStudioRunHistory(entries: StudioRunHistoryEntry[]): void {
  try {
    localStorage.setItem(
      STUDIO_RUN_HISTORY_STORAGE_KEY,
      JSON.stringify(entries.slice(0, MAX_STUDIO_RUN_HISTORY)),
    );
  } catch {
    // Ignore localStorage persistence errors.
  }
}

function getPathTail(value: string | null | undefined): string {
  const trimmed = String(value || '').trim().replace(/[\\/]+$/, '');
  if (!trimmed) return 'Workspace';
  const parts = trimmed.split(/[\\/]/);
  return parts[parts.length - 1] || trimmed;
}

function readFileAsAttachment(file: File): Promise<StudioAttachment | null> {
  if (!ALLOWED_IMAGE_MIME_TYPES.has(file.type)) {
    return Promise.resolve(null);
  }
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      const parts = result.split(',');
      if (!parts[1]) {
        resolve(null);
        return;
      }
      resolve({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: file.name,
        size: file.size,
        mimeType: file.type,
        base64: result,
        previewUrl: result,
      });
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

function getPromptPlaceholder(intent: StudioIntent): string {
  if (intent === 'image-edit') {
    return 'Describe how you want the references edited (style, lighting, composition, details)...';
  }
  if (intent === 'video-generate') {
    return 'Describe the shot, motion, camera style, and duration you want...';
  }
  return 'Describe the image you want to generate...';
}

type StudioViewProps = {
  active: boolean;
};

export function StudioView({ active }: StudioViewProps) {
  const snap = useUiSnapshot();
  const actions = useActions();
  const bridge = window.antseedDesktop as DesktopBridge | undefined;
  const initialDraftRef = useRef<StudioDraft>(loadStudioDraft());

  const [intent, setIntent] = useState<StudioIntent>(initialDraftRef.current.intent);
  const [prompt, setPrompt] = useState(initialDraftRef.current.prompt);
  const [attachments, setAttachments] = useState<StudioAttachment[]>([]);
  const [selectedServiceValue, setSelectedServiceValue] = useState(initialDraftRef.current.selectedServiceValue);
  const [selectedResultKey, setSelectedResultKey] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(initialDraftRef.current.showHistory);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [attachmentNotice, setAttachmentNotice] = useState<string | null>(null);
  const [copiedResultUrl, setCopiedResultUrl] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [studioRuns, setStudioRuns] = useState<StudioRunHistoryEntry[]>(() => loadStudioRunHistory());
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    persistStudioRunHistory(studioRuns);
  }, [studioRuns]);

  const studioServiceOptions = useMemo(() => (
    snap.chatServiceOptions.filter((entry) => isStudioServiceCandidate(entry))
  ), [snap.chatServiceOptions]);

  const compatibleServiceOptions = useMemo(() => (
    studioServiceOptions.filter((entry) => supportsStudioIntent(entry, intent))
  ), [studioServiceOptions, intent]);

  const intentOptionCounts = useMemo<Record<StudioIntent, number>>(
    () => ({
      'image-edit': studioServiceOptions.filter((entry) => supportsStudioIntent(entry, 'image-edit')).length,
      'image-generate': studioServiceOptions.filter((entry) => supportsStudioIntent(entry, 'image-generate')).length,
      'video-generate': studioServiceOptions.filter((entry) => supportsStudioIntent(entry, 'video-generate')).length,
    }),
    [studioServiceOptions],
  );

  useEffect(() => {
    if (selectedServiceValue && compatibleServiceOptions.some((entry) => entry.value === selectedServiceValue)) {
      return;
    }
    setSelectedServiceValue(compatibleServiceOptions[0]?.value || '');
  }, [compatibleServiceOptions, selectedServiceValue]);

  useEffect(() => {
    persistStudioDraft({
      intent,
      prompt,
      selectedServiceValue,
      showHistory,
    });
  }, [intent, prompt, selectedServiceValue, showHistory]);

  const mediaResults = useMemo<StudioMediaResult[]>(() => {
    const byUrl = new Map<string, StudioMediaResult>();
    for (const run of studioRuns) {
      for (const output of run.outputs) {
        if (!byUrl.has(output.url)) {
          byUrl.set(output.url, output);
        }
      }
    }
    return [...byUrl.values()].sort((a, b) => b.createdAt - a.createdAt);
  }, [studioRuns]);

  useEffect(() => {
    if (mediaResults.length === 0) {
      setSelectedResultKey(null);
      return;
    }
    if (!selectedResultKey || !mediaResults.some((entry) => entry.key === selectedResultKey)) {
      setSelectedResultKey(mediaResults[0]?.key || null);
    }
  }, [mediaResults, selectedResultKey]);

  const selectedResult = useMemo(
    () => mediaResults.find((entry) => entry.key === selectedResultKey) || mediaResults[0] || null,
    [mediaResults, selectedResultKey],
  );

  const workspacePath = snap.chatWorkspacePath || snap.chatWorkspaceDefaultPath;
  const workspaceLabel = getPathTail(workspacePath);
  const git = snap.chatWorkspaceGitStatus;
  const gitSummary = git.available
    ? `${git.branch || 'detached'}${git.modifiedFiles + git.stagedFiles + git.untrackedFiles > 0 ? ' - dirty' : ' - clean'}`
    : git.error
      ? 'Git unavailable'
      : 'No git repo';

  const selectedService = compatibleServiceOptions.find((entry) => entry.value === selectedServiceValue) || null;
  const selectedServiceTags = selectedService?.categories.slice(0, 4).join(', ') || '';
  const requiresReference = STUDIO_INTENT_REFERENCE_REQUIRED[intent];

  const submitDisabledReason = useMemo(() => {
    if (isSubmitting) return 'A Studio task is already running.';
    if (snap.chatInputDisabled) return 'Studio input is temporarily unavailable.';
    if (!bridge?.apiTryProxyRequest || !bridge?.chatAiGetProxyStatus) {
      return 'Desktop proxy bridge is unavailable.';
    }
    if (studioServiceOptions.length === 0) {
      return 'No Studio-ready services found. Add media categories like image, video, edit, or multimodal.';
    }
    if (compatibleServiceOptions.length === 0) {
      return `No services currently advertise support for ${STUDIO_INTENT_LABELS[intent]}.`;
    }
    if (!selectedService) return 'Select a compatible model service.';
    if (requiresReference && attachments.length === 0) {
      return 'Image Edit requires at least one reference image.';
    }
    if (prompt.trim().length === 0 && attachments.length === 0) {
      return 'Add a prompt or reference image before running.';
    }
    return null;
  }, [
    attachments.length,
    bridge,
    compatibleServiceOptions.length,
    intent,
    isSubmitting,
    prompt,
    requiresReference,
    selectedService,
    snap.chatInputDisabled,
    studioServiceOptions.length,
  ]);

  const canSubmit = submitDisabledReason === null;

  const upsertFiles = useCallback(async (files: FileList | File[]) => {
    const nextSlots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (nextSlots === 0) {
      setAttachmentNotice(`Maximum ${MAX_ATTACHMENTS} references reached.`);
      return;
    }
    const incomingFiles = Array.from(files);
    const overflowCount = Math.max(0, incomingFiles.length - nextSlots);
    const selectedFiles = incomingFiles.slice(0, nextSlots);
    const parsed = await Promise.all(selectedFiles.map((file) => readFileAsAttachment(file)));
    const valid = parsed.filter((entry): entry is StudioAttachment => Boolean(entry));
    const unsupportedCount = selectedFiles.length - valid.length;
    if (valid.length === 0) {
      if (unsupportedCount > 0 || overflowCount > 0) {
        setAttachmentNotice(
          [
            unsupportedCount > 0 ? `${unsupportedCount} unsupported file(s) skipped (use JPG, PNG, WEBP, or GIF).` : null,
            overflowCount > 0 ? `${overflowCount} file(s) skipped due to attachment limit.` : null,
          ].filter(Boolean).join(' '),
        );
      }
      return;
    }
    setAttachments((prev) => [...prev, ...valid].slice(0, MAX_ATTACHMENTS));
    if (unsupportedCount > 0 || overflowCount > 0) {
      setAttachmentNotice(
        [
          unsupportedCount > 0 ? `${unsupportedCount} unsupported file(s) skipped (use JPG, PNG, WEBP, or GIF).` : null,
          overflowCount > 0 ? `${overflowCount} file(s) skipped due to attachment limit.` : null,
        ].filter(Boolean).join(' '),
      );
      return;
    }
    setAttachmentNotice(null);
  }, [attachments.length]);

  const handleFileInput = useCallback((event: React.ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files;
    if (files) {
      void upsertFiles(files);
    }
    event.target.value = '';
  }, [upsertFiles]);

  const handleDrop = useCallback((event: React.DragEvent<HTMLElement>) => {
    event.preventDefault();
    setIsDragOver(false);
    if (event.dataTransfer?.files?.length) {
      void upsertFiles(event.dataTransfer.files);
    }
  }, [upsertFiles]);

  const handlePaste = useCallback((event: React.ClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (const item of items) {
      const file = item.getAsFile();
      if (file && ALLOWED_IMAGE_MIME_TYPES.has(file.type)) {
        files.push(file);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      void upsertFiles(files);
    }
  }, [upsertFiles]);

  const handleSubmit = useCallback(async () => {
    if (!canSubmit || !selectedService || !bridge?.apiTryProxyRequest || !bridge?.chatAiGetProxyStatus) return;

    setRunError(null);
    setIsSubmitting(true);
    actions.handleServiceChange(selectedService.value, selectedService.peerId);

    try {
      const references: StudioRunReference[] = attachments.map((entry) => ({
        name: entry.name,
        mimeType: entry.mimeType,
        base64: entry.base64,
      }));
      const request = buildStudioRunRequest(
        selectedService.id,
        intent,
        prompt.trim(),
        references,
      );
      const proxyStatus = await bridge.chatAiGetProxyStatus();
      const proxyPort = proxyStatus.ok && proxyStatus.data.running
        ? proxyStatus.data.port
        : 0;
      if (!proxyPort || proxyPort <= 0) {
        const message = 'Buyer proxy is offline. Start Buyer runtime before running Studio tasks.';
        setRunError(message);
        return;
      }

      const proxyRequest = buildStudioProxyRequest(selectedService, request);
      const rawResult = await bridge.apiTryProxyRequest({
        port: proxyPort,
        path: proxyRequest.path,
        method: proxyRequest.method,
        headers: proxyRequest.headers,
        body: proxyRequest.bodyText,
      });
      const parsed = parseStudioProxyTransportResult(rawResult, selectedService.label);
      const createdAt = Date.now();

      if (!parsed.ok) {
        setRunError(parsed.message);
        setStudioRuns((prev) => [
          {
            id: `failed-${String(createdAt)}`,
            status: 'failed',
            intent,
            serviceLabel: selectedService.label,
            prompt: prompt.trim(),
            createdAt,
            outputs: [],
            error: parsed.message,
          },
          ...prev,
        ].slice(0, MAX_STUDIO_RUN_HISTORY));
        return;
      }

      const outputItems: StudioMediaResult[] = parsed.data.outputs.map((entry, index) => ({
        key: `${parsed.data.id}:${String(index)}:${entry.url}`,
        url: entry.url,
        kind: entry.kind,
        createdAt,
      }));

      setStudioRuns((prev) => [
        {
          id: parsed.data.id,
          status: parsed.data.status,
          intent,
          serviceLabel: selectedService.label,
          prompt: prompt.trim(),
          createdAt,
          outputs: outputItems,
        },
        ...prev,
      ].slice(0, MAX_STUDIO_RUN_HISTORY));

      setSelectedResultKey(outputItems[0]?.key || null);
      setPrompt('');
      setAttachments([]);
      setAttachmentNotice(null);
    } catch (error) {
      setRunError((error as Error)?.message || 'Unexpected Studio run error');
    } finally {
      setIsSubmitting(false);
    }
  }, [
    actions,
    attachments,
    bridge,
    canSubmit,
    intent,
    prompt,
    selectedService,
  ]);

  const handleServiceChange = useCallback((value: string) => {
    setSelectedServiceValue(value);
    const option = compatibleServiceOptions.find((entry) => entry.value === value);
    actions.handleServiceChange(value, option?.peerId);
  }, [actions, compatibleServiceOptions]);

  const handleCopySelectedResultUrl = useCallback(() => {
    if (!selectedResult) return;
    void navigator.clipboard.writeText(selectedResult.url).then(() => {
      setCopiedResultUrl(true);
    }).catch(() => {
      setCopiedResultUrl(false);
    });
  }, [selectedResult]);

  const handleOpenSelectedResult = useCallback(() => {
    if (!selectedResult) return;
    window.open(selectedResult.url, '_blank', 'noopener,noreferrer');
  }, [selectedResult]);

  const handleDownloadSelectedResult = useCallback(() => {
    if (!selectedResult) return;
    const ext = selectedResult.kind === 'video' ? 'mp4' : 'png';
    const stamp = new Date(selectedResult.createdAt).toISOString().replace(/[:.]/g, '-');
    const anchor = document.createElement('a');
    anchor.href = selectedResult.url;
    anchor.download = `studio-${selectedResult.kind}-${stamp}.${ext}`;
    anchor.target = '_blank';
    anchor.rel = 'noopener noreferrer';
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  }, [selectedResult]);

  const handleNewRun = useCallback(() => {
    setPrompt('');
    setAttachments([]);
    setAttachmentNotice(null);
    setRunError(null);
  }, []);

  useEffect(() => {
    if (!copiedResultUrl) return;
    const timer = window.setTimeout(() => setCopiedResultUrl(false), 1200);
    return () => window.clearTimeout(timer);
  }, [copiedResultUrl]);

  const intentPromptPlaceholder = getPromptPlaceholder(intent);

  return (
    <section
      className={`view ${styles.studioView}${active ? ' active' : ''}`}
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={(event) => {
        event.preventDefault();
        if (!event.currentTarget.contains(event.relatedTarget as Node)) {
          setIsDragOver(false);
        }
      }}
      onDrop={handleDrop}
      role="tabpanel"
    >
      {isDragOver && (
        <div className={styles.dropOverlay}>
          <div className={styles.dropOverlayInner}>Drop images to use as references</div>
        </div>
      )}
      <div className={styles.layout}>
        <aside className={styles.controlPane}>
          <div className={styles.section}>
            <div className={styles.sectionTitle}>Studio</div>
            <div className={styles.intentRow}>
              {STUDIO_INTENTS.map((entry) => (
                <button
                  key={entry}
                  className={`${styles.intentBtn}${intent === entry ? ` ${styles.intentBtnActive}` : ''}`}
                  onClick={() => setIntent(entry)}
                  title={`${intentOptionCounts[entry]} compatible services`}
                >
                  {STUDIO_INTENT_LABELS[entry].replace(' Generation', ' Gen')}
                </button>
              ))}
            </div>
            <div className={styles.intentMeta}>
              {intentOptionCounts[intent]} compatible service{intentOptionCounts[intent] === 1 ? '' : 's'} for {STUDIO_INTENT_LABELS[intent]}
            </div>
          </div>

          {studioServiceOptions.length === 0 ? (
            <div className={`${styles.supportBanner} ${styles.supportBannerWarn}`}>
              <div className={styles.supportTitle}>No Studio-compatible services</div>
              <div className={styles.supportText}>
                Studio needs models tagged for media tasks (for example: image, video, edit, multimodal).
              </div>
              <button className={styles.supportAction} onClick={() => actions.refreshPlugins()}>
                Refresh Plugins
              </button>
            </div>
          ) : compatibleServiceOptions.length === 0 ? (
            <div className={`${styles.supportBanner} ${styles.supportBannerWarn}`}>
              <div className={styles.supportTitle}>Intent Not Supported</div>
              <div className={styles.supportText}>
                No discovered service currently advertises {STUDIO_INTENT_LABELS[intent]} support.
              </div>
            </div>
          ) : (
            <div className={`${styles.supportBanner} ${styles.supportBannerInfo}`}>
              <div className={styles.supportText}>
                Studio is filtering to services that advertise {STUDIO_INTENT_LABELS[intent]} capability.
              </div>
            </div>
          )}

          <div className={styles.section}>
            <label className={styles.label} htmlFor="studio-service-select">Model Service</label>
            <select
              id="studio-service-select"
              className={styles.select}
              value={selectedServiceValue}
              onChange={(event) => handleServiceChange(event.target.value)}
              disabled={compatibleServiceOptions.length === 0 || snap.chatInputDisabled || isSubmitting}
            >
              {compatibleServiceOptions.length === 0 ? (
                <option value="">No compatible services found</option>
              ) : (
                compatibleServiceOptions.map((entry) => (
                  <option key={entry.value} value={entry.value}>
                    {entry.label}
                  </option>
                ))
              )}
            </select>
            {selectedService && (
              <div className={styles.selectHelp}>
                {selectedService.label}{selectedServiceTags ? ` - ${selectedServiceTags}` : ''}
              </div>
            )}
          </div>

          <div className={styles.section}>
            <label className={styles.label} htmlFor="studio-prompt">Prompt</label>
            <textarea
              id="studio-prompt"
              className={styles.prompt}
              placeholder={intentPromptPlaceholder}
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  void handleSubmit();
                }
              }}
              disabled={snap.chatInputDisabled || isSubmitting}
            />
          </div>

          <div className={styles.section}>
            <div className={styles.labelRow}>
              <span className={styles.label}>References</span>
              <span className={styles.counter}>{attachments.length}/{MAX_ATTACHMENTS}</span>
            </div>
            <input
              ref={fileInputRef}
              id={fileInputId}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif"
              style={{ display: 'none' }}
              onChange={handleFileInput}
            />
            <button
              className={styles.attachBtn}
              onClick={() => fileInputRef.current?.click()}
              disabled={attachments.length >= MAX_ATTACHMENTS || snap.chatInputDisabled || isSubmitting}
            >
              <HugeiconsIcon icon={Add01Icon} size={14} strokeWidth={2} />
              Add Images
            </button>
            <div className={styles.referenceGrid}>
              {attachments.map((entry) => (
                <div key={entry.id} className={styles.referenceCard}>
                  <img src={entry.previewUrl} alt={entry.name} />
                  <button
                    className={styles.referenceRemove}
                    onClick={() => {
                      setAttachments((prev) => prev.filter((item) => item.id !== entry.id));
                      setAttachmentNotice(null);
                    }}
                    title="Remove reference"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
            {attachmentNotice && <div className={styles.attachmentNotice}>{attachmentNotice}</div>}
          </div>

          <div className={styles.section}>
            <div className={styles.metaRow}>
              <button className={styles.metaBtn} onClick={() => void actions.refreshWorkspaceGitStatus()} title={git.error || gitSummary}>
                <HugeiconsIcon icon={GitBranchIcon} size={14} strokeWidth={1.5} />
                <span>{gitSummary}</span>
              </button>
            </div>
            <div className={styles.metaRow}>
              <button className={styles.metaBtn} onClick={() => void actions.chooseWorkspace()} title={workspacePath || 'Choose workspace'}>
                <HugeiconsIcon icon={Folder01Icon} size={14} strokeWidth={1.5} />
                <span>{workspaceLabel}</span>
              </button>
            </div>
          </div>

          {submitDisabledReason && <div className={styles.inputHint}>{submitDisabledReason}</div>}
          {runError && <div className={styles.error}>{runError}</div>}

          <button className={styles.submitBtn} disabled={!canSubmit} onClick={() => void handleSubmit()}>
            {isSubmitting ? 'Running...' : 'Run Studio Task'}
            {!isSubmitting && <HugeiconsIcon icon={ArrowUp02Icon} size={14} strokeWidth={2.5} />}
          </button>
        </aside>

        <main className={styles.canvasPane}>
          <div className={styles.canvasHeader}>
            <div className={styles.canvasTitle}>Canvas</div>
            <div className={styles.canvasHeaderActions}>
              <button
                className={styles.historyToggle}
                onClick={handleCopySelectedResultUrl}
                disabled={!selectedResult}
              >
                {copiedResultUrl ? 'Copied URL' : 'Copy URL'}
              </button>
              <button
                className={styles.historyToggle}
                onClick={handleOpenSelectedResult}
                disabled={!selectedResult}
              >
                Open
              </button>
              <button
                className={styles.historyToggle}
                onClick={handleDownloadSelectedResult}
                disabled={!selectedResult}
              >
                Download
              </button>
              <button className={styles.historyToggle} onClick={() => setShowHistory((value) => !value)}>
                {showHistory ? 'Hide History' : 'Show History'}
              </button>
              <button className={styles.historyToggle} onClick={handleNewRun}>
                New Run
              </button>
            </div>
          </div>

          {selectedResult ? (
            <div className={styles.canvasPreview}>
              {selectedResult.kind === 'video' ? (
                <video src={selectedResult.url} controls className={styles.previewVideo} />
              ) : (
                <img src={selectedResult.url} alt="Studio result" className={styles.previewImage} />
              )}
            </div>
          ) : (
            <div className={styles.emptyCanvas}>
              <div className={styles.emptyTitle}>No generated media yet</div>
              <div className={styles.emptyHint}>
                {compatibleServiceOptions.length > 0
                  ? 'Run a Studio task to start building image/video outputs.'
                  : `No ${STUDIO_INTENT_LABELS[intent]} services are currently available.`}
              </div>
            </div>
          )}

          <div className={styles.resultStrip}>
            {mediaResults.map((entry) => (
              <button
                key={entry.key}
                className={`${styles.resultThumb}${selectedResult?.key === entry.key ? ` ${styles.resultThumbActive}` : ''}`}
                onClick={() => setSelectedResultKey(entry.key)}
                title={entry.url}
              >
                {entry.kind === 'video' ? (
                  <video src={entry.url} muted />
                ) : (
                  <img src={entry.url} alt="Result thumbnail" />
                )}
              </button>
            ))}
          </div>
        </main>

        {showHistory && (
          <aside className={styles.historyPane}>
            <div className={styles.historyTitle}>Run History</div>
            <div className={styles.historyList}>
              {studioRuns.map((entry) => {
                const primaryOutput = entry.outputs[0] ?? null;
                const label = `${new Date(entry.createdAt).toLocaleTimeString()} | ${entry.serviceLabel} | ${STUDIO_INTENT_LABELS[entry.intent]}`;
                return (
                  <button
                    key={entry.id}
                    className={styles.historyItem}
                    disabled={!primaryOutput}
                    onClick={() => {
                      if (primaryOutput) setSelectedResultKey(primaryOutput.key);
                    }}
                    title={entry.error || entry.prompt || label}
                  >
                    {label}
                  </button>
                );
              })}
              {studioRuns.length === 0 && (
                <div className={styles.historyEmpty}>No previous runs yet.</div>
              )}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
