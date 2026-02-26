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
    name: 'openai',
    type: 'provider',
    description: 'OpenAI-compatible provider (OpenAI, Together, OpenRouter, API key)',
    package: '@antseed/provider-openai',
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
    description: 'Local router for Claude Code, Aider, Codex',
    package: '@antseed/router-local',
  },
]
