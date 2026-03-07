import { useUiSnapshot } from '../../hooks/useUiSnapshot';

type ConnectionViewProps = {
  active: boolean;
};

export function ConnectionView({ active }: ConnectionViewProps) {
  const { connectionMeta, connectionStatus, connectionNetwork, connectionSources, connectionNotes } =
    useUiSnapshot();

  return (
    <section className={`view${active ? ' active' : ''}`} role="tabpanel">
      <div className="page-header">
        <h2>Connection</h2>
        <div className={`connection-badge badge-${connectionMeta.tone}`}>{connectionMeta.label}</div>
      </div>
      <div className="panel-grid two-col">
        <article className="panel">
          <div className="panel-head">
            <h3>Node Status</h3>
          </div>
          <pre>{connectionStatus}</pre>
        </article>
        <article className="panel">
          <div className="panel-head">
            <h3>Network Stats</h3>
          </div>
          <pre>{connectionNetwork}</pre>
        </article>
        <article className="panel">
          <div className="panel-head">
            <h3>Data Sources</h3>
          </div>
          <pre>{connectionSources}</pre>
        </article>
        <article className="panel">
          <div className="panel-head">
            <h3>Connection Notes</h3>
          </div>
          <pre>{connectionNotes}</pre>
        </article>
      </div>
    </section>
  );
}
