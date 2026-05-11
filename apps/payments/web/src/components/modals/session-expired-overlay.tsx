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
    <div
      className="session-expired-overlay"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="session-expired-title"
    >
      <div className="session-expired-card">
        <div className="session-expired-emblem" aria-hidden="true">
          <svg width="84" height="84" viewBox="0 0 84 84" fill="none">
            <circle
              className="session-expired-emblem-orbit"
              cx="42"
              cy="42"
              r="34"
              stroke="currentColor"
              strokeOpacity="0.32"
              strokeWidth="1.2"
              strokeDasharray="8 6"
            >
              <animateTransform
                attributeName="transform"
                type="rotate"
                from="0 42 42"
                to="360 42 42"
                dur="28s"
                repeatCount="indefinite"
              />
            </circle>
            <circle
              cx="42"
              cy="42"
              r="26"
              stroke="currentColor"
              strokeOpacity="0.16"
              strokeWidth="1"
            />
            <circle cx="42" cy="42" r="18" fill="currentColor" fillOpacity="0.12" />
            <path
              d="M42 42 L42 30"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
            />
            <path
              d="M42 42 L52 42"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeOpacity="0.55"
            />
            <circle cx="42" cy="42" r="2" fill="currentColor" />
          </svg>
        </div>

        <div className="session-expired-eyebrow">
          <span className="session-expired-dot" aria-hidden="true" />
          Connection ended
        </div>

        <h2 id="session-expired-title" className="session-expired-title">
          Session expired
        </h2>

        <p className="session-expired-subtitle">
          The payments server was restarted. Reopen this portal from the desktop app
          or CLI to get a new session.
        </p>
      </div>
    </div>
  );
}
