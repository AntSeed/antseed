import { createRoot, type Root } from 'react-dom/client';
import { AppShell } from './AppShell';
import { OnchainProviders } from './providers/OnchainProviders';

let root: Root | null = null;

export function mountAppShell(): void {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('Renderer root container "#root" was not found.');
  }

  if (!root) {
    root = createRoot(container);
  }

  root.render(
    <OnchainProviders>
      <AppShell />
    </OnchainProviders>
  );
}
