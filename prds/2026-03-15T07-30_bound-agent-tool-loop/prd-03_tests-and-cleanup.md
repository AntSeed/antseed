# PRD-03: Tests + Cleanup

Created: 2026-03-15T07:45:00Z
Depends on: PRD-02

## Overview

Rewrite the integration test suite for the new tool-based agent loop architecture. Delete dead code. Update README and docs.

---

### Task 1: Rewrite `provider.test.ts`

##### REWRITE: `packages/bound-agent/src/provider.test.ts`

Replace the test suite. The test helpers (`makeBody`, `parseBody`, `makeReq`, `mockProvider`, `makeAnthropicTextResponse`, `makeOpenAITextResponse`) are reusable — keep them. Add new response helpers for tool-call responses.

**New test helper functions to add:**

```ts
function makeAnthropicToolUseResponse(toolName: string, toolId: string, input: unknown): Uint8Array {
  return makeBody({
    content: [{ type: 'tool_use', id: toolId, name: toolName, input }],
  });
}

function makeOpenAIToolCallResponse(toolName: string, toolId: string, args: unknown): Uint8Array {
  return makeBody({
    choices: [{
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: toolId,
          type: 'function',
          function: { name: toolName, arguments: JSON.stringify(args) },
        }],
      },
      finish_reason: 'tool_calls',
    }],
  });
}
```

**Test categories to cover (all using the `BoundAgentProvider` public API):**

**1. Persona only (no knowledge) — Anthropic:**
- Injects persona + guardrails into system prompt (1 call)
- Does NOT inject tools or tool-set instructions
- Preserves buyer system prompt (string)
- Preserves buyer system prompt (array with cache_control)

**2. Persona only — OpenAI:**
- Injects persona as system message

**3. Agent loop — Anthropic format:**
- LLM calls `antseed_load_knowledge` → tool executed → result appended → re-prompt → final text response (verify 2 calls, tool result contains module content)
- LLM responds with text only → no loop, 1 call
- LLM calls buyer tool only → no loop, 1 call, response returned as-is
- LLM calls both `antseed_load_knowledge` AND buyer tool → execute antseed only, re-prompt (buyer tool call still pending in next iteration)
- LLM loads multiple knowledge modules in sequence (2 loop iterations)
- Unknown module name → error tool result
- Max iterations reached → final response has internal calls stripped

**4. Agent loop — OpenAI format:**
- LLM calls `antseed_load_knowledge` → executed → re-prompt → text response
- LLM calls buyer function tool → no loop, response as-is

**5. Tool injection:**
- `antseed_load_knowledge` injected alongside buyer tools
- Tool catalog embedded in tool description
- No tools injected when no knowledge modules
- No tools injected when tool_choice forces specific function

**6. Streaming:**
- Loop iterations buffered, final response streamed
- Direct stream when no knowledge modules (persona only)
- Streaming with tool loop (buffered iterations + streamed final)

**7. Per-service:**
- Different agents for different services
- Unmatched service passes through unchanged
- Wildcard `*` fallback
- Service resolved from `model` field (OpenAI)
- Single BoundAgentDefinition backward compat

**8. Error handling:**
- Non-JSON body passes through unchanged
- Custom confidentiality prompt

**9. Provider delegation:**
- Delegates name, services, pricing, maxConcurrency, getCapacity

#### Acceptance Criteria
- [ ] `provider.test.ts` rewritten with all test categories above
- [ ] All tests pass
- [ ] No dead test code from old two-pass architecture

---

### Task 2: Update README

##### MODIFY: `packages/bound-agent/README.md`

Update the "How it works" section to describe the tool-based agent loop instead of the two-pass selection approach. Key changes:

- Replace "selection pass" / "response pass" language with agent loop description
- Mention that `antseed_load_knowledge` tool is injected alongside buyer tools
- Explain that the LLM decides when to load knowledge (not a separate selection call)
- Keep the manifest format section unchanged
- Update the "Knowledge selection" section to describe tool-based loading
- Update "What gets injected" to mention tools + tool-set instructions

#### Acceptance Criteria
- [ ] README reflects new architecture
- [ ] No references to "selection pass" or "two-pass"
- [ ] Manifest format documentation unchanged

---

### Task 3: Update docs

##### MODIFY: `docs/protocol/templates/provider-plugin/README.md`

Update the "Adding a Bound Agent" section. Replace any reference to "selection pass" with tool-based agent loop.

##### MODIFY: `apps/cli/README.md`

Update the "Bound Agent" section if it references the selection mechanism. Keep config examples unchanged.

#### Acceptance Criteria
- [ ] No references to old two-pass architecture in any docs
- [ ] Config examples unchanged

---

### Task 4: Clean up dead code

Delete files and code that are no longer needed:

- Remove `stripToolMessages` function if it was kept in any file (it was in old `provider.ts` — the new architecture doesn't need it since we inject tools rather than stripping them from a selection call)
- Verify no old imports remain across the package

Run:
```bash
npx tsc --noEmit -p packages/bound-agent/tsconfig.json
npx vitest run packages/bound-agent/src/
```

#### Acceptance Criteria
- [ ] No dead code
- [ ] TypeScript compiles clean
- [ ] All tests pass
- [ ] `pnpm run build` succeeds for bound-agent and CLI
