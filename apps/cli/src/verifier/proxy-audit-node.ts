import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  BuyerResponsePaymentEvidence,
  PeerInfo,
  SerializedHttpRequest,
  SerializedHttpResponse,
  StoredResponseAuth,
} from '@antseed/node'
import {
  BUYER_AUDIT_EXECUTE_PATH,
  BUYER_AUDIT_IDENTITY_PATH,
  BUYER_AUDIT_TOKEN_FILENAME,
  decodeSerializedHttpResponse,
  encodeSerializedHttpRequest,
  type BuyerAuditExecuteResponse,
  type BuyerAuditIdentity,
} from '../proxy/audit-protocol.js'
import type { DirectAuditNode } from './audit-runner.js'

interface StoredProxyAuditExecution {
  peerId: string
  responseAuth: StoredResponseAuth | null
  payment: BuyerResponsePaymentEvidence | null
  failure: BuyerAuditExecuteResponse['failure']
}

export interface ProxyDirectAuditNodeOptions {
  baseUrl?: string
  token?: string
  tokenFile?: string
  responseAuthTimeoutMs?: number
}

export class ProxyDirectAuditNode implements DirectAuditNode {
  readonly identity: BuyerAuditIdentity
  private readonly baseUrl: string
  private readonly token: string
  private readonly responseAuthTimeoutMs: number
  private readonly executions = new Map<string, StoredProxyAuditExecution>()

  private constructor(baseUrl: string, token: string, identity: BuyerAuditIdentity, responseAuthTimeoutMs: number) {
    this.baseUrl = baseUrl
    this.token = token
    this.identity = identity
    this.responseAuthTimeoutMs = responseAuthTimeoutMs
  }

  static async connect(options: ProxyDirectAuditNodeOptions = {}): Promise<ProxyDirectAuditNode> {
    const baseUrl = normalizeLocalProxyUrl(options.baseUrl ?? 'http://127.0.0.1:8377')
    const token = options.token ?? await loadProxyAuditToken(options.tokenFile)
    const response = await fetch(new URL(BUYER_AUDIT_IDENTITY_PATH, baseUrl), {
      method: 'GET',
      headers: { authorization: `Bearer ${token}` },
    })
    const body = await readJsonResponse(response)
    if (!response.ok || body.ok !== true || !isBuyerAuditIdentity(body.identity)) {
      throw new Error(readProxyError(body, `buyer proxy identity request failed with HTTP ${response.status}`))
    }
    return new ProxyDirectAuditNode(
      baseUrl,
      token,
      body.identity,
      options.responseAuthTimeoutMs ?? 120_000,
    )
  }

  async sendRequest(
    peer: PeerInfo,
    request: SerializedHttpRequest,
    options?: { signal?: AbortSignal },
  ): Promise<SerializedHttpResponse> {
    const response = await fetch(new URL(BUYER_AUDIT_EXECUTE_PATH, this.baseUrl), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        peerId: peer.peerId,
        request: encodeSerializedHttpRequest(request),
        responseAuthTimeoutMs: this.responseAuthTimeoutMs,
      }),
      ...(options?.signal ? { signal: options.signal } : {}),
    })
    const body = await readJsonResponse(response)
    if (!response.ok || !isBuyerAuditExecuteResponse(body)) {
      throw new Error(readProxyError(body, `buyer proxy audit request failed with HTTP ${response.status}`))
    }
    this.assertIdentity(body.identity)
    if (body.peerId !== peer.peerId) throw new Error('buyer proxy returned evidence for a different peer')
    const payment = body.payment ? {
      sellerChargeUsdc: BigInt(body.payment.sellerChargeUsdc),
      spendingAuth: body.payment.spendingAuth,
    } : null
    this.executions.set(request.requestId, {
      peerId: body.peerId,
      responseAuth: body.responseAuth,
      payment,
      failure: body.failure,
    })
    if (!body.response) {
      throw new Error(body.failure?.message ?? 'buyer proxy returned no response')
    }
    return decodeSerializedHttpResponse(body.response)
  }

  async waitForResponseAuth(requestId: string, _timeoutMs = 30_000): Promise<StoredResponseAuth> {
    const execution = this.requireExecution(requestId)
    if (!execution.responseAuth) {
      throw new Error(execution.failure?.message ?? `buyer proxy returned no ResponseAuth for ${requestId}`)
    }
    return execution.responseAuth
  }

  async finalizeResponsePayment(peer: PeerInfo, requestId?: string): Promise<BuyerResponsePaymentEvidence> {
    if (!requestId) throw new Error('requestId is required for proxy audit payment finalization')
    const execution = this.requireExecution(requestId)
    if (execution.peerId !== peer.peerId) throw new Error('buyer proxy payment peer mismatch')
    if (!execution.payment) {
      throw new Error(execution.failure?.message ?? `buyer proxy returned no payment evidence for ${requestId}`)
    }
    this.executions.delete(requestId)
    return execution.payment
  }

  private requireExecution(requestId: string): StoredProxyAuditExecution {
    const execution = this.executions.get(requestId)
    if (!execution) throw new Error(`unknown buyer proxy audit request ${requestId}`)
    return execution
  }

  private assertIdentity(identity: BuyerAuditIdentity): void {
    if (identity.address.toLowerCase() !== this.identity.address.toLowerCase()
      || identity.peerId !== this.identity.peerId) {
      throw new Error('buyer proxy identity changed during benchmark execution')
    }
  }
}

export function defaultBuyerAuditTokenPath(): string {
  return join(homedir(), '.antseed', BUYER_AUDIT_TOKEN_FILENAME)
}

async function loadProxyAuditToken(tokenFile?: string): Promise<string> {
  const environmentToken = process.env.ANTSEED_BUYER_PROXY_AUDIT_TOKEN?.trim()
  if (environmentToken) return environmentToken
  const path = tokenFile ?? defaultBuyerAuditTokenPath()
  const token = (await readFile(path, 'utf8')).trim()
  if (!token) throw new Error(`buyer proxy audit token file is empty: ${path}`)
  return token
}

function normalizeLocalProxyUrl(value: string): string {
  const url = new URL(value)
  const hostname = url.hostname.toLowerCase()
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]', '::1'].includes(hostname)) {
    throw new Error('proxy audit transport only supports localhost HTTP URLs')
  }
  url.pathname = '/'
  url.search = ''
  url.hash = ''
  return url.toString()
}

async function readJsonResponse(response: Response): Promise<Record<string, any>> {
  const text = await response.text()
  try {
    return JSON.parse(text) as Record<string, any>
  } catch {
    throw new Error(`buyer proxy returned invalid JSON (HTTP ${response.status})`)
  }
}

function isBuyerAuditIdentity(value: unknown): value is BuyerAuditIdentity {
  if (!value || typeof value !== 'object') return false
  const identity = value as Partial<BuyerAuditIdentity>
  return typeof identity.address === 'string' && identity.address.length > 0
    && typeof identity.peerId === 'string' && identity.peerId.length > 0
}

function isBuyerAuditExecuteResponse(value: Record<string, any>): value is BuyerAuditExecuteResponse {
  return typeof value.ok === 'boolean'
    && isBuyerAuditIdentity(value.identity)
    && typeof value.peerId === 'string'
}

function readProxyError(body: Record<string, any>, fallback: string): string {
  if (typeof body.error === 'string' && body.error.length > 0) return body.error
  if (body.failure && typeof body.failure.message === 'string') return body.failure.message
  return fallback
}
