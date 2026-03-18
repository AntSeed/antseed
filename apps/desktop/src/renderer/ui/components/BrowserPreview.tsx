import { useRef, useState, useCallback, useEffect } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ArrowLeft01Icon,
  ArrowRight01Icon,
  ArrowReloadHorizontalIcon,
  Cancel01Icon,
  SmartPhone01Icon,
  Sun02Icon,
  Moon02Icon,
  Copy01Icon,
  ConsoleIcon,
} from '@hugeicons/core-free-icons';
import styles from './BrowserPreview.module.scss';

/** Minimal interface for the Electron <webview> element methods we use. */
interface WebviewElement extends HTMLElement {
  getURL(): string;
  canGoBack(): boolean;
  canGoForward(): boolean;
  goBack(): void;
  goForward(): void;
  reload(): void;
  stop(): void;
  loadURL(url: string): Promise<void>;
  executeJavaScript(code: string): Promise<unknown>;
  setUserAgent(userAgent: string): void;
}

type ConsoleEntry = {
  level: 'log' | 'warn' | 'error' | 'info';
  text: string;
  timestamp: number;
};

type BrowserPreviewProps = {
  url: string | null;
  onClose: () => void;
  onNavigate: (url: string) => void;
  onElementSelected?: (info: {
    selector: string;
    tagName: string;
    text: string;
    attributes: Record<string, string>;
  }) => void;
};

const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 844;
const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';

const ELEMENT_PICKER_INJECT = `
(function() {
  if (window.__antseedPickerActive) return;
  window.__antseedPickerActive = true;

  const overlay = document.createElement('div');
  overlay.id = '__antseed-picker-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483646;cursor:crosshair;';
  document.body.appendChild(overlay);

  const highlight = document.createElement('div');
  highlight.id = '__antseed-picker-highlight';
  highlight.style.cssText = 'position:fixed;z-index:2147483645;pointer-events:none;border:2px solid #1fd87a;background:rgba(31,216,122,0.08);transition:all 0.05s;';
  document.body.appendChild(highlight);

  let lastTarget = null;

  function getSelector(el) {
    if (el.id) return '#' + CSS.escape(el.id);
    let path = '';
    while (el && el.nodeType === 1) {
      let selector = el.tagName.toLowerCase();
      if (el.id) { path = '#' + CSS.escape(el.id) + (path ? ' > ' + path : ''); break; }
      if (el.className && typeof el.className === 'string') {
        const cls = el.className.trim().split(/\\s+/).slice(0, 2).map(c => '.' + CSS.escape(c)).join('');
        selector += cls;
      }
      const parent = el.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === el.tagName);
        if (siblings.length > 1) selector += ':nth-child(' + (Array.from(parent.children).indexOf(el) + 1) + ')';
      }
      path = selector + (path ? ' > ' + path : '');
      el = parent;
    }
    return path;
  }

  function getAttrs(el) {
    const attrs = {};
    for (const a of el.attributes) {
      if (a.name !== 'style') attrs[a.name] = a.value.slice(0, 200);
    }
    return attrs;
  }

  overlay.addEventListener('mousemove', function(e) {
    overlay.style.pointerEvents = 'none';
    const target = document.elementFromPoint(e.clientX, e.clientY);
    overlay.style.pointerEvents = 'auto';
    if (!target || target === overlay || target === highlight) return;
    lastTarget = target;
    const rect = target.getBoundingClientRect();
    highlight.style.top = rect.top + 'px';
    highlight.style.left = rect.left + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';
  });

  overlay.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    if (!lastTarget) return;
    const info = {
      selector: getSelector(lastTarget),
      tagName: lastTarget.tagName.toLowerCase(),
      text: (lastTarget.textContent || '').trim().slice(0, 300),
      attributes: getAttrs(lastTarget),
    };
    overlay.remove();
    highlight.remove();
    window.__antseedPickerActive = false;
    window.__antseedPickerResult = info;
  });

  document.addEventListener('keydown', function handler(e) {
    if (e.key === 'Escape') {
      overlay.remove();
      highlight.remove();
      window.__antseedPickerActive = false;
      document.removeEventListener('keydown', handler);
    }
  });
})();
`;

const ELEMENT_PICKER_POLL = `
(function() {
  const result = window.__antseedPickerResult;
  if (result) {
    window.__antseedPickerResult = null;
    return result;
  }
  return null;
})();
`;

export function BrowserPreview({ url, onClose, onNavigate, onElementSelected }: BrowserPreviewProps) {
  const webviewRef = useRef<WebviewElement | null>(null);
  const [displayUrl, setDisplayUrl] = useState(url ?? 'http://localhost:3000');
  const [pageTitle, setPageTitle] = useState('Workspace Preview');
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pickerActive, setPickerActive] = useState(false);
  const [mobileMode, setMobileMode] = useState(false);
  const [darkMode, setDarkMode] = useState(false);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const [consoleEntries, setConsoleEntries] = useState<ConsoleEntry[]>([]);
  const [consoleFilter, setConsoleFilter] = useState<'all' | 'error' | 'warn'>('all');
  const pickerPollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consoleScrollRef = useRef<HTMLDivElement>(null);

  const hasUrl = Boolean(url && url.trim().length > 0);

  // Update webview when url prop changes
  useEffect(() => {
    const webview = webviewRef.current;
    if (webview && url) {
      try {
        const currentUrl = webview.getURL();
        if (currentUrl !== url) {
          webview.loadURL(url);
        }
      } catch {
        // webview not ready yet
      }
    }
    if (url) {
      setDisplayUrl(url);
    }
  }, [url]);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    const handleNavigate = () => {
      const nextUrl = webview.getURL();
      setDisplayUrl(nextUrl);
      onNavigate(nextUrl);
      setCanGoBack(webview.canGoBack());
      setCanGoForward(webview.canGoForward());
    };

    const handleTitleUpdate = (e: Event) => {
      const ev = e as Event & { title?: string };
      const nextTitle = typeof ev.title === 'string' ? ev.title.trim() : '';
      setPageTitle(nextTitle || 'Workspace Preview');
    };

    const handleStartLoading = () => {
      setIsLoading(true);
      setLoadError(null);
    };
    const handleStopLoading = () => {
      setIsLoading(false);
      handleNavigate();
    };

    const handleFailLoad = (e: Event) => {
      const ev = e as Event & { errorCode: number; errorDescription: string; validatedURL: string; isMainFrame: boolean };
      if (!ev.isMainFrame) return; // ignore sub-resource failures
      if (ev.errorCode === -3) return; // ERR_ABORTED — user navigated away, not a real error
      setIsLoading(false);
      setLoadError(`${ev.errorDescription || 'Connection failed'} (${ev.validatedURL})`);
    };

    const handleConsoleMessage = (e: Event) => {
      const ev = e as Event & { level: number; message: string };
      const level = ev.level === 2 ? 'error' : ev.level === 1 ? 'warn' : 'log';
      setConsoleEntries((prev) => [
        ...prev.slice(-500),
        { level, text: ev.message, timestamp: Date.now() },
      ]);
    };

    webview.addEventListener('did-navigate', handleNavigate);
    webview.addEventListener('did-navigate-in-page', handleNavigate);
    webview.addEventListener('did-start-loading', handleStartLoading);
    webview.addEventListener('did-stop-loading', handleStopLoading);
    webview.addEventListener('did-fail-load', handleFailLoad);
    webview.addEventListener('console-message', handleConsoleMessage);
    webview.addEventListener('page-title-updated', handleTitleUpdate);

    return () => {
      webview.removeEventListener('did-navigate', handleNavigate);
      webview.removeEventListener('did-navigate-in-page', handleNavigate);
      webview.removeEventListener('did-start-loading', handleStartLoading);
      webview.removeEventListener('did-stop-loading', handleStopLoading);
      webview.removeEventListener('did-fail-load', handleFailLoad);
      webview.removeEventListener('console-message', handleConsoleMessage);
      webview.removeEventListener('page-title-updated', handleTitleUpdate);
    };
  }, [onNavigate]);

  // Auto-scroll console
  useEffect(() => {
    const el = consoleScrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [consoleEntries]);

  // Clean up picker polling on unmount
  useEffect(() => {
    return () => {
      if (pickerPollRef.current) clearInterval(pickerPollRef.current);
    };
  }, []);

  const handleUrlSubmit = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key !== 'Enter') return;
      let target = displayUrl.trim();
      if (!target) return;
      if (target && !target.match(/^https?:\/\//)) {
        target = `http://${target}`;
      }
      setDisplayUrl(target);
      onNavigate(target);
      webviewRef.current?.loadURL(target);
    },
    [displayUrl, onNavigate],
  );

  const goBack = useCallback(() => webviewRef.current?.goBack(), []);
  const goForward = useCallback(() => webviewRef.current?.goForward(), []);
  const reload = useCallback(() => {
    if (isLoading) {
      webviewRef.current?.stop();
    } else {
      webviewRef.current?.reload();
    }
  }, [isLoading]);

  const toggleMobile = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const next = !mobileMode;
    setMobileMode(next);
    if (next) {
      webview.setUserAgent(MOBILE_UA);
    } else {
      webview.setUserAgent('');
    }
    webview.reload();
  }, [mobileMode]);

  const toggleDarkMode = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const next = !darkMode;
    setDarkMode(next);
    webview
      .executeJavaScript(
        next
          ? `document.documentElement.style.colorScheme='dark'; document.documentElement.classList.add('dark');`
          : `document.documentElement.style.colorScheme='light'; document.documentElement.classList.remove('dark');`,
      )
      .catch(() => {});
  }, [darkMode]);

  const copyUrl = useCallback(() => {
    if (!displayUrl.trim()) return;
    navigator.clipboard.writeText(displayUrl).catch(() => {});
  }, [displayUrl]);

  const openTypedUrl = useCallback(() => {
    let target = displayUrl.trim();
    if (!target) return;
    if (!target.match(/^https?:\/\//)) {
      target = `http://${target}`;
    }
    setDisplayUrl(target);
    onNavigate(target);
    webviewRef.current?.loadURL(target);
  }, [displayUrl, onNavigate]);

  const togglePicker = useCallback(() => {
    const webview = webviewRef.current;
    if (!webview) return;

    if (pickerActive) {
      webview
        .executeJavaScript(
          `const o=document.getElementById('__antseed-picker-overlay');const h=document.getElementById('__antseed-picker-highlight');if(o)o.remove();if(h)h.remove();window.__antseedPickerActive=false;`,
        )
        .catch(() => {});
      if (pickerPollRef.current) {
        clearInterval(pickerPollRef.current);
        pickerPollRef.current = null;
      }
      setPickerActive(false);
      return;
    }

    webview.executeJavaScript(ELEMENT_PICKER_INJECT).catch(() => {});
    setPickerActive(true);

    pickerPollRef.current = setInterval(() => {
      webview
        .executeJavaScript(ELEMENT_PICKER_POLL)
        .then((result) => {
          if (result && typeof result === 'object') {
            setPickerActive(false);
            if (pickerPollRef.current) {
              clearInterval(pickerPollRef.current);
              pickerPollRef.current = null;
            }
            onElementSelected?.(
              result as {
                selector: string;
                tagName: string;
                text: string;
                attributes: Record<string, string>;
              },
            );
          }
        })
        .catch(() => {});
    }, 200);
  }, [pickerActive, onElementSelected]);

  const filteredConsole = consoleEntries.filter((e) => {
    if (consoleFilter === 'all') return true;
    return e.level === consoleFilter;
  });

  const statusLabel = loadError
    ? 'Error'
    : isLoading
      ? 'Loading'
      : hasUrl
        ? mobileMode
          ? 'Mobile'
          : 'Ready'
        : 'Idle';

  const hostLabel = (() => {
    try {
      const parsed = new URL(displayUrl);
      return parsed.host || parsed.pathname;
    } catch {
      return displayUrl.trim() || 'No URL selected';
    }
  })();

  const webviewStyle: React.CSSProperties = mobileMode
    ? {
        width: MOBILE_WIDTH,
        height: MOBILE_HEIGHT,
        maxWidth: '100%',
        maxHeight: '100%',
        margin: '0 auto',
        border: '1px solid var(--border)',
        borderRadius: 12,
      }
    : { width: '100%', height: '100%' };

  return (
    <div className={styles.browserPreview}>
      {/* Navigation bar */}
      <div className={styles.toolbar}>
        <button className={styles.navBtn} onClick={goBack} disabled={!canGoBack} title="Back">
          <HugeiconsIcon icon={ArrowLeft01Icon} size={16} strokeWidth={1.5} />
        </button>
        <button className={styles.navBtn} onClick={goForward} disabled={!canGoForward} title="Forward">
          <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={1.5} />
        </button>
        <button className={styles.navBtn} onClick={reload} title={isLoading ? 'Stop' : 'Reload'}>
          {isLoading ? (
            <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.5} />
          ) : (
            <HugeiconsIcon icon={ArrowReloadHorizontalIcon} size={16} strokeWidth={1.5} />
          )}
        </button>
        <input
          className={styles.urlBar}
          value={displayUrl}
          onChange={(e) => setDisplayUrl(e.target.value)}
          onKeyDown={handleUrlSubmit}
          spellCheck={false}
          placeholder="Enter a localhost URL or website"
        />
        <button className={styles.openBtn} onClick={openTypedUrl} disabled={!displayUrl.trim()} title="Open URL">
          Open
        </button>
        {/* Device & utility buttons */}
        <button
          className={`${styles.navBtn} ${darkMode ? styles.navBtnActive : ''}`}
          onClick={toggleDarkMode}
          title={darkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          disabled={!hasUrl}
        >
          <HugeiconsIcon icon={darkMode ? Sun02Icon : Moon02Icon} size={16} strokeWidth={1.5} />
        </button>
        <button className={styles.navBtn} onClick={copyUrl} title="Copy URL" disabled={!hasUrl}>
          <HugeiconsIcon icon={Copy01Icon} size={16} strokeWidth={1.5} />
        </button>
        <button
          className={`${styles.navBtn} ${mobileMode ? styles.navBtnActive : ''}`}
          onClick={toggleMobile}
          title={mobileMode ? 'Desktop viewport' : 'Mobile viewport'}
          disabled={!hasUrl}
        >
          <HugeiconsIcon icon={SmartPhone01Icon} size={16} strokeWidth={1.5} />
        </button>
        <button
          className={`${styles.pickerBtn} ${pickerActive ? styles.pickerBtnActive : ''}`}
          onClick={togglePicker}
          title={pickerActive ? 'Cancel element picker' : 'Select an element'}
          disabled={!hasUrl}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M3 3l4.5 10 1.8-4.2L13.5 7z" />
            <path d="M10.5 10.5L14 14" />
          </svg>
        </button>
        <button className={styles.closeBtn} onClick={onClose} title="Close preview">
          <HugeiconsIcon icon={Cancel01Icon} size={16} strokeWidth={1.5} />
        </button>
      </div>
      <div className={styles.statusBar}>
        <div className={styles.statusMeta}>
          <span className={`${styles.statusBadge} ${loadError ? styles.statusBadgeError : isLoading ? styles.statusBadgeLoading : styles.statusBadgeReady}`}>
            {statusLabel}
          </span>
          <span className={styles.statusTitle}>{pageTitle}</span>
        </div>
        <span className={styles.statusHost}>{hostLabel}</span>
      </div>

      {/* Webview */}
      <div className={`${styles.webviewContainer} ${mobileMode ? styles.webviewMobile : ''}`}>
        {hasUrl ? (
          <webview
            ref={webviewRef}
            src={url ?? undefined}
            allowpopups={true}
            style={{ ...webviewStyle, display: loadError ? 'none' : undefined }}
          />
        ) : null}
        {hasUrl && isLoading && !loadError && (
          <div className={styles.loadingOverlay}>
            <div className={styles.loadingCard}>
              <div className={styles.loadingSpinner} />
              <div className={styles.loadingText}>Loading preview…</div>
            </div>
          </div>
        )}
        {!hasUrl && (
          <div className={styles.emptyState}>
            <div className={styles.emptyStateEyebrow}>Workspace Preview</div>
            <div className={styles.emptyStateTitle}>Open a site beside the chat</div>
            <div className={styles.emptyStateCopy}>
              Paste a localhost URL, open a deployed page, or let the assistant launch a dev server and send it here.
            </div>
            <div className={styles.emptyStateActions}>
              <button className={styles.emptyStateAction} onClick={() => { setDisplayUrl('http://localhost:3000'); onNavigate('http://localhost:3000'); }}>
                localhost:3000
              </button>
              <button className={styles.emptyStateAction} onClick={() => { setDisplayUrl('http://localhost:5173'); onNavigate('http://localhost:5173'); }}>
                localhost:5173
              </button>
              <button className={styles.emptyStateAction} onClick={() => { setDisplayUrl('http://localhost:4173'); onNavigate('http://localhost:4173'); }}>
                localhost:4173
              </button>
            </div>
          </div>
        )}
        {loadError && (
          <div className={styles.loadError}>
            <div className={styles.loadErrorIcon}>!</div>
            <div className={styles.loadErrorTitle}>Can't reach this page</div>
            <div className={styles.loadErrorDetail}>{loadError}</div>
            <button className={styles.loadErrorRetry} onClick={reload}>
              Try again
            </button>
          </div>
        )}
      </div>

      {/* Console panel */}
      <div className={styles.consoleBar}>
        <button
          className={`${styles.consoleToggle} ${consoleOpen ? styles.consoleToggleActive : ''}`}
          onClick={() => setConsoleOpen((v) => !v)}
        >
          <HugeiconsIcon icon={ConsoleIcon} size={14} strokeWidth={1.5} />
          <span>Console</span>
          {consoleEntries.filter((e) => e.level === 'error').length > 0 && (
            <span className={styles.consoleBadge}>
              {consoleEntries.filter((e) => e.level === 'error').length}
            </span>
          )}
        </button>
        {consoleOpen && (
          <div className={styles.consoleFilters}>
            {(['all', 'error', 'warn'] as const).map((f) => (
              <button
                key={f}
                className={`${styles.consoleFilterBtn} ${consoleFilter === f ? styles.consoleFilterBtnActive : ''}`}
                onClick={() => setConsoleFilter(f)}
              >
                {f}
              </button>
            ))}
            <button
              className={styles.consoleFilterBtn}
              onClick={() => setConsoleEntries([])}
              title="Clear console"
            >
              clear
            </button>
          </div>
        )}
      </div>
      {consoleOpen && (
        <div className={styles.consolePanel} ref={consoleScrollRef}>
          {filteredConsole.length === 0 ? (
            <div className={styles.consoleEmpty}>No console output</div>
          ) : (
            filteredConsole.map((entry, i) => (
              <div
                key={i}
                className={`${styles.consoleLine} ${entry.level === 'error' ? styles.consoleError : ''} ${entry.level === 'warn' ? styles.consoleWarn : ''}`}
              >
                <span className={styles.consoleTime}>
                  {new Date(entry.timestamp).toLocaleTimeString([], {
                    hour: '2-digit',
                    minute: '2-digit',
                    second: '2-digit',
                  })}
                </span>
                <span className={styles.consoleText}>{entry.text}</span>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
