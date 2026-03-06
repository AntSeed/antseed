export const ANTSEED_STREAMING_RESPONSE_HEADER = 'x-antseed-streaming';
/** Marker header set on HttpRequest frames whose body is sent via HttpRequestChunk/End frames. */
export const ANTSEED_UPLOAD_CHUNK_HEADER = 'x-antseed-upload';
/**
 * Maximum size of a request body that can be sent as a single request frame.
 * Larger bodies are sent as chunked upload frames.
 */
export const ANTSEED_UPLOAD_THRESHOLD_BYTES = 256 * 1024;
/**
 * Maximum size of each chunk when sending chunked request uploads.
 * Kept small for cross-peer RTC compatibility where max message size can vary
 * across environments.
 */
export const ANTSEED_UPLOAD_CHUNK_SIZE = 8 * 1024;

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
