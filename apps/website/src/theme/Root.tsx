import type React from 'react';
import {useEffect} from 'react';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';

/**
 * Global scroll state: `data-scrolled` on <html> drives the navbar
 * transformation (transparent bar at top → floating pill when scrolling).
 * `data-anim` gates scroll-reveal styles so content stays visible for
 * SSR/no-JS and only animates once hydrated.
 */
function useScrollState() {
  useEffect(() => {
    const root = document.documentElement;
    root.setAttribute('data-anim', 'true');
    let ticking = false;
    const update = () => {
      ticking = false;
      root.setAttribute('data-scrolled', window.scrollY > 24 ? 'true' : 'false');
    };
    const onScroll = () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(update);
      }
    };
    update();
    window.addEventListener('scroll', onScroll, {passive: true});
    return () => window.removeEventListener('scroll', onScroll);
  }, []);
}

export default function Root({children}: {children: React.ReactNode}) {
  useScrollState();
  return <>{children}</>;
}
