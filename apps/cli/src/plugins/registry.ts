export interface TrustedPlugin {
  name: string
  type: 'provider' | 'router' | 'verifier'
  description: string
  package: string
  /** Exact npm version for trusted verifier packages. */
  version?: string
}

export const TRUSTED_PLUGINS: TrustedPlugin[] = [
  {
    name: 'anthropic',
    type: 'provider',
    description: 'Anthropic API provider (API key)',
    package: '@antseed/provider-anthropic',
  },
  {
    name: 'claude-code',
    type: 'provider',
    description: 'Claude Code keychain provider (testing only)',
    package: '@antseed/provider-claude-code',
  },
  {
    name: 'claude-oauth',
    type: 'provider',
    description: 'Claude OAuth provider (testing only)',
    package: '@antseed/provider-claude-oauth',
  },
  {
    name: 'openai',
    type: 'provider',
    description: 'OpenAI-compatible provider (OpenAI, Together, OpenRouter, API key)',
    package: '@antseed/provider-openai',
  },
  {
    name: 'openai-responses',
    type: 'provider',
    description: 'OpenAI Responses provider via Codex auth (testing only)',
    package: '@antseed/provider-openai-responses',
  },
  {
    name: 'local-llm',
    type: 'provider',
    description: 'Local LLM provider (Ollama, llama.cpp)',
    package: '@antseed/provider-local-llm',
  },
  {
    name: 'local',
    type: 'router',
    description: 'Local router for Claude Code, Codex',
    package: '@antseed/router-local',
  },
  {
    name: 'refoundhq-antseed-verifier',
    type: 'verifier',
    description: 'TEE attestation verifier + prover (Intel TDX, DCAP)',
    package: '@refoundhq/antseed-verifier',
    version: '0.1.0',
  },
]

export function resolvePluginPackage(nameOrPackage: string): string {
  const trusted = TRUSTED_PLUGINS.find((plugin) => plugin.name === nameOrPackage)
  return trusted?.package ?? nameOrPackage
}
