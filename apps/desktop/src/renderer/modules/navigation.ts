type AppMode = 'seeder' | 'connect';

type NavigationState = Record<string, any>;

type NavigationInitOptions = {
  uiState: NavigationState;
  navButtons: HTMLElement[];
  views: HTMLElement[];
  toolbarViews?: Set<string>;
  storageKey?: string;
};

export function initNavigationModule({
  uiState,
  navButtons,
  views,
  toolbarViews = new Set(['overview', 'desktop']),
  storageKey = 'antseed-app-mode',
}: NavigationInitOptions) {
  function setActiveView(viewName: string): void {
    for (const button of navButtons) {
      const active = button.dataset.view === viewName;
      button.classList.toggle('active', active);
      button.setAttribute('aria-selected', active ? 'true' : 'false');
    }

    for (const view of views) {
      view.classList.toggle('active', view.id === `view-${viewName}`);
    }

    const toolbar = document.querySelector<HTMLElement>('.runtime-toolbar');
    const mainContent = document.querySelector<HTMLElement>('.main-content');
    const showToolbar = toolbarViews.has(viewName);
    if (toolbar) toolbar.classList.toggle('hidden', !showToolbar);
    if (mainContent) mainContent.classList.toggle('show-toolbar', showToolbar);
  }

  function getActiveView(): string {
    for (const view of views) {
      if (view.classList.contains('active')) {
        return view.id.replace('view-', '');
      }
    }
    return 'overview';
  }

  function setAppMode(mode: AppMode): void {
    uiState.appMode = mode;
    try {
      localStorage.setItem(storageKey, mode);
    } catch {
      // Ignore storage errors in restricted environments.
    }

    const modeButtons = document.querySelectorAll<HTMLElement>('.mode-btn[data-appmode]');
    for (const btn of modeButtons) {
      btn.classList.toggle('active', btn.dataset.appmode === mode);
    }

    const modeElements = document.querySelectorAll<HTMLElement>('[data-mode="seeder"], [data-mode="connect"], [data-mode="both"]');
    for (const el of modeElements) {
      const elMode = el.getAttribute('data-mode');
      if (elMode === 'both' || elMode === mode) {
        el.classList.remove('mode-hidden');
      } else {
        el.classList.add('mode-hidden');
      }
    }

    const activeView = getActiveView();
    const activeNavItem = document.querySelector<HTMLElement>(`.sidebar-nav li[data-mode] .sidebar-btn[data-view="${activeView}"]`);
    if (activeNavItem) {
      const parentLi = activeNavItem.closest('li[data-mode]');
      if (parentLi && parentLi.classList.contains('mode-hidden')) {
        setActiveView('overview');
      }
    }
  }

  function initNavigation(): void {
    for (const button of navButtons) {
      button.addEventListener('click', () => {
        const targetView = button.dataset.view || 'overview';
        setActiveView(targetView);
      });
    }

    const modeButtons = document.querySelectorAll<HTMLElement>('.mode-btn[data-appmode]');
    for (const btn of modeButtons) {
      btn.addEventListener('click', () => {
        const nextMode = btn.dataset.appmode === 'connect' ? 'connect' : 'seeder';
        setAppMode(nextMode);
      });
    }
  }

  function getSavedAppMode(): AppMode | null {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved === 'connect' || saved === 'seeder') {
        return saved;
      }
      return null;
    } catch {
      return null;
    }
  }

  return {
    setActiveView,
    getActiveView,
    setAppMode,
    initNavigation,
    getSavedAppMode,
  };
}
