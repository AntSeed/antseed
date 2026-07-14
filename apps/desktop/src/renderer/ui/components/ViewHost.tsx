import { Suspense, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ViewName } from '../types';
import { getViewRegistryEntry } from './viewRegistry';

type ViewHostProps = {
  activeView: ViewName;
  onSelectView: (view: ViewName) => void;
};

// Must match the animation duration of .view-pane-in/.view-pane-out in
// global.scss — the outgoing view unmounts after this delay.
const VIEW_SLIDE_MS = 300;

// Renderer-lifetime scroll position per view. Views unmount when navigated
// away from, so drilling into another screen and coming back would otherwise
// land at the top. Written once when a pane unmounts and restored before
// paint on mount — no scroll listeners, no state updates.
const viewScrollCache = new Map<ViewName, number>();

// Each view's scrolling element is its root `.view` section. The Suspense
// fallback also carries `.view`, so exclude it — restoring must wait for the
// real view.
const SCROLL_EL_SELECTOR = '.view:not(.route-loading)';

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

function ViewPane({ view, className, hidden, onSelectView }: {
  view: ViewName;
  className: string;
  hidden?: boolean;
  onSelectView: (view: ViewName) => void;
}) {
  const ref = useRef<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    const pane = ref.current;
    if (!pane) return undefined;
    const apply = (): boolean => {
      const el = pane.querySelector<HTMLElement>(SCROLL_EL_SELECTOR);
      if (!el) return false;
      const top = viewScrollCache.get(view) ?? 0;
      if (top > 0) el.scrollTop = top;
      return true;
    };
    if (apply()) return undefined;
    // Lazy chunk still loading — restore once the view replaces the fallback.
    const observer = new MutationObserver(() => {
      if (apply()) observer.disconnect();
    });
    observer.observe(pane, { childList: true });
    return () => observer.disconnect();
  }, [view]);

  useEffect(() => () => {
    const el = ref.current?.querySelector<HTMLElement>(SCROLL_EL_SELECTOR);
    if (el) viewScrollCache.set(view, el.scrollTop);
  }, [view]);

  return (
    <div ref={ref} className={className} {...(hidden ? { 'aria-hidden': true } : {})}>
      <RoutedView view={view} onSelectView={onSelectView} />
    </div>
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
        <ViewPane
          key={`out-${slide.previous}`}
          view={slide.previous}
          className="view-pane view-pane-out"
          hidden
          onSelectView={onSelectView}
        />
      )}
      <ViewPane
        key={slide.view}
        view={slide.view}
        className={`view-pane${sliding ? ' view-pane-in' : ''}`}
        onSelectView={onSelectView}
      />
    </section>
  );
}
