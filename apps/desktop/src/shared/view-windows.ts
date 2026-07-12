// Window size preset per renderer view, shared between the main process
// (which resizes the window when the view changes) and the renderer's view
// registry test (which asserts every view is covered). Keyed by plain string
// because ViewName lives in renderer-only code; the registry test enforces
// that the keys stay in sync with VIEW_NAMES.
export type WindowSizePresetName = 'standard' | 'compact';

export const VIEW_WINDOW_PRESETS = {
  // VPR screens are small single-purpose panels.
  home: 'compact',
  explore: 'compact',
  model: 'compact',
  tools: 'compact',
  preferences: 'compact',
  credits: 'compact',
  help: 'compact',
  // Chat opens at the standard (wide) preset so the conversation-list panel
  // fits next to the nav rail.
  chat: 'standard',
  // Diagnostic/dev screens stay in the same compact panel as the VPR views
  // (they're reachable from Help & Support) — their tables and panels scroll
  // within the window instead of blowing it up to the wide preset.
  developer: 'compact',
  overview: 'compact',
  peers: 'compact',
  connection: 'compact',
  desktop: 'compact',
  config: 'compact',
  'system-proxy': 'compact',
} as const satisfies Record<string, WindowSizePresetName>;

export function windowPresetForView(view: string): WindowSizePresetName {
  return (VIEW_WINDOW_PRESETS as Record<string, WindowSizePresetName>)[view] ?? 'standard';
}
