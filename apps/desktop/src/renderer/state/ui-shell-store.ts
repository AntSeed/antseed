export type AppMode = 'connect';
export type ViewName =
  | 'chat'
  | 'overview'
  | 'peers'
  | 'sessions'
  | 'connection'
  | 'config'
  | 'desktop'
  | 'earnings'
  | 'wallet';
export type EarningsPeriod = 'day' | 'week' | 'month';

export type UiShellState = Readonly<{
  activeView: ViewName;
  appMode: AppMode;
  earningsPeriod: EarningsPeriod;
}>;

type UiShellListener = (next: UiShellState, prev: UiShellState) => void;

const DEFAULT_STATE: UiShellState = {
  activeView: 'chat',
  appMode: 'connect',
  earningsPeriod: 'month',
};
const VALID_VIEWS = new Set<ViewName>([
  'chat',
  'overview',
  'peers',
  'sessions',
  'connection',
  'config',
  'desktop',
  'earnings',
  'wallet',
]);

let state: UiShellState = { ...DEFAULT_STATE };

const listeners = new Set<UiShellListener>();

function emit(next: UiShellState, prev: UiShellState): void {
  for (const listener of listeners) {
    listener(next, prev);
  }
}

function commit(nextState: UiShellState): void {
  if (
    nextState.activeView === state.activeView
    && nextState.appMode === state.appMode
    && nextState.earningsPeriod === state.earningsPeriod
  ) {
    return;
  }

  const prev = state;
  state = nextState;
  emit(state, prev);
}

function normalizeView(view: ViewName): ViewName {
  return VALID_VIEWS.has(view) ? view : 'chat';
}

export function getUiShellState(): UiShellState {
  return state;
}

export function subscribeUiShellState(listener: UiShellListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function subscribeUiShellSnapshot(listener: () => void): () => void {
  return subscribeUiShellState(() => {
    listener();
  });
}

export function setActiveView(nextView: ViewName): void {
  commit({
    ...state,
    activeView: normalizeView(nextView),
  });
}

export function setAppMode(nextMode: AppMode): void {
  commit({
    ...state,
    appMode: nextMode,
    activeView: normalizeView(state.activeView),
  });
}

export function setEarningsPeriod(nextPeriod: EarningsPeriod): void {
  commit({
    ...state,
    earningsPeriod: nextPeriod,
  });
}
