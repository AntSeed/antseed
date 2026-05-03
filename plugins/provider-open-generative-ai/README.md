# @antseed/provider-open-generative-ai

Provide Studio media generation/edit capacity on the AntSeed P2P network through Open-Generative-AI compatible upstreams (for example MuAPI-style submit/poll APIs).

## Installation

```bash
antseed plugin add @antseed/provider-open-generative-ai
```

## Usage

```bash
# Put your upstream API key in env vars
export OPENAI_API_KEY=...

# Configure provider + services in AntSeed config
antseed config seller add-provider media --plugin open-generative-ai --base-url https://api.muapi.ai
antseed config seller add-service media flux-dev \
  --upstream "flux-dev" \
  --input 2.0 --output 2.0 \
  --categories image,image-generate,studio

antseed config seller add-service media wan-video \
  --upstream "wan-video" \
  --input 4.0 --output 4.0 \
  --categories video,video-generate,studio

antseed seller start
```

Studio submits runs to `POST /v1/studio/run` via the buyer proxy with explicit `x-antseed-provider` and `x-antseed-pin-peer` routing headers.

## Configuration

### Required

| Key | Description |
|-----|-------------|
| `OPENAI_API_KEY` or `OPEN_GENERATIVE_AI_API_KEY` | Upstream API key (sent as `x-api-key`) |

### Optional

| Key | Default | Description |
|-----|---------|-------------|
| `OPENAI_BASE_URL` or `OPEN_GENERATIVE_AI_BASE_URL` | `https://api.muapi.ai` | Upstream base URL |
| `ANTSEED_ALLOWED_SERVICES` | -- | Announced services allowlist |
| `ANTSEED_SERVICE_ALIAS_MAP_JSON` | -- | JSON map of announced service -> upstream endpoint/model key |
| `ANTSEED_INPUT_USD_PER_MILLION` | `10` | Default input token price |
| `ANTSEED_OUTPUT_USD_PER_MILLION` | `10` | Default output token price |
| `ANTSEED_CACHED_INPUT_USD_PER_MILLION` | -- | Optional cached-input price |
| `ANTSEED_SERVICE_PRICING_JSON` | -- | Per-service pricing overrides |
| `ANTSEED_MAX_CONCURRENCY` | `4` | Max concurrent Studio runs |
| `OPEN_GENERATIVE_AI_POLL_INTERVAL_MS` | `2000` | Poll interval for prediction status |
| `OPEN_GENERATIVE_AI_MAX_POLL_ATTEMPTS_IMAGE` | `60` | Max poll attempts for image intents |
| `OPEN_GENERATIVE_AI_MAX_POLL_ATTEMPTS_VIDEO` | `900` | Max poll attempts for video intent |

## Studio Endpoint

### Request

`POST /v1/studio/run`

```json
{
  "model": "flux-dev",
  "intent": "image-generate",
  "prompt": "product shot on a clean background",
  "references": [
    {
      "name": "ref.png",
      "mimeType": "image/png",
      "base64": "data:image/png;base64,..."
    }
  ],
  "options": {
    "aspect_ratio": "16:9"
  }
}
```

### Response

```json
{
  "id": "pred_123",
  "status": "completed",
  "outputs": [
    { "url": "https://...", "kind": "image" }
  ],
  "meta": {
    "endpoint": "flux-dev"
  }
}
```
