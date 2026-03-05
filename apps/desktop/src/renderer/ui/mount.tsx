import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { AppShell } from './AppShell';

let root: Root | null = null;

export function mountAppShell(): void {
  const container = document.getElementById('root');
  if (!container) {
    throw new Error('Renderer root container "#root" was not found.');
  }

  if (!root) {
    root = createRoot(container);
  }

  flushSync(() => {
    root?.render(<AppShell />);
  });
}
