import type React from 'react';
import {useEffect} from 'react';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import {
  track,
  isDownloadUrl,
  isOutboundUrl,
  platformFromUrl,
  sectionOf,
  visibleLabel,
} from '../lib/analytics';

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

/**
 * Click tracking, delegated from the document rather than wired into each
 * button. Every current and future link is covered without touching call sites,
 * and nothing here can block or alter navigation — the listener only reads.
 *
 * Emits:
 *   download_vpr   — any link to our GitHub releases (the conversion event)
 *   outbound_click — any link leaving antseed.com
 */
function useClickTracking() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Ignore synthetic clicks and modified clicks we can't attribute cleanly.
      if (!e.isTrusted) return;
      const target = e.target as Element | null;
      const anchor = target?.closest?.('a[href]') as HTMLAnchorElement | null;
      if (!anchor) return;

      const href = anchor.getAttribute('href') || '';
      if (!href || href.startsWith('#')) return;

      // Resolve relative hrefs so the URL checks see an absolute value.
      let absolute = href;
      try {
        absolute = new URL(href, window.location.href).href;
      } catch {
        return;
      }

      const common = {
        link_url: absolute,
        link_text: visibleLabel(anchor),
        link_section: sectionOf(anchor),
        page_path: window.location.pathname,
      };

      if (isDownloadUrl(absolute)) {
        // Mark this as the key event in GA4 — see ANALYTICS.md.
        track('download_vpr', {
          ...common,
          platform: platformFromUrl(absolute),
        });
        return;
      }

      if (isOutboundUrl(absolute)) {
        track('outbound_click', {
          ...common,
          outbound_domain: new URL(absolute).hostname,
        });
      }
    };

    document.addEventListener('click', onClick, {capture: true, passive: true});
    return () => document.removeEventListener('click', onClick, {capture: true});
  }, []);
}

export default function Root({children}: {children: React.ReactNode}) {
  useScrollState();
  useClickTracking();
  return <>{children}</>;
}
