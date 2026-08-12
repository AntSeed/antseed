# antseed-images

Generate images from text prompts through a seller-specific AntSeed image route.

## Install

With the [GitHub CLI](https://cli.github.com/) (v2.90.0+):

```bash
gh skill install AntSeed/antseed antseed-images
```

Add `--scope user` to install it for every project supported by your agent, or use `--agent <agent>` to target one agent.

You can also point an agent directly at [`SKILL.md`](SKILL.md).

## Prerequisites

AntSeed Desktop or `antseed buyer start` must be running, and the buyer must have sufficient deposited USDC. The skill uses the local buyer proxy, normally at `http://127.0.0.1:8377`.

## Required parameters

Provide the skill with the exact route selected in AntStation:

- `peer_id` — seller peer ID
- `service_id` — seller's advertised image service ID
- `prompt` — image description

The skill sends the request to `/v1/images/generations` with the routed model `<peer_id>@<service_id>`. It does not silently switch sellers.

## Example prompt

```text
Use the antseed-images skill with:
peer_id: 9e8f9aaee684298b7f2af2ae008e3692f0e9f4f7
service_id: gpt-image-2
prompt: A tiny ant astronaut planting a seed on Mars
```

See [SKILL.md](SKILL.md) for request, output, safety, and error-handling instructions.
