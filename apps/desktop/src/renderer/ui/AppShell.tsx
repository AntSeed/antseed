import { useCallback, useEffect, useRef, useState } from 'react';
import { ViewHost } from './components/ViewHost';
import { SetupScreen } from './components/SetupScreen';
import { preloadViews, viewsForPreload } from './components/viewRegistry';
import { shallowEqual, useUiSelector } from './hooks/useUiSelector';
import { VIEW_NAMES, type ViewName } from './types';
import { VprShell } from './components/VprShell';

type IdleCallbackHandle = ReturnType<typeof setTimeout> | number;

function scheduleRoutePreload(callback: () => void): () => void {
  const win = window as unknown as {
    requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (win.requestIdleCallback) {
    const handle = win.requestIdleCallback(callback, { timeout: 1_500 });
    return () => win.cancelIdleCallback?.(handle);
  }

  const handle: IdleCallbackHandle = window.setTimeout(callback, 250);
  return () => window.clearTimeout(handle);
}

export function AppShell() {
  const snap = useUiSelector((state) => ({
    appSetupStatusKnown: state.appSetupStatusKnown,
    appSetupNeeded: state.appSetupNeeded,
    appSetupComplete: state.appSetupComplete,
    chatServiceCount: state.chatServiceOptions.length,
    chatPanelExpanded: state.chatPanelExpanded,
  }), shallowEqual);
  const [activeView, setActiveView] = useState<ViewName>('home');
  const [setupVisible, setSetupVisible] = useState(false);
  const [setupDismissed, setSetupDismissed] = useState(false);
  const activeViewRef = useRef<ViewName>('home');
  const depositReturnViewRef = useRef<ViewName>('credits');

  const handleSelectView = useCallback((view: ViewName) => {
    const current = activeViewRef.current;
    if (view === current) return;
    if (view === 'deposit') depositReturnViewRef.current = current;
    activeViewRef.current = view;
    setActiveView(view);
  }, []);

  const handleLeaveDeposit = useCallback(() => {
    const target = depositReturnViewRef.current;
    activeViewRef.current = target;
    setActiveView(target);
  }, []);

  const hasServices = snap.chatServiceCount > 0;

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

    // The setup screen is a first-run bootstrap aid, not a hard gate. If the
    // buyer runtime later starts successfully and services load, let the user
    // into the app even if plugin setup reported a transient repair/install
    // failure. This prevents a stale "Failed to install router plugin" status
    // from covering a now-usable desktop session.
    if (hasServices) {
      const timer = setTimeout(() => {
        setSetupVisible(false);
        setSetupDismissed(true);
      }, 900);
      return () => clearTimeout(timer);
    }

    if (!snap.appSetupComplete) {
      setSetupVisible(true);
      return;
    }

    setSetupVisible(true);
  }, [snap.appSetupStatusKnown, snap.appSetupNeeded, snap.appSetupComplete, hasServices, setupDismissed]);

  const showSetup = setupVisible;

  useEffect(() => {
    return window.antseedDesktop?.onNavigateView?.((viewName) => {
      if (!(VIEW_NAMES as readonly string[]).includes(viewName)) return;
      handleSelectView(viewName as ViewName);
    });
  }, [handleSelectView]);

  useEffect(() => {
    if (showSetup) return undefined;

    void preloadViews(viewsForPreload('eager'));

    return scheduleRoutePreload(() => {
      void preloadViews(viewsForPreload('idle'));
    });
  }, [showSetup]);

  useEffect(() => {
    if (showSetup) return;
    // Chat supports both window sizes: thin by default, expanded to the
    // standard preset when the user opens the conversation-list panel.
    if (activeView === 'chat' && snap.chatPanelExpanded) {
      void window.antseedDesktop?.applyWindowPreset?.('standard');
      return;
    }
    void window.antseedDesktop?.applyWindowView?.(activeView);
  }, [activeView, showSetup, snap.chatPanelExpanded]);

  if (showSetup) {
    return <SetupScreen />;
  }

  return (
    <VprShell
      activeView={activeView}
      onSelectView={handleSelectView}
      onLeaveDeposit={handleLeaveDeposit}
    >
      <ViewHost activeView={activeView} onSelectView={handleSelectView} />
    </VprShell>
  );
}
