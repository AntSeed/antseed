import { createRoot } from 'react-dom/client';
import { App } from './app';
import { Providers } from './providers';
import '@rainbow-me/rainbowkit/styles.css';
import './global.scss';

const root = document.getElementById('root')!;
createRoot(root).render(
  <Providers>
    <App />
  </Providers>
);
