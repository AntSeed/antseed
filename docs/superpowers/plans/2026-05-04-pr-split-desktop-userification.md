# PR Split — `feat/desktop-userification` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split PR [#445](https://github.com/AntSeed/antseed/pull/445) (`feat/desktop-userification`, 56 files / +9,058 / −1,588 LOC) into 8 smaller, reviewable PRs while preserving every byte of styling and behaviour.

**Architecture:** Cherry-pick **files** (not commits) at the golden branch's HEAD into a wave-structured tree of split branches. Wave 1 cuts from a fresh base off `main`; later waves cut from their parent's branch so imports resolve. Per-PR byte-equality is verified before each push, and an end-to-end byte-equality check after Wave 4 closes out PR #445.

**Tech Stack:** git, pnpm, TypeScript, Vite, Electron, vitest, GitHub CLI (`gh`).

**Spec:** `docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md` — read before executing.

---

## Conventions

- **`GOLDEN`** = `feat/desktop-userification` (frozen — never push to it during the split).
- **`SPLIT_BASE`** = `feat/desktop-userification-split-base` (created in Task 0; cut from `main` HEAD).
- All `pnpm` commands run from the monorepo root unless noted. **Never use `npm`.**
- Every PR uses `gh pr create --draft` first; the user marks "Ready for review" once they're satisfied.
- Push commands target the user's `fork` remote (visible in `git branch -a`); replace with `origin` if the executor's setup differs.

## Per-PR commit-message convention

Each PR is a **single squash commit** built from the golden state of its files:

```
<type>(desktop): <one-line summary>

Part of the PR-split of #445. See docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md
for the full plan.

Files in this PR:
- <list>
```

`<type>` is `feat`, `style`, `refactor`, `test`, or `chore` per the message tone of commits already on `GOLDEN`.

---

## Task 0: Pre-flight — freeze golden, create base branch

**Files:** none modified yet.

- [ ] **Step 1: Confirm working tree is clean and on `GOLDEN`**

Run:
```bash
git status
git rev-parse --abbrev-ref HEAD
```
Expected: `working tree clean`, current branch `feat/desktop-userification`.

- [ ] **Step 2: Capture the golden HEAD commit for verification**

Run:
```bash
git rev-parse feat/desktop-userification
```
Expected: a SHA. Record it (e.g. paste in scratch); the end-to-end check will compare against this exact commit.

- [ ] **Step 3: Fetch latest `main`**

Run:
```bash
git fetch origin main:main
```
Expected: fast-forward of local `main`, or "Already up to date."

- [ ] **Step 4: Create the split base branch from `main` HEAD**

Run:
```bash
git switch -c feat/desktop-userification-split-base main
```
Expected: switched to a new branch.

- [ ] **Step 4b: Commit the split spec + plan as the seed of the split base**

These two meta-docs about the split should ride on the base so every child PR's branch inherits them.

Run:
```bash
git add docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md \
       docs/superpowers/plans/2026-05-04-pr-split-desktop-userification.md
git commit -m "$(cat <<'EOF'
docs(split): spec and plan for the PR-split of #445

Seed commit on feat/desktop-userification-split-base. These two files are
meta-documentation about the split itself; they are inherited by every child
PR's branch via cherry-pick base, and excluded from the end-to-end golden
byte-equality check (they do not exist on feat/desktop-userification).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 5: Push the base branch so child PRs can target it later if needed**

Run:
```bash
git push -u fork feat/desktop-userification-split-base
```
Expected: branch pushed.

- [ ] **Step 6 (optional, R3 mitigation): Install a local pre-push hook that refuses pushes to `GOLDEN`**

Append to `.git/hooks/pre-push` (create if absent), then `chmod +x`:
```bash
#!/usr/bin/env bash
remote_name="$1"
while read -r local_ref local_sha remote_ref remote_sha; do
  if [[ "$remote_ref" == "refs/heads/feat/desktop-userification" ]]; then
    echo "BLOCKED: feat/desktop-userification is frozen during PR split."
    exit 1
  fi
done
exit 0
```
This is local-only; safe to skip if the user prefers discipline.

- [ ] **Step 7: Verify build/typecheck/test pass on the base before any cherry-picking**

Run:
```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
```
Expected: all green. If anything fails, the failure is pre-existing on `main`; resolve or note before continuing — split tasks must not inherit a broken baseline.

- [ ] **Step 8: Commit the optional hook (if installed) and push**

Hooks are not tracked in git; nothing to commit. Skip.

---

## Task 1: Build & open PR 1 — Foundations

**Files (cherry-picked from `GOLDEN`):**
- Create: `apps/desktop/src/renderer/assets/provider-logos/anthropic.png`
- Create: `apps/desktop/src/renderer/assets/provider-logos/cohere.png`
- Create: `apps/desktop/src/renderer/assets/provider-logos/deepseek.png`
- Create: `apps/desktop/src/renderer/assets/provider-logos/google.png`
- Create: `apps/desktop/src/renderer/assets/provider-logos/meta.png`
- Create: `apps/desktop/src/renderer/assets/provider-logos/minimax.png`
- Create: `apps/desktop/src/renderer/assets/provider-logos/mistral.png`
- Create: `apps/desktop/src/renderer/assets/provider-logos/moonshot.png`
- Create: `apps/desktop/src/renderer/assets/provider-logos/nousresearch.svg`
- Create: `apps/desktop/src/renderer/assets/provider-logos/openai.png`
- Create: `apps/desktop/src/renderer/assets/provider-logos/qwen.png`
- Create: `apps/desktop/src/renderer/assets/provider-logos/zhipu.png`
- Create: `apps/desktop/src/renderer/ui/components/AlphaHint.tsx`
- Create: `apps/desktop/src/renderer/ui/components/AlphaHint.module.scss`
- Create: `apps/desktop/src/renderer/ui/components/chat/ProviderLogo.tsx`
- Create: `apps/desktop/src/renderer/ui/components/chat/model-logos.tsx`
- Create: `apps/desktop/src/renderer/ui/components/chat/discover-category-icons.ts`

- [ ] **Step 1: Cut the PR 1 branch from the split base**

Run:
```bash
git switch -c feat/desktop-foundations feat/desktop-userification-split-base
```
Expected: switched to a new branch.

- [ ] **Step 2: Cherry-pick the 17 files from `GOLDEN`**

Run:
```bash
git checkout feat/desktop-userification -- \
  apps/desktop/src/renderer/assets/provider-logos/anthropic.png \
  apps/desktop/src/renderer/assets/provider-logos/cohere.png \
  apps/desktop/src/renderer/assets/provider-logos/deepseek.png \
  apps/desktop/src/renderer/assets/provider-logos/google.png \
  apps/desktop/src/renderer/assets/provider-logos/meta.png \
  apps/desktop/src/renderer/assets/provider-logos/minimax.png \
  apps/desktop/src/renderer/assets/provider-logos/mistral.png \
  apps/desktop/src/renderer/assets/provider-logos/moonshot.png \
  apps/desktop/src/renderer/assets/provider-logos/nousresearch.svg \
  apps/desktop/src/renderer/assets/provider-logos/openai.png \
  apps/desktop/src/renderer/assets/provider-logos/qwen.png \
  apps/desktop/src/renderer/assets/provider-logos/zhipu.png \
  apps/desktop/src/renderer/ui/components/AlphaHint.tsx \
  apps/desktop/src/renderer/ui/components/AlphaHint.module.scss \
  apps/desktop/src/renderer/ui/components/chat/ProviderLogo.tsx \
  apps/desktop/src/renderer/ui/components/chat/model-logos.tsx \
  apps/desktop/src/renderer/ui/components/chat/discover-category-icons.ts
```
Expected: no output, files staged.

- [ ] **Step 3: Per-PR fidelity check (in-set files match golden byte-for-byte)**

Run:
```bash
git diff --cached feat/desktop-userification -- \
  apps/desktop/src/renderer/assets/provider-logos/ \
  apps/desktop/src/renderer/ui/components/AlphaHint.tsx \
  apps/desktop/src/renderer/ui/components/AlphaHint.module.scss \
  apps/desktop/src/renderer/ui/components/chat/ProviderLogo.tsx \
  apps/desktop/src/renderer/ui/components/chat/model-logos.tsx \
  apps/desktop/src/renderer/ui/components/chat/discover-category-icons.ts
```
Expected: empty output. **If non-empty, stop and investigate before continuing.**

- [ ] **Step 4: Per-PR scope check (no other files touched)**

Run:
```bash
git status --porcelain
```
Expected: lines beginning with `A  ` for exactly the 17 files above and nothing else.

- [ ] **Step 5: Install + build to verify isolated compile**

Run:
```bash
pnpm install
pnpm run build
```
Expected: full monorepo build succeeds. Foundation files compile without consumers (confirmed during spec self-review: no ESLint config, `noUnusedLocals` does not flag unused exports).

- [ ] **Step 6: Typecheck**

Run:
```bash
pnpm run typecheck
```
Expected: no errors.

- [ ] **Step 7: Run tests**

Run:
```bash
pnpm run test
```
Expected: all suites green. (No new tests in this PR; this just confirms nothing regressed.)

- [ ] **Step 8: Smoke-test the desktop app**

Run:
```bash
cd apps/desktop && pnpm run dev
```
Click through Chat/Discover/Config/External Clients views. **Expected:** identical to current `main`. The new components are present in the bundle but not rendered yet.

Stop the dev server (Ctrl-C) and `cd ..` back to repo root.

- [ ] **Step 9: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(desktop): add foundation assets and shared components

Part of the PR-split of #445. See docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md
for the full plan.

Files in this PR:
- 12 provider logo assets (PNG/SVG)
- AlphaHint component (tsx + scss)
- ProviderLogo component
- model-logos helper
- discover-category-icons helper

These are pure additions with no consumers in this PR. They are
introduced ahead of the views that will import them so reviewers can
focus on the visual surface changes in subsequent PRs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
Expected: single commit created.

- [ ] **Step 10: Push**

Run:
```bash
git push -u fork feat/desktop-foundations
```
Expected: branch pushed.

- [ ] **Step 11: Open the PR as a draft**

Run:
```bash
gh pr create --draft --base main --head feat/desktop-foundations \
  --title "feat(desktop): foundations — provider logos, AlphaHint, ProviderLogo, model-logos, category-icons" \
  --body "$(cat <<'EOF'
## Summary

Part 1 of 8 in the PR-split of #445.

Pure additions: 12 provider logo assets and 5 shared UI helpers. No consumers in this PR — they're introduced ahead of the views that import them in subsequent PRs of the split, so reviewers can read those PRs without the noise of new files.

## Files

- 12 PNG/SVG provider logos under `apps/desktop/src/renderer/assets/provider-logos/`
- `AlphaHint.tsx` + `.module.scss`
- `chat/ProviderLogo.tsx`
- `chat/model-logos.tsx`
- `chat/discover-category-icons.ts`

## Fidelity

- [x] \`git diff feat/desktop-userification..HEAD -- <files>\` is empty
- [x] No files outside the listed set are changed
- [x] Build / typecheck / test all green

## Plan

Full split plan: \`docs/superpowers/plans/2026-05-04-pr-split-desktop-userification.md\`
Tracking PR: #445

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```
Expected: PR URL printed.

- [ ] **Step 12: Capture PR 1's URL for Task 3's mapping comment**

Run:
```bash
gh pr view feat/desktop-foundations --json url -q .url
```
Record the URL printed — it'll go into PR #445's top-comment in Task 3.

---

## Task 2: Build & open PR 3 — Chat peer-routing module

*Eligible to run in parallel with Task 1.*

**Files (cherry-picked from `GOLDEN`):**
- Create: `apps/desktop/src/renderer/modules/chat.peer-routing.test.ts`
- Modify: `apps/desktop/src/renderer/modules/chat.ts`

- [ ] **Step 1: Cut the PR 3 branch from the split base**

Run:
```bash
git switch -c feat/desktop-chat-peer-routing feat/desktop-userification-split-base
```

- [ ] **Step 2: Cherry-pick both files**

Run:
```bash
git checkout feat/desktop-userification -- \
  apps/desktop/src/renderer/modules/chat.ts \
  apps/desktop/src/renderer/modules/chat.peer-routing.test.ts
```

- [ ] **Step 3: Per-PR fidelity check**

Run:
```bash
git diff --cached feat/desktop-userification -- \
  apps/desktop/src/renderer/modules/chat.ts \
  apps/desktop/src/renderer/modules/chat.peer-routing.test.ts
```
Expected: empty.

- [ ] **Step 4: Per-PR scope check**

Run:
```bash
git status --porcelain
```
Expected: only the two files above (`A  ` for the test, `M  ` for `chat.ts`).

- [ ] **Step 5: Build**

Run:
```bash
pnpm install
pnpm run build
```
Expected: success.

- [ ] **Step 6: Typecheck**

Run:
```bash
pnpm run typecheck
```
Expected: no errors.

- [ ] **Step 7: Run tests — must include the new `chat.peer-routing.test.ts`**

Run:
```bash
pnpm run test
```
Expected: all suites green, including the new peer-routing test (look for `chat.peer-routing.test` in the output).

- [ ] **Step 8: Smoke-test desktop chat**

Run:
```bash
cd apps/desktop && pnpm run dev
```
Send a chat message; confirm peer routing still works end-to-end. Stop the server.

- [ ] **Step 9: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(desktop): refine chat peer-routing module

Part of the PR-split of #445. See docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md
for the full plan.

Files in this PR:
- modules/chat.ts (peer-routing logic refinement)
- modules/chat.peer-routing.test.ts (new vitest coverage)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 10: Push and open the draft PR**

Run:
```bash
git push -u fork feat/desktop-chat-peer-routing
gh pr create --draft --base main --head feat/desktop-chat-peer-routing \
  --title "feat(desktop): refine chat peer-routing + add unit test" \
  --body "$(cat <<'EOF'
## Summary

Part 3 of 8 in the PR-split of #445.

Self-contained backend logic change in the chat module's peer routing, plus a new vitest covering the routing behaviour. Independent of the UI overhaul; no visual impact.

## Files

- \`apps/desktop/src/renderer/modules/chat.ts\` — peer-routing refinement
- \`apps/desktop/src/renderer/modules/chat.peer-routing.test.ts\` — new test

## Fidelity

- [x] \`git diff feat/desktop-userification..HEAD -- <files>\` is empty
- [x] No files outside the listed set are changed
- [x] Build / typecheck / test all green (including the new peer-routing test)

## Plan

Full split plan: \`docs/superpowers/plans/2026-05-04-pr-split-desktop-userification.md\`
Tracking PR: #445

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 11: Capture PR 3's URL for Task 3's mapping comment**

Run:
```bash
gh pr view feat/desktop-chat-peer-routing --json url -q .url
```
Record the URL printed — it'll go into PR #445's top-comment in Task 3 alongside PR 1's URL.

---

## Task 3: Convert PR #445 to draft and post the mapping comment

*Run after Tasks 1 and 2 are open (so URLs exist), or run later and update the comment as more PRs land.*

- [ ] **Step 1: Switch back to the golden branch (read-only — do not push)**

Run:
```bash
git switch feat/desktop-userification
```

- [ ] **Step 2: Convert PR #445 to draft**

Run:
```bash
gh pr ready 445 --undo
```
Expected: "Pull request #445 is now a draft."

- [ ] **Step 3: Post the top-comment explaining the split**

Run (fill in the URLs as PRs are opened — initially leave the later ones blank or "TBD"):
```bash
gh pr comment 445 --body "$(cat <<'EOF'
## ⚠️ This PR has been split into 8 smaller PRs

Per team-lead feedback that this PR is too large for one merge, the work is being shipped as a wave-structured stack of 8 focused PRs. This PR remains open as the **golden reference** — its branch (\`feat/desktop-userification\`) is frozen and used to verify byte-for-byte fidelity at the end. It will be closed once all 8 child PRs land and the end-to-end golden diff confirms zero loss.

### Child PRs

**Wave 1 — Foundations (parallel)**
- PR 1 — Foundations: <PR-1-URL>
- PR 3 — Chat peer-routing: <PR-3-URL>

**Wave 2 — Two parallel tracks (after Wave 1)**
- PR 2 — Discover inline filters: TBD
- PR 4 — App chrome refresh: TBD

**Wave 3 — View restyles (parallel, after PR 4)**
- PR 5 — Chat surface: TBD
- PR 7 — ConfigView: TBD
- PR 8 — ExternalClientsView: TBD

**Wave 4 — Discover landing (last)**
- PR 6 — Discover landing: TBD

### Reviewer comment mapping

If you've left review comments above on this PR, here's where they now live:

- _Comments on \`Sidebar.tsx\` / \`TitleBar.tsx\` / \`AppShell.tsx\` / \`WalletPanel.tsx\` / \`global.scss\`_ → reply on **PR 4 (chrome refresh)**
- _Comments on \`DiscoverWelcome.tsx\` / \`.module.scss\`_ → reply on **PR 6 (Discover landing)**
- _Comments on \`ExternalClientsView.tsx\` / \`.module.scss\`_ → reply on **PR 8 (ExternalClientsView)**
- _Comments on \`ConfigView.tsx\` / \`.module.scss\`_ → reply on **PR 7 (ConfigView)**
- _Comments on the inline filter components_ → reply on **PR 2**
- _Comments on chat-surface files (\`ChatView\`, \`ChatBubble\`, \`StreamingIndicator\`, \`ServiceDropdown\`, \`SessionApprovalCard\`)_ → reply on **PR 5**
- _Comments on the new shared components (\`AlphaHint\`, \`ProviderLogo\`, \`model-logos\`, \`discover-category-icons\`)_ → reply on **PR 1**
- _Comments on \`chat.ts\` peer-routing_ → reply on **PR 3**

Plan: \`docs/superpowers/plans/2026-05-04-pr-split-desktop-userification.md\`
Spec: \`docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md\`
EOF
)"
```
Expected: comment posted.

- [ ] **Step 4: Plan to keep the comment updated as later PRs open**

Each later task has a "Update PR #445 mapping comment" step. The simplest workflow is to open PR #445 in the GitHub web UI, click the `...` menu on the mapping comment, and replace the relevant `TBD` line with the new PR's URL.

Alternative if you prefer the CLI: get the comment ID from `gh api repos/AntSeed/antseed/issues/445/comments --jq '.[].id'`, then `gh api -X PATCH repos/AntSeed/antseed/issues/comments/<id> -f body=@new-body.md`.

---

## Task 4: After PR 1 merges — build & open PR 2 (Discover inline filters)

**Wait condition:** PR 1 must be merged to `main` before starting.

**Files (cherry-picked from `GOLDEN`):**
- Create: `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.tsx`
- Create: `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.module.scss`
- Create: `apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.tsx`
- Create: `apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.module.scss`
- Create: `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineSortFilter.tsx`
- Create: `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineSortFilter.module.scss`
- Create: `apps/desktop/src/renderer/ui/components/chat/discover-filter-util.ts`
- Create: `apps/desktop/src/renderer/ui/components/chat/discover-filter-util.test.ts`
- Modify: `apps/desktop/src/renderer/ui/hooks/useDiscoverFilters.ts`
- Modify: `apps/desktop/src/renderer/ui/components/chat/DiscoverFilters.tsx`
- Modify: `apps/desktop/src/renderer/ui/components/chat/DiscoverFilters.module.scss`
- Create: `docs/superpowers/specs/2026-05-03-discover-inline-filters-design.md`
- Create: `docs/superpowers/plans/2026-05-03-discover-inline-filters.md`
- Modify: `.gitignore`

- [ ] **Step 1: Update `main` and cut the PR 2 branch**

Run:
```bash
git fetch origin main:main
git switch -c feat/desktop-discover-inline-filters main
```

- [ ] **Step 2: Cherry-pick the 14 files**

Run:
```bash
git checkout feat/desktop-userification -- \
  apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.tsx \
  apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.module.scss \
  apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.tsx \
  apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.module.scss \
  apps/desktop/src/renderer/ui/components/chat/DiscoverInlineSortFilter.tsx \
  apps/desktop/src/renderer/ui/components/chat/DiscoverInlineSortFilter.module.scss \
  apps/desktop/src/renderer/ui/components/chat/discover-filter-util.ts \
  apps/desktop/src/renderer/ui/components/chat/discover-filter-util.test.ts \
  apps/desktop/src/renderer/ui/hooks/useDiscoverFilters.ts \
  apps/desktop/src/renderer/ui/components/chat/DiscoverFilters.tsx \
  apps/desktop/src/renderer/ui/components/chat/DiscoverFilters.module.scss \
  docs/superpowers/specs/2026-05-03-discover-inline-filters-design.md \
  docs/superpowers/plans/2026-05-03-discover-inline-filters.md \
  .gitignore
```

- [ ] **Step 3: Per-PR fidelity check**

Run:
```bash
git diff --cached feat/desktop-userification -- \
  apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.tsx \
  apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.module.scss \
  apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.tsx \
  apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.module.scss \
  apps/desktop/src/renderer/ui/components/chat/DiscoverInlineSortFilter.tsx \
  apps/desktop/src/renderer/ui/components/chat/DiscoverInlineSortFilter.module.scss \
  apps/desktop/src/renderer/ui/components/chat/discover-filter-util.ts \
  apps/desktop/src/renderer/ui/components/chat/discover-filter-util.test.ts \
  apps/desktop/src/renderer/ui/hooks/useDiscoverFilters.ts \
  apps/desktop/src/renderer/ui/components/chat/DiscoverFilters.tsx \
  apps/desktop/src/renderer/ui/components/chat/DiscoverFilters.module.scss \
  docs/superpowers/specs/2026-05-03-discover-inline-filters-design.md \
  docs/superpowers/plans/2026-05-03-discover-inline-filters.md \
  .gitignore
```
Expected: empty.

- [ ] **Step 4: Per-PR scope check**

Run:
```bash
git status --porcelain
```
Expected: only the 14 files above.

- [ ] **Step 5: Build**

Run:
```bash
pnpm install
pnpm run build
```
Expected: success. (PR 1's `discover-category-icons` is already on `main`; `DiscoverFilters.tsx`'s import resolves.)

- [ ] **Step 6: Typecheck**

Run:
```bash
pnpm run typecheck
```
Expected: no errors.

- [ ] **Step 7: Run tests — must include the new `discover-filter-util.test.ts`**

Run:
```bash
pnpm run test
```
Expected: all suites green, including `discover-filter-util.test`.

- [ ] **Step 8: Smoke-test the inline filters in the desktop app**

Run:
```bash
cd apps/desktop && pnpm run dev
```
On the Discover view, exercise:
- Category dropdown opens, multi-select, Esc / outside-click closes, label updates
- Price dropdown opens, single-select, label updates
- Sort dropdown still works
- Existing filter drawer (sliders icon) still opens and operates

Stop the server.

- [ ] **Step 9: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(desktop): inline Discover filters (Category, Price, Sort)

Part of the PR-split of #445. See docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md
for the full plan.

Implements the spec at docs/superpowers/specs/2026-05-03-discover-inline-filters-design.md.

Files in this PR:
- DiscoverInlineCategoryFilter, DiscoverInlinePriceFilter, DiscoverInlineSortFilter (3 component pairs)
- discover-filter-util + test
- useDiscoverFilters hook (clearCategories addition)
- DiscoverFilters mount + TimeWindowSelect addition
- Spec + implementation plan for the inline-filters feature
- .gitignore: ignore .superpowers/ session content

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 10: Push and open the draft PR**

Run:
```bash
git push -u fork feat/desktop-discover-inline-filters
gh pr create --draft --base main --head feat/desktop-discover-inline-filters \
  --title "feat(desktop): inline Discover filters — Category, Price, Sort" \
  --body "$(cat <<'EOF'
## Summary

Part 2 of 8 in the PR-split of #445.

Surfaces three filter axes (Category, Price, Sort) as inline dropdowns on the Discover controls row, instead of being hidden behind the advanced-filters drawer. Drawer remains as the escape hatch for the rest of the filter axes.

This PR ships the spec, the plan, and the implementation together for self-contained review.

## Files

- 3 new inline-filter component pairs (\`DiscoverInline{Category,Price,Sort}Filter\` + scss)
- \`discover-filter-util.ts\` + vitest
- Hook addition (\`useDiscoverFilters.clearCategories\`)
- DiscoverFilters mount + TimeWindowSelect inline addition
- Inline-filters spec and implementation plan under \`docs/superpowers/\`
- \`.gitignore\`: ignore \`.superpowers/\` session content

## Fidelity

- [x] \`git diff feat/desktop-userification..HEAD -- <files>\` is empty
- [x] No files outside the listed set are changed
- [x] Build / typecheck / test all green (incl. \`discover-filter-util.test\`)

## Plan

Full split plan: \`docs/superpowers/plans/2026-05-04-pr-split-desktop-userification.md\`
Tracking PR: #445

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 11: Update PR #445's mapping comment with PR 2's URL**

Get this PR's URL:
```bash
gh pr view feat/desktop-discover-inline-filters --json url -q .url
```

Open PR #445 in GitHub, find the mapping comment posted in Task 3, and replace the `TBD` next to "PR 2 — Discover inline filters" with the URL printed above.

---

## Task 5: After PR 1 merges — build & open PR 4 (App chrome refresh + WalletPanel)

*Eligible to run in parallel with Task 4 — they touch disjoint files.*

**Wait condition:** PR 1 must be merged to `main`.

**Files (cherry-picked from `GOLDEN`):**
- Modify: `apps/desktop/src/renderer/ui/AppShell.tsx`
- Modify: `apps/desktop/src/renderer/ui/components/Sidebar.tsx`
- Modify: `apps/desktop/src/renderer/ui/components/Sidebar.module.scss`
- Modify: `apps/desktop/src/renderer/ui/components/TitleBar.tsx`
- Modify: `apps/desktop/src/renderer/ui/components/TitleBar.module.scss`
- Create: `apps/desktop/src/renderer/ui/components/WalletPanel.tsx`
- Modify: `apps/desktop/src/renderer/global.scss`

- [ ] **Step 1: Update `main` and cut the PR 4 branch**

Run:
```bash
git fetch origin main:main
git switch -c feat/desktop-chrome-refresh main
```

- [ ] **Step 2: Cherry-pick the 7 files**

Run:
```bash
git checkout feat/desktop-userification -- \
  apps/desktop/src/renderer/ui/AppShell.tsx \
  apps/desktop/src/renderer/ui/components/Sidebar.tsx \
  apps/desktop/src/renderer/ui/components/Sidebar.module.scss \
  apps/desktop/src/renderer/ui/components/TitleBar.tsx \
  apps/desktop/src/renderer/ui/components/TitleBar.module.scss \
  apps/desktop/src/renderer/ui/components/WalletPanel.tsx \
  apps/desktop/src/renderer/global.scss
```

- [ ] **Step 3: Per-PR fidelity check**

Run:
```bash
git diff --cached feat/desktop-userification -- \
  apps/desktop/src/renderer/ui/AppShell.tsx \
  apps/desktop/src/renderer/ui/components/Sidebar.tsx \
  apps/desktop/src/renderer/ui/components/Sidebar.module.scss \
  apps/desktop/src/renderer/ui/components/TitleBar.tsx \
  apps/desktop/src/renderer/ui/components/TitleBar.module.scss \
  apps/desktop/src/renderer/ui/components/WalletPanel.tsx \
  apps/desktop/src/renderer/global.scss
```
Expected: empty.

- [ ] **Step 4: Per-PR scope check**

Run:
```bash
git status --porcelain
```
Expected: only the 7 files above.

- [ ] **Step 5: Rebuild Electron native modules (R7 mitigation)**

The chrome refresh removes the OS titlebar — most likely surface for native quirks.

Run:
```bash
pnpm install
cd apps/desktop && pnpm run rebuild && cd -
```
Expected: native modules rebuilt for Electron's Node version.

- [ ] **Step 6: Build**

Run:
```bash
pnpm run build
```

- [ ] **Step 7: Typecheck**

Run:
```bash
pnpm run typecheck
```

- [ ] **Step 8: Run tests**

Run:
```bash
pnpm run test
```

- [ ] **Step 9: Smoke-test the new chrome on macOS (the user's actual platform)**

Run:
```bash
cd apps/desktop && pnpm run dev
```
Verify:
- OS titlebar is gone; sidebar is restyled with the new logo
- Wallet panel opens from the sidebar/wallet trigger; copy-address tick animates; close works
- AlphaHint renders where designed
- Sidebar navigation between Chat / Discover / Config / External Clients still works
- Window can still be moved (drag region works) and resized

Take screenshots; attach to the PR.

Stop the server.

- [ ] **Step 10: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(desktop): app chrome refresh — remove OS titlebar, restyle sidebar, add WalletPanel

Part of the PR-split of #445. See docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md
for the full plan.

Files in this PR:
- AppShell.tsx (chrome wiring)
- Sidebar.tsx + .module.scss (full restyle, mounts AlphaHint + WalletPanel + uses model-logos)
- TitleBar.tsx + .module.scss (replacement; also hosts wallet-panel styles)
- WalletPanel.tsx (new component; imports TitleBar.module.scss)
- global.scss

Consumes the foundation components from PR #1 (AlphaHint, model-logos).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 11: Push and open the draft PR**

Run:
```bash
git push -u fork feat/desktop-chrome-refresh
gh pr create --draft --base main --head feat/desktop-chrome-refresh \
  --title "feat(desktop): app chrome refresh — remove titlebar, restyle sidebar, add WalletPanel" \
  --body "$(cat <<'EOF'
## Summary

Part 4 of 8 in the PR-split of #445.

The largest structural change in the split — removes the OS titlebar, fully restyles the sidebar, and introduces the WalletPanel. Foundation for the per-view restyles in PRs 5/6/7/8.

## Files

- \`AppShell.tsx\` (chrome wiring)
- \`Sidebar.tsx\` + \`.module.scss\` (full restyle; mounts AlphaHint + WalletPanel; uses model-logos)
- \`TitleBar.tsx\` + \`.module.scss\` (replacement; also hosts wallet-panel styles)
- \`WalletPanel.tsx\` (new; imports TitleBar.module.scss)
- \`global.scss\`

Depends on PR #1 (foundations) for AlphaHint and model-logos.

## Test plan

- [x] Build / typecheck / test green
- [x] OS titlebar removed; sidebar restyled
- [x] Wallet panel: open / copy-address / close
- [x] AlphaHint renders correctly
- [x] Window drag-region + resize still works on macOS
- [x] Sidebar navigation between Chat/Discover/Config/External Clients still works

Screenshots attached.

## Plan

Full split plan: \`docs/superpowers/plans/2026-05-04-pr-split-desktop-userification.md\`
Tracking PR: #445

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 12: Attach screenshots and update PR #445's mapping comment with PR 4's URL**

Attach screenshots via the GitHub web UI (drag-and-drop into a PR comment).

Get this PR's URL:
```bash
gh pr view feat/desktop-chrome-refresh --json url -q .url
```

Open PR #445 and replace the `TBD` next to "PR 4 — App chrome refresh" in the mapping comment with the URL printed above.

---

## Task 6: After PR 4 merges — build & open PR 5 (Chat surface restyle)

*Eligible to run in parallel with Tasks 7 and 8 — disjoint files.*

**Wait condition:** PR 4 must be merged to `main`.

**Files (cherry-picked from `GOLDEN`):**
- Modify: `apps/desktop/src/renderer/ui/components/views/ChatView.tsx`
- Modify: `apps/desktop/src/renderer/ui/components/views/ChatView.module.scss`
- Modify: `apps/desktop/src/renderer/ui/components/chat/ChatBubble.tsx`
- Modify: `apps/desktop/src/renderer/ui/components/StreamingIndicator.tsx`
- Modify: `apps/desktop/src/renderer/ui/components/StreamingIndicator.module.scss`
- Modify: `apps/desktop/src/renderer/ui/components/chat/ServiceDropdown.tsx`
- Modify: `apps/desktop/src/renderer/ui/components/chat/ServiceDropdown.module.scss`
- Modify: `apps/desktop/src/renderer/ui/components/chat/SwitchServiceDialog.module.scss`
- Modify: `apps/desktop/src/renderer/ui/components/chat/SessionApprovalCard.tsx`
- Modify: `apps/desktop/src/renderer/ui/components/chat/SessionApprovalCard.module.scss`

- [ ] **Step 1: Update `main` and cut branch**

Run:
```bash
git fetch origin main:main
git switch -c feat/desktop-chat-surface main
```

- [ ] **Step 2: Cherry-pick the 10 files**

Run:
```bash
git checkout feat/desktop-userification -- \
  apps/desktop/src/renderer/ui/components/views/ChatView.tsx \
  apps/desktop/src/renderer/ui/components/views/ChatView.module.scss \
  apps/desktop/src/renderer/ui/components/chat/ChatBubble.tsx \
  apps/desktop/src/renderer/ui/components/StreamingIndicator.tsx \
  apps/desktop/src/renderer/ui/components/StreamingIndicator.module.scss \
  apps/desktop/src/renderer/ui/components/chat/ServiceDropdown.tsx \
  apps/desktop/src/renderer/ui/components/chat/ServiceDropdown.module.scss \
  apps/desktop/src/renderer/ui/components/chat/SwitchServiceDialog.module.scss \
  apps/desktop/src/renderer/ui/components/chat/SessionApprovalCard.tsx \
  apps/desktop/src/renderer/ui/components/chat/SessionApprovalCard.module.scss
```

- [ ] **Step 3: Per-PR fidelity check**

Run:
```bash
git diff --cached feat/desktop-userification -- \
  apps/desktop/src/renderer/ui/components/views/ChatView.tsx \
  apps/desktop/src/renderer/ui/components/views/ChatView.module.scss \
  apps/desktop/src/renderer/ui/components/chat/ChatBubble.tsx \
  apps/desktop/src/renderer/ui/components/StreamingIndicator.tsx \
  apps/desktop/src/renderer/ui/components/StreamingIndicator.module.scss \
  apps/desktop/src/renderer/ui/components/chat/ServiceDropdown.tsx \
  apps/desktop/src/renderer/ui/components/chat/ServiceDropdown.module.scss \
  apps/desktop/src/renderer/ui/components/chat/SwitchServiceDialog.module.scss \
  apps/desktop/src/renderer/ui/components/chat/SessionApprovalCard.tsx \
  apps/desktop/src/renderer/ui/components/chat/SessionApprovalCard.module.scss
```
Expected: empty.

- [ ] **Step 4: Per-PR scope check**

Run:
```bash
git status --porcelain
```
Expected: only the 10 files above.

- [ ] **Step 5: Build, typecheck, test**

Run:
```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
```
Expected: all green.

- [ ] **Step 6: Smoke-test the chat surface**

Run:
```bash
cd apps/desktop && pnpm run dev
```
Verify on the Chat view:
- ChatBubble rendering of user + assistant messages (incl. streaming)
- StreamingIndicator animation
- ServiceDropdown trigger + popover (uses ProviderLogo from PR 1)
- Switch-service dialog
- SessionApprovalCard appearance + accept/reject flow

Take screenshots; attach to the PR.

Stop the server.

- [ ] **Step 7: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(desktop): chat surface restyle — ChatView, bubbles, streaming, service dropdown, approval card

Part of the PR-split of #445. See docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md
for the full plan.

Files in this PR:
- views/ChatView.tsx + .module.scss
- chat/ChatBubble.tsx
- StreamingIndicator.tsx + .module.scss
- chat/ServiceDropdown.tsx + .module.scss (uses ProviderLogo from PR 1)
- chat/SwitchServiceDialog.module.scss
- chat/SessionApprovalCard.tsx + .module.scss

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Push and open the draft PR**

Run:
```bash
git push -u fork feat/desktop-chat-surface
gh pr create --draft --base main --head feat/desktop-chat-surface \
  --title "feat(desktop): chat surface restyle — ChatView, bubbles, streaming, service dropdown, approval card" \
  --body "$(cat <<'EOF'
## Summary

Part 5 of 8 in the PR-split of #445.

Restyles the chat surface — view shell, message bubbles, streaming indicator, service-switcher dropdown and dialog, session approval card. Renders inside the new chrome from PR #4.

## Files

- \`views/ChatView.tsx\` + \`.module.scss\`
- \`chat/ChatBubble.tsx\`
- \`StreamingIndicator.tsx\` + \`.module.scss\`
- \`chat/ServiceDropdown.tsx\` + \`.module.scss\`
- \`chat/SwitchServiceDialog.module.scss\`
- \`chat/SessionApprovalCard.tsx\` + \`.module.scss\`

Depends on PR #1 (ProviderLogo) and PR #4 (chrome layout).

## Test plan

- [x] Build / typecheck / test green
- [x] Chat send / receive / streaming
- [x] Service dropdown + switch dialog
- [x] Session approval card flow

Screenshots attached.

## Plan

Full split plan: \`docs/superpowers/plans/2026-05-04-pr-split-desktop-userification.md\`
Tracking PR: #445

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 9: Attach screenshots and update PR #445's mapping comment with PR 5's URL**

Attach screenshots via the GitHub web UI.

Get this PR's URL:
```bash
gh pr view feat/desktop-chat-surface --json url -q .url
```

Open PR #445 and replace the `TBD` next to "PR 5 — Chat surface" with the URL printed above.

---

## Task 7: After PR 4 merges — build & open PR 7 (ConfigView restyle)

*Eligible to run in parallel with Tasks 6 and 8.*

**Wait condition:** PR 4 must be merged to `main`.

**Files (cherry-picked from `GOLDEN`):**
- Modify: `apps/desktop/src/renderer/ui/components/views/ConfigView.tsx`
- Create: `apps/desktop/src/renderer/ui/components/views/ConfigView.module.scss`

- [ ] **Step 1: Update `main` and cut branch**

Run:
```bash
git fetch origin main:main
git switch -c feat/desktop-config-view main
```

- [ ] **Step 2: Cherry-pick**

Run:
```bash
git checkout feat/desktop-userification -- \
  apps/desktop/src/renderer/ui/components/views/ConfigView.tsx \
  apps/desktop/src/renderer/ui/components/views/ConfigView.module.scss
```

- [ ] **Step 3: Per-PR fidelity check**

Run:
```bash
git diff --cached feat/desktop-userification -- \
  apps/desktop/src/renderer/ui/components/views/ConfigView.tsx \
  apps/desktop/src/renderer/ui/components/views/ConfigView.module.scss
```
Expected: empty.

- [ ] **Step 4: Per-PR scope check**

Run:
```bash
git status --porcelain
```
Expected: only the 2 files above.

- [ ] **Step 5: Build / typecheck / test**

Run:
```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
```
Expected: all green.

- [ ] **Step 6: Smoke-test ConfigView**

Run:
```bash
cd apps/desktop && pnpm run dev
```
Open Settings (Config view). Verify all sections render and editing/saving config still works (Chain Config, etc.).

Screenshots; attach to PR.

- [ ] **Step 7: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
style(desktop): ConfigView restyle

Part of the PR-split of #445. See docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md
for the full plan.

Files in this PR:
- views/ConfigView.tsx + .module.scss

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Push and open the draft PR**

Run:
```bash
git push -u fork feat/desktop-config-view
gh pr create --draft --base main --head feat/desktop-config-view \
  --title "style(desktop): ConfigView restyle" \
  --body "$(cat <<'EOF'
## Summary

Part 7 of 8 in the PR-split of #445.

Restyles the Config (Settings) view. Two-file change.

## Files

- \`views/ConfigView.tsx\`
- \`views/ConfigView.module.scss\`

Depends on PR #4 (chrome layout).

## Test plan

- [x] Build / typecheck / test green
- [x] All settings sections render
- [x] Editing + saving Chain Config still works

Screenshots attached.

## Plan

Full split plan: \`docs/superpowers/plans/2026-05-04-pr-split-desktop-userification.md\`
Tracking PR: #445

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 9: Update PR #445's mapping comment with PR 7's URL**

Get this PR's URL:
```bash
gh pr view feat/desktop-config-view --json url -q .url
```

Open PR #445 and replace the `TBD` next to "PR 7 — ConfigView" with the URL printed above.

---

## Task 8: After PR 4 merges — build & open PR 8 (ExternalClientsView restyle)

*Eligible to run in parallel with Tasks 6 and 7.*

**Wait condition:** PR 4 must be merged to `main`.

**Files (cherry-picked from `GOLDEN`):**
- Modify: `apps/desktop/src/renderer/ui/components/views/ExternalClientsView.tsx`
- Modify: `apps/desktop/src/renderer/ui/components/views/ExternalClientsView.module.scss`

- [ ] **Step 1: Update `main` and cut branch**

Run:
```bash
git fetch origin main:main
git switch -c feat/desktop-external-clients-view main
```

- [ ] **Step 2: Cherry-pick**

Run:
```bash
git checkout feat/desktop-userification -- \
  apps/desktop/src/renderer/ui/components/views/ExternalClientsView.tsx \
  apps/desktop/src/renderer/ui/components/views/ExternalClientsView.module.scss
```

- [ ] **Step 3: Per-PR fidelity check**

Run:
```bash
git diff --cached feat/desktop-userification -- \
  apps/desktop/src/renderer/ui/components/views/ExternalClientsView.tsx \
  apps/desktop/src/renderer/ui/components/views/ExternalClientsView.module.scss
```
Expected: empty.

- [ ] **Step 4: Per-PR scope check**

Run:
```bash
git status --porcelain
```
Expected: only the 2 files above.

- [ ] **Step 5: Build / typecheck / test**

Run:
```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
```

- [ ] **Step 6: Smoke-test ExternalClientsView**

Run:
```bash
cd apps/desktop && pnpm run dev
```
Open the External Clients view. Walk the full flow:
- List of clients renders
- Add-client / pair-client flow runs end-to-end
- Per-client detail / edit / remove still work

Screenshots; attach.

- [ ] **Step 7: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
style(desktop): ExternalClientsView restyle and flow refinement

Part of the PR-split of #445. See docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md
for the full plan.

Files in this PR:
- views/ExternalClientsView.tsx + .module.scss

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Push and open the draft PR**

Run:
```bash
git push -u fork feat/desktop-external-clients-view
gh pr create --draft --base main --head feat/desktop-external-clients-view \
  --title "style(desktop): ExternalClientsView restyle and flow refinement" \
  --body "$(cat <<'EOF'
## Summary

Part 8 of 8 in the PR-split of #445.

Largest single PR in the split (~2,000 LOC) but cohesive — one view's full restyle and flow refinement. Two-file change.

## Files

- \`views/ExternalClientsView.tsx\`
- \`views/ExternalClientsView.module.scss\`

Depends on PR #4 (chrome layout).

## Test plan

- [x] Build / typecheck / test green
- [x] List renders
- [x] Add-client / pair-client flow end-to-end
- [x] Per-client detail / edit / remove

Screenshots attached.

## Plan

Full split plan: \`docs/superpowers/plans/2026-05-04-pr-split-desktop-userification.md\`
Tracking PR: #445

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 9: Update PR #445's mapping comment with PR 8's URL**

Get this PR's URL:
```bash
gh pr view feat/desktop-external-clients-view --json url -q .url
```

Open PR #445 and replace the `TBD` next to "PR 8 — ExternalClientsView" with the URL printed above.

---

## Task 9: After PR 2, PR 4, and PR 5 all merge — build & open PR 6 (Discover landing restyle)

**Wait condition:** All of PR 2, PR 4, PR 5 must be merged to `main`.

> **Optional R5 mitigation (parallel-eligible after PR 4 *opens*):** If PR 6 review becomes a bottleneck, you can cut an early draft branch off PR 4's branch, cherry-pick DiscoverWelcome onto it, push, and open a draft PR titled "DO NOT MERGE until #2, #4, #5 land" so reviewers can read the diff in parallel. When the wait condition above is met, rebase that branch onto `main` and run the steps below from Step 3 onward. Skip if reviews are moving quickly.

**Files (cherry-picked from `GOLDEN`):**
- Modify: `apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.tsx`
- Modify: `apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.module.scss`

- [ ] **Step 1: Update `main` and cut branch**

Run:
```bash
git fetch origin main:main
git switch -c feat/desktop-discover-landing main
```

- [ ] **Step 2: Cherry-pick**

Run:
```bash
git checkout feat/desktop-userification -- \
  apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.tsx \
  apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.module.scss
```

- [ ] **Step 3: Per-PR fidelity check**

Run:
```bash
git diff --cached feat/desktop-userification -- \
  apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.tsx \
  apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.module.scss
```
Expected: empty.

- [ ] **Step 4: Per-PR scope check**

Run:
```bash
git status --porcelain
```
Expected: only the 2 files above.

- [ ] **Step 5: Build / typecheck / test**

Run:
```bash
pnpm install
pnpm run build
pnpm run typecheck
pnpm run test
```

- [ ] **Step 6: Smoke-test the Discover landing**

Run:
```bash
cd apps/desktop && pnpm run dev
```
Open Discover. Verify:
- Card grid renders with redesigned cards (uses ProviderLogo + category icons from PR 1)
- Inline filters (Category / Price / Sort) from PR 2 sit correctly above the grid
- Search + filter drawer still work
- Provider tags + alpha badge render correctly

Screenshots; attach.

- [ ] **Step 7: Commit**

Run:
```bash
git commit -m "$(cat <<'EOF'
feat(desktop): Discover landing restyle — DiscoverWelcome

Part of the PR-split of #445. See docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md
for the full plan.

Files in this PR:
- chat/DiscoverWelcome.tsx + .module.scss

Renders inside the new chrome (PR #4) and chat surface (PR #5), uses
foundations from PR #1 (ProviderLogo, discover-category-icons), and
integrates with the inline filters from PR #2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Step 8: Push and open the draft PR**

Run:
```bash
git push -u fork feat/desktop-discover-landing
gh pr create --draft --base main --head feat/desktop-discover-landing \
  --title "feat(desktop): Discover landing restyle — DiscoverWelcome card redesign + provider logos" \
  --body "$(cat <<'EOF'
## Summary

Part 6 of 8 (last) in the PR-split of #445.

Restyles the Discover landing page — card redesign, provider logos integration, alpha-badge restyle. Two-file change but the largest single visual surface in the split.

## Files

- \`chat/DiscoverWelcome.tsx\`
- \`chat/DiscoverWelcome.module.scss\`

Depends on:
- PR #1 (ProviderLogo, discover-category-icons)
- PR #2 (inline filters integration)
- PR #4 (chrome layout)
- PR #5 (chat surface — ChatView shell)

## Test plan

- [x] Build / typecheck / test green
- [x] Card grid renders with new design + provider logos + category icons
- [x] Inline filters above the grid work
- [x] Search + filter drawer still work
- [x] Alpha badge + provider tags render correctly

Screenshots attached.

## Plan

Full split plan: \`docs/superpowers/plans/2026-05-04-pr-split-desktop-userification.md\`
Tracking PR: #445 (will be closed after this lands and Task 10 verifies)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] **Step 9: Update PR #445's mapping comment with PR 6's URL**

Get this PR's URL:
```bash
gh pr view feat/desktop-discover-landing --json url -q .url
```

Open PR #445 and replace the `TBD` next to "PR 6 — Discover landing" with the URL printed above.

---

## Task 10: End-to-end golden verification + close PR #445

**Wait condition:** All 8 PRs (1, 2, 3, 4, 5, 6, 7, 8) merged to `main`.

- [ ] **Step 1: Update `main` to the latest merged state**

Run:
```bash
git switch main
git fetch origin main:main
git pull --ff-only
```

- [ ] **Step 2: Run the headline byte-equality check**

Run:
```bash
git diff feat/desktop-userification..main -- \
  apps/desktop \
  docs/superpowers \
  .gitignore \
  ':(exclude)docs/superpowers/specs/2026-05-04-pr-split-desktop-userification-design.md' \
  ':(exclude)docs/superpowers/plans/2026-05-04-pr-split-desktop-userification.md'
```
**Expected: empty output.**

The two excluded paths are this plan and its spec — meta-docs about the split that live on `feat/desktop-userification-split-base` (and were inherited by every child branch). They do not exist on GOLDEN, so they would otherwise show as legitimate additions.

If non-empty after the exclusions, the diff itself names exactly what was dropped. Continue to Step 3 (open a fidelity catch-up PR). If empty, skip to Step 5.

- [ ] **Step 3 (only if Step 2 was non-empty): Open a fidelity catch-up PR**

Run:
```bash
git switch -c chore/desktop-userification-fidelity-catchup main
git checkout feat/desktop-userification -- <files-from-step-2-output>
git status --porcelain   # verify only the expected files
git diff feat/desktop-userification..HEAD   # verify empty
git commit -m "chore(desktop): fidelity catch-up — restore bytes missed in PR-split"
git push -u fork chore/desktop-userification-fidelity-catchup
gh pr create --base main --head chore/desktop-userification-fidelity-catchup \
  --title "chore(desktop): fidelity catch-up — restore bytes missed in PR-split"
```
Wait for it to merge, then re-run Step 2 to confirm empty.

- [ ] **Step 4: Re-run the byte-equality check**

Run:
```bash
git fetch origin main:main && git switch main && git pull --ff-only
git diff feat/desktop-userification..main -- apps/desktop docs/superpowers .gitignore
```
**Expected: empty.**

- [ ] **Step 5: Close PR #445 with a final note**

Run:
```bash
gh pr comment 445 --body "All 8 split PRs have landed and the end-to-end golden diff against main is empty — byte-for-byte fidelity confirmed. Closing this PR."
gh pr close 445
```

- [ ] **Step 6: Delete the split-base branch**

Run:
```bash
git push fork --delete feat/desktop-userification-split-base
```

- [ ] **Step 7: (Optional) delete the merged feature branches locally**

Run:
```bash
git branch -d feat/desktop-foundations feat/desktop-discover-inline-filters \
  feat/desktop-chat-peer-routing feat/desktop-chrome-refresh \
  feat/desktop-chat-surface feat/desktop-discover-landing \
  feat/desktop-config-view feat/desktop-external-clients-view
```

- [ ] **Step 8: (Optional) delete the local pre-push hook**

Edit or remove `.git/hooks/pre-push` if installed in Task 0 step 6.

---

## Coverage check (run before executing)

Every file from the original golden diff must appear in exactly one task. The 56-file partition:

- **Task 1 (PR 1):** 12 assets + AlphaHint.{tsx,scss} + ProviderLogo + model-logos + discover-category-icons = **17 files**
- **Task 2 (PR 3):** chat.ts + chat.peer-routing.test.ts = **2 files**
- **Task 4 (PR 2):** 6 inline-filter component files + discover-filter-util.{ts,test.ts} + useDiscoverFilters + DiscoverFilters.{tsx,scss} + 2 doc files + .gitignore = **14 files**
- **Task 5 (PR 4):** AppShell + Sidebar.{tsx,scss} + TitleBar.{tsx,scss} + WalletPanel + global.scss = **7 files**
- **Task 6 (PR 5):** ChatView.{tsx,scss} + ChatBubble + StreamingIndicator.{tsx,scss} + ServiceDropdown.{tsx,scss} + SwitchServiceDialog.scss + SessionApprovalCard.{tsx,scss} = **10 files**
- **Task 7 (PR 7):** ConfigView.{tsx,scss} = **2 files**
- **Task 8 (PR 8):** ExternalClientsView.{tsx,scss} = **2 files**
- **Task 9 (PR 6):** DiscoverWelcome.{tsx,scss} = **2 files**

Total: 17 + 2 + 14 + 7 + 10 + 2 + 2 + 2 = **56 files.** ✅ Matches the golden diff exactly.
