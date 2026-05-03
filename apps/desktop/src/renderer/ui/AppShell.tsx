import { useEffect, useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { ViewHost } from './components/ViewHost';
import { DiscoverWelcome } from './components/chat/DiscoverWelcome';
import { SetupScreen } from './components/SetupScreen';
import { useUiSnapshot } from './hooks/useUiSnapshot';
import { useActions } from './hooks/useActions';
import type { ViewName } from './types';

export function AppShell() {
  const snap = useUiSnapshot();
  const actions = useActions();
  const [activeView, setActiveView] = useState<ViewName>('discover');
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [setupVisible, setSetupVisible] = useState(false);
  const [setupDismissed, setSetupDismissed] = useState(false);

  const hasServices = snap.chatServiceOptions.length > 0;

  // Show setup during first-run plugin/runtime bootstrapping, but never re-open it
  // just because the service catalog is temporarily empty. Service discovery is
  // refreshed periodically and can briefly return zero rows (peer/DHT/RPC timing,
  // signature/payment probe failures, etc.); treating that as setup-required
  // yanks active desktop users back to SetupScreen.
  //
  // Gate on appSetupStatusKnown so we don't briefly flash the normal app shell
  // before the IPC round-trip resolves and reveals that setup is actually needed.
  useEffect(() => {
    if (!snap.appSetupStatusKnown) return;
    if (!snap.appSetupNeeded) {
      setSetupVisible(false);
      setSetupDismissed(true);
      return;
    }
    if (setupDismissed) {
      setSetupVisible(false);
      return;
    }
    if (!snap.appSetupComplete) {
      setSetupVisible(true);
      return;
    }

    // If setup completed before the renderer observed it, keep the setup screen
    // only until the first service catalog arrives. Once hidden, latch it hidden
    // for the rest of the renderer session.
    if (hasServices) {
      const timer = setTimeout(() => {
        setSetupVisible(false);
        setSetupDismissed(true);
      }, 900);
      return () => clearTimeout(timer);
    }

    setSetupVisible(true);
  }, [snap.appSetupStatusKnown, snap.appSetupNeeded, snap.appSetupComplete, hasServices, setupDismissed]);

  const showSetup = setupVisible;

  const hasConversations = Array.isArray(snap.chatConversations) && snap.chatConversations.length > 0;
  const showOnboarding =
    !onboardingDismissed &&
    !hasConversations &&
    !snap.chatActiveConversation &&
    !snap.chatStreamingMessage &&
    !snap.chatSending;

  useEffect(() => {
    if (!snap.devMode && (activeView === 'connection' || activeView === 'peers' || activeView === 'desktop')) {
      setActiveView('overview');
    }
  }, [activeView, snap.devMode]);

  // Re-show onboarding if user deletes all conversations
  useEffect(() => {
    if (hasConversations) setOnboardingDismissed(false);
  }, [hasConversations]);

  const handleStartChatting = useCallback(
    (serviceValue: string, peerId?: string) => {
      actions.startNewChat();
      actions.handleServiceChange(serviceValue, peerId);
      setOnboardingDismissed(true);
      setActiveView('chat');
    },
    [actions],
  );

  if (showSetup) {
    return <SetupScreen />;
  }

  /* if (showOnboarding) {
    return (
      <>
        <TitleBar />
        <div className="app-container">
          <main className="main-content">
            <DiscoverWelcome
              serviceOptions={snap.chatServiceOptions}
              onStartChatting={handleStartChatting}
            />
          </main>
        </div>
      </>
    );
  } */

  return (
    <div className="app-container">
      <Sidebar activeView={activeView} onSelectView={setActiveView} />
      <main className="main-content">
        <ViewHost activeView={activeView} onSelectView={setActiveView} />
      </main>
    </div>
  );
}
