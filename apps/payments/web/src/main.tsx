import { createRoot } from 'react-dom/client';
import { App } from './App';
import './styles/global.scss';

const root = document.getElementById('root')!;
createRoot(root).render(<App />);
