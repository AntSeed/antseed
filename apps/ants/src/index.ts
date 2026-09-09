import { pathToFileURL } from 'node:url';
import { createAntsServer } from './server.js';

export { createAntsServer, resolveAntsChain } from './server.js';
export type { AntsServer, AntsServerOptions } from './server.js';
export * from './service/index.js';

const DEFAULT_PORT = 3119;

const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;

if (isMain) {
  const port = Number(process.env['ANTSEED_ANTS_PORT']) || DEFAULT_PORT;
  createAntsServer({ port, dataDir: process.env['ANTSEED_DATA_DIR'] || undefined }).then(async (server) => {
    const url = await server.listen();
    console.log(`[ants] Dashboard running at ${url}`);
  }).catch((error) => {
    console.error('[ants] Failed to start:', error);
    process.exit(1);
  });
}
