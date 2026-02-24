import { MessageType, type FramedMessage } from "../types/protocol.js";
import type { PeerConnection } from "../p2p/connection-manager.js";
import { encodeFrame } from "../p2p/message-protocol.js";
import {
  encodeHttpRequest,
  decodeHttpRequest,
  encodeHttpResponse,
  decodeHttpResponse,
  encodeHttpResponseChunk,
  decodeHttpResponseChunk,
} from "./request-codec.js";
import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
} from "../types/http.js";

type ResponseHandler = (response: SerializedHttpResponse) => void;
type ChunkHandler = (chunk: SerializedHttpResponseChunk) => void;
type RequestHandler = (request: SerializedHttpRequest) => void | Promise<void>;

/**
 * Request/response multiplexer over DataChannel.
 * Handles both buyer-side and seller-side proxy communication.
 */
export class ProxyMux {
  private readonly _connection: PeerConnection;
  private _messageIdCounter = 0;

  // Buyer side: pending requests awaiting responses
  private readonly _responseHandlers = new Map<string, ResponseHandler>();
  private readonly _chunkHandlers = new Map<string, ChunkHandler>();

  // Seller side: handler for incoming proxy requests
  private _requestHandler: RequestHandler | null = null;

  constructor(connection: PeerConnection) {
    this._connection = connection;
  }

  /** Buyer side: send a proxy request and register response/chunk handlers. */
  sendProxyRequest(
    request: SerializedHttpRequest,
    onResponse: ResponseHandler,
    onChunk: ChunkHandler
  ): void {
    this._responseHandlers.set(request.requestId, onResponse);
    this._chunkHandlers.set(request.requestId, onChunk);

    const payload = encodeHttpRequest(request);
    const frame = encodeFrame({
      type: MessageType.HttpRequest,
      messageId: this._nextMessageId(),
      payload,
    });

    this._connection.send(frame);
  }

  /** Buyer side: cancel handlers for an in-flight request. */
  cancelProxyRequest(requestId: string): void {
    this._responseHandlers.delete(requestId);
    this._chunkHandlers.delete(requestId);
  }

  /** Seller side: register a handler for incoming proxy requests. */
  onProxyRequest(handler: RequestHandler): void {
    this._requestHandler = handler;
  }

  /** Seller side: send a complete proxy response. */
  sendProxyResponse(response: SerializedHttpResponse): void {
    const payload = encodeHttpResponse(response);
    const frame = encodeFrame({
      type: MessageType.HttpResponse,
      messageId: this._nextMessageId(),
      payload,
    });

    this._connection.send(frame);
  }

  /** Seller side: send a proxy response chunk. */
  sendProxyChunk(chunk: SerializedHttpResponseChunk): void {
    const type = chunk.done
      ? MessageType.HttpResponseEnd
      : MessageType.HttpResponseChunk;

    const payload = encodeHttpResponseChunk(chunk);
    const frame = encodeFrame({
      type,
      messageId: this._nextMessageId(),
      payload,
    });

    this._connection.send(frame);
  }

  /** Route an incoming frame to the correct handler based on message type. */
  async handleFrame(frame: FramedMessage): Promise<void> {
    try {
      switch (frame.type) {
        case MessageType.HttpRequest: {
          // Seller side: incoming request from buyer
          if (this._requestHandler) {
            const request = decodeHttpRequest(frame.payload);
            await this._requestHandler(request);
          }
          break;
        }
        case MessageType.HttpResponse: {
          // Buyer side: complete response from seller
          const response = decodeHttpResponse(frame.payload);
          const handler = this._responseHandlers.get(response.requestId);
          if (handler) {
            this._responseHandlers.delete(response.requestId);
            this._chunkHandlers.delete(response.requestId);
            handler(response);
          }
          break;
        }
        case MessageType.HttpResponseChunk: {
          // Buyer side: streaming chunk from seller
          const chunk = decodeHttpResponseChunk(frame.payload);
          const chunkHandler = this._chunkHandlers.get(chunk.requestId);
          if (chunkHandler) {
            chunkHandler(chunk);
          }
          break;
        }
        case MessageType.HttpResponseEnd: {
          // Buyer side: final chunk (done=true) from seller
          const endChunk = decodeHttpResponseChunk(frame.payload);
          const endHandler = this._chunkHandlers.get(endChunk.requestId);
          if (endHandler) {
            endHandler(endChunk);
            this._responseHandlers.delete(endChunk.requestId);
            this._chunkHandlers.delete(endChunk.requestId);
          }
          break;
        }
        case MessageType.HttpResponseError: {
          // Buyer side: error response from seller
          const errorResponse = decodeHttpResponse(frame.payload);
          const errorHandler = this._responseHandlers.get(errorResponse.requestId);
          if (errorHandler) {
            this._responseHandlers.delete(errorResponse.requestId);
            this._chunkHandlers.delete(errorResponse.requestId);
            errorHandler(errorResponse);
          }
          break;
        }
        default:
          // Unknown message type — ignore
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to handle proxy frame type ${frame.type}: ${message}`);
    }
  }

  /** Number of in-flight requests (buyer side). */
  activeRequestCount(): number {
    return this._responseHandlers.size;
  }

  private _nextMessageId(): number {
    const id = this._messageIdCounter;
    this._messageIdCounter = (this._messageIdCounter + 1) & 0xFFFFFFFF;
    return id;
  }
}
