/**
 * Custom Electron protocol for serving chat attachments.
 *
 * URL shape:
 *   antseed-attachment://<conversationId>/<attachmentId>
 *
 * The scheme is registered as privileged (standard + secure) so the
 * browser engine renders PDFs, HTML, SVG and images natively — no base64
 * round-tripping through IPC.
 *
 * For HTML responses we inject a Content-Security-Policy that forbids
 * script execution and external fetches. Combined with `sandbox=""` on
 * the iframe in the renderer this keeps user-authored HTML inert.
 *
 * URL parsing lives in `attachment-protocol-url.ts` so it can be unit
 * tested without the Electron runtime.
 */
import { net, protocol } from 'electron';
import { pathToFileURL } from 'node:url';
import { resolveAttachmentPath } from './attachment-store.js';
import { ATTACHMENT_SCHEME, parseAttachmentUrl } from './attachment-protocol-url.js';

export { ATTACHMENT_SCHEME, parseAttachmentUrl } from './attachment-protocol-url.js';

/**
 * Must be called *before* `app.whenReady()` — Electron requires privileged
 * schemes to be registered at import time.
 */
export function registerAttachmentScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ATTACHMENT_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
      },
    },
  ]);
}

/**
 * Wire the actual request handler. Must run after `app.whenReady()`.
 * `resolveRootDir` lets integration tests point at a temp attachments
 * root without touching `CHAT_DATA_DIR`; production callers leave it
 * undefined.
 */
export function installAttachmentProtocol(options: { resolveRootDir?: () => string | undefined } = {}): void {
  protocol.handle(ATTACHMENT_SCHEME, async (request) => handleAttachmentRequest(request, options.resolveRootDir?.()));
}

/**
 * Handler body, extracted for clarity and so future integration tests can
 * exercise it with a synthetic `Request` once an Electron test harness
 * exists.
 */
export async function handleAttachmentRequest(request: Request, rootDir?: string): Promise<Response> {
  const parsed = parseAttachmentUrl(request.url);
  if (!parsed) {
    return new Response('Bad request', { status: 400 });
  }
  const resolved = await resolveAttachmentPath(
    parsed.conversationId,
    parsed.attachmentId,
    rootDir ? { rootDir } : {},
  );
  if (!resolved) {
    return new Response('Not found', { status: 404 });
  }
  let response: Response;
  try {
    response = await net.fetch(pathToFileURL(resolved).toString());
  } catch {
    return new Response('Internal error', { status: 500 });
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.startsWith('text/html')) {
    // Re-wrap the response so we can attach a tight CSP and disable
    // sniffing. Combined with `sandbox=""` on the renderer-side iframe,
    // this keeps user-authored HTML inert.
    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    headers.set(
      'Content-Security-Policy',
      "default-src 'none'; img-src 'self' data: blob:; style-src 'unsafe-inline'; font-src data:",
    );
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(body, { status: response.status, headers });
  }
  // For every other response type (plain text, JSON, source, images,
  // PDFs) we forbid MIME sniffing so Chromium can't reclassify a text
  // payload as HTML and start executing scripts from it.
  if (!response.headers.has('X-Content-Type-Options')) {
    const headers = new Headers(response.headers);
    headers.set('X-Content-Type-Options', 'nosniff');
    const body = await response.arrayBuffer();
    return new Response(body, { status: response.status, headers });
  }
  return response;
}
