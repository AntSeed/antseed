# Renderer TypeScript Migration Plan

## Goal
Move the Electron renderer from JavaScript to TypeScript with zero runtime regressions, then tighten typing quality iteratively.

## Phase 1 (Completed)
- Convert renderer entrypoint and modules from `.js` to `.ts`.
- Add renderer bridge typings and global `window.antseedDesktop` declaration.
- Keep behavior unchanged while making build/typecheck pass.
- Validate with:
  - `npm run typecheck:renderer`
  - `npm run build`

### Files migrated in phase 1
- `src/renderer/app.ts`
- `src/renderer/modules/navigation.ts`
- `src/renderer/modules/runtime.ts`
- `src/renderer/modules/settings.ts`
- `src/renderer/modules/dashboard-api.ts`
- `src/renderer/modules/dashboard-render.ts`
- `src/renderer/modules/wallet.ts`
- `src/renderer/modules/chat.ts`
- `src/renderer/types/bridge.ts`
- `src/renderer/types/global.d.ts`
- `src/renderer/index.html` (entry script now `app.ts`)

## Phase 2 (Next)
- Replace `any`-heavy renderer state with explicit interfaces (`UiState`, `RendererElements`, DTOs).
- Remove weak typing in `app.ts` (`AnyRecord`, permissive helpers).
- Type-safe bridge contract reuse between preload and renderer.
- Add renderer unit tests for:
  - View/mode switching
  - Session fallback rendering
  - Plugin-install hint flow
  - Chat stream event rendering

## Phase 3 (Hardening)
- Re-enable stricter TS checks incrementally:
  - Turn `noImplicitAny` back to `true`
  - Address strict null-safety hotspots
- Add CI gate for renderer typecheck/build.
- Add regression checklist for runtime controls + chat + wallet paths.
