import { lazy } from 'react';
import type { ComponentType, LazyExoticComponent } from 'react';
import type { ViewName } from '../types';

export type RoutedViewProps = {
  active: boolean;
  onSelectView?: (view: ViewName) => void;
};

export type ViewRegistryEntry = {
  component: LazyExoticComponent<ComponentType<RoutedViewProps>>;
  preload: () => Promise<ComponentType<RoutedViewProps>>;
  receivesOnSelectView: boolean;
};

function createViewEntry(
  loader: () => Promise<ComponentType<RoutedViewProps>>,
  receivesOnSelectView: boolean,
): ViewRegistryEntry {
  let loadPromise: Promise<ComponentType<RoutedViewProps>> | null = null;
  const preload = () => {
    loadPromise ??= loader();
    return loadPromise;
  };

  return {
    component: lazy(async () => ({ default: await preload() })),
    preload,
    receivesOnSelectView,
  };
}

export const VIEW_REGISTRY = {
  chat: createViewEntry(
    async () => (await import('./views/ChatView')).ChatView as ComponentType<RoutedViewProps>,
    true,
  ),
  overview: createViewEntry(
    async () => (await import('./views/OverviewView')).OverviewView as ComponentType<RoutedViewProps>,
    false,
  ),
  peers: createViewEntry(
    async () => (await import('./views/PeersView')).PeersView as ComponentType<RoutedViewProps>,
    false,
  ),
  connection: createViewEntry(
    async () => (await import('./views/ConnectionView')).ConnectionView as ComponentType<RoutedViewProps>,
    false,
  ),
  config: createViewEntry(
    async () => (await import('./views/ConfigView')).ConfigView as ComponentType<RoutedViewProps>,
    false,
  ),
  desktop: createViewEntry(
    async () => (await import('./views/DesktopView')).DesktopView as ComponentType<RoutedViewProps>,
    false,
  ),
  'external-clients': createViewEntry(
    async () => (await import('./views/ExternalClientsView')).ExternalClientsView as ComponentType<RoutedViewProps>,
    false,
  ),
  discover: createViewEntry(
    async () => (await import('./views/DiscoverView')).DiscoverView as ComponentType<RoutedViewProps>,
    true,
  ),
} satisfies Record<ViewName, ViewRegistryEntry>;

export function getViewRegistryEntry(view: ViewName): ViewRegistryEntry {
  return VIEW_REGISTRY[view];
}

export function preloadView(view: ViewName): Promise<ComponentType<RoutedViewProps>> {
  return getViewRegistryEntry(view).preload();
}

export function preloadViews(views: readonly ViewName[]): Promise<unknown[]> {
  return Promise.all(views.map((view) => preloadView(view)));
}
