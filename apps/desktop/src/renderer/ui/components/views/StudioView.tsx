import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Add01Icon, ArrowUp02Icon, Folder01Icon, GitBranchIcon } from '@hugeicons/core-free-icons';
import { useUiSnapshot } from '../../hooks/useUiSnapshot';
import { useActions } from '../../hooks/useActions';
import type { RawChatAttachment } from '../../../types/bridge';
import styles from './StudioView.module.scss';

type StudioIntent = 'image-edit' | 'image-generate' | 'video-generate';

type StudioAttachment = RawChatAttachment & {
  previewUrl: string;
};

type StudioMediaResult = {
  key: string;
  url: string;
  kind: 'image' | 'video';
  createdAt: number;
};

type ServiceSignalEntry = {
  label: string;
  description: string;
  categories: string[];
};

const STUDIO_INTENTS: StudioIntent[] = ['image-edit', 'image-generate', 'video-generate'];

const STUDIO_INTENT_LABELS: Record<StudioIntent, string> = {
  'image-edit': 'Image Edit',
  'image-generate': 'Image Generation',
  'video-generate': 'Video Generation',
};

const STUDIO_INTENT_HINTS: Record<StudioIntent, string[]> = {
  'image-edit': ['image-edit', 'image edit', 'edit', 'inpaint', 'img2img', 'multimodal', 'vision', 'image', 'media'],
  'image-generate': ['image', 'image-generation', 'image generate', 'diffusion', 'flux', 'sdxl', 'gpt-image', 'media'],
  'video-generate': ['video', 'video-generation', 'video generate', 'animation', 'cinema', 'lipsync', 'motion'],
};

const STUDIO_INTENT_REFERENCE_REQUIRED: Record<StudioIntent, boolean> = {
  'image-edit': true,
  'image-generate': false,
  'video-generate': false,
};

const MAX_ATTACHMENTS = 8;
const ALLOWED_IMAGE_MIME_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MEDIA_CATEGORY_HINTS = ['image', 'video', 'edit', 'vision', 'media', 'cinema', 'lipsync', 'animation', 'diffusion', 'inpaint'];
const MEDIA_LABEL_HINT = /(image|video|edit|vision|media|cinema|lipsync|animate|diffusion|inpaint)/i;
const URL_REGEX = /https?:\/\/[^\s<>"'`]+/g;

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

function classifyMediaUrl(url: string): 'image' | 'video' | null {
  const clean = url.split('?')[0]?.toLowerCase() || url.toLowerCase();
  if (/\.(mp4|mov|webm|m4v|avi|mkv)$/.test(clean)) return 'video';
  if (/\.(png|jpg|jpeg|webp|gif|bmp|svg)$/.test(clean)) return 'image';
  return null;
}

function extractUrlsFromText(text: string): string[] {
  if (!text) return [];
  const matches = text.match(URL_REGEX) || [];
  return matches.map((entry) => entry.replace(/[),.;]+$/, ''));
}

function extractUrlsFromUnknown(value: unknown): string[] {
  if (typeof value === 'string') {
    return extractUrlsFromText(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap((entry) => extractUrlsFromUnknown(entry));
  }
  if (!value || typeof value !== 'object') {
    return [];
  }
  const record = value as Record<string, unknown>;
  const directKeys = ['url', 'image_url', 'video_url', 'content', 'text', 'output', 'details'];
  return directKeys.flatMap((key) => extractUrlsFromUnknown(record[key]));
}

function toServiceSignalText(entry: ServiceSignalEntry): string {
  const categoryText = entry.categories.join(' ');
  return `${entry.label} ${entry.description} ${categoryText}`.toLowerCase();
}

function hasAnyHint(signal: string, hints: string[]): boolean {
  return hints.some((hint) => signal.includes(hint));
}

function isStudioServiceCandidate(entry: ServiceSignalEntry): boolean {
  const categoryHit = entry.categories.some((category) => {
    const lowered = category.toLowerCase();
    return MEDIA_CATEGORY_HINTS.some((hint) => lowered.includes(hint));
  });
  if (categoryHit) return true;
  const text = `${entry.label} ${entry.description}`.trim();
  return MEDIA_LABEL_HINT.test(text);
}

function supportsStudioIntent(entry: ServiceSignalEntry, intent: StudioIntent): boolean {
  const signal = toServiceSignalText(entry);
  return hasAnyHint(signal, STUDIO_INTENT_HINTS[intent]);
}

function buildStudioPrompt(intent: StudioIntent, prompt: string, imageCount: number): string {
  const requestedTask = prompt.trim();
  const fallbackTask =
    intent === 'image-edit'
      ? 'Edit the attached reference images and produce a polished variant.'
      : intent === 'video-generate'
        ? 'Generate a short cinematic video.'
        : 'Generate a high-quality image.';
  return [
    '[ANTSEED_STUDIO_V1]',
    `intent=${intent}`,
    `references=${String(imageCount)}`,
    `task=${requestedTask || fallbackTask}`,
    'Return direct media URLs in markdown and list the key generation settings used.',
  ].join('\n');
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
  const [intent, setIntent] = useState<StudioIntent>('image-edit');
  const [prompt, setPrompt] = useState('');
  const [attachments, setAttachments] = useState<StudioAttachment[]>([]);
  const [selectedServiceValue, setSelectedServiceValue] = useState('');
  const [selectedResultKey, setSelectedResultKey] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const studioServiceOptions = useMemo(() => {
    return snap.chatServiceOptions.filter((entry) => isStudioServiceCandidate(entry));
  }, [snap.chatServiceOptions]);

  const compatibleServiceOptions = useMemo(() => {
    return studioServiceOptions.filter((entry) => supportsStudioIntent(entry, intent));
  }, [studioServiceOptions, intent]);

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
    const fallbackValue = compatibleServiceOptions[0]?.value || '';
    setSelectedServiceValue(fallbackValue);
  }, [compatibleServiceOptions, selectedServiceValue]);

  const mediaResults = useMemo<StudioMediaResult[]>(() => {
    const messages = Array.isArray(snap.chatMessages) ? snap.chatMessages : [];
    const urls: StudioMediaResult[] = [];
    for (const rawMessage of messages) {
      if (!rawMessage || typeof rawMessage !== 'object') continue;
      const message = rawMessage as { role?: unknown; content?: unknown; createdAt?: unknown };
      if (message.role !== 'assistant') continue;
      const extracted = extractUrlsFromUnknown(message.content);
      const createdAt = Number(message.createdAt) || Date.now();
      for (const url of extracted) {
        const kind = classifyMediaUrl(url);
        if (!kind) continue;
        urls.push({ key: `${url}|${createdAt}`, url, kind, createdAt });
      }
    }
    const deduped = new Map<string, StudioMediaResult>();
    for (const entry of urls.sort((a, b) => b.createdAt - a.createdAt)) {
      if (!deduped.has(entry.url)) {
        deduped.set(entry.url, { ...entry, key: `${entry.url}|${entry.createdAt}` });
      }
    }
    return [...deduped.values()];
  }, [snap.chatMessages]);

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
    ? `${git.branch || 'detached'}${git.modifiedFiles + git.stagedFiles + git.untrackedFiles > 0 ? ' • dirty' : ' • clean'}`
    : git.error
      ? 'Git unavailable'
      : 'No git repo';

  const conversationSummaries = useMemo(() => {
    if (!Array.isArray(snap.chatConversations)) return [] as Array<{ id: string; title: string }>;
    return (snap.chatConversations as Array<Record<string, unknown>>)
      .map((entry) => ({
        id: String(entry.id || ''),
        title: String(entry.title || 'Untitled Studio Run'),
      }))
      .filter((entry) => entry.id.length > 0)
      .slice(0, 20);
  }, [snap.chatConversations]);

  const selectedService = compatibleServiceOptions.find((entry) => entry.value === selectedServiceValue) || null;
  const selectedServiceTags = selectedService?.categories.slice(0, 4).join(', ') || '';
  const requiresReference = STUDIO_INTENT_REFERENCE_REQUIRED[intent];

  const submitDisabledReason = useMemo(() => {
    if (snap.chatAbortVisible || snap.chatSending) return 'A Studio task is already running.';
    if (snap.chatInputDisabled) return 'Studio input is temporarily unavailable.';
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
    compatibleServiceOptions.length,
    intent,
    prompt,
    requiresReference,
    selectedService,
    snap.chatAbortVisible,
    snap.chatInputDisabled,
    snap.chatSending,
    studioServiceOptions.length,
  ]);

  const canSubmit = submitDisabledReason === null;

  const upsertFiles = useCallback(async (files: FileList | File[]) => {
    const nextSlots = Math.max(0, MAX_ATTACHMENTS - attachments.length);
    if (nextSlots === 0) return;
    const selectedFiles = Array.from(files).slice(0, nextSlots);
    const parsed = await Promise.all(selectedFiles.map((file) => readFileAsAttachment(file)));
    const valid = parsed.filter((entry): entry is StudioAttachment => Boolean(entry));
    if (valid.length === 0) return;
    setAttachments((prev) => [...prev, ...valid].slice(0, MAX_ATTACHMENTS));
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

  const handleSubmit = useCallback(() => {
    if (!canSubmit || !selectedService) return;

    actions.handleServiceChange(selectedService.value, selectedService.peerId);
    const instruction = buildStudioPrompt(intent, prompt, attachments.length);
    const rawAttachments: RawChatAttachment[] = attachments.map((entry) => ({
      id: entry.id,
      name: entry.name,
      mimeType: entry.mimeType,
      size: entry.size,
      base64: entry.base64,
    }));
    actions.sendMessage(instruction, rawAttachments);
    setPrompt('');
  }, [actions, attachments, canSubmit, intent, prompt, selectedService]);

  const handleServiceChange = useCallback((value: string) => {
    setSelectedServiceValue(value);
    const option = compatibleServiceOptions.find((entry) => entry.value === value);
    actions.handleServiceChange(value, option?.peerId);
  }, [actions, compatibleServiceOptions]);

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
              <button className={styles.supportAction} onClick={() => actions.setExperienceMode('code')}>
                Switch to Code Mode
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
              disabled={compatibleServiceOptions.length === 0 || snap.chatInputDisabled || snap.chatSending}
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
                {selectedService.label}{selectedServiceTags ? ` • ${selectedServiceTags}` : ''}
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
              disabled={snap.chatInputDisabled}
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
              disabled={attachments.length >= MAX_ATTACHMENTS || snap.chatInputDisabled}
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
                    onClick={() => setAttachments((prev) => prev.filter((item) => item.id !== entry.id))}
                    title="Remove reference"
                  >
                    x
                  </button>
                </div>
              ))}
            </div>
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
          {snap.chatError && <div className={styles.error}>{snap.chatError}</div>}

          <button className={styles.submitBtn} disabled={!canSubmit} onClick={handleSubmit}>
            {snap.chatAbortVisible ? 'Running...' : 'Run Studio Task'}
            {!snap.chatAbortVisible && <HugeiconsIcon icon={ArrowUp02Icon} size={14} strokeWidth={2.5} />}
          </button>
        </aside>

        <main className={styles.canvasPane}>
          <div className={styles.canvasHeader}>
            <div className={styles.canvasTitle}>Canvas</div>
            <div className={styles.canvasHeaderActions}>
              <button className={styles.historyToggle} onClick={() => setShowHistory((value) => !value)}>
                {showHistory ? 'Hide History' : 'Show History'}
              </button>
              <button className={styles.historyToggle} onClick={() => actions.startNewChat()}>
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
            <div className={styles.historyTitle}>Chat History</div>
            <div className={styles.historyList}>
              {conversationSummaries.map((entry) => (
                <button
                  key={entry.id}
                  className={styles.historyItem}
                  onClick={() => void actions.openConversation(entry.id)}
                >
                  {entry.title}
                </button>
              ))}
              {conversationSummaries.length === 0 && (
                <div className={styles.historyEmpty}>No previous runs yet.</div>
              )}
            </div>
          </aside>
        )}
      </div>
    </section>
  );
}
