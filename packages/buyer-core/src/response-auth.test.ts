import { keccak256 } from 'ethers'
import { describe, expect, it } from 'vitest'
import { ANTSEED_STREAMING_RESPONSE_HEADER } from '@antseed/protocol/http'
import {
  hashRequest,
  hashResponse,
  responseAuthRequestPreimage,
  responseAuthResponsePreimage,
} from './response-auth.js'

describe('ResponseAuth preimages', () => {
  it('reproduce the request and response hashes used by ResponseAuth', () => {
    const request = {
      requestId: 'request-1',
      method: 'POST',
      path: '/v1/chat/completions',
      headers: { 'content-type': 'application/json' },
      body: new TextEncoder().encode('{"model":"model-a"}'),
    }
    const response = {
      requestId: request.requestId,
      statusCode: 200,
      headers: {
        'content-type': 'application/json',
        [ANTSEED_STREAMING_RESPONSE_HEADER]: '1',
      },
      body: new TextEncoder().encode('{"choices":[]}'),
    }

    expect(keccak256(responseAuthRequestPreimage(request))).toBe(hashRequest(request))
    expect(keccak256(responseAuthResponsePreimage(response))).toBe(hashResponse(response))
  })
})
