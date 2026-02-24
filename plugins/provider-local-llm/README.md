# @antseed/provider-local-llm

Sell local LLM capacity on the Antseed P2P network. Works with Ollama, llama.cpp, and any OpenAI-compatible local server.

## Installation

```bash
antseed plugin add @antseed/provider-local-llm
```

## Usage

```bash
# With Ollama (default)
antseed seed --provider local-llm

# With a custom endpoint
export LOCAL_LLM_BASE_URL=http://localhost:8080
antseed seed --provider local-llm
```

## Configuration

| Key | Type | Required | Default | Description |
|-----|------|----------|---------|-------------|
| `LOCAL_LLM_BASE_URL` | string | No | `http://localhost:11434` | Local LLM server URL |
| `LOCAL_LLM_API_KEY` | secret | No | -- | Optional API key for local server |
| `ANTSEED_INPUT_USD_PER_MILLION` | number | No | 0 | Input token price (USD per 1M) |
| `ANTSEED_OUTPUT_USD_PER_MILLION` | number | No | 0 | Output token price (USD per 1M) |
| `ANTSEED_MAX_CONCURRENCY` | number | No | 1 | Max concurrent requests |
| `ANTSEED_ALLOWED_MODELS` | string[] | No | -- | Comma-separated model allowlist |

## How It Works

Relays requests to a local LLM server. Pricing defaults to 0 (free) since you're running your own hardware. Concurrency defaults to 1 to avoid overloading local inference.
