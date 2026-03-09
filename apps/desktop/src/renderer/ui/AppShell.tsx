import { useEffect, useState, useCallback } from 'react';
import { Sidebar } from './components/Sidebar';
import { StreamingIndicator } from './components/StreamingIndicator';
import { TitleBar } from './components/TitleBar';
import { ViewHost } from './components/ViewHost';
import { DiscoverWelcome } from './components/chat/DiscoverWelcome';
import { SetupScreen } from './components/SetupScreen';
import { useUiSnapshot } from './hooks/useUiSnapshot';
import { useActions } from './hooks/useActions';
import type { ViewName } from './types';

export function AppShell() {
  const snap = useUiSnapshot();
  const actions = useActions();
  const [activeView, setActiveView] = useState<ViewName>('chat');
  const [onboardingDismissed, setOnboardingDismissed] = useState(false);
  const [setupVisible, setSetupVisible] = useState(false);

  const hasModels = snap.chatModelOptions.length > 0;

  // Show setup screen while needed; hide once plugin installed and models are available.
  // Gate on appSetupStatusKnown so we don't briefly flash the normal app shell before
  // the IPC round-trip resolves and reveals that setup is actually required.
  useEffect(() => {
    if (!snap.appSetupStatusKnown) return;
    if (!snap.appSetupNeeded) {
      setSetupVisible(false);
      return;
    }
    if (!snap.appSetupComplete || !hasModels) {
      setSetupVisible(true);
    } else {
      const timer = setTimeout(() => setSetupVisible(false), 900);
      return () => clearTimeout(timer);
    }
  }, [snap.appSetupStatusKnown, snap.appSetupNeeded, snap.appSetupComplete, hasModels]);

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
    (modelValue: string) => {
      actions.handleModelChange(modelValue);
      actions.startNewChat();
      setOnboardingDismissed(true);
      setActiveView('chat');
    },
    [actions],
  );

  if (showSetup || !snap.appSetupStatusKnown || !snap.chatConversationsLoaded) {
    return <SetupScreen />;
  }

  if (showOnboarding) {
    return (
      <>
        <TitleBar />
        <div className="app-container">
          <main className="main-content">
            <DiscoverWelcome
              modelOptions={snap.chatModelOptions}
              onStartChatting={handleStartChatting}
            />
          </main>
        </div>
        <StreamingIndicator />
      </>
    );
  }

  return (
    <>
      <TitleBar />
      <div className="app-container">
        <Sidebar activeView={activeView} onSelectView={setActiveView} />
        <main className="main-content">
          <ViewHost activeView={activeView} />
        </main>
      </div>
      <StreamingIndicator />
    </>
  );
}
