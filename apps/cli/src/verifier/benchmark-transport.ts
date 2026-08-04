import { InvalidArgumentError } from 'commander'
import type { BenchmarkExecutionTransport } from './benchmark.js'
import { ProxyDirectAuditNode } from './proxy-audit-node.js'

export type BenchmarkTransportMode = 'direct' | 'proxy'

export interface BenchmarkTransportOptions {
  transport?: BenchmarkTransportMode
  proxyUrl?: string
  proxyTokenFile?: string
}

export function parseBenchmarkTransportMode(value: string): BenchmarkTransportMode {
  const normalized = value.trim().toLowerCase()
  if (normalized === 'direct' || normalized === 'proxy') return normalized
  throw new InvalidArgumentError('transport must be direct or proxy')
}

export async function connectBenchmarkExecutionTransport(input: {
  options: BenchmarkTransportOptions
  responseAuthTimeoutMs: number
}): Promise<BenchmarkExecutionTransport | undefined> {
  if ((input.options.transport ?? 'direct') === 'direct') return undefined
  const node = await ProxyDirectAuditNode.connect({
    ...(input.options.proxyUrl ? { baseUrl: input.options.proxyUrl } : {}),
    ...(input.options.proxyTokenFile ? { tokenFile: input.options.proxyTokenFile } : {}),
    responseAuthTimeoutMs: input.responseAuthTimeoutMs,
  })
  return {
    node,
    verifierAddress: node.identity.address,
    verifierPeerId: node.identity.peerId,
  }
}
