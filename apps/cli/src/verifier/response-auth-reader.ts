import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { VerificationStorage, type StoredResponseAuth } from '@antseed/node'

export const DEFAULT_RESPONSE_AUTH_WAIT_TIMEOUT_MS = 35_000
export const RESPONSE_AUTH_POLL_INTERVAL_MS = 100

export interface ResponseAuthLookup {
  getResponseAuth(requestId: string): StoredResponseAuth | null
}

export interface ResponseAuthEvidenceStatus {
  requestId: string | null
  status: 'verified' | 'missing' | 'invalid'
  responseAuth: StoredResponseAuth | null
  failureReason: string | null
}

export interface ResponseAuthReader {
  waitForVerified(input: {
    requestId: string
    sellerPeerId: string
    advertisedService: string
    timeoutMs?: number
  }): Promise<ResponseAuthEvidenceStatus>
  close(): void
}

export async function openResponseAuthReader(input: {
  dataDir: string
  timeoutMs?: number
  sleepFn?: (delayMs: number) => Promise<void>
}): Promise<ResponseAuthReader> {
  const path = join(input.dataDir, 'verification.db')
  try {
    await access(path)
  } catch {
    throw new Error(`buyer verification database not found at ${path}; start antseed buyer first`)
  }
  const storage = new VerificationStorage(path)
  return createResponseAuthReader(storage, input.timeoutMs, input.sleepFn)
}

export function createResponseAuthReader(
  storage: ResponseAuthLookup & { close?: () => void },
  defaultTimeoutMs = DEFAULT_RESPONSE_AUTH_WAIT_TIMEOUT_MS,
  sleepFn: (delayMs: number) => Promise<void> = sleep,
): ResponseAuthReader {
  return {
    async waitForVerified(input) {
      const timeoutMs = input.timeoutMs ?? defaultTimeoutMs
      const deadline = Date.now() + timeoutMs
      for (;;) {
        const record = storage.getResponseAuth(input.requestId)
        if (record) return validateStoredResponseAuth(record, input)
        if (Date.now() >= deadline) {
          return {
            requestId: input.requestId,
            status: 'missing',
            responseAuth: null,
            failureReason: `ResponseAuth was not persisted within ${timeoutMs}ms`,
          }
        }
        await sleepFn(Math.min(RESPONSE_AUTH_POLL_INTERVAL_MS, Math.max(1, deadline - Date.now())))
      }
    },
    close() {
      storage.close?.()
    },
  }
}

export function validateStoredResponseAuth(
  record: StoredResponseAuth,
  expected: { requestId: string; sellerPeerId: string; advertisedService: string },
): ResponseAuthEvidenceStatus {
  const mismatch = record.requestId !== expected.requestId
    ? `request ID mismatch (${record.requestId} != ${expected.requestId})`
    : normalized(record.sellerPeerId) !== normalized(expected.sellerPeerId)
      ? `seller peer ID mismatch (${record.sellerPeerId} != ${expected.sellerPeerId})`
      : normalized(record.advertisedService) !== normalized(expected.advertisedService)
        ? `advertised service mismatch (${record.advertisedService} != ${expected.advertisedService})`
        : record.verified !== true
          ? record.verificationError ?? 'ResponseAuth is not verified'
          : null
  return {
    requestId: expected.requestId,
    status: mismatch ? 'invalid' : 'verified',
    responseAuth: record,
    failureReason: mismatch,
  }
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs))
}

function normalized(value: string): string {
  return value.trim().toLowerCase()
}
