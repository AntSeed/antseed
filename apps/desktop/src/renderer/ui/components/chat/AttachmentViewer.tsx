import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './AttachmentViewer.module.scss';

/**
 * Attachment that can be previewed. Currently scoped to images (composer
 * uploads pre-send, and image blocks in chat history). Non-image file
 * previews are intentionally out of scope here — they're planned as a
 * follow-up that stores raw bytes on disk and uses a custom Electron
 * protocol so the browser engine can render them natively.
 */
export type ViewerAttachment = {
  name: string;
  mimeType: string;
  size?: number;
  /** Full data URL (e.g. "data:image/png;base64,...") — used by composer chips. */
  dataUrl?: string;
  /** Image base64 body (no "data:" prefix) — from ContentBlock.image source. */
  imageBase64?: string;
  imageMimeType?: string;
  error?: string;
};

type AttachmentViewerProps = {
  attachment: ViewerAttachment;
  onClose: () => void;
};

function formatSize(bytes: number | undefined): string {
  if (typeof bytes !== 'number' || !Number.isFinite(bytes)) return '';
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
  return `${(mb / 1024).toFixed(1)} GB`;
}

function isImageMime(mimeType: string | undefined): boolean {
  return Boolean(mimeType && mimeType.toLowerCase().startsWith('image/'));
}

function buildImageSrc(att: ViewerAttachment): string | null {
  if (att.dataUrl && att.dataUrl.startsWith('data:')) return att.dataUrl;
  if (att.imageBase64 && att.imageMimeType) {
    return `data:${att.imageMimeType};base64,${att.imageBase64}`;
  }
  return null;
}

export function AttachmentViewer({ attachment, onClose }: AttachmentViewerProps) {
  const [closing, setClosing] = useState(false);
  const closeTimerRef = useRef<ReturnType<typeof window.setTimeout> | null>(null);

  const close = useCallback(() => {
    setClosing(true);
    if (closeTimerRef.current !== null) window.clearTimeout(closeTimerRef.current);
    closeTimerRef.current = window.setTimeout(onClose, 180);
  }, [onClose]);

  useEffect(() => {
    return () => {
      if (closeTimerRef.current !== null) {
        window.clearTimeout(closeTimerRef.current);
        closeTimerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const handleKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [close]);

  const imgSrc = useMemo(
    () => (isImageMime(attachment.mimeType) ? buildImageSrc(attachment) : null),
    [attachment],
  );
  const downloadHref = imgSrc;

  const metaParts = [attachment.mimeType, formatSize(attachment.size)].filter(Boolean).join(' · ');

  return createPortal(
    <div
      className={`${styles.backdrop}${closing ? ` ${styles.closing}` : ''}`}
      onClick={close}
      role="presentation"
    >
      <div
        className={styles.panel}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={attachment.name}
      >
        <div className={styles.header}>
          <div className={styles.titleGroup}>
            <div className={styles.name} title={attachment.name}>{attachment.name}</div>
            {metaParts && <div className={styles.meta}>{metaParts}</div>}
          </div>
          <div className={styles.actions}>
            {downloadHref && (
              <a
                className={styles.downloadBtn}
                href={downloadHref}
                download={attachment.name || 'attachment'}
                title="Download"
              >
                Download
              </a>
            )}
            <button type="button" className={styles.closeBtn} onClick={close} aria-label="Close">
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
                <path d="M1 1l12 12M13 1L1 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
              </svg>
            </button>
          </div>
        </div>
        <div className={styles.body}>
          {attachment.error ? (
            <div className={styles.errorMsg}>{attachment.error}</div>
          ) : imgSrc ? (
            <div className={styles.imageWrap}>
              <img src={imgSrc} alt={attachment.name} className={styles.image} />
            </div>
          ) : (
            <div className={styles.emptyMsg}>No inline preview available for this file type.</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
