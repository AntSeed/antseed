# @antseed/provider-veo

Thin native Veo API relay for a seller-operated service. The seller owns job execution, permissions, retries, storage, result URLs, and refunds. This plugin does not manage jobs or safely isolate a directly shared upstream account on its own.

## Configuration

Install with `antseed plugin add @antseed/provider-veo`, set `GEMINI_API_KEY` to the seller endpoint credential, and merge this provider into `seller.providers` in your configuration:

```json
{
  "veo": {
    "plugin": "veo",
    "baseUrl": "https://seller.example.test",
    "apiKeyEnv": "GEMINI_API_KEY",
    "defaults": {
      "inputUsdPerMillion": 0,
      "outputUsdPerMillion": 0
    },
    "services": {
      "veo-3.1-generate-preview": {
        "capabilities": {
          "inputs": [
            "text",
            "image"
          ],
          "outputs": [
            "video"
          ]
        },
        "unitBillingModels": {
          "veo-video": {
            "version": 1,
            "components": [
              {
                "unit": "video_seconds",
                "priceUsd": 0.1
              }
            ]
          }
        }
      }
    }
  }
}
```

The sample price is illustrative. For fixed pricing use `video_generations`; an empty component list explicitly makes the service free. Start with `antseed seller start`. Runtime settings: `GEMINI_BASE_URL` (required), `GEMINI_API_KEY` (required), `ANTSEED_ALLOWED_SERVICES`, `ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON`, optional `ANTSEED_SERVICE_CAPABILITIES_JSON`, and `ANTSEED_MAX_CONCURRENCY` (default 10 concurrent HTTP requests, not active jobs). Service names must match native model names; aliases are not supported.

## Buyer API

Send this native request to the local buyer proxy with JSON content type:

```text
POST /v1beta/models/veo-3.1-generate-preview:predictLongRunning

{"instances":[{"prompt":"A cat in a garden"}],"parameters":{"durationSeconds":"8","numberOfVideos":1}}
```

Poll `GET /v1beta/{name}` using the returned operation `name`; do not replace it with the model ID. The proxy persists the originating seller automatically. Multiple concurrent jobs can use different sellers. Native bodies and identifiers are preserved.

A successful acceptance is billable even if generation later fails. Polling and cancellation do not repeat the generation charge. No automatic submission retries occur after an uncertain send.

The AntSeed seller node records which buyer created each operation and rejects status requests from any other buyer with 404 before they reach the endpoint. The endpoint may add its own checks using `x-antseed-buyer-peer-id`. Gemini API result URIs require the API key, so the endpoint must return buyer-downloadable result URLs that do not expose seller credentials. No authenticated Files API download proxy is included.

For persistence limits, failure recovery, and compatibility, see [native video integration](../../docs/protocol/spec/10-native-video.md).
