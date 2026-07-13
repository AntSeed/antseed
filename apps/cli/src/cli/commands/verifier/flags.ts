import { InvalidArgumentError } from 'commander'

/**
 * Commander argument parser for strictly-positive integer flags.
 *
 * A bare `parseInt` silently maps garbage to NaN — `--interval 5m` became
 * `setTimeout(NaN)`, i.e. a zero-delay audit loop hammering paid probes.
 * Rejecting non-integers at parse time turns the typo into a CLI error.
 */
export function parsePositiveIntFlag(value: string): number {
  if (!/^\d+$/.test(value.trim())) {
    throw new InvalidArgumentError('must be a positive integer')
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new InvalidArgumentError('must be a positive integer')
  }
  return parsed
}

/**
 * Resolve the upstream API input for `verifier reference build`, giving CLI
 * flags strict precedence over config: `--api-key` must beat a configured
 * `apiKeyEnv` (previously the env var silently won and the enrollment billed
 * the wrong account), and `--api-key-env` must beat a configured `apiKey`.
 */
export function resolveReferenceUpstreamInput(
  flags: { baseUrl?: string; apiKey?: string; apiKeyEnv?: string },
  configUpstream: { baseUrl?: string; apiKey?: string; apiKeyEnv?: string } | undefined,
): { baseUrl: string; apiKey?: string; apiKeyEnv?: string } {
  const baseUrl = flags.baseUrl ?? configUpstream?.baseUrl ?? ''
  if (flags.apiKey) {
    return { baseUrl, apiKey: flags.apiKey }
  }
  if (flags.apiKeyEnv) {
    return { baseUrl, apiKeyEnv: flags.apiKeyEnv }
  }
  return {
    baseUrl,
    ...(configUpstream?.apiKey ? { apiKey: configUpstream.apiKey } : {}),
    ...(configUpstream?.apiKeyEnv ? { apiKeyEnv: configUpstream.apiKeyEnv } : {}),
  }
}
