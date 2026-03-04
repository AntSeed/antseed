import { NetworkPoller } from './poller.js';
import { createServer } from './server.js';

const PORT = parseInt(process.env['PORT'] ?? '4000', 10);
const CACHE_PATH = process.env['CACHE_PATH'];

const poller = new NetworkPoller(CACHE_PATH);
const server = createServer(poller, PORT);

await server.start();
await poller.start();

// Graceful shutdown
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

function shutdown(): void {
  console.log('[network-stats] shutting down...');
  poller.stop();
  server.stop();
  process.exit(0);
}
