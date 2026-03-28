import { useEffect, useRef, useCallback, useState } from 'react';

export interface WsEvent {
  type: string;
  data: unknown;
  timestamp: number;
}

type EventHandler = (event: WsEvent) => void;

export function useWebSocket(handlers: Record<string, EventHandler>) {
  const [connected, setConnected] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectRef = useRef<number | null>(null);
  const closedRef = useRef(false);
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  const connect = useCallback(() => {
    if (closedRef.current) return;

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${protocol}//${window.location.host}/ws`);

    ws.onopen = () => { setConnected(true); };

    ws.onmessage = (msg) => {
      try {
        const event: WsEvent = JSON.parse(msg.data);
        const handler = handlersRef.current[event.type];
        if (handler) handler(event);
      } catch { /* ignore malformed */ }
    };

    ws.onclose = () => {
      setConnected(false);
      if (closedRef.current) return;
      reconnectRef.current = window.setTimeout(connect, 3000);
    };

    ws.onerror = () => { ws.close(); };
    wsRef.current = ws;
  }, []);

  useEffect(() => {
    closedRef.current = false;
    connect();
    return () => {
      closedRef.current = true;
      if (reconnectRef.current !== null) {
        window.clearTimeout(reconnectRef.current);
        reconnectRef.current = null;
      }
      wsRef.current?.close();
    };
  }, [connect]);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  return { connected, send };
}
