export type BadgeTone = 'active' | 'idle' | 'warn' | 'bad';

export type RendererElements = {
  connectState: HTMLElement | null;
  dashboardState: HTMLElement | null;
  connectBadge: HTMLElement | null;
  runtimeActivity: HTMLElement | null;
  dashboardBadge: HTMLElement | null;
  connectWarning: HTMLElement | null;
  daemonState: HTMLElement | null;
  logs: HTMLElement | null;

  connectRouter: HTMLInputElement | null;
  dashboardPort: HTMLInputElement | null;

  pluginSetupCard: HTMLElement | null;
  pluginSetupStatus: HTMLElement | null;
  refreshPluginsBtn: HTMLButtonElement | null;
  installConnectPluginBtn: HTMLButtonElement | null;

  overviewBadge: HTMLElement | null;
  ovNodeState: HTMLElement | null;
  ovPeers: HTMLElement | null;
  ovDhtHealth: HTMLElement | null;
  ovUptime: HTMLElement | null;
  ovPeersCount: HTMLElement | null;
  overviewPeersBody: HTMLElement | null;

  peersMeta: HTMLElement | null;
  peersMessage: HTMLElement | null;
  peersBody: HTMLElement | null;
  peersHead: HTMLElement | null;
  peerFilter: HTMLInputElement | null;

  chatModelSelect: HTMLSelectElement | HTMLInputElement | null;
  chatModelStatus: HTMLElement | null;
  chatProxyStatus: HTMLElement | null;
  chatNewBtn: HTMLButtonElement | null;
  chatConversations: HTMLElement | null;
  chatHeader: HTMLElement | null;
  chatThreadMeta: HTMLElement | null;
  chatDeleteBtn: HTMLButtonElement | null;
  chatMessages: HTMLElement | null;
  chatInput: HTMLTextAreaElement | HTMLInputElement | null;
  chatSendBtn: HTMLButtonElement | null;
  chatAbortBtn: HTMLButtonElement | null;
  chatError: HTMLElement | null;
  chatStreamingIndicator: HTMLElement | null;

  connectionMeta: HTMLElement | null;
  connectionStatus: HTMLElement | null;
  connectionNetwork: HTMLElement | null;
  connectionSources: HTMLElement | null;
  connectionNotes: HTMLElement | null;

  configMeta: HTMLElement | null;
  configMessage: HTMLElement | null;
  configSaveBtn: HTMLButtonElement | null;
  cfgProxyPort: HTMLInputElement | null;
  cfgPreferredProviders: HTMLInputElement | null;
  cfgBuyerMaxInputUsdPerMillion: HTMLInputElement | null;
  cfgBuyerMaxOutputUsdPerMillion: HTMLInputElement | null;
  cfgMinRep: HTMLInputElement | null;
  cfgPaymentMethod: HTMLInputElement | HTMLSelectElement | null;

  overviewDataSources: HTMLElement | null;
};

function byId<T extends Element = HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

export function createRendererElements(): RendererElements {
  return {
    connectState: byId('connectState'),
    dashboardState: byId('dashboardState'),
    connectBadge: byId('connectBadge'),
    runtimeActivity: byId('runtimeActivity'),
    dashboardBadge: byId('dashboardBadge'),
    connectWarning: byId('connectWarning'),
    daemonState: byId('daemonState'),
    logs: byId('logs'),

    connectRouter: byId<HTMLInputElement>('connectRouter'),
    dashboardPort: byId<HTMLInputElement>('dashboardPort'),

    pluginSetupCard: byId('pluginSetupCard'),
    pluginSetupStatus: byId('pluginSetupStatus'),
    refreshPluginsBtn: byId<HTMLButtonElement>('refreshPluginsBtn'),
    installConnectPluginBtn: byId<HTMLButtonElement>('installConnectPluginBtn'),

    overviewBadge: byId('overviewBadge'),
    ovNodeState: byId('ovNodeState'),
    ovPeers: byId('ovPeers'),
    ovDhtHealth: byId('ovDhtHealth'),
    ovUptime: byId('ovUptime'),
    ovPeersCount: byId('ovPeersCount'),
    overviewPeersBody: byId('overviewPeersBody'),

    peersMeta: byId('peersMeta'),
    peersMessage: byId('peersMessage'),
    peersBody: byId('peersBody'),
    peersHead: byId('peersHead'),
    peerFilter: byId<HTMLInputElement>('peerFilter'),

    chatModelSelect: byId<HTMLSelectElement>('chatModelSelect'),
    chatModelStatus: byId('chatModelStatus'),
    chatProxyStatus: byId('chatProxyStatus'),
    chatNewBtn: byId<HTMLButtonElement>('chatNewBtn'),
    chatConversations: byId('chatConversations'),
    chatHeader: byId('chatHeader'),
    chatThreadMeta: byId('chatThreadMeta'),
    chatDeleteBtn: byId<HTMLButtonElement>('chatDeleteBtn'),
    chatMessages: byId('chatMessages'),
    chatInput: byId<HTMLTextAreaElement>('chatInput') ?? byId<HTMLInputElement>('chatInput'),
    chatSendBtn: byId<HTMLButtonElement>('chatSendBtn'),
    chatAbortBtn: byId<HTMLButtonElement>('chatAbortBtn'),
    chatError: byId('chatError'),
    chatStreamingIndicator: byId('chatStreamingIndicator'),

    connectionMeta: byId('connectionMeta'),
    connectionStatus: byId('connectionStatus'),
    connectionNetwork: byId('connectionNetwork'),
    connectionSources: byId('connectionSources'),
    connectionNotes: byId('connectionNotes'),

    configMeta: byId('configMeta'),
    configMessage: byId('configMessage'),
    configSaveBtn: byId<HTMLButtonElement>('configSaveBtn'),
    cfgProxyPort: byId<HTMLInputElement>('cfgProxyPort'),
    cfgPreferredProviders: byId<HTMLInputElement>('cfgPreferredProviders'),
    cfgBuyerMaxInputUsdPerMillion: byId<HTMLInputElement>('cfgBuyerMaxInputUsdPerMillion'),
    cfgBuyerMaxOutputUsdPerMillion: byId<HTMLInputElement>('cfgBuyerMaxOutputUsdPerMillion'),
    cfgMinRep: byId<HTMLInputElement>('cfgMinRep'),
    cfgPaymentMethod: byId<HTMLSelectElement>('cfgPaymentMethod') ?? byId<HTMLInputElement>('cfgPaymentMethod'),

    overviewDataSources: byId('overviewDataSources'),
  };
}

export function setText(el: Element | null | undefined, value: string): void {
  if (el) {
    el.textContent = value;
  }
}

export function setBadgeTone(el: Element | null | undefined, tone: BadgeTone, label: string): void {
  if (!el) return;
  el.classList.remove('badge-active', 'badge-idle', 'badge-warn', 'badge-bad');
  el.classList.add(`badge-${tone}`);
  el.textContent = label;
}
