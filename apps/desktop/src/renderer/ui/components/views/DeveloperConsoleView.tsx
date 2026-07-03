import type { ViewName } from '../../types';

type Props = {
  onSelectView?: (view: ViewName) => void;
};

const developerRoutes: Array<{ view: ViewName; label: string }> = [
  { view: 'overview', label: 'Overview' },
  { view: 'peers', label: 'Peers' },
  { view: 'connection', label: 'Connection' },
  { view: 'desktop', label: 'Logs' },
  { view: 'config', label: 'Config' },
  { view: 'system-proxy', label: 'System Proxy' },
];

export function DeveloperConsoleView({ onSelectView }: Props) {
  return (
    <section className={`view view-developer`} role="tabpanel">
      <div className="page-header">
        <h2>Developer Console</h2>
      </div>
      <div className="panel-grid">
        {developerRoutes.map((route) => (
          <button key={route.view} type="button" onClick={() => onSelectView?.(route.view)}>
            {route.label}
          </button>
        ))}
      </div>
    </section>
  );
}
