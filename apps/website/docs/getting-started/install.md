---
sidebar_position: 2
slug: /install
title: Install
hide_title: true
---

# Install

AntSeed requires Node.js 20+ and works on macOS, Linux, and Windows (WSL).

```bash title="install"
$ npm install -g @antseed/cli
```

Verify the installation:

```bash title="verify"
$ antseed --version
antseed v0.1.24
```

## Related Packages

| Package | Description |
|---|---|
| `@antseed/cli` | CLI tool for running a node |
| `@antseed/node` | Protocol SDK (core library) |
| `@antseed/provider-core` | Base provider utilities and HTTP relay |
| `@antseed/router-core` | Peer scoring and routing utilities |
| `@antseed/provider-anthropic` | Anthropic API key provider |
| `@antseed/provider-claude-code` | Claude Code keychain provider |
| `@antseed/provider-openai` | OpenAI-compatible provider (OpenAI, Together, OpenRouter) |
| `@antseed/provider-claude-oauth` | Claude OAuth provider |
| `@antseed/provider-local-llm` | Local LLM provider (Ollama/llama.cpp) |
| `@antseed/router-local` | Local router for CLI tools |
| `@antseed/dashboard` | Web dashboard |
