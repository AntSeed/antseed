export type BadgeTone = 'active' | 'idle' | 'warn' | 'bad';

export type RendererElements = {
  seedState: HTMLElement | null;
  connectState: HTMLElement | null;
  dashboardState: HTMLElement | null;
  seedBadge: HTMLElement | null;
  connectBadge: HTMLElement | null;
  dashboardBadge: HTMLElement | null;
  connectWarning: HTMLElement | null;
  daemonState: HTMLElement | null;
  logs: HTMLElement | null;

  seedProvider: HTMLInputElement | null;
  seedAuthType: HTMLInputElement | null;
  seedAuthValue: HTMLInputElement | null;
  seedAuthValueLabel: HTMLElement | null;
  connectRouter: HTMLInputElement | null;
  dashboardPort: HTMLInputElement | null;

  pluginSetupCard: HTMLElement | null;
  pluginSetupStatus: HTMLElement | null;
  refreshPluginsBtn: HTMLButtonElement | null;
  installSeedPluginBtn: HTMLButtonElement | null;
  installConnectPluginBtn: HTMLButtonElement | null;

  overviewBadge: HTMLElement | null;
  ovNodeState: HTMLElement | null;
  ovPeers: HTMLElement | null;
  ovSessionsCard: HTMLElement | null;
  ovSessions: HTMLElement | null;
  ovEarnings: HTMLElement | null;
  ovDhtHealth: HTMLElement | null;
  ovUptime: HTMLElement | null;
  ovPeersCount: HTMLElement | null;
  overviewPeersBody: HTMLElement | null;
  capacityArc: HTMLElement | null;
  capacityPercent: HTMLElement | null;
  ovProxyPort: HTMLElement | null;
  ovCapSessions: HTMLElement | null;
  ovCapPeers: HTMLElement | null;
  ovCapDht: HTMLElement | null;
  miniChartContainer: HTMLElement | null;

  peersMeta: HTMLElement | null;
  peersMessage: HTMLElement | null;
  peersBody: HTMLElement | null;
  peersHead: HTMLElement | null;
  peerFilter: HTMLInputElement | null;

  sessionsMeta: HTMLElement | null;
  sessionsMessage: HTMLElement | null;
  sessionsBody: HTMLElement | null;
  sessionsHead: HTMLElement | null;

  earningsMeta: HTMLElement | null;
  earningsMessage: HTMLElement | null;
  earnToday: HTMLElement | null;
  earnWeek: HTMLElement | null;
  earnMonth: HTMLElement | null;
  earningsLineChart: HTMLCanvasElement | null;
  earningsPieChart: HTMLCanvasElement | null;

  walletMeta: HTMLElement | null;
  walletMessage: HTMLElement | null;
  walletAddress: HTMLElement | null;
  walletCopyBtn: HTMLButtonElement | null;
  walletChain: HTMLElement | null;
  walletETH: HTMLElement | null;
  walletUSDC: HTMLElement | null;
  walletNetwork: HTMLElement | null;
  escrowDeposited: HTMLElement | null;
  escrowCommitted: HTMLElement | null;
  escrowAvailable: HTMLElement | null;
  walletAmount: HTMLInputElement | null;
  walletDepositBtn: HTMLButtonElement | null;
  walletWithdrawBtn: HTMLButtonElement | null;
  walletActionMessage: HTMLElement | null;
  walletModeNode: HTMLButtonElement | null;
  walletModeExternal: HTMLButtonElement | null;
  walletNodeSection: HTMLElement | null;
  walletExternalSection: HTMLElement | null;
  wcStatus: HTMLElement | null;
  wcStatusText: HTMLElement | null;
  wcAddressRow: HTMLElement | null;
  wcAddress: HTMLElement | null;
  wcCopyBtn: HTMLButtonElement | null;
  wcConnectBtn: HTMLButtonElement | null;
  wcDisconnectBtn: HTMLButtonElement | null;
  wcQrContainer: HTMLElement | null;
  wcQrCanvas: HTMLCanvasElement | null;

  chatModelSelect: HTMLSelectElement | HTMLInputElement | null;
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
  cfgReserveFloor: HTMLInputElement | null;
  cfgSellerInputUsdPerMillion: HTMLInputElement | null;
  cfgSellerOutputUsdPerMillion: HTMLInputElement | null;
  cfgMaxBuyers: HTMLInputElement | null;
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
    seedState: byId('seedState'),
    connectState: byId('connectState'),
    dashboardState: byId('dashboardState'),
    seedBadge: byId('seedBadge'),
    connectBadge: byId('connectBadge'),
    dashboardBadge: byId('dashboardBadge'),
    connectWarning: byId('connectWarning'),
    daemonState: byId('daemonState'),
    logs: byId('logs'),

    seedProvider: byId<HTMLInputElement>('seedProvider'),
    seedAuthType: byId<HTMLInputElement>('seedAuthType'),
    seedAuthValue: byId<HTMLInputElement>('seedAuthValue'),
    seedAuthValueLabel: byId('seedAuthValueLabel'),
    connectRouter: byId<HTMLInputElement>('connectRouter'),
    dashboardPort: byId<HTMLInputElement>('dashboardPort'),

    pluginSetupCard: byId('pluginSetupCard'),
    pluginSetupStatus: byId('pluginSetupStatus'),
    refreshPluginsBtn: byId<HTMLButtonElement>('refreshPluginsBtn'),
    installSeedPluginBtn: byId<HTMLButtonElement>('installSeedPluginBtn'),
    installConnectPluginBtn: byId<HTMLButtonElement>('installConnectPluginBtn'),

    overviewBadge: byId('overviewBadge'),
    ovNodeState: byId('ovNodeState'),
    ovPeers: byId('ovPeers'),
    ovSessionsCard: byId('ovSessionsCard'),
    ovSessions: byId('ovSessions'),
    ovEarnings: byId('ovEarnings'),
    ovDhtHealth: byId('ovDhtHealth'),
    ovUptime: byId('ovUptime'),
    ovPeersCount: byId('ovPeersCount'),
    overviewPeersBody: byId('overviewPeersBody'),
    capacityArc: byId<HTMLElement>('capacityArc'),
    capacityPercent: byId('capacityPercent'),
    ovProxyPort: byId('ovProxyPort'),
    ovCapSessions: byId('ovCapSessions'),
    ovCapPeers: byId('ovCapPeers'),
    ovCapDht: byId('ovCapDht'),
    miniChartContainer: byId('miniChartContainer'),

    peersMeta: byId('peersMeta'),
    peersMessage: byId('peersMessage'),
    peersBody: byId('peersBody'),
    peersHead: byId('peersHead'),
    peerFilter: byId<HTMLInputElement>('peerFilter'),

    sessionsMeta: byId('sessionsMeta'),
    sessionsMessage: byId('sessionsMessage'),
    sessionsBody: byId('sessionsBody'),
    sessionsHead: byId('sessionsHead'),

    earningsMeta: byId('earningsMeta'),
    earningsMessage: byId('earningsMessage'),
    earnToday: byId('earnToday'),
    earnWeek: byId('earnWeek'),
    earnMonth: byId('earnMonth'),
    earningsLineChart: byId<HTMLCanvasElement>('earningsLineChart'),
    earningsPieChart: byId<HTMLCanvasElement>('earningsPieChart'),

    walletMeta: byId('walletMeta'),
    walletMessage: byId('walletMessage'),
    walletAddress: byId('walletAddress'),
    walletCopyBtn: byId<HTMLButtonElement>('walletCopyBtn'),
    walletChain: byId('walletChain'),
    walletETH: byId('walletETH'),
    walletUSDC: byId('walletUSDC'),
    walletNetwork: byId('walletNetwork'),
    escrowDeposited: byId('escrowDeposited'),
    escrowCommitted: byId('escrowCommitted'),
    escrowAvailable: byId('escrowAvailable'),
    walletAmount: byId<HTMLInputElement>('walletAmount'),
    walletDepositBtn: byId<HTMLButtonElement>('walletDepositBtn'),
    walletWithdrawBtn: byId<HTMLButtonElement>('walletWithdrawBtn'),
    walletActionMessage: byId('walletActionMessage'),
    walletModeNode: byId<HTMLButtonElement>('walletModeNode'),
    walletModeExternal: byId<HTMLButtonElement>('walletModeExternal'),
    walletNodeSection: byId('walletNodeSection'),
    walletExternalSection: byId('walletExternalSection'),
    wcStatus: byId('wcStatus'),
    wcStatusText: byId('wcStatusText'),
    wcAddressRow: byId('wcAddressRow'),
    wcAddress: byId('wcAddress'),
    wcCopyBtn: byId<HTMLButtonElement>('wcCopyBtn'),
    wcConnectBtn: byId<HTMLButtonElement>('wcConnectBtn'),
    wcDisconnectBtn: byId<HTMLButtonElement>('wcDisconnectBtn'),
    wcQrContainer: byId('wcQrContainer'),
    wcQrCanvas: byId<HTMLCanvasElement>('wcQrCanvas'),

    chatModelSelect: byId<HTMLSelectElement>('chatModelSelect'),
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
    cfgReserveFloor: byId<HTMLInputElement>('cfgReserveFloor'),
    cfgSellerInputUsdPerMillion: byId<HTMLInputElement>('cfgSellerInputUsdPerMillion'),
    cfgSellerOutputUsdPerMillion: byId<HTMLInputElement>('cfgSellerOutputUsdPerMillion'),
    cfgMaxBuyers: byId<HTMLInputElement>('cfgMaxBuyers'),
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
