import { randomUUID } from 'node:crypto'
import { nativeVideoAcceptance, type NativeVideoRoute, type SerializedHttpResponse } from '@antseed/api-adapter'
import type { ResourceRoutes } from './resource-routes.js'

// Video creates are charged when the seller accepts the job. If that acceptance
// response is lost, a retry must carry the same key so the seller can return the
// stored acceptance instead of creating and charging a second job. The buyer
// proxy assigns the key because native video clients do not send one.
export const VIDEO_IDEMPOTENCY_KEY_HEADER = 'x-antseed-idempotency-key'
const VIDEO_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/

export interface VideoRequestError {
  statusCode: number
  body: { error: { code: string; message: string } }
}

/**
 * Prepares a native video request before seller selection.
 *
 * A create may go to any seller that serves the model and gets an idempotency
 * key for safe client retries. Status and cancel must go back to the exact
 * seller, provider and service that accepted the job, because only that seller
 * knows the job ID.
 */
export function prepareVideoRequest(
  route: NativeVideoRoute,
  headers: Record<string, string>,
  routes: ResourceRoutes,
): { headers: Record<string, string> } | { error: VideoRequestError } {
  if (route.action === 'create') {
    const suppliedKey = (headers[VIDEO_IDEMPOTENCY_KEY_HEADER] ?? headers['idempotency-key'])?.trim()
    if (suppliedKey !== undefined && !VIDEO_IDEMPOTENCY_KEY_PATTERN.test(suppliedKey)) {
      return { error: { statusCode: 400, body: { error: { code: 'invalid_idempotency_key', message: 'Idempotency key must be 1-128 characters of [A-Za-z0-9._:-]' } } } }
    }
    return { headers: { ...headers, [VIDEO_IDEMPOTENCY_KEY_HEADER]: suppliedKey || randomUUID() } }
  }
  const job = routes.resolve(route.protocol, route.resourceId!)
  if (!job) {
    return { error: { statusCode: 404, body: { error: { code: 'video_route_not_found', message: 'Unknown video job' } } } }
  }
  return {
    headers: {
      ...headers,
      'x-antseed-pin-peer': job.sellerPeerId,
      'x-antseed-provider': job.provider,
      'x-antseed-service': job.service,
    },
  }
}

/**
 * Tags a seller's video response for the client and remembers which seller
 * accepted a new job, so later status and cancel requests route back to it.
 * Returns true when a new job route was recorded and should be persisted.
 */
export function recordVideoAcceptance(
  route: NativeVideoRoute,
  requestHeaders: Record<string, string>,
  response: SerializedHttpResponse,
  seller: { peerId: string; provider: string; service: string | null },
  routes: ResourceRoutes,
): boolean {
  response.headers['x-antseed-seller-peer'] = seller.peerId
  if (route.action !== 'create') return false
  response.headers[VIDEO_IDEMPOTENCY_KEY_HEADER] = requestHeaders[VIDEO_IDEMPOTENCY_KEY_HEADER]!
  const resourceId = nativeVideoAcceptance(route.protocol, response)
  if (!resourceId || !seller.service) return false
  routes.record({ protocol: route.protocol, resourceId, sellerPeerId: seller.peerId.toLowerCase(), provider: seller.provider, service: seller.service })
  return true
}
