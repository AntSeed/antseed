# PR Split — `feat/desktop-userification`

**Date:** 2026-05-04
**Area:** `apps/desktop` — entire desktop UI refresh on `feat/desktop-userification`
**Author:** Dean (designed with Claude)
**Tracking PR:** [#445](https://github.com/AntSeed/antseed/pull/445) (kept open as draft for golden reference)

## Problem

PR #445 changes 56 files with +9,058 / −1,588 LOC across 13 commits, mixing
several unrelated concerns: a fully-specced "Discover inline filters" feature,
a broad UI overhaul (sidebar/titlebar/views), new shared components, asset
additions, and a backend chat-routing tweak. The team lead has flagged it as
too large to review or merge as a single unit.

## Goal

Split the work into **8 smaller PRs** that each (a) carry one cohesive
concern, (b) fit a moderate review size (~600–2,000 LOC), and (c) **preserve
every styling nuance of the current branch** — when all 8 land, the resulting
state on `main` must be byte-equal to `feat/desktop-userification`.

## Non-goals

- Rewriting or refactoring any of the work on the way out.
- Changing the visual or behavioural output of the UI.
- Re-authoring commit history within the source branch (it stays frozen).
- Reusing existing commits via `git cherry-pick` (commits mix concerns and
  cannot be cleanly partitioned — we cherry-pick **files at golden HEAD**
  instead).

## Constraints

- pnpm everywhere (root `pnpm install / build / test / typecheck` and
  `cd apps/desktop && pnpm run dev`).
- `feat/desktop-userification` is frozen as the golden reference — no further
  pushes to it for the duration of the split.
- Each split PR must build, typecheck, and pass tests on its own.
- Final state on `main` must satisfy:
  ```
  git diff feat/desktop-userification..main -- apps/desktop docs/superpowers .gitignore \
    ':(exclude)docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md' \
    ':(exclude)docs/superpowers/plans/2026-05-04-pr-split-desktop-userification.md'
  ```
  is empty (modulo documented fidelity shims that have been removed). The two
  exclusions are this spec and its plan — meta-documentation about the split
  itself, committed onto `feat/desktop-userification-split-base` (and inherited
  by every child PR's branch). They do not exist on `GOLDEN`, so they would
  otherwise show as legitimate additions in the diff.

## Workflow mechanics

### Branch model

A new base branch `feat/desktop-userification-split-base` is cut from `main`
at today's HEAD. Wave-1 branches (PR 1, PR 3) cut from this base. Later
waves cut from their parent's branch (e.g. PR 4 cuts from PR 1's branch,
PR 5 cuts from PR 4's branch) so each branch's tree already contains the
components it imports. After a parent PR merges, the open downstream
branches rebase onto `main`.

Branch naming:

- `feat/desktop-foundations` (PR 1)
- `feat/desktop-discover-inline-filters` (PR 2, off PR 1)
- `feat/desktop-chat-peer-routing` (PR 3)
- `feat/desktop-chrome-refresh` (PR 4, off PR 1)
- `feat/desktop-chat-surface` (PR 5, off PR 4)
- `feat/desktop-discover-landing` (PR 6, off PR 4 — rebased on PR 2 once it lands)
- `feat/desktop-config-view` (PR 7, off PR 4)
- `feat/desktop-external-clients-view` (PR 8, off PR 4)

### Construction rule

Each split branch is built by:

1. `git switch -c <branch> <base-or-parent>`
2. `git checkout feat/desktop-userification -- <files for this PR>`
3. `pnpm install && pnpm run build && pnpm run typecheck && pnpm run test`
4. `cd apps/desktop && pnpm run dev` and exercise the PR's surface
5. Commit as a single squash-style commit with a focused message
6. Open the PR, link it from PR #445's top-comment, and run the per-PR
   fidelity check (see Verification)

**No edits beyond cherry-pick** unless one of the two pre-authorised fidelity
shims is required (see Allowed deviations). Every shim is marked
`// FIDELITY-SHIM: removed in PR <n>` and listed in the PR description.

### Disposition of PR #445

PR #445 is converted to draft and gets a top-comment that:

- Explains the split and links every child PR.
- Maps any open lead-comments on #445 to the child PR they now apply to.
- Is closed after PR 8 merges and the end-to-end golden check passes.

## The 8 PRs

The 56-file diff partitions cleanly: every file appears in exactly one PR.

### PR 1 — Foundations (~330 LOC + 12 assets)

Pure additions; no consumers in this PR.

- `apps/desktop/src/renderer/assets/provider-logos/*.{png,svg}` (12 files)
- `apps/desktop/src/renderer/ui/components/AlphaHint.tsx` (+65)
- `apps/desktop/src/renderer/ui/components/AlphaHint.module.scss` (+196)
- `apps/desktop/src/renderer/ui/components/chat/ProviderLogo.tsx` (+64)
- `apps/desktop/src/renderer/ui/components/chat/model-logos.tsx` (+156)
- `apps/desktop/src/renderer/ui/components/chat/discover-category-icons.ts` (+69)

**Off:** `feat/desktop-userification-split-base`. **Deps:** none.
**Confirmed clean isolated build:** the project has no ESLint config and
TypeScript's `noUnusedLocals` only flags unused locals (not unused exports),
so pure-export foundation files compile and typecheck without consumers.

### PR 2 — Discover inline filters feature (~1,700 LOC)

Already designed in `docs/superpowers/specs/2026-05-03-discover-inline-filters-design.md`;
this PR ships the spec, the plan, and the implementation together.

- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.tsx` (+170)
- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.module.scss` (+184)
- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.tsx` (+95)
- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.module.scss` (+122)
- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineSortFilter.tsx` (+85)
- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineSortFilter.module.scss` (+95)
- `apps/desktop/src/renderer/ui/components/chat/discover-filter-util.ts` (+48)
- `apps/desktop/src/renderer/ui/components/chat/discover-filter-util.test.ts` (+31)
- `apps/desktop/src/renderer/ui/hooks/useDiscoverFilters.ts` (+6)
- `apps/desktop/src/renderer/ui/components/chat/DiscoverFilters.tsx` (+159)
- `apps/desktop/src/renderer/ui/components/chat/DiscoverFilters.module.scss` (+176)
- `docs/superpowers/specs/2026-05-03-discover-inline-filters-design.md` (+294)
- `docs/superpowers/plans/2026-05-03-discover-inline-filters.md` (+933)
- `.gitignore` (+5) — adds `.superpowers/` to ignored brainstorm session content; ships with the brainstorm artifacts.

**Off:** PR 1. **Deps:** PR 1 (`DiscoverFilters.tsx` imports
`discover-category-icons`).

### PR 3 — Chat peer-routing module (~180 LOC)

Self-contained backend logic with new vitest coverage.

- `apps/desktop/src/renderer/modules/chat.ts` (+44)
- `apps/desktop/src/renderer/modules/chat.peer-routing.test.ts` (+135)

**Off:** `feat/desktop-userification-split-base`. **Deps:** none.

### PR 4 — App chrome refresh + WalletPanel (~1,700 LOC)

The largest structural change: removes the OS titlebar, restyles the sidebar,
introduces the wallet panel.

- `apps/desktop/src/renderer/ui/AppShell.tsx` (+19)
- `apps/desktop/src/renderer/ui/components/Sidebar.tsx` (+256)
- `apps/desktop/src/renderer/ui/components/Sidebar.module.scss` (+494)
- `apps/desktop/src/renderer/ui/components/TitleBar.tsx` (+138) — replacement
- `apps/desktop/src/renderer/ui/components/TitleBar.module.scss` (+344) — also hosts wallet-panel styles
- `apps/desktop/src/renderer/ui/components/WalletPanel.tsx` (+148) — imports `TitleBar.module.scss`, hence bundled here
- `apps/desktop/src/renderer/global.scss` (+15)

**Off:** PR 1. **Deps:** PR 1 (`Sidebar` imports `AlphaHint`, `WalletPanel`,
`model-logos`).

### PR 5 — Chat surface restyle (~1,450 LOC)

- `apps/desktop/src/renderer/ui/components/views/ChatView.tsx` (+125)
- `apps/desktop/src/renderer/ui/components/views/ChatView.module.scss` (+329)
- `apps/desktop/src/renderer/ui/components/chat/ChatBubble.tsx` (+11)
- `apps/desktop/src/renderer/ui/components/StreamingIndicator.tsx` (+153)
- `apps/desktop/src/renderer/ui/components/StreamingIndicator.module.scss` (+266)
- `apps/desktop/src/renderer/ui/components/chat/ServiceDropdown.tsx` (+135)
- `apps/desktop/src/renderer/ui/components/chat/ServiceDropdown.module.scss` (+190)
- `apps/desktop/src/renderer/ui/components/chat/SwitchServiceDialog.module.scss` (+5)
- `apps/desktop/src/renderer/ui/components/chat/SessionApprovalCard.tsx` (+50)
- `apps/desktop/src/renderer/ui/components/chat/SessionApprovalCard.module.scss` (+225)

**Off:** PR 4. **Deps:** PR 1 (`ServiceDropdown` imports `ProviderLogo`),
PR 4 (chrome layout context).

### PR 6 — Discover landing restyle (~1,540 LOC)

- `apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.tsx` (+682)
- `apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.module.scss` (+858)

**Off:** PR 4 → rebased on PR 2 and PR 5 once those land. **Deps:** PR 1
(`ProviderLogo`, `discover-category-icons`), PR 2 (filter integration),
PR 4 (chrome), PR 5 (renders inside the new ChatView).

### PR 7 — ConfigView restyle (~1,050 LOC)

- `apps/desktop/src/renderer/ui/components/views/ConfigView.tsx` (+426)
- `apps/desktop/src/renderer/ui/components/views/ConfigView.module.scss` (+626)

**Off:** PR 4. **Deps:** PR 4.

### PR 8 — ExternalClientsView restyle (~2,000 LOC)

Largest single PR; cohesive (one view's restyle).

- `apps/desktop/src/renderer/ui/components/views/ExternalClientsView.tsx` (+584)
- `apps/desktop/src/renderer/ui/components/views/ExternalClientsView.module.scss` (+1,429)

**Off:** PR 4. **Deps:** PR 4.

## Merge order

Four waves; later waves wait for the prior wave's foundation, but PRs within
a wave merge in any order.

### Wave 1 — Foundations (parallel)
- PR 1 — Foundations
- PR 3 — Chat peer-routing

### Wave 2 — Two parallel tracks (after Wave 1)
- PR 2 — Discover inline filters
- PR 4 — App chrome refresh

### Wave 3 — View restyles (parallel, after PR 4)
- PR 5 — Chat surface
- PR 7 — ConfigView
- PR 8 — ExternalClientsView

### Wave 4 — DiscoverWelcome (last)
- PR 6 — Discover landing (depends on PR 2, PR 4, PR 5)

**Critical path:** PR 1 → PR 4 → PR 5 → PR 6 (four sequential merges
minimum; a fifth if PR 2 doesn't ship in parallel with PR 4).

**Rebase rule:** as each PR merges, every open downstream branch runs
`git rebase main`. Conflicts should be near-zero because the file partition
is disjoint.

## Verification & fidelity protocol

This is the load-bearing safety net.

### Per-PR fidelity check (mandatory)

Before opening each PR:

```bash
# 1. Every file in this PR matches the golden branch byte-for-byte
git diff feat/desktop-userification..HEAD -- <PR's file list>
# Expected: empty

# 2. No file outside this PR's set has changed
git diff feat/desktop-userification..HEAD --stat
# Expected: only this PR's files appear
```

Both must pass before opening the PR.

### Per-PR build & UX check

For every PR:

1. `pnpm install && pnpm run build`
2. `pnpm run typecheck`
3. `pnpm run test`
4. `cd apps/desktop && pnpm run dev`
5. Exercise the PR's specific surface plus a smoke test of unaffected views.

For PRs 4–8, attach screenshots of the changed view side-by-side with the
same view rendered from `feat/desktop-userification`.

### End-to-end golden check (the headline guarantee)

After all 8 PRs land on `main`:

```bash
git diff feat/desktop-userification..main -- apps/desktop docs/superpowers .gitignore
# Expected: empty
```

If empty, byte-for-byte fidelity is mathematically proven and PR #445 can be
closed. If non-empty, the diff itself names exactly what was dropped, and a
single focused "fidelity catch-up" PR restores it.

### Allowed deviations (must be documented)

Two narrow exceptions to "no edits beyond cherry-pick":

1. **Lint shims** — `eslint-disable` for unused exports in PR 1, removed in
   PR 4.
2. **Import path stubs** — temporary local stubs for imports that don't yet
   exist on the parent branch. Removed when the dependency lands.

Each shim carries `// FIDELITY-SHIM: removed in PR <n>` and is listed in the
PR description. The end-to-end golden check naturally surfaces any shim that
wasn't removed.

## Risks & mitigations

- **R1 — Interleaved file history.** Several files were edited across
  commits that mixed concerns. Mitigation: file-level cherry-pick at golden
  HEAD collapses interleaving; the byte-diff check is the proof.
- **R2 — Linter / typecheck failure on PR 1 in isolation.** *Resolved
  during spec self-review:* repo has no ESLint config and TS
  `noUnusedLocals` does not flag unused exports. PR 1 builds cleanly.
- **R3 — Accidental push to the golden branch.** Anyone pushing invalidates
  the byte-diff guarantee. Mitigation: convert PR #445 to draft; consider a
  local `pre-push` hook that refuses pushes to `feat/desktop-userification`.
- **R4 — `main` moves during the rollout.** Other merges between waves can
  introduce conflicts on otherwise-disjoint files. Mitigation: rebase open
  downstream branches after every merge; investigate any unexpected
  conflicts.
- **R5 — PR 6 bottleneck.** DiscoverWelcome depends on four prior PRs.
  Mitigation: open PR 6 as a draft off PR 4 immediately so reviewers can
  read it while the chain catches up; mark "do not merge until #2, #4, #5
  land."
- **R6 — Lost reviewer context from PR #445.** Lead's existing comments
  live on #445. Mitigation: top-comment maps each open comment to the child
  PR it now applies to.
- **R7 — Native-module / Electron quirks during PR 4.** Titlebar removal
  touches OS chrome. Mitigation: run `pnpm run rebuild` (in `apps/desktop`)
  before `pnpm run dev` for PR 4 specifically; test on the user's actual
  macOS build.
- **R8 — End-to-end golden diff non-empty after merge.** Mitigation: open a
  single focused "fidelity catch-up" PR with whatever the diff shows.

## Abort criteria

Pause and re-plan if:

- A PR shows >50 LOC of cherry-pick conflict — means files we thought were
  disjoint actually share state.
- The end-to-end golden diff after Wave 3 is non-empty by more than the
  documented shims — means we've lost bytes somewhere.

## Open questions to resolve before execution

- Decide whether to install the optional `pre-push` hook on the golden
  branch (R3 mitigation) or rely on discipline.
