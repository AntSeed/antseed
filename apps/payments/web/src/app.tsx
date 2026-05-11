import { AppShell } from './components/layout/app-shell';
import { SessionExpiredOverlay } from './components/modals/session-expired-overlay';

export function App() {
  return (
    <>
      <AppShell />
      <SessionExpiredOverlay />
    </>
  );
}
