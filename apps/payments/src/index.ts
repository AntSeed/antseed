import { pathToFileURL } from 'node:url';
import { createServer } from './server.js';

export { createServer } from './server.js';
export type { PaymentsServerOptions } from './server.js';

const DEFAULT_PORT = 3118;

// Only auto-start when this file is the process entry point (not when the
// CLI imports it as a library). Compare the module URL with argv[1] resolved
// as a file:// URL — the standard ESM "main module" check.
const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(process.argv[1]).href
  : false;

if (isMain) {
  const port = Number(process.env['ANTSEED_PAYMENTS_PORT']) || DEFAULT_PORT;
  const dataDir = process.env['ANTSEED_DATA_DIR'] || undefined;
  const identityHex = process.env['ANTSEED_IDENTITY_HEX'] || undefined;

  createServer({ port, dataDir, identityHex }).then(async (server) => {
    await server.listen({ port, host: '127.0.0.1' });
    console.log(`[payments] Portal running at http://127.0.0.1:${port}`);
  }).catch((err) => {
    console.error('[payments] Failed to start:', err);
    process.exit(1);
  });
}
