import { useBodyScrollLock } from '../hooks/useBodyScrollLock';

interface LoaderOverlayProps {
  isVisible: boolean;
}

export function LoaderOverlay({ isVisible }: LoaderOverlayProps) {
  useBodyScrollLock(isVisible);

  if (!isVisible) return null;

  return (
    <div className="loader-overlay" role="status" aria-live="polite" aria-label="Loading">
      <div className="loader-overlay-card">
        <div className="loader-overlay-spinner" />
      </div>
    </div>
  );
}
