import { createRoot } from 'react-dom/client';
import { VprMenuBarApp } from './ui/menu-bar/VprMenuBarApp';
import { initThemeMode } from './ui/lib/theme';

document.documentElement.style.background = 'transparent';
document.body.style.background = 'transparent';
initThemeMode();

const container = document.getElementById('root');
if (!container) throw new Error('Menu-bar root container "#root" was not found.');
createRoot(container).render(<VprMenuBarApp />);
