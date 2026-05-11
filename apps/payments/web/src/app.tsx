import { useBalance, useConfig } from './hooks/queries';
import { AppShell } from './components/layout/app-shell';
import { SessionExpiredOverlay } from './components/modals/session-expired-overlay';

export function App() {
  const { data: balance = null, isFetched: balanceFetched } = useBalance();
  const { data: config = null } = useConfig();
  return (
    <>
      <AppShell balance={balance} balanceLoaded={balanceFetched} config={config} />
      <SessionExpiredOverlay />
    </>
  );
}
