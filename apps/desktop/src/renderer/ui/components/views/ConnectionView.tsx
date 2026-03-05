import { memo } from 'react';

type ConnectionViewProps = {
  active: boolean;
};

const ConnectionContent = memo(function ConnectionContent() {
  return (
    <>
      <div className="page-header">
        <h2>Connection</h2>
        <div id="connectionMeta" className="connection-badge badge-idle">
          No data
        </div>
      </div>
      <div className="panel-grid two-col">
        <article className="panel">
          <div className="panel-head">
            <h3>Node Status</h3>
          </div>
          <pre id="connectionStatus">No status data.</pre>
        </article>
        <article className="panel">
          <div className="panel-head">
            <h3>Network Stats</h3>
          </div>
          <pre id="connectionNetwork">No network stats.</pre>
        </article>
        <article className="panel">
          <div className="panel-head">
            <h3>Data Sources</h3>
          </div>
          <pre id="connectionSources">No data source info.</pre>
        </article>
        <article className="panel">
          <div className="panel-head">
            <h3>Connection Notes</h3>
          </div>
          <pre id="connectionNotes">No notes.</pre>
        </article>
      </div>
    </>
  );
});

export function ConnectionView({ active }: ConnectionViewProps) {
  return (
    <section id="view-connection" className={`view${active ? ' active' : ''}`} role="tabpanel">
      <ConnectionContent />
    </section>
  );
}
