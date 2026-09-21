import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '../App';
import { installDashboardTransport } from '../runtime';
import { hostedConfig } from './config';
import { HostedRuntime } from './runtime';
import '../styles.scss';

const root = document.getElementById('root');
if (!root) throw new Error('Dashboard root is missing.');

try {
  const { chain, projectId } = hostedConfig(import.meta.env);
  let storage: Storage | null = null;
  try { storage = window.localStorage; } catch {}
  let tabId: string = crypto.randomUUID();
  try {
    tabId = window.sessionStorage.getItem('ants.hosted.tab') ?? tabId;
    window.sessionStorage.setItem('ants.hosted.tab', tabId);
  } catch {}
  installDashboardTransport(new HostedRuntime(chain, projectId, storage, navigator.locks, tabId));
  if (!window.location.hash) window.history.replaceState(null, '', '#/stake');
  createRoot(root).render(<StrictMode><App /></StrictMode>);
} catch (error) {
  root.textContent = `Dashboard configuration error: ${error instanceof Error ? error.message : String(error)}`;
}
