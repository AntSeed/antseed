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
    name: 'openrouter',
    type: 'provider',
    description: 'OpenRouter multi-model provider (API key)',
    package: '@antseed/provider-openrouter',
  },
  {
    name: 'local-llm',
    type: 'provider',
    description: 'Local LLM provider (Ollama, llama.cpp)',
    package: '@antseed/provider-local-llm',
  },
  {
    name: 'local-proxy',
    type: 'router',
    description: 'Local HTTP proxy for Claude Code, Aider, Codex',
    package: '@antseed/router-local-proxy',
  },
  {
    name: 'local-chat',
    type: 'router',
    description: 'Local desktop chat router',
    package: '@antseed/router-local-chat',
  },
]
