export const VPR_VIEW_NAMES = ['home', 'explore', 'model', 'tools', 'preferences', 'credits', 'chat'] as const;
export const DEV_VIEW_NAMES = ['developer', 'overview', 'peers', 'connection', 'desktop', 'config', 'system-proxy'] as const;

export const VIEW_NAMES = [...VPR_VIEW_NAMES, ...DEV_VIEW_NAMES] as const;

export type VprViewName = (typeof VPR_VIEW_NAMES)[number];
export type DevViewName = (typeof DEV_VIEW_NAMES)[number];
export type ViewName = (typeof VIEW_NAMES)[number];
