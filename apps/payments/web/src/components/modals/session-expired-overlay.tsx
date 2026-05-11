import { useEffect, useState } from 'react';

export function SessionExpiredOverlay() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const handler = () => setVisible(true);
    window.addEventListener('antseed:session-expired', handler);
    return () => window.removeEventListener('antseed:session-expired', handler);
  }, []);

  if (!visible) return null;

  return (
    <div className="session-expired-overlay" role="alert">
      <div className="session-expired-card">
        <div className="session-expired-icon">
          <svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
            <circle cx="24" cy="24" r="22" stroke="var(--text-muted)" strokeWidth="2" strokeDasharray="4 3" />
            <path d="M24 14V26" stroke="var(--text-muted)" strokeWidth="2.5" strokeLinecap="round" />
            <circle cx="24" cy="33" r="1.5" fill="var(--text-muted)" />
          </svg>
        </div>
        <h2 className="session-expired-title">Session expired</h2>
        <p className="session-expired-subtitle">
          The payments server was restarted. Please reopen this portal from the desktop app or CLI to get a new session.
        </p>
      </div>
    </div>
  );
}
