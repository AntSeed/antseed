import { createPortal } from 'react-dom';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import styles from './AttachmentViewer.module.scss';

/**
 * Attachment that can be previewed. Shape is intentionally permissive so this
 * works for both composer chips (raw base64 data URLs) and chat-history file
 * blocks (PreparedChatAttachment, which has `image.data` for images and
 * `text` for parsed text/PDF content).
 */
export type ViewerAttachment = {
  name: string;
  mimeType: string;
  size?: number;
  /** Full data URL (e.g. "data:image/png;base64,...") — used by composer chips. */
  dataUrl?: string;
  /** Image base64 body (no "data:" prefix) — from PreparedChatAttachment. */
  imageBase64?: string;
  imageMimeType?: string;
  /** Extracted text (PDFs, docx, source, etc.). */
  text?: string;
  truncated?: boolean;
  error?: string;
};

type AttachmentViewerProps = {
  attachment: ViewerAttachment;
  onClose: () => void;
};

const MAX_TEXT_PREVIEW_CHARS = 200_000;

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

function isPdfMime(mimeType: string | undefined): boolean {
  return mimeType?.toLowerCase() === 'application/pdf';
}

function buildImageSrc(att: ViewerAttachment): string | null {
  if (att.dataUrl && att.dataUrl.startsWith('data:')) return att.dataUrl;
  if (att.imageBase64 && att.imageMimeType) {
    return `data:${att.imageMimeType};base64,${att.imageBase64}`;
  }
  // If dataUrl is a raw base64 body but mime is image/*, fall back
  if (att.dataUrl && isImageMime(att.mimeType)) {
    return att.dataUrl.startsWith('data:') ? att.dataUrl : `data:${att.mimeType};base64,${att.dataUrl}`;
  }
  return null;
}

/**
 * Build a download URL for the attachment. When `isBlob` is true the caller
 * owns the URL and must `URL.revokeObjectURL` it when no longer needed.
 */
function buildDownloadHref(att: ViewerAttachment): { href: string; isBlob: boolean } | null {
  if (att.dataUrl && att.dataUrl.startsWith('data:')) return { href: att.dataUrl, isBlob: false };
  const imgSrc = buildImageSrc(att);
  if (imgSrc) return { href: imgSrc, isBlob: false };
  if (typeof att.text === 'string' && att.text.length > 0) {
    const encoded = new Blob([att.text], { type: 'text/plain;charset=utf-8' });
    return { href: URL.createObjectURL(encoded), isBlob: true };
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

  const download = useMemo(() => buildDownloadHref(attachment), [attachment]);
  useEffect(() => {
    if (!download?.isBlob) return;
    return () => {
      URL.revokeObjectURL(download.href);
    };
  }, [download]);

  const imgSrc = isImageMime(attachment.mimeType) ? buildImageSrc(attachment) : null;
  const pdfSrc = isPdfMime(attachment.mimeType) && attachment.dataUrl?.startsWith('data:')
    ? attachment.dataUrl
    : null;
  const textPreview = attachment.text
    ? attachment.text.length > MAX_TEXT_PREVIEW_CHARS
      ? `${attachment.text.slice(0, MAX_TEXT_PREVIEW_CHARS)}\n\n... (truncated for preview)`
      : attachment.text
    : null;

  const metaParts = [attachment.mimeType, formatSize(attachment.size), attachment.truncated ? 'truncated' : '']
    .filter(Boolean)
    .join(' · ');

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
            {download && (
              <a
                className={styles.downloadBtn}
                href={download.href}
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
          ) : pdfSrc ? (
            <iframe
              title={attachment.name}
              src={pdfSrc}
              className={styles.pdfFrame}
            />
          ) : textPreview ? (
            <pre className={styles.textPreview}>{textPreview}</pre>
          ) : (
            <div className={styles.emptyMsg}>
              No inline preview available for this file type.
              {download ? ' Use Download to save the file.' : ''}
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
