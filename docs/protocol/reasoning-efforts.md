# Reasoning-effort announcements

Sellers may advertise `serviceCapabilities[service].reasoningEfforts` with any
nonempty, unique subset of `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and
`max`. These labels describe the service's supported controls, not a guarantee
that every API protocol can represent every label.

```json
{
  "model": {
    "reasoning": true,
    "reasoningEfforts": ["none", "low", "high"]
  }
}
```

Use this shape in provider `serviceCapabilities` configuration or the existing
`ANTSEED_SERVICE_CAPABILITIES_JSON` environment variable. Omission means unknown;
it does not mean unsupported. Empty lists, duplicates, unknown labels, and enabled
efforts alongside `reasoning: false` are rejected. `reasoning: false` may coexist
with `reasoningEfforts: ["none"]`.

The list is covered by the seller's metadata signature and sorted by code-unit
order for binary encoding. Metadata v13 uses a two-byte capability presence mask;
bit 9 indicates the effort list, with bit 8 reserved for the later routing slice.
The payload is a one-byte count followed by length-prefixed UTF-8 labels, after
supported parameters. Metadata v12 retains its one-byte mask. Encoding efforts on
older versions fails instead of silently discarding them.

Per-peer discovery and catalog entries preserve these announcements. They do not
change requests, choose reasoning levels, or add UI controls. A model-wide
capability summary must not be treated as a particular seller's effort list.

This is review slice 2/5 of the unreleased stack: quantity billing, reasoning
announcements, routing protocol/discovery, shared execution, then buyer routing.
Metadata stays v13 and billing stays v2 throughout the stack. These intermediate
wire layouts are not independent releases; deploy the completed stack together.
