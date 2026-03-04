import { createRoot } from 'react-dom/client';
import { AppShell } from './AppShell';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Renderer root #root was not found');
}

createRoot(container).render(<AppShell />);
