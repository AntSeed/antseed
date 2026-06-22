export interface TrustedPlugin {
  name: string
  type: 'provider' | 'router' | 'service'
  description: string
  package: string
  /** Human-readable label shown in UIs before the plugin is loaded. */
  displayName?: string
  /** Service sub-kind (e.g. 'funding'), surfaced for services not yet loaded. */
  kind?: string
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
    name: 'auto-deposit',
    type: 'service',
    displayName: 'Auto Deposit',
    kind: 'funding',
    description: 'Gasless auto-deposit: sweeps loose USDC into the network (Circle Paymaster + EIP-7702)',
    package: '@antseed/service-auto-deposit',
  },
]

export function resolvePluginPackage(nameOrPackage: string): string {
  const trusted = TRUSTED_PLUGINS.find((plugin) => plugin.name === nameOrPackage)
  return trusted?.package ?? nameOrPackage
}

export function getTrustedServicePlugins(): TrustedPlugin[] {
  return TRUSTED_PLUGINS.filter((plugin) => plugin.type === 'service')
}
