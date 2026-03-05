type NavigationInitOptions = {
  navButtons: HTMLElement[];
  views: HTMLElement[];
  toolbarViews?: Set<string>;
};

export function initNavigationModule({
  navButtons,
  views,
  toolbarViews = new Set(['overview', 'desktop']),
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

  }

  function getActiveView(): string {
    for (const view of views) {
      if (view.classList.contains('active')) {
        return view.id.replace('view-', '');
      }
    }
    return 'overview';
  }

  function initNavigation(): void {
    for (const button of navButtons) {
      button.addEventListener('click', () => {
        const targetView = button.dataset.view || 'overview';
        setActiveView(targetView);
      });
    }
  }

  return {
    setActiveView,
    getActiveView,
    initNavigation,
  };
}
