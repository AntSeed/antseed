import { createRoot } from 'react-dom/client';
import { FloatApp } from './ui/float/FloatApp';
import { initThemeMode } from './ui/lib/theme';

// The floating pill lives in a transparent frameless window; strip the app
// background so only the pill itself paints.
document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';

// Match the main window's light/dark mode (and follow live changes).
initThemeMode();

const container = document.getElementById('root');
if (!container) {
  throw new Error('Float root container "#root" was not found.');
}

createRoot(container).render(<FloatApp />);
