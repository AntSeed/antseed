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
  encodeHttpRequestChunk,
  decodeHttpRequestChunk,
} from "./request-codec.js";
import {
  ANTSEED_STREAMING_RESPONSE_HEADER,
  ANTSEED_UPLOAD_CHUNK_HEADER,
  ANTSEED_UPLOAD_THRESHOLD_BYTES,
  ANTSEED_UPLOAD_CHUNK_SIZE,
} from "../types/http.js";
import { debugLog } from "../utils/debug.js";
import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
  SerializedHttpResponseChunk,
} from "../types/http.js";

type ResponseHandler = (
  response: SerializedHttpResponse,
  metadata: { streamingStart: boolean }
) => void;
type ChunkHandler = (chunk: SerializedHttpResponseChunk) => void;
type RequestHandler = (request: SerializedHttpRequest) => void | Promise<void>;

/** Per-request upload size cap, total budget, and stall timeout. */
export interface ProxyMuxUploadLimits {
  /** Max body bytes for a single upload. Default: 32 MiB. Buyer receives 413 on violation. */
  maxUploadBodyBytes?: number;
  /** Max bytes across ALL concurrent in-progress uploads. Default: 256 MiB. */
  maxTotalPendingUploadBytes?: number;
  /** Max ms between the header frame and HttpRequestEnd. Default: 120_000 ms. */
  uploadTimeoutMs?: number;
}

const DEFAULT_MAX_UPLOAD_BODY_BYTES       = 32  * 1024 * 1024; // 32 MiB
const DEFAULT_MAX_TOTAL_PENDING_BYTES     = 256 * 1024 * 1024; // 256 MiB
const DEFAULT_UPLOAD_TIMEOUT_MS           = 120_000;            // 2 min

interface PendingUpload {
  headerReq: SerializedHttpRequest;
  chunks: Uint8Array[];
  byteCount: number;
  timer: ReturnType<typeof setTimeout>;
}

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

  // Seller side: in-progress chunked uploads with size tracking and timeouts
  private readonly _pendingUploads = new Map<string, PendingUpload>();
  private _totalPendingUploadBytes = 0;

  private readonly _maxUploadBodyBytes: number;
  private readonly _maxTotalPendingUploadBytes: number;
  private readonly _uploadTimeoutMs: number;

  constructor(connection: PeerConnection, uploadLimits?: ProxyMuxUploadLimits) {
    this._connection = connection;
    this._maxUploadBodyBytes       = uploadLimits?.maxUploadBodyBytes       ?? DEFAULT_MAX_UPLOAD_BODY_BYTES;
    this._maxTotalPendingUploadBytes = uploadLimits?.maxTotalPendingUploadBytes ?? DEFAULT_MAX_TOTAL_PENDING_BYTES;
    this._uploadTimeoutMs          = uploadLimits?.uploadTimeoutMs          ?? DEFAULT_UPLOAD_TIMEOUT_MS;
  }

  /** Buyer side: send a proxy request and register response/chunk handlers. */
  sendProxyRequest(
    request: SerializedHttpRequest,
    onResponse: ResponseHandler,
    onChunk: ChunkHandler
  ): void {
    const useChunkedUpload = request.body.length > ANTSEED_UPLOAD_THRESHOLD_BYTES;
    debugLog(
      `[ProxyMux] send request reqId=${request.requestId.slice(0, 8)} bytes=${request.body.length} chunked=${useChunkedUpload ? "true" : "false"}`,
    );
    this._responseHandlers.set(request.requestId, onResponse);
    this._chunkHandlers.set(request.requestId, onChunk);

    if (useChunkedUpload) {
      this._sendChunkedRequest(request);
    } else {
      const payload = encodeHttpRequest(request);
      this._connection.send(encodeFrame({
        type: MessageType.HttpRequest,
        messageId: this._nextMessageId(),
        payload,
      }));
    }
  }

  /** Buyer side: split a large request body into HttpRequest + HttpRequestChunk* + HttpRequestEnd. */
  private _sendChunkedRequest(request: SerializedHttpRequest): void {
    // Header frame: metadata only, empty body, upload marker
    const headerRequest: SerializedHttpRequest = {
      ...request,
      headers: { ...request.headers, [ANTSEED_UPLOAD_CHUNK_HEADER]: 'chunked' },
      body: new Uint8Array(0),
    };
    this._connection.send(encodeFrame({
      type: MessageType.HttpRequest,
      messageId: this._nextMessageId(),
      payload: encodeHttpRequest(headerRequest),
    }));

    // Stream body in ANTSEED_UPLOAD_CHUNK_SIZE slices
    const body = request.body;
    let offset = 0;
    while (offset < body.length) {
      const end = Math.min(offset + ANTSEED_UPLOAD_CHUNK_SIZE, body.length);
      const isLast = end >= body.length;
      const payload = encodeHttpRequestChunk({
        requestId: request.requestId,
        data: body.slice(offset, end),
        done: isLast,
      });
      this._connection.send(encodeFrame({
        type: isLast ? MessageType.HttpRequestEnd : MessageType.HttpRequestChunk,
        messageId: this._nextMessageId(),
        payload,
      }));
      offset = end;
    }
  }

  /** Buyer side: cancel handlers for an in-flight request. */
  cancelProxyRequest(requestId: string): void {
    debugLog(`[ProxyMux] cancel request reqId=${requestId.slice(0, 8)}`);
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
          const request = decodeHttpRequest(frame.payload);
          debugLog(
            `[ProxyMux] recv request reqId=${request.requestId.slice(0, 8)} chunked=${request.headers[ANTSEED_UPLOAD_CHUNK_HEADER] === 'chunked' ? "true" : "false"} bodyBytes=${request.body.length}`,
          );
          if (request.headers[ANTSEED_UPLOAD_CHUNK_HEADER] === 'chunked') {
            // Body will arrive via HttpRequestChunk/HttpRequestEnd — start buffering.
            // If a duplicate header frame arrives for the same requestId, evict the
            // existing entry first to prevent timer leaks and accounting drift.
            const existing = this._pendingUploads.get(request.requestId);
            if (existing) {
              clearTimeout(existing.timer);
              this._totalPendingUploadBytes -= existing.byteCount;
              for (const c of existing.chunks) c.fill(0);
            }
            const timer = setTimeout(
              () => this._abortUpload(request.requestId, 408, 'Upload timed out'),
              this._uploadTimeoutMs,
            );
            this._pendingUploads.set(request.requestId, {
              headerReq: request,
              chunks: [],
              byteCount: 0,
              timer,
            });
          } else if (this._requestHandler) {
            await this._requestHandler(request);
          }
          break;
        }
        case MessageType.HttpRequestChunk: {
          // Seller side: non-final body chunk of a chunked upload
          const chunk = decodeHttpRequestChunk(frame.payload);
          const entry = this._pendingUploads.get(chunk.requestId);
          if (!entry || chunk.data.length === 0) break;
          debugLog(
            `[ProxyMux] recv request chunk reqId=${chunk.requestId.slice(0, 8)} bytes=${chunk.data.length} pending=${entry.byteCount + chunk.data.length}`,
          );

          // Per-request size guard
          if (entry.byteCount + chunk.data.length > this._maxUploadBodyBytes) {
            this._abortUpload(chunk.requestId, 413, 'Upload body exceeds per-request limit');
            break;
          }
          // Global budget guard
          if (this._totalPendingUploadBytes + chunk.data.length > this._maxTotalPendingUploadBytes) {
            this._abortUpload(chunk.requestId, 413, 'Server upload capacity exceeded');
            break;
          }

          entry.chunks.push(chunk.data);
          entry.byteCount += chunk.data.length;
          this._totalPendingUploadBytes += chunk.data.length;
          break;
        }
        case MessageType.HttpRequestEnd: {
          // Seller side: final body chunk — reassemble, zero intermediates, dispatch
          const chunk = decodeHttpRequestChunk(frame.payload);
          const entry = this._pendingUploads.get(chunk.requestId);
          if (!entry) break;
          debugLog(
            `[ProxyMux] recv request end reqId=${chunk.requestId.slice(0, 8)} finalBytes=${chunk.data.length} pendingBefore=${entry.byteCount}`,
          );

          // Check final chunk against limits
          const finalLen = chunk.data.length;
          if (finalLen > 0) {
            if (entry.byteCount + finalLen > this._maxUploadBodyBytes) {
              this._abortUpload(chunk.requestId, 413, 'Upload body exceeds per-request limit');
              break;
            }
            if (this._totalPendingUploadBytes + finalLen > this._maxTotalPendingUploadBytes) {
              this._abortUpload(chunk.requestId, 413, 'Server upload capacity exceeded');
              break;
            }
            entry.chunks.push(chunk.data);
            entry.byteCount += finalLen;
            this._totalPendingUploadBytes += finalLen;
          }

          // Clean up tracking state
          clearTimeout(entry.timer);
          this._pendingUploads.delete(chunk.requestId);
          this._totalPendingUploadBytes -= entry.byteCount;

          if (this._requestHandler) {
            const body = _concatChunks(entry.chunks);
            // Zero intermediates — reduces the window for sensitive data in RAM
            for (const c of entry.chunks) c.fill(0);
            entry.chunks.length = 0;

            const { [ANTSEED_UPLOAD_CHUNK_HEADER]: _marker, ...cleanHeaders } = entry.headerReq.headers;
            await this._requestHandler({ ...entry.headerReq, headers: cleanHeaders, body });
          }
          break;
        }
        case MessageType.HttpResponse: {
          // Buyer side: response from seller (start frame for streams).
          const response = decodeHttpResponse(frame.payload);
          debugLog(
            `[ProxyMux] recv response reqId=${response.requestId.slice(0, 8)} status=${response.statusCode} bytes=${response.body.length} streamingStart=${response.headers[ANTSEED_STREAMING_RESPONSE_HEADER] === '1' ? "true" : "false"}`,
          );
          const handler = this._responseHandlers.get(response.requestId);
          if (handler) {
            const streamingStart = response.headers[ANTSEED_STREAMING_RESPONSE_HEADER] === '1';
            if (!streamingStart) {
              this._responseHandlers.delete(response.requestId);
              this._chunkHandlers.delete(response.requestId);
            }
            handler(response, { streamingStart });
          }
          break;
        }
        case MessageType.HttpResponseChunk: {
          // Buyer side: streaming chunk from seller
          const chunk = decodeHttpResponseChunk(frame.payload);
          debugLog(
            `[ProxyMux] recv response chunk reqId=${chunk.requestId.slice(0, 8)} bytes=${chunk.data.length} done=${chunk.done ? "true" : "false"}`,
          );
          const chunkHandler = this._chunkHandlers.get(chunk.requestId);
          if (chunkHandler) {
            chunkHandler(chunk);
          }
          break;
        }
        case MessageType.HttpResponseEnd: {
          // Buyer side: final chunk (done=true) from seller
          const endChunk = decodeHttpResponseChunk(frame.payload);
          debugLog(
            `[ProxyMux] recv response end reqId=${endChunk.requestId.slice(0, 8)} bytes=${endChunk.data.length}`,
          );
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
            errorHandler(errorResponse, { streamingStart: false });
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

  /** Number of in-progress chunked uploads buffered on the seller side. */
  pendingUploadCount(): number {
    return this._pendingUploads.size;
  }

  /** Total bytes currently buffered across all in-progress uploads. */
  pendingUploadBytes(): number {
    return this._totalPendingUploadBytes;
  }

  /**
   * Seller side: abort and discard all buffered chunked-upload state.
   * Call on connection close or session end to prevent memory leaks.
   * Zeros all buffered chunk data before discarding.
   */
  abortPendingUploads(): void {
    for (const entry of this._pendingUploads.values()) {
      clearTimeout(entry.timer);
      for (const c of entry.chunks) c.fill(0);
    }
    this._pendingUploads.clear();
    this._totalPendingUploadBytes = 0;
  }

  /**
   * Abort a single in-progress upload, zero its buffers, and send an error
   * response to the buyer.
   */
  private _abortUpload(requestId: string, statusCode: number, reason: string): void {
    const entry = this._pendingUploads.get(requestId);
    if (!entry) return;

    clearTimeout(entry.timer);
    this._totalPendingUploadBytes -= entry.byteCount;
    for (const c of entry.chunks) c.fill(0);
    this._pendingUploads.delete(requestId);

    this.sendProxyResponse({
      requestId,
      statusCode,
      headers: { 'content-type': 'text/plain' },
      body: new TextEncoder().encode(reason),
    });
  }

  private _nextMessageId(): number {
    const id = this._messageIdCounter;
    this._messageIdCounter = (this._messageIdCounter + 1) & 0xFFFFFFFF;
    return id;
  }
}

function _concatChunks(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array(0);
  if (chunks.length === 1) return chunks[0]!.slice();
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}
