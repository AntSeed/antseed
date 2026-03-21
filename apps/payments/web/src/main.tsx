import { createRoot } from 'react-dom/client';
import { ThirdwebProvider } from 'thirdweb/react';
import { App } from './App';
import './styles/global.scss';

const root = document.getElementById('root')!;
createRoot(root).render(
  <ThirdwebProvider>
    <App />
  </ThirdwebProvider>
);
