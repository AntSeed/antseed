export const VIEW_NAMES = ['chat', 'studio', 'overview', 'peers', 'connection', 'config', 'desktop', 'external-clients', 'discover'] as const;

export type ViewName = (typeof VIEW_NAMES)[number];
