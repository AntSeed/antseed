import { Suspense, useEffect, useState } from 'react';
import type { ViewName } from '../types';
import { getViewRegistryEntry } from './viewRegistry';

type ViewHostProps = {
  activeView: ViewName;
  onSelectView: (view: ViewName) => void;
};

// Must match the animation duration of .view-pane-in/.view-pane-out in
// global.scss — the outgoing view unmounts after this delay.
const VIEW_SLIDE_MS = 300;

function slideIndex(view: ViewName): number {
  return getViewRegistryEntry(view).slideIndex;
}

type SlideState = {
  view: ViewName;
  previous: ViewName | null;
  direction: 'forward' | 'back';
};

function ViewLoadingFallback() {
  return (
    <div className="view route-loading" role="status" aria-live="polite" aria-label="Loading view">
      <span className="route-loading-spinner" aria-hidden="true" />
    </div>
  );
}

function RoutedView({ view, onSelectView }: { view: ViewName; onSelectView: (view: ViewName) => void }) {
  const { component: View, receivesOnSelectView } = getViewRegistryEntry(view);

  return (
    <Suspense fallback={<ViewLoadingFallback />}>
      <View {...(receivesOnSelectView ? { onSelectView } : {})} />
    </Suspense>
  );
}

export function ViewHost({ activeView, onSelectView }: ViewHostProps) {
  const [slide, setSlide] = useState<SlideState>({ view: activeView, previous: null, direction: 'forward' });

  // Derive during render so the outgoing view is captured in the same pass
  // that swaps in the new one (a re-render is scheduled before commit).
  if (slide.view !== activeView) {
    setSlide({
      view: activeView,
      previous: slide.view,
      direction: slideIndex(activeView) >= slideIndex(slide.view) ? 'forward' : 'back',
    });
  }

  useEffect(() => {
    if (!slide.previous) return undefined;
    const timer = window.setTimeout(() => {
      setSlide((current) => (current.previous ? { ...current, previous: null } : current));
    }, VIEW_SLIDE_MS);
    return () => window.clearTimeout(timer);
  }, [slide]);

  const sliding = slide.previous !== null;

  return (
    <section className={`view-host${sliding ? ` view-host-sliding view-host-${slide.direction}` : ''}`}>
      {slide.previous && (
        <div key={`out-${slide.previous}`} className="view-pane view-pane-out" aria-hidden="true">
          <RoutedView view={slide.previous} onSelectView={onSelectView} />
        </div>
      )}
      <div key={slide.view} className={`view-pane${sliding ? ' view-pane-in' : ''}`}>
        <RoutedView view={slide.view} onSelectView={onSelectView} />
      </div>
    </section>
  );
}
