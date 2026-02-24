# antseed-dashboard

Web dashboard for monitoring and configuring an Antseed node. Provides real-time status, peer discovery, and session tracking via a Fastify server with WebSocket support.

## Usage

The dashboard is typically started through the CLI:

```bash
antseed dashboard
```

Or programmatically:

```ts
import { createDashboardServer } from 'antseed-dashboard';

const server = await createDashboardServer({
  port: 3000,
  node: antseedNode,
});
```

## Key Exports

- `createDashboardServer()` -- Creates and configures the Fastify server
- `getNodeStatus()` -- Retrieve current node status
- `broadcastEvent()` -- Broadcast events to connected WebSocket clients
- `getConnectedClientCount()` -- Count active WebSocket connections

## Architecture

- **Server**: Fastify with CORS, static file serving, and WebSocket support
- **API Routes**: RESTful endpoints for node status, peer info, and configuration
- **WebSocket**: Real-time event streaming to the frontend
- **DHT Queries**: Service layer for DHT peer discovery
- **Frontend**: Separate React app in `web/` (built with `npm run build:web`)

## Development

```bash
pnpm run build        # Build server
pnpm run build:web    # Build frontend (cd web && npm install && npm run build)
pnpm run build:all    # Build both
```
