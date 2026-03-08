import type { RendererUiState } from '../core/state';
import { notifyUiStateChanged } from '../core/store';
import type { DesktopBridge } from '../types/bridge';

type AppSetupModuleOptions = {
  uiState: RendererUiState;
  bridge: DesktopBridge | null;
};

export function initAppSetupModule({ uiState, bridge }: AppSetupModuleOptions) {
  if (!bridge) return;

  // Query initial status — if plugin was already installed this returns
  // needed:false and the setup screen never shows.
  void bridge.getAppSetupStatus?.().then((status) => {
    uiState.appSetupNeeded = status.needed;
    uiState.appSetupComplete = status.complete;
    notifyUiStateChanged();
  });

  bridge.onAppSetupStep?.((data) => {
    uiState.appSetupStep = data.label;
    notifyUiStateChanged();
  });

  bridge.onAppSetupComplete?.(() => {
    uiState.appSetupComplete = true;
    notifyUiStateChanged();

    // Auto-start connect so the setup screen can show DHT/peer/model progress.
    void bridge.start?.({
      mode: 'connect',
      router: 'local',
    }).catch(() => {
      // Error is handled / logged by the runtime module.
    });
  });
}
