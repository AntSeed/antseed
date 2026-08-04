import type {
  BuyerResponsePaymentEvidence,
  SerializedHttpRequest,
  SerializedHttpResponse,
  StoredResponseAuth,
} from '@antseed/node'

export const BUYER_AUDIT_IDENTITY_PATH = '/_antseed/audit/identity'
export const BUYER_AUDIT_EXECUTE_PATH = '/_antseed/audit/execute'
export const BUYER_AUDIT_TOKEN_FILENAME = 'buyer.audit-token'

export interface BuyerAuditIdentity {
  address: string
  peerId: string
}

export interface EncodedSerializedHttpRequest {
  requestId: string
  method: string
  path: string
  headers: Record<string, string>
  bodyBase64: string
}

export interface EncodedSerializedHttpResponse {
  requestId: string
  statusCode: number
  headers: Record<string, string>
  bodyBase64: string
}

export interface BuyerAuditExecuteRequest {
  peerId: string
  request: EncodedSerializedHttpRequest
  responseAuthTimeoutMs: number
}

export type BuyerAuditFailureStage = 'request' | 'response-auth' | 'payment'

export interface BuyerAuditExecuteResponse {
  ok: boolean
  identity: BuyerAuditIdentity
  peerId: string
  response: EncodedSerializedHttpResponse | null
  responseAuth: StoredResponseAuth | null
  payment: {
    sellerChargeUsdc: string
    spendingAuth: BuyerResponsePaymentEvidence['spendingAuth']
  } | null
  failure: {
    stage: BuyerAuditFailureStage
    message: string
  } | null
}

export function encodeSerializedHttpRequest(request: SerializedHttpRequest): EncodedSerializedHttpRequest {
  return {
    requestId: request.requestId,
    method: request.method,
    path: request.path,
    headers: request.headers,
    bodyBase64: Buffer.from(request.body).toString('base64'),
  }
}

export function decodeSerializedHttpRequest(request: EncodedSerializedHttpRequest): SerializedHttpRequest {
  return {
    requestId: request.requestId,
    method: request.method,
    path: request.path,
    headers: request.headers,
    body: new Uint8Array(Buffer.from(request.bodyBase64, 'base64')),
  }
}

export function encodeSerializedHttpResponse(response: SerializedHttpResponse): EncodedSerializedHttpResponse {
  return {
    requestId: response.requestId,
    statusCode: response.statusCode,
    headers: response.headers,
    bodyBase64: Buffer.from(response.body).toString('base64'),
  }
}

export function decodeSerializedHttpResponse(response: EncodedSerializedHttpResponse): SerializedHttpResponse {
  return {
    requestId: response.requestId,
    statusCode: response.statusCode,
    headers: response.headers,
    body: new Uint8Array(Buffer.from(response.bodyBase64, 'base64')),
  }
}
