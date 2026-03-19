/**
 * Preload script for popup windows (Coinbase Smart Wallet auth).
 *
 * Polyfills window.opener.postMessage by relaying messages through
 * Electron IPC back to the parent window. The Coinbase SDK expects
 * window.opener.postMessage() to work, but Electron's child windows
 * don't have a real window.opener reference.
 */
const { ipcRenderer } = require('electron');

// When the page tries to call window.opener.postMessage, relay via IPC
window.addEventListener('DOMContentLoaded', () => {
  // Create a fake window.opener if it doesn't exist
  if (!window.opener) {
    window.opener = {};
  }

  // Override postMessage to relay through IPC
  const originalPostMessage = window.opener.postMessage?.bind(window.opener);
  window.opener.postMessage = function(message, targetOrigin, transfer) {
    // Send via IPC to main process, which forwards to parent window
    ipcRenderer.send('popup-post-message', { message, targetOrigin });
    // Also try the original if it exists
    if (originalPostMessage) {
      try { originalPostMessage(message, targetOrigin, transfer); } catch {}
    }
  };
});

// Listen for messages FROM the parent (forwarded via IPC)
ipcRenderer.on('parent-post-message', (_event, data) => {
  window.postMessage(data.message, '*');
});
