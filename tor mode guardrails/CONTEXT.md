# Tor Mode Guardrails - Session Context

Last updated: 2026-02-26
Repo: /Users/eylon/Claude/antseed-monorepo
Branch: main

## Goal
Build a Tor hidden-service mode for AntSeed so inbound seller connections do not expose direct IP addresses.

## Work Completed
1. Researched current networking behavior in `@antseed/node`.
2. Confirmed blockers for Tor-only privacy in current implementation:
   - seller listens publicly (`0.0.0.0`),
   - NAT mapping is enabled,
   - discovery/announce relies on UDP DHT,
   - buyer resolves and connects to direct host:port.
3. Wrote PRD:
   - `docs/tor-hidden-service-prd.md`
4. Installed and validated Babysitter tooling:
   - `@a5c-ai/babysitter`, `@a5c-ai/babysitter-sdk`, `@a5c-ai/babysitter-breakpoints`
   - `babysitter version` => `0.0.169`
5. Ran a Babysitter planning/approval flow for this feature:
   - runId: `01KJCJE1NSS20DA2SWG08KWJW5`
   - output state: `ready-for-implementation`
   - run artifacts: `/tmp/antseed-babysitter-runs/01KJCJE1NSS20DA2SWG08KWJW5`
6. Implemented Phase 1 Tor MVP guardrails in code:
   - seller tor mode: loopback bind, no DHT startup, no NAT traversal
   - buyer tor mode: manual peers, no DHT lookup, forced TCP transport
   - SOCKS5 outbound dialing support in connection manager
   - tor config schema/defaults/validation and CLI tor flags
   - tests updated and passing
7. Ran Babysitter subagent-style implementation tracking with 3 streams:
   - runId: `01KJCJYMXX8AYCGFD4AR44V8V6`
   - streams: `node`, `cli`, `tests`
   - output state: `phase1-implemented`
   - run artifacts: `/tmp/antseed-babysitter-runs/01KJCJYMXX8AYCGFD4AR44V8V6`

## Repo State
- Uncommitted docs/module artifacts:
  - `docs/tor-hidden-service-prd.md`
  - `tor mode guardrails/CONTEXT.md`
  - `tor mode guardrails/SESSION_START_PROMPT.md`
  - `tor mode guardrails/babysitter/phase1-process.mjs`
  - `tor mode guardrails/babysitter/phase1-inputs.json`
  - `tor mode guardrails/babysitter/README.md`
- Uncommitted Phase 1 implementation changes are present in `apps/cli` and `packages/node`.

## Critical Constraints
- Tor mode must fail closed by default (no silent direct-IP fallback).
- Keep public mode behavior unchanged.
- Do not merge protocol-v3 endpoint format until Phase 2 unless explicitly scoped.

## Key References
- PRD: `docs/tor-hidden-service-prd.md`
- Node entry: `packages/node/src/node.ts`
- Connection manager: `packages/node/src/p2p/connection-manager.ts`
- Discovery DHT: `packages/node/src/discovery/dht-node.ts`
- Seed command: `apps/cli/src/cli/commands/seed.ts`
- Connect command: `apps/cli/src/cli/commands/connect.ts`
- Babysitter module: `tor mode guardrails/babysitter/`
