import { memo } from 'react';

type DesktopViewProps = {
  active: boolean;
};

const DesktopContent = memo(function DesktopContent() {
  return (
    <>
      <div className="page-header">
        <h2>Logs</h2>
        <div id="desktopMeta" className="connection-badge badge-idle">
          live stream
        </div>
      </div>

      <pre id="daemonState" hidden></pre>
      <div className="panel-grid">
        <article className="panel">
          <div className="panel-head">
            <h3>Runtime Logs</h3>
          </div>
          <div id="logs" className="logs" aria-live="polite"></div>
        </article>
      </div>
    </>
  );
});

export function DesktopView({ active }: DesktopViewProps) {
  return (
    <section id="view-desktop" className={`view${active ? ' active' : ''}`} role="tabpanel">
      <DesktopContent />
    </section>
  );
}
