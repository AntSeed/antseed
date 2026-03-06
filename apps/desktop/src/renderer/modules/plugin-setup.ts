import type { DesktopBridge, LogEvent, PluginInfo } from '../types/bridge';
import type { RendererUiState } from '../core/state';
import { notifyUiStateChanged } from '../core/store';
import {
  DEFAULT_ROUTER_RUNTIME,
  ROUTER_PACKAGE_ALIASES,
} from '../core/constants';
import { safeArray, safeString } from '../core/safe';

type PluginSetupModuleOptions = {
  bridge?: DesktopBridge;
  uiState: RendererUiState;
  appendSystemLog: (message: string) => void;
};

function normalizePluginSlug(value: unknown, fallback: string): string {
  const raw = safeString(value, fallback).trim().toLowerCase();
  const slug = raw.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  return slug || fallback;
}

export function normalizeRouterRuntime(value: unknown): string {
  const raw = safeString(value, DEFAULT_ROUTER_RUNTIME).trim().toLowerCase();
  if (!raw) return DEFAULT_ROUTER_RUNTIME;

  if (
    raw === 'claude-code' ||
    raw === '@antseed/router-local' ||
    raw === 'antseed-router-claude-code' ||
    raw === 'antseed-router-local'
  ) {
    return 'local';
  }

  return raw;
}

export function resolveRouterPackageName(value: unknown): string {
  const raw = safeString(value, DEFAULT_ROUTER_RUNTIME).trim().toLowerCase();
  if (!raw) return ROUTER_PACKAGE_ALIASES[DEFAULT_ROUTER_RUNTIME];
  if (ROUTER_PACKAGE_ALIASES[raw]) return ROUTER_PACKAGE_ALIASES[raw];
  if (raw.startsWith('@')) return raw;
  if (raw.startsWith('router-')) return `@antseed/${raw}`;
  return `@antseed/router-${normalizePluginSlug(raw, DEFAULT_ROUTER_RUNTIME)}`;
}

function toInstalledPluginSet(plugins: unknown): Set<string> {
  const entries = safeArray<PluginInfo>(plugins)
    .map((plugin) => safeString(plugin?.package, ''))
    .filter(Boolean);
  return new Set(entries);
}

function extractMissingPluginPackage(logLine: unknown): string | null {
  const match = /Plugin\s+"([^"]+)"\s+not found/i.exec(safeString(logLine, ''));
  return match?.[1]?.trim() || null;
}

export function initPluginSetupModule({
  bridge,
  uiState,
  appendSystemLog,
}: PluginSetupModuleOptions) {
  function expectedRouterPluginPackage(): string {
    return resolveRouterPackageName(uiState.connectRouterValue);
  }

  function clearRouterPluginHint(): void {
    uiState.pluginHints.router = null;
    notifyUiStateChanged();
  }

  function clearAllPluginHints(): void {
    clearRouterPluginHint();
    notifyUiStateChanged();
  }

  function updatePluginHintFromLog(event: Partial<LogEvent> | null | undefined): void {
    const pkg = extractMissingPluginPackage(event?.line);
    if (!pkg) return;

    if (event?.mode === 'connect') {
      uiState.pluginHints.router = resolveRouterPackageName(pkg);
      return;
    }

    if (pkg.includes('-router-') || pkg.includes('/router-')) {
      uiState.pluginHints.router = resolveRouterPackageName(pkg);
    }
  }

  function renderPluginSetupState(): void {
    const expectedRouter = uiState.pluginHints.router || expectedRouterPluginPackage();
    const installedRouter = uiState.installedPlugins.has(expectedRouter);
    const missing: string[] = [];
    if (!installedRouter) missing.push(expectedRouter);

    uiState.pluginSetupStatus =
      missing.length === 0
        ? 'Required runtime plugins are installed.'
        : `Missing plugin${missing.length > 1 ? 's' : ''}: ${missing.join(', ')}`;

    uiState.pluginInstallBtnLabel = installedRouter
      ? `Buyer Ready (${expectedRouter})`
      : `Install ${expectedRouter}`;
    uiState.pluginInstallBtnDisabled =
      uiState.pluginInstallBusy || installedRouter || !bridge?.pluginsInstall;
    uiState.pluginRefreshBtnDisabled = uiState.pluginInstallBusy || !bridge?.pluginsList;

    notifyUiStateChanged();
  }

  async function refreshPluginInventory(): Promise<void> {
    if (!bridge?.pluginsList) return;

    const result = await bridge.pluginsList();
    if (!result?.ok) throw new Error(result?.error || 'Failed to read installed plugins');

    uiState.installedPlugins = toInstalledPluginSet(result.plugins);
    renderPluginSetupState();
  }

  async function installPluginPackage(packageName: string): Promise<void> {
    if (!bridge?.pluginsInstall) throw new Error('Plugin installer is unavailable in this build');

    uiState.pluginInstallBusy = true;
    renderPluginSetupState();

    try {
      const result = await bridge.pluginsInstall(packageName);
      if (!result?.ok) throw new Error(result?.error || `Failed to install ${packageName}`);

      uiState.installedPlugins = toInstalledPluginSet(result.plugins);
      appendSystemLog(`Installed ${packageName}.`);
      clearAllPluginHints();
      renderPluginSetupState();
    } finally {
      uiState.pluginInstallBusy = false;
      renderPluginSetupState();
    }
  }

  return {
    expectedRouterPluginPackage,
    normalizeRouterRuntime,
    resolveRouterPackageName,
    clearRouterPluginHint,
    clearAllPluginHints,
    updatePluginHintFromLog,
    renderPluginSetupState,
    refreshPluginInventory,
    installPluginPackage,
  };
}
