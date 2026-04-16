import { useEffect } from 'react';

interface LoaderOverlayProps {
  isVisible: boolean;
}

export function LoaderOverlay({ isVisible }: LoaderOverlayProps) {
  useEffect(() => {
    if (!isVisible) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [isVisible]);

  if (!isVisible) return null;

  return (
    <div className="loader-overlay" role="status" aria-live="polite" aria-label="Loading">
      <div className="loader-overlay-card">
        <div className="loader-overlay-spinner" />
      </div>
    </div>
  );
}
