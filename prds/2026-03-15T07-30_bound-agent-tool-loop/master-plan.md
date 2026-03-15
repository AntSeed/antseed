# Master Plan: Bound Agent Tool-Based Agent Loop

**Status:** PRDS_GENERATED
**PRDs generated:** 2026-03-15T07:45:00Z

## Overview

Redesign `@antseed/bound-agent` from a two-pass knowledge selection approach to a tool-based agent loop. The LLM gets the persona, guardrails, and `antseed_*` tools injected alongside any buyer tools. It decides what to load, calls internal tools as needed, and when done the internal tools are stripped and the response goes to the buyer.

## Goals

1. Replace the two-pass architecture (selection LLM + response LLM) with a single-LLM agent loop
2. Inject `antseed_*` prefixed tools alongside buyer tools with clear separation instructions
3. Make tools declarative via the `agent.json` manifest — creators configure, not code
4. Keep per-service agent support
5. Extensible tool system — `antseed_load_knowledge` for v1, room for `antseed_fetch_url` etc. later
6. Clean, structured code — small files with single responsibilities

## Architecture

### Request Flow

```
Buyer request (may include buyer tools like Read, Write, Bash)
    |
    v
Inject: persona + guardrails + antseed_* tools + knowledge catalog + two-tool-set instructions
    |
    v
Forward to inner provider (handleRequest)
    |
    v
Response contains antseed_* tool calls? ──yes──> Execute tools, append results, re-prompt
    |                                                    |
    no                                                   | (loop, max iterations)
    |                                                    |
    v                                                    v
Response has only buyer tools or text ◄─────────────────┘
    |
    v
Return / stream to buyer (response is already clean — no stripping needed)
    |
    (only strip antseed_* blocks if max iterations hit with internal calls still pending)
```

### Two Tool Sets — Separation Prompt

The system prompt injection tells the LLM:

> You have internal tools prefixed with `antseed_` for gathering context and knowledge.
> Use them as needed before responding. Do not mention them to the user.
> All other tools belong to the user — use those only as the user requests.
> Always resolve all antseed_ tool calls before responding or using external tools.

### Agent Loop Rules

| Response contains | Action |
|---|---|
| Only `antseed_*` calls | Execute, append results, re-prompt (continue loop) |
| Only buyer tool calls | Done — strip internals, return |
| Both `antseed_*` and buyer calls | Execute `antseed_*` only, append results, re-prompt |
| No tool calls (text only) | Done — strip internals, return |

### Manifest Format (`agent.json`)

```json
{
  "name": "social-media-advisor",
  "persona": "./persona.md",
  "guardrails": [
    "Never write posts without explicit request"
  ],
  "knowledge": [
    {
      "name": "linkedin-posting",
      "description": "Creating and optimizing LinkedIn posts",
      "file": "./knowledge/linkedin-posting.md"
    }
  ]
}
```

Same manifest as today. The `knowledge` array drives `antseed_load_knowledge` tool generation. No manifest changes needed for v1 — the tool system is derived from the existing fields.

### Internal Tool: `antseed_load_knowledge`

Injected when the agent has knowledge modules. Schema:

```json
{
  "name": "antseed_load_knowledge",
  "description": "Load a knowledge module by name. Available modules:\n- linkedin-posting: Creating and optimizing LinkedIn posts\n- x-threads: Writing X threads",
  "input_schema": {
    "type": "object",
    "properties": {
      "name": { "type": "string", "description": "Module name to load" }
    },
    "required": ["name"]
  }
}
```

The catalog is embedded in the tool description — no separate system prompt catalog block needed. This is cleaner than the old approach.

### File Structure

```
packages/bound-agent/src/
  index.ts              # barrel exports
  loader.ts             # loadBoundAgent() — manifest + file loading (keep as-is)
  provider.ts           # BoundAgentProvider — per-service routing, delegates to AgentLoop
  agent-loop.ts         # AgentLoop — the core loop: inject, call, handle tools, strip, return
  tools.ts              # tool definitions, execution, format helpers (Anthropic + OpenAI)
  system-prompt.ts      # system prompt assembly (persona + guardrails + instructions)
  provider.test.ts      # tests
```

Key split: `provider.ts` handles the Provider interface delegation and per-service routing. `agent-loop.ts` handles the actual loop logic. `tools.ts` handles tool injection/stripping/execution across both API formats. `system-prompt.ts` assembles the system prompt from persona + guardrails + confidentiality + tool-set instructions.

## Architectural Decisions

1. **Single LLM, not two** — The bound agent's persona and tools are injected into the buyer's LLM call. No separate "bound agent LLM" for context gathering. Simpler, cheaper, lower latency.

2. **Tool prefix namespace (`antseed_`)** — Internal tools are prefixed to distinguish from buyer tools. The LLM is instructed to treat them differently. Clean separation without complex routing.

3. **Execute antseed-only on mixed calls** — When the LLM calls both internal and buyer tools, we execute only the `antseed_*` calls and re-prompt. This lets the LLM resolve internal context before touching buyer tools. Avoids the old approach of aborting the loop.

4. **Catalog in tool description** — The knowledge catalog (module names + descriptions) is embedded in the `antseed_load_knowledge` tool description, not in a separate system prompt block. One injection point, cleaner stripping.

5. **Keep `loader.ts` as-is** — The manifest loading code is clean and doesn't need changes. The manifest format stays the same for v1.

6. **Streaming: buffer loop, stream final** — Intermediate agent loop iterations are buffered (handleRequest). The final response is streamed via handleRequestStream on the inner provider. Same pattern as the old AgentProvider, proven to work.

7. **No stripping in normal flow** — When the loop terminates (text or buyer tools only), the response is already clean. No need for a "final clean request" or response stripping. Only strip `antseed_*` blocks in the max-iterations edge case.

## PRD Dependency Graph

```
PRD-01: Core agent loop + tools
         |
PRD-02: Provider integration + per-service
         |
PRD-03: Tests + cleanup
```

Linear dependency chain. Each PRD builds on the previous.

## PRD Summary

| PRD | Name | Depends On | Tasks | Scope |
|-----|------|------------|-------|-------|
| PRD-01 | Agent loop + tool system | — | 11 | `agent-loop.ts`, `tools.ts`, `system-prompt.ts` — the core loop, tool injection/stripping/execution, system prompt assembly. Both Anthropic and OpenAI formats. |
| PRD-02 | Provider integration | PRD-01 | 3 | Rewrite `provider.ts` to use AgentLoop instead of two-pass. Per-service routing stays. Verify CLI unchanged. |
| PRD-03 | Tests + cleanup | PRD-02 | 4 | Rewrite test suite for new architecture. Delete dead code. Update README and docs. |

## Out of Scope

- New tool types beyond `antseed_load_knowledge` (fetch_url, validate_output, etc.) — future PRDs
- Workflow/multi-step chains — future feature
- Intake flows — future feature
- Output schema enforcement — future feature
- Manifest format changes — v1 uses the existing format
- Separate bound agent LLM model selection — uses same model as buyer's request
