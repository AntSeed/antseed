export const ANTSEED_STREAMING_RESPONSE_HEADER = 'x-antseed-streaming';
/** Marker header set on HttpRequest frames whose body is sent via HttpRequestChunk/End frames. */
export const ANTSEED_UPLOAD_CHUNK_HEADER = 'x-antseed-upload';
/** Body size threshold above which ProxyMux automatically switches to chunked upload (1 MiB). */
export const ANTSEED_UPLOAD_CHUNK_SIZE = 1 * 1024 * 1024;

export interface SerializedHttpRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface SerializedHttpResponse {
  requestId: string;
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface SerializedHttpResponseChunk {
  requestId: string;
  data: Uint8Array;
  done: boolean;
}

export interface SerializedHttpRequestChunk {
  requestId: string;
  data: Uint8Array;
  done: boolean;
}
