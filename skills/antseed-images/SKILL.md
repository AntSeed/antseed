---
name: antseed-images
description: Generate images from text prompts through a specific AntSeed seller and image service. Use when the user asks to create, generate, or make an image with AntSeed and provides a peer ID and service ID.
---

# AntSeed Images

Generate an image through the user's local AntSeed buyer proxy using a concrete seller and image service.

## Prerequisites

- AntSeed Desktop or `antseed buyer start` must be running.
- The buyer must have enough deposited USDC for the selected seller.
- The caller must provide both:
  - `peer_id`: the AntSeed seller peer ID
  - `service_id`: the seller's advertised image service ID
- The default buyer endpoint is `http://127.0.0.1:8377`. Use a different port only when the user provides one.

## Parameters

Treat these values as fixed for the request:

- `peer_id` — exact seller peer ID
- `service_id` — exact image service ID
- `prompt` — the user's image description
- `output` — optional destination path
- `proxy_url` — optional buyer URL; default `http://127.0.0.1:8377`

Build the routed model as `<peer_id>@<service_id>`. The proxy can auto-select a peer from a bare model name, but this skill intentionally routes to the exact seller the user chose — pinned requests never fail over. Do not silently substitute another seller or service. If the route fails, report the error and let the user choose another route.

## Generate an Image

Send an OpenAI-compatible request to `<proxy_url>/v1/images/generations`. Use a JSON encoder such as `jq`; do not interpolate an unescaped prompt into JSON.

Capture the response in a private temporary file, then decode `data[0].b64_json` directly into the output file without printing it:

```bash
response_file="$(mktemp)"
trap 'rm -f "$response_file"' EXIT
output="${output:-generated-image.png}"

curl --fail-with-body "$proxy_url/v1/images/generations" \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer antseed-desktop' \
  --data-binary "$(jq -n \
    --arg model "$peer_id@$service_id" \
    --arg prompt "$prompt" \
    '{model: $model, prompt: $prompt, n: 1, response_format: "b64_json"}')" \
  --output "$response_file"

jq -r '.data[0].b64_json // empty' "$response_file" | base64 --decode > "$output"
```

If the response contains `data[0].url` instead, download it immediately to the output file. Accept only an HTTPS URL. Do not follow redirects to private, loopback, link-local, or otherwise unsafe destinations.

The `<peer_id>@<service_id>` prefix requires a JSON body. If the user asks for `/v1/images/edits` (multipart body, no JSON model to rewrite), pin the seller with the `x-antseed-pin-peer: <peer_id>` header instead and send the bare `service_id` as the model.

## Safety and Output Rules

- Never print or paste image base64, generated-image URLs, authorization headers, private keys, or full API responses into chat or logs.
- Do not expose the local buyer proxy beyond loopback.
- Do not treat image bytes as text tokens.
- Request one image unless the user explicitly asks for more and the selected service supports it.
- Do not guess optional parameters such as `size`, `quality`, or `style`; seller capabilities differ. Send them only when the user supplies a supported value.
- Image generation may take several minutes. Wait for completion unless the user cancels.
- After generation, tell the user the saved file path, seller peer ID, and service ID. Display the saved image when the agent environment supports it.

## Errors

- `missing_routing_target` (or `no_peer_pinned` from a pre-release proxy): the request reached the proxy without a model or pin — ensure the model is exactly `<peer_id>@<service_id>`.
- `model_not_found`: the selected seller does not advertise that exact service ID. Check `curl -s 'http://127.0.0.1:8377/v1/models?type=images'` — answered locally, it lists every image model on the network with the peers serving it.
- HTTP `402`: the buyer needs additional deposited USDC or payment-channel capacity.
- HTTP `502`: the selected peer is unavailable or outside the buyer's routing policy. Do not silently fail over.
- Connection refused: start AntSeed Desktop or `antseed buyer start`.
