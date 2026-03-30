import { createServer } from './server.js';

export { createServer } from './server.js';
export type { PaymentsServerOptions } from './server.js';

const DEFAULT_PORT = 3118;

// Only auto-start if this file is the entry point (not imported as a library)
const isMain = process.argv[1]?.endsWith('index.js') || process.argv[1]?.endsWith('index.ts');

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
