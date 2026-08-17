export type VprCompactModel = {
  provider: string;
  serviceId: string;
  label: string;
  peerCount: number;
  categories: string[];
  kind: 'text' | 'image';
  protocols: string[];
  minInputUsdPerMillion: number | null;
  maxInputUsdPerMillion: number | null;
  minOutputUsdPerMillion: number | null;
  maxOutputUsdPerMillion: number | null;
  minCachedInputUsdPerMillion: number | null;
  maxCachedInputUsdPerMillion: number | null;
  minImageUsdPerImage: number | null;
  maxImageUsdPerImage: number | null;
  expectedSavingsPct: number | null;
  bestPeerId: string | null;
  baselineInputUsdPerMillion?: number | null;
  baselineOutputUsdPerMillion?: number | null;
};

export type VprCompactApp = {
  name: string;
  displayName: string;
  toolSlugs?: string[];
  iconDataUri?: string;
};

export type VprCompactConversation = {
  id: string;
  tool: string;
  title: string;
  sessionShort: string;
  pinnedServiceId: string | null;
  lastActiveAt: number;
  active: boolean;
  cost: string | null;
  routedPeerName: string | null;
};

export type VprCompactSurfaceData = {
  apps: VprCompactApp[];
  selectedApp: string;
  models: VprCompactModel[];
  favoriteKeys?: string[];
  selectedModel: { provider: string; serviceId: string } | null;
  pinnedSellers?: Record<string, string>;
  conversations: VprCompactConversation[];
  usageLabel: string;
  balanceLabel?: string;
  needsFunds?: boolean;
  runtimeOn?: boolean;
  identityLabel?: string;
  showRoutedPeer?: boolean;
  trafficActive: boolean;
  openMenu?: boolean;
};

export type VprCompactSurfaceAction =
  | 'open-main'
  | { type: 'open-deposit' }
  | { type: 'select-model'; provider: string; serviceId: string }
  | { type: 'pin-chat-model'; conversationId: string; provider: string; serviceId: string }
  | { type: 'open-chat-app'; conversationId: string }
  | { type: 'set-compact'; compact: boolean };
