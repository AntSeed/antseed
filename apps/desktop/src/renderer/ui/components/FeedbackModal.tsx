import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent, type KeyboardEvent } from 'react';
import { Attachment02Icon, InformationCircleIcon } from '@hugeicons/core-free-icons';
import { HugeiconsIcon } from '@hugeicons/react';
import { Button, Modal } from '@antseed/ui';
import {
  FEEDBACK_IMAGE_MIME_TYPES,
  FEEDBACK_MAX_ATTACHMENT_BYTES,
  FEEDBACK_MAX_EMAIL_LENGTH,
  FEEDBACK_MAX_IMAGES,
  FEEDBACK_MAX_TEXT_LENGTH,
  type FeedbackImageInput,
  type FeedbackImageMimeType,
  type FeedbackSubmitResult,
} from '../../../shared/feedback';
import { InfoTooltip } from './InfoTooltip';
import styles from './FeedbackModal.module.scss';

type FeedbackAttachment = FeedbackImageInput & {
  id: string;
  previewUrl: string;
};

type FeedbackModalProps = {
  configured: boolean;
  isOpen: boolean;
  onClose: () => void;
  onSubmitted: (result: FeedbackSubmitResult) => void;
};

const ACCEPTED_MIME_TYPES = new Set<string>(FEEDBACK_IMAGE_MIME_TYPES);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FeedbackAttachmentCandidate = Pick<FeedbackImageInput, 'size'>;
type FeedbackFileCandidate = Pick<File, 'size' | 'type'>;

export function validateFeedbackEmail(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > FEEDBACK_MAX_EMAIL_LENGTH || !EMAIL_PATTERN.test(trimmed)) {
    return 'Enter a valid contact email or leave it blank.';
  }
  return null;
}

export function validateFeedbackAttachmentSelection(
  attachments: readonly FeedbackAttachmentCandidate[],
  files: readonly FeedbackFileCandidate[],
): string | null {
  if (files.some((file) => !ACCEPTED_MIME_TYPES.has(file.type))) {
    return 'Attach JPEG, PNG, or WebP images only.';
  }
  if (attachments.length + files.length > FEEDBACK_MAX_IMAGES) {
    return `Attach no more than ${FEEDBACK_MAX_IMAGES} images.`;
  }
  const totalBytes = [...attachments, ...files].reduce((total, file) => total + file.size, 0);
  if (totalBytes > FEEDBACK_MAX_ATTACHMENT_BYTES) {
    return 'Attachments exceed the 8 MiB total limit.';
  }
  return null;
}

export function isFeedbackSubmitShortcut(
  event: Pick<KeyboardEvent<HTMLFormElement>, 'ctrlKey' | 'key' | 'metaKey'>,
  canSubmit: boolean,
): boolean {
  return canSubmit && (event.metaKey || event.ctrlKey) && event.key === 'Enter';
}

function encodeBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

async function prepareAttachment(file: File): Promise<FeedbackAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const dataBase64 = encodeBase64(bytes);
  return {
    id: `${file.name}-${file.size}-${file.lastModified}-${crypto.randomUUID()}`,
    name: file.name,
    mimeType: file.type as FeedbackImageMimeType,
    size: file.size,
    dataBase64,
    previewUrl: `data:${file.type};base64,${dataBase64}`,
  };
}

export function FeedbackModal({ configured, isOpen, onClose, onSubmitted }: FeedbackModalProps) {
  const [feedback, setFeedback] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [includeDiagnosticLogs, setIncludeDiagnosticLogs] = useState(false);
  const [attachments, setAttachments] = useState<FeedbackAttachment[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [contactEmailError, setContactEmailError] = useState<string | null>(null);
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const reset = useCallback(() => {
    setFeedback('');
    setContactEmail('');
    setIncludeDiagnosticLogs(false);
    setAttachments([]);
    setSubmitting(false);
    setError(null);
    setContactEmailError(null);
    setIsDraggingOver(false);
  }, []);

  useEffect(() => {
    if (isOpen) reset();
  }, [isOpen, reset]);

  const addFiles = useCallback(async (files: File[]) => {
    if (submitting || files.length === 0) return;
    const selectionError = validateFeedbackAttachmentSelection(attachments, files);
    if (selectionError) {
      setError(selectionError);
      return;
    }
    try {
      const prepared = await Promise.all(files.map(prepareAttachment));
      setAttachments((current) => [...current, ...prepared]);
      setError(null);
    } catch {
      setError('Unable to read one of the selected images.');
    }
  }, [attachments, submitting]);

  const handleSubmit = useCallback(async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const emailError = validateFeedbackEmail(contactEmail);
    if (emailError) {
      setContactEmailError(emailError);
      return;
    }
    if (!configured) {
      setError('Feedback is unavailable in this build.');
      return;
    }
    const bridge = window.antseedDesktop?.feedbackSubmit;
    if (!bridge) {
      setError('Feedback is unavailable in this build.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await bridge({
        feedback,
        contactEmail,
        images: attachments.map(({ previewUrl: _previewUrl, id: _id, ...attachment }) => attachment),
        includeDiagnosticLogs,
      });
      if (!result.ok) {
        setError(result.error ?? 'Unable to send feedback. Please try again.');
        return;
      }
      onSubmitted(result);
    } catch {
      setError('Unable to send feedback. Please try again.');
    } finally {
      setSubmitting(false);
    }
  }, [attachments, configured, contactEmail, feedback, includeDiagnosticLogs, onSubmitted]);

  const canSubmit = configured && feedback.trim().length > 0 && !submitting;
  const shortcutModifier = typeof window !== 'undefined' && window.antseedDesktop?.platform === 'darwin'
    ? '⌘'
    : 'Ctrl';

  const handleFormKeyDown = useCallback((event: KeyboardEvent<HTMLFormElement>) => {
    if (isFeedbackSubmitShortcut(event, canSubmit)) {
      event.preventDefault();
      event.currentTarget.requestSubmit();
    }
  }, [canSubmit]);

  const handleDrop = useCallback((event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDraggingOver(false);
    void addFiles(Array.from(event.dataTransfer.files));
  }, [addFiles]);

  return (
    <Modal
      bodyClassName={styles.modalBody}
      className={styles.modal}
      isOpen={isOpen}
      onClose={submitting ? () => {} : onClose}
      size="lg"
      title="Feedback"
    >
      <div
        className={styles.dropZone}
        onDragEnter={(event) => { event.preventDefault(); setIsDraggingOver(true); }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDraggingOver(false);
        }}
        onDragOver={(event) => event.preventDefault()}
        onDrop={handleDrop}
      >
        {isDraggingOver && <div className={styles.dropOverlay}>Drop images here</div>}
        <form className={styles.form} onSubmit={handleSubmit} onKeyDown={handleFormKeyDown}>
          <div className={styles.fields}>
            <label className={styles.srOnly} htmlFor="feedback-details">Feedback details</label>
            <textarea
              id="feedback-details"
              autoFocus
              className={styles.textarea}
              disabled={submitting}
              maxLength={FEEDBACK_MAX_TEXT_LENGTH}
              placeholder="What do you like? How can we improve?"
              rows={5}
              value={feedback}
              onChange={(event) => { setFeedback(event.target.value); setError(null); }}
              onPaste={(event) => {
                const files = Array.from(event.clipboardData.files);
                if (files.length > 0) void addFiles(files);
              }}
            />

            <label className={styles.srOnly} htmlFor="feedback-email">Contact email</label>
            <input
              id="feedback-email"
              className={`${styles.email}${contactEmailError ? ` ${styles.inputError}` : ''}`}
              disabled={submitting}
              maxLength={FEEDBACK_MAX_EMAIL_LENGTH}
              placeholder="productive@example.com (optional)"
              type="email"
              value={contactEmail}
              onChange={(event) => {
                setContactEmail(event.target.value);
                setContactEmailError(null);
                setError(null);
              }}
            />
            {contactEmailError && <p className={styles.fieldError} role="alert">{contactEmailError}</p>}

            <div className={styles.diagnosticsRow}>
              <label className={styles.checkboxLabel}>
                <input
                  checked={includeDiagnosticLogs}
                  disabled={submitting}
                  type="checkbox"
                  onChange={(event) => setIncludeDiagnosticLogs(event.target.checked)}
                />
                <span>Include diagnostic logs</span>
              </label>
              <InfoTooltip
                align="left"
                content={<span>Attaches recent app logs after masking secrets, identities, network addresses, emails, and local paths.</span>}
              >
                <button className={styles.infoButton} type="button" aria-label="About diagnostic logs">
                  <HugeiconsIcon icon={InformationCircleIcon} size={17} strokeWidth={1.8} />
                </button>
              </InfoTooltip>
            </div>

            {attachments.length > 0 && (
              <div className={styles.attachments} aria-label="Attached images">
                {attachments.map((attachment) => (
                  <div className={styles.thumbnail} key={attachment.id}>
                    <img src={attachment.previewUrl} alt={attachment.name} />
                    <button
                      aria-label={`Remove ${attachment.name}`}
                      disabled={submitting}
                      type="button"
                      onClick={() => setAttachments((current) => current.filter((item) => item.id !== attachment.id))}
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}

            {!configured && <p className={styles.unavailable}>Feedback is unavailable in this source build. Configure the Telegram feedback environment variables to enable it.</p>}
            {error && <p className={styles.submitError} role="alert">{error}</p>}
          </div>

          <div className={styles.footer}>
            <input
              ref={fileInputRef}
              accept={FEEDBACK_IMAGE_MIME_TYPES.join(',')}
              className={styles.fileInput}
              disabled={submitting}
              multiple
              type="file"
              onChange={(event) => {
                void addFiles(Array.from(event.target.files ?? []));
                event.target.value = '';
              }}
            />
            <Button
              className={styles.attachButton}
              disabled={submitting}
              leadingIcon={<HugeiconsIcon icon={Attachment02Icon} size={20} strokeWidth={1.8} />}
              variant="outline"
              onClick={() => fileInputRef.current?.click()}
            >
              Attach image
            </Button>
            <Button className={styles.submitButton} disabled={!canSubmit} type="submit">
              {submitting ? <><span className={styles.spinner} /> Sending…</> : <>Send Feedback <kbd>{shortcutModifier}</kbd><kbd>↵</kbd></>}
            </Button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
