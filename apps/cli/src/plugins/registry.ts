export interface TrustedPlugin {
  name: string
  type: 'provider' | 'router'
  description: string
  package: string
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
    name: 'open-generative-ai',
    type: 'provider',
    description: 'Studio media provider for Open-Generative-AI / MuAPI-style APIs',
    package: '@antseed/provider-open-generative-ai',
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
]

export function resolvePluginPackage(nameOrPackage: string): string {
  const trusted = TRUSTED_PLUGINS.find((plugin) => plugin.name === nameOrPackage)
  return trusted?.package ?? nameOrPackage
}
