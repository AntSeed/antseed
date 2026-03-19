/**
 * Monkey-patch window.open for Coinbase SDK popups in Electron.
 *
 * Electron's child BrowserWindows don't support window.opener.postMessage,
 * which the Coinbase Smart Wallet SDK requires. This patch intercepts
 * window.open calls to keys.coinbase.com and opens them in a same-origin
 * iframe overlay instead, which preserves parent.postMessage communication.
 */

const COINBASE_DOMAINS = ['keys.coinbase.com', 'wallet.coinbase.com'];

let overlayContainer: HTMLDivElement | null = null;
let activeIframe: HTMLIFrameElement | null = null;

function isCoinbaseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return COINBASE_DOMAINS.some(d => parsed.hostname.includes(d));
  } catch {
    return false;
  }
}

function createOverlay(): HTMLDivElement {
  if (overlayContainer) return overlayContainer;

  overlayContainer = document.createElement('div');
  overlayContainer.id = 'coinbase-popup-overlay';
  Object.assign(overlayContainer.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    width: '100vw',
    height: '100vh',
    backgroundColor: 'rgba(0, 0, 0, 0.5)',
    zIndex: '99999',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  });

  // Click backdrop to close
  overlayContainer.addEventListener('click', (e) => {
    if (e.target === overlayContainer) {
      closeOverlay();
    }
  });

  document.body.appendChild(overlayContainer);
  return overlayContainer;
}

function closeOverlay(): void {
  if (activeIframe) {
    activeIframe.remove();
    activeIframe = null;
  }
  if (overlayContainer) {
    overlayContainer.remove();
    overlayContainer = null;
  }
}

export function installCoinbasePopupFix(): void {
  const originalOpen = window.open.bind(window);

  window.open = function(
    url?: string | URL,
    target?: string,
    features?: string,
  ): WindowProxy | null {
    const urlStr = url?.toString() || '';

    if (!isCoinbaseUrl(urlStr)) {
      return originalOpen(url, target, features);
    }

    // Create iframe overlay instead of popup
    const overlay = createOverlay();

    const iframe = document.createElement('iframe');
    Object.assign(iframe.style, {
      width: '420px',
      height: '700px',
      border: 'none',
      borderRadius: '16px',
      backgroundColor: '#fff',
    });
    iframe.src = urlStr;
    iframe.allow = 'publickey-credentials-get *; publickey-credentials-create *';

    overlay.appendChild(iframe);
    activeIframe = iframe;

    // Return the iframe's contentWindow as the "popup" reference
    // The Coinbase SDK will call popup.postMessage() on this
    // and the iframe can call parent.postMessage() back (same top-level window)

    // Wait for iframe to load, then return its window
    // For now, return a proxy that forwards postMessage
    let proxyClosed = false;
    const proxy = {
      get closed() { return proxyClosed; },
      focus: () => iframe.focus(),
      close: () => {
        proxyClosed = true;
        closeOverlay();
      },
      postMessage: (message: unknown, targetOrigin: string) => {
        // Forward to iframe once loaded
        try {
          iframe.contentWindow?.postMessage(message, targetOrigin);
        } catch {
          // Cross-origin, expected before load
        }
      },
      // Minimal WindowProxy interface
      location: { href: urlStr },
      opener: window,
    } as unknown as WindowProxy;

    return proxy;
  };

  // Listen for messages from the iframe (Coinbase auth result)
  // The iframe will call parent.postMessage() which arrives here
  // since it's the same top-level window — no relay needed!
}
