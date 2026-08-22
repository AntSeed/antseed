import type React from 'react';
import {useEffect} from 'react';
import '@fontsource-variable/geist';
import '@fontsource-variable/geist-mono';
import {
  track,
  isDownloadUrl,
  isGetStartedUrl,
  isOutboundUrl,
  platformFromUrl,
  sectionOf,
  visibleLabel,
} from '../lib/analytics';
import {MOBILE_GET_STARTED_QUERY} from '../lib/useMobileGetStarted';

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
 *   download_vpr   — a link to our GitHub releases, on viewports wide enough
 *                    to actually download (the desktop conversion event)
 *   get_started    — the mobile funnel entry: a /get-started link, or a
 *                    download link tapped on a phone viewport, where
 *                    useMobileGetStarted reroutes to /get-started instead
 *                    of downloading
 *   outbound_click — any link leaving antseed.com
 */
function useClickTracking() {
  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      // Only real user input. Programmatic .click() calls are not user intent.
      // Ctrl/Cmd-click still arrives here as a normal `click` and does count —
      // it is a deliberate open-in-new-tab.
      if (!e.isTrusted) return;
      // `auxclick` also fires on right-click (button 2), which opens a context
      // menu rather than navigating. Only the middle button is a real open.
      if (e.type === 'auxclick' && e.button !== 1) return;
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
        // On phone viewports the VPR CTAs keep their download href but
        // reroute to /get-started on tap (useMobileGetStarted, which runs
        // after this capture listener) — count those as funnel entries, not
        // download conversions.
        if (window.matchMedia(MOBILE_GET_STARTED_QUERY).matches) {
          track('get_started', common);
          return;
        }
        // Conversion event. Marked as the key event in GA4.
        track('download_vpr', {
          ...common,
          platform: platformFromUrl(absolute),
        });
        return;
      }

      if (isGetStartedUrl(absolute)) {
        track('get_started', common);
        return;
      }

      if (isOutboundUrl(absolute)) {
        track('outbound_click', {
          ...common,
          outbound_domain: new URL(absolute).hostname,
        });
      }
    };

    // `click` covers left and Ctrl/Cmd-click; `auxclick` covers the middle
    // button, which opens a new tab and never fires `click`. A given gesture
    // fires exactly one of the two, so nothing is double-counted.
    document.addEventListener('click', onClick, {capture: true, passive: true});
    document.addEventListener('auxclick', onClick, {capture: true, passive: true});
    return () => {
      document.removeEventListener('click', onClick, {capture: true});
      document.removeEventListener('auxclick', onClick, {capture: true});
    };
  }, []);
}

export default function Root({children}: {children: React.ReactNode}) {
  useScrollState();
  useClickTracking();
  return <>{children}</>;
}
