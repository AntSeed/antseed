import { Suspense } from 'react';
import type { ViewName } from '../types';
import { getViewRegistryEntry } from './viewRegistry';

type ViewHostProps = {
  activeView: ViewName;
  onSelectView: (view: ViewName) => void;
};

function ViewLoadingFallback() {
  return (
    <div className="view active route-loading" role="status" aria-live="polite" aria-label="Loading view">
      <span className="route-loading-spinner" aria-hidden="true" />
    </div>
  );
}

export function ViewHost({ activeView, onSelectView }: ViewHostProps) {
  const { component: ActiveView, receivesOnSelectView } = getViewRegistryEntry(activeView);

  return (
    <section className="view-host">
      <Suspense fallback={<ViewLoadingFallback />}>
        <ActiveView
          // ViewHost only mounts the active page; legacy view-level `active`
          // effects can keep using the prop as an always-true invariant.
          active={true}
          {...(receivesOnSelectView ? { onSelectView } : {})}
        />
      </Suspense>
    </section>
  );
}
