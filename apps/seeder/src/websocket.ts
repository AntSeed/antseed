import { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import type { WebSocket } from 'ws';

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

const clients = new Set<WebSocket>();

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

    socket.send(
      JSON.stringify({
        type: 'status_change',
        data: { connected: true },
        timestamp: Date.now(),
      } satisfies WsEvent)
    );
  });
}

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
