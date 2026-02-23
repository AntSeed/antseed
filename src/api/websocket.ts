import { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';

/** Event types pushed to the dashboard via WebSocket */
export type WsEventType =
  | 'peer_connected'
  | 'peer_disconnected'
  | 'session_started'
  | 'session_ended'
  | 'earnings_update'
  | 'status_change'
  | 'network_peers_updated';

export interface WsEvent {
  type: WsEventType;
  data: unknown;
  timestamp: number;
}

/** Set of connected WebSocket clients */
const clients = new Set<WebSocket>();

/**
 * Register the WebSocket endpoint on the Fastify server.
 * Dashboard connects to ws://localhost:{port}/ws
 */
export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  await app.register(fastifyWebsocket);

  app.get('/ws', { websocket: true }, (socket, _req) => {
    clients.add(socket);

    socket.on('close', () => {
      clients.delete(socket);
    });

    socket.on('error', () => {
      clients.delete(socket);
    });

    // Send initial connection confirmation
    socket.send(
      JSON.stringify({
        type: 'status_change',
        data: { connected: true },
        timestamp: Date.now(),
      } satisfies WsEvent)
    );
  });
}

/**
 * Broadcast an event to all connected dashboard WebSocket clients.
 * Called by the daemon when state changes occur.
 *
 * @param event - The event to broadcast
 */
export function broadcastEvent(event: WsEvent): void {
  const message = JSON.stringify(event);
  for (const client of clients) {
    if (client.readyState === client.OPEN) {
      try {
        client.send(message);
      } catch {
        clients.delete(client);
      }
    }
  }
}

/**
 * Get the number of connected dashboard clients.
 */
export function getConnectedClientCount(): number {
  return clients.size;
}
