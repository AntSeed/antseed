---
sidebar_position: 8
slug: /guides/metadata-v13-upgrade
title: Metadata v13 Upgrade
description: Safe buyer-first rollout for operation-specific image generation and edit pricing.
---

# Metadata v13 Upgrade

Metadata v13 adds the `operation` unit-billing match key. Image services can now advertise separate prices for requests received at `/v1/images/generations` (`image_generation`) and `/v1/images/edits` (`image_edit`).

This is a **buyer-first migration**. Older buyers reject metadata versions newer than they understand and drop that seller from discovery.

## Compatibility Matrix

| Buyer version | Seller v10 | Seller v11 | Seller v12 | Seller v13 |
|---|---:|---:|---:|---:|
| v10 | Visible | Not visible | Not visible | Not visible |
| v11 | Visible | Visible | Not visible | Not visible |
| v12 | Visible | Visible | Visible | Not visible |
| v13 | Visible | Visible | Visible | Visible |

## Recommended Rollout

1. Publish the updated packages and buyer applications.
2. Upgrade and restart buyer CLIs, Desktop installations, routers, and embedded `@antseed/node` buyers.
3. Verify updated buyers still discover existing v10-v12 sellers.
4. Upgrade a small seller canary group.
5. Verify v13 canaries appear in `antseed network browse --json` from updated buyers.
6. Test both image generation and a follow-up edit through the same selected seller.
7. Roll the seller update through the remaining fleet.

Provider plugins do not choose the metadata version. The seller's `@antseed/node` runtime signs and serves metadata v13.

## Seller Configuration

Use operation-specific components when generation and editing have different upstream costs:

```json
{
  "upstreamModel": "grok-imagine-image-quality",
  "imageEditModel": "grok-imagine-quality-edit",
  "capabilities": {
    "inputs": ["text", "image"],
    "outputs": ["image"]
  },
  "unitBillingModels": {
    "openai-images": {
      "version": 1,
      "components": [
        {
          "unit": "output_images",
          "priceUsd": 0.06,
          "match": { "operation": "image_generation" }
        },
        {
          "unit": "output_images",
          "priceUsd": 0.06,
          "match": { "operation": "image_edit" }
        }
      ]
    }
  }
}
```

Unqualified components remain valid as blended or fallback pricing. Seller startup warns when `imageEditModel` is configured without an explicit `openai-images` unit-billing model. The example prices reflect Venice's catalog when written; verify current `type=image` and `type=inpaint` model pricing before advertising a service.

## Verification

```bash
antseed --version
antseed network browse --json
```

Upgraded sellers report `"version": 13`. Confirm the paired service advertises image input and that its billing components include the intended `operation` values.

## Rollback

Removing operation-specific components from `config.json` does **not** make an updated seller emit older metadata. To restore visibility to v12 buyers, run the previous seller binary/package version. Once the buyer fleet supports v13, upgrade the seller again.
