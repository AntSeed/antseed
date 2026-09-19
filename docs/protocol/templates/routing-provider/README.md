# Structured routing provider

`src/index.ts` exports a free, deterministic provider plugin. Its advertised `position`
preference selects the first or last eligible candidate. The buyer does not hardcode that
field. Copy into a provider package with `@antseed/node`, compile as ESM TypeScript and
load its default export through the normal provider-plugin workflow.

Build protocol, node and router-core, then check the fixtures without contacting a service:

```bash
node docs/protocol/templates/routing-provider/check-compatibility.mjs
```

For captured data, pass descriptor, request and response JSON file paths in that order.
The checker never sends a paid request. See `docs/router-network-integration.md` for the
wire contract, schema subset and migration notes.
