import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { VprBackTitle, VprCard } from '../vpr/VprKit';
import styles from './DiagnosticsView.module.scss';

type ConnectionViewProps = {
  onSelectView?: (view: import('../../types').ViewName) => void;
};

export function ConnectionView({ onSelectView }: ConnectionViewProps) {
  const { connectionMeta, connectionStatus, connectionNetwork, connectionSources, connectionNotes } =
    useUiSelector((state) => ({
      connectionMeta: state.connectionMeta,
      connectionStatus: state.connectionStatus,
      connectionNetwork: state.connectionNetwork,
      connectionSources: state.connectionSources,
      connectionNotes: state.connectionNotes,
    }), shallowEqual);

  const badgeTone = styles[`badge_${connectionMeta.tone}`] ?? '';

  const sections: Array<{ title: string; body: string }> = [
    { title: 'Node status', body: connectionStatus },
    { title: 'Network stats', body: connectionNetwork },
    { title: 'Data sources', body: connectionSources },
    { title: 'Connection notes', body: connectionNotes },
  ];

  return (
    <section className={`view view-connection ${styles.view}`} role="tabpanel">
      <div className={styles.stack}>
        <div className={styles.headRow}>
          <VprBackTitle title="Connection" fallback="help" />
          <span className={`${styles.badge} ${badgeTone}`}>{connectionMeta.label}</span>
        </div>

        {sections.map((section) => (
          <VprCard key={section.title} className={styles.card}>
            <span className={styles.cardTitle}>{section.title}</span>
            <pre className={styles.pre}>{section.body}</pre>
          </VprCard>
        ))}
      </div>
    </section>
  );
}
