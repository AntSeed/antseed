---
title: AntStation Studio
---

# AntStation Studio

AntStation Studio is the media-generation workspace inside AntStation. It routes image and video generation requests through the AntSeed buyer proxy to Studio-capable providers on the network.

## What Studio supports

The first Studio contract supports three intents:

- `image-generate` — prompt to image.
- `image-edit` — reference image plus edit prompt.
- `video-generate` — prompt and optional reference image to video.

Studio discovers compatible services from provider metadata categories. A service appears in Studio when it advertises media categories such as:

- `studio`
- `image`
- `image-generation`
- `image-edit`
- `video`
- `video-generation`
- `multimodal`

## Using Studio in AntStation

1. Start AntStation and wait for buyer discovery to populate services.
2. Open **Studio** from the sidebar.
3. Pick an intent: image generation, image edit, or video generation.
4. Select a compatible service.
5. Enter a prompt.
6. Add reference images when the intent requires or benefits from them.
7. Click **Run Studio Task**.

Studio sends the run through the local buyer proxy and pins it to the selected peer/provider. Completed outputs appear in the canvas and local run history.

## Provider endpoint

Studio-capable providers expose:

```http
POST /v1/studio/run
```

Example request:

```json
{
  "model": "flux-dev",
  "intent": "image-generate",
  "prompt": "A cinematic ant robot in a neon workshop",
  "references": [],
  "options": {
    "aspectRatio": "16:9"
  }
}
```

Example response:

```json
{
  "id": "run-123",
  "status": "completed",
  "outputs": [
    {
      "kind": "image",
      "url": "https://cdn.example.com/output.png"
    }
  ]
}
```

## Becoming a Studio provider

The built-in Studio provider plugin is:

```txt
@antseed/provider-open-generative-ai
```

It adapts Open-Generative-AI / MuAPI-style async media APIs to the AntSeed Studio contract.

Minimum config:

```json
{
  "seller": {
    "providers": {
      "open-generative-ai": {
        "services": {
          "flux-dev": {
            "categories": ["studio", "image", "image-generation"]
          },
          "kling-video": {
            "categories": ["studio", "video", "video-generation"]
          }
        }
      }
    }
  }
}
```

Required environment:

```bash
OPEN_GENERATIVE_AI_API_KEY=<key>
ANTSEED_ALLOWED_SERVICES=flux-dev,kling-video
```

Optional environment:

```bash
OPEN_GENERATIVE_AI_BASE_URL=https://api.muapi.ai
OPEN_GENERATIVE_AI_POLL_INTERVAL_MS=2000
OPEN_GENERATIVE_AI_MAX_POLL_ATTEMPTS_IMAGE=60
OPEN_GENERATIVE_AI_MAX_POLL_ATTEMPTS_VIDEO=900
ANTSEED_MAX_CONCURRENCY=4
ANTSEED_SERVICE_ALIAS_MAP_JSON='{"flux-dev":"flux/dev"}'
```

## Error behavior

Studio shows user-facing errors for common failure cases:

- No Studio-compatible services found.
- The selected provider does not expose `/v1/studio/run`.
- The provider rejects the requested intent or model.
- Reference upload fails.
- Upstream generation fails or times out.
- The provider returns no usable image/video output URL.

Providers should avoid returning secrets or raw upstream traces in error messages.
