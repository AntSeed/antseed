# Discover — Inline Category & Price Filters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface two new dropdown filter pills (Categories multi-select, Price preset single-select) in the Discover marketplace controls row, sharing state with the existing `useDiscoverFilters` hook.

**Architecture:** Two purpose-built React components live alongside the existing `DiscoverFilters` drawer. They write to the same hook setters as the drawer so there is one source of truth. A small helper module gains `PRICE_PRESETS` + `matchPricePreset` for label/active-state derivation. The hook gains one method, `clearCategories()`. No new state, no new dependencies, no schema changes.

**Tech Stack:** TypeScript, React (function components + hooks), CSS modules (kebab-case in `.module.scss` accessed as camelCase in TS), Node built-in test runner via `npx tsx --test`.

**Spec:** `docs/superpowers/specs/2026-05-03-discover-inline-filters-design.md`

---

## File Structure

**New files**
- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.tsx` — multi-select chip popover. Owns local `open` state and outside-click listener. Reads `availableCategories` / `categorySet`, writes via `toggleCategory` / `clearCategories`.
- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.module.scss` — trigger pill + popover styles. Reuses CSS variables already defined in `DiscoverWelcome.module.scss` (`--bg-card`, `--border`, etc.).
- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.tsx` — single-select radio popover for the four price buckets. Reads `maxInputPrice` / `maxOutputPrice`, writes via `setMaxInputPrice` / `setMaxOutputPrice`.
- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.module.scss` — trigger pill + popover styles.

**Modified files**
- `apps/desktop/src/renderer/ui/components/chat/discover-filter-util.ts` — add `PRICE_PRESETS` constant, `PricePresetId` type, `matchPricePreset()` helper.
- `apps/desktop/src/renderer/ui/components/chat/discover-filter-util.test.ts` — add 4 tests for the new helper.
- `apps/desktop/src/renderer/ui/hooks/useDiscoverFilters.ts` — add `clearCategories` method to state and return value.
- `apps/desktop/src/renderer/ui/hooks/useDiscoverFilters.test.ts` — does not exist as a hook-rendering test today (file currently tests pure pipeline only). The new `clearCategories` is exercised via the existing component (manual + type-check); no automated test added here to avoid pulling in a React Testing Library dep.
- `apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.tsx` — render the two new components inside the `controlsRow`, between `filterTrigger` and `sortSelect`.
- `apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.module.scss` — add `flex-wrap: wrap` and a `row-gap` to `.controls-row` so pills wrap to a second row at narrow widths.

---

## Task 1: Add `PRICE_PRESETS` constant and `matchPricePreset` helper

**Files:**
- Modify: `apps/desktop/src/renderer/ui/components/chat/discover-filter-util.ts` (append to end of file)
- Test: `apps/desktop/src/renderer/ui/components/chat/discover-filter-util.test.ts` (append new tests + extend imports)

- [ ] **Step 1: Write the failing tests**

Append to `discover-filter-util.test.ts`. First update the import block at the top of the file to include the new exports:

```ts
import {
  matchesSearch, matchesMaxInputPrice, matchesMaxOutputPrice,
  matchesMinStake,
  matchesLastSeen, matchesLastSettled,
  matchesMinChannels, rowChannelCount,
  applyFilters, applySort, paginate, totalPagesFor,
  MAX_INPUT_PRICE_SLIDER_USD, MAX_OUTPUT_PRICE_SLIDER_USD,
  PRICE_PRESETS, matchPricePreset,
} from './discover-filter-util';
```

Then append at the end of the file:

```ts
test('PRICE_PRESETS lists the four buckets in expected order', () => {
  assert.deepEqual(
    PRICE_PRESETS.map((p) => p.id),
    ['any', 'free', 'p10', 'p100'],
  );
  // 'any' must equal the slider max so default state matches.
  assert.equal(PRICE_PRESETS[0]!.cap, MAX_INPUT_PRICE_SLIDER_USD);
  assert.equal(PRICE_PRESETS[1]!.cap, 0);
  assert.equal(PRICE_PRESETS[2]!.cap, 0.10);
  assert.equal(PRICE_PRESETS[3]!.cap, 1.00);
});

test('matchPricePreset returns matching preset id when both prices equal a cap', () => {
  assert.equal(matchPricePreset(MAX_INPUT_PRICE_SLIDER_USD, MAX_OUTPUT_PRICE_SLIDER_USD), 'any');
  assert.equal(matchPricePreset(0, 0), 'free');
  assert.equal(matchPricePreset(0.10, 0.10), 'p10');
  assert.equal(matchPricePreset(1.00, 1.00), 'p100');
});

test('matchPricePreset tolerates float epsilon (≤ 0.001)', () => {
  assert.equal(matchPricePreset(0.1 + 1e-9, 0.1 - 1e-9), 'p10');
  assert.equal(matchPricePreset(1.0009, 1.0), 'p100');
});

test('matchPricePreset returns "custom" when input/output diverge or do not match a cap', () => {
  assert.equal(matchPricePreset(0.5, 0.5), 'custom');                 // no preset at 0.5
  assert.equal(matchPricePreset(0.10, 1.00), 'custom');                // input/output diverge
  assert.equal(matchPricePreset(0, MAX_OUTPUT_PRICE_SLIDER_USD), 'custom');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop && npx tsx --test src/renderer/ui/components/chat/discover-filter-util.test.ts`
Expected: 4 new tests fail with TypeScript / runtime errors (`PRICE_PRESETS` and `matchPricePreset` not exported). Existing 15 tests still pass.

- [ ] **Step 3: Implement the helper in `discover-filter-util.ts`**

Append to the very end of `apps/desktop/src/renderer/ui/components/chat/discover-filter-util.ts`:

```ts
/* ── Price preset buckets (used by inline Price filter dropdown) ──────── */

/**
 * Common price ceilings users can pick inline without opening the drawer.
 * Each preset's `cap` is applied to BOTH `maxInputPrice` and `maxOutputPrice`
 * — a row passes only if both sides are at or below the cap.
 *
 * The 'any' preset's cap equals the slider max so default state (no filtering)
 * round-trips cleanly through `matchPricePreset`. If the input and output
 * slider maxes ever diverge, replace the single `cap` with separate
 * `inputCap` / `outputCap` and update `matchPricePreset` accordingly.
 */
export const PRICE_PRESETS = [
  { id: 'any',  label: 'Any',           cap: MAX_INPUT_PRICE_SLIDER_USD },
  { id: 'free', label: 'Free only',     cap: 0 },
  { id: 'p10',  label: 'Under $0.10/M', cap: 0.10 },
  { id: 'p100', label: 'Under $1/M',    cap: 1.00 },
] as const;

export type PricePresetId = typeof PRICE_PRESETS[number]['id'];

const PRICE_EPSILON = 0.001;

export function matchPricePreset(
  input: number,
  output: number,
): PricePresetId | 'custom' {
  for (const p of PRICE_PRESETS) {
    if (Math.abs(input - p.cap) < PRICE_EPSILON && Math.abs(output - p.cap) < PRICE_EPSILON) {
      return p.id;
    }
  }
  return 'custom';
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop && npx tsx --test src/renderer/ui/components/chat/discover-filter-util.test.ts`
Expected: all 19 tests pass (15 existing + 4 new).

- [ ] **Step 5: Type-check**

Run: `cd apps/desktop && npm run typecheck:renderer`
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/ui/components/chat/discover-filter-util.ts \
        apps/desktop/src/renderer/ui/components/chat/discover-filter-util.test.ts
git commit -m "feat(discover): add PRICE_PRESETS and matchPricePreset helper

Powers inline Price filter dropdown — maps slider state (maxInputPrice,
maxOutputPrice) to one of four common buckets (Any, Free only, Under
\$0.10/M, Under \$1/M) or 'custom' when values don't match a preset."
```

---

## Task 2: Add `clearCategories()` to `useDiscoverFilters`

**Files:**
- Modify: `apps/desktop/src/renderer/ui/hooks/useDiscoverFilters.ts`

This is a tiny additive change to the hook. No automated test (the hook has no React Testing Library setup; `useDiscoverFilters.test.ts` covers the pipeline only). The method is exercised by Task 4's component and verified manually in Task 6.

- [ ] **Step 1: Add the type to `DiscoverFilterState`**

In `useDiscoverFilters.ts`, locate the `DiscoverFilterState` type (around line 18). Add `clearCategories` after `toggleCategory`:

```ts
export type DiscoverFilterState = {
  // … existing fields unchanged …

  setSearch: (v: string) => void;
  toggleCategory: (cat: string) => void;
  clearCategories: () => void;
  togglePeer: (peerId: string) => void;
  // … rest unchanged …
};
```

- [ ] **Step 2: Implement the callback inside the hook body**

Right after the existing `toggleCategory` `useCallback` (around line 70), add:

```ts
const clearCategories = useCallback(() => {
  setCategorySet(new Set());
}, []);
```

- [ ] **Step 3: Include it in the returned object**

In the return statement at the bottom of the hook, after `toggleCategory`:

```ts
return {
  // … existing fields …
  setSearch,
  toggleCategory,
  clearCategories,
  togglePeer,
  // … rest unchanged …
};
```

- [ ] **Step 4: Type-check**

Run: `cd apps/desktop && npm run typecheck:renderer`
Expected: 0 errors. The hook now exposes `clearCategories: () => void` on `DiscoverFilterState`.

- [ ] **Step 5: Run existing tests**

Run: `cd apps/desktop && npx tsx --test src/renderer/ui/hooks/useDiscoverFilters.test.ts`
Expected: existing pipeline tests still pass (the new method is unused by them).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/ui/hooks/useDiscoverFilters.ts
git commit -m "feat(discover): add clearCategories to useDiscoverFilters

Single-call clear for the inline Category filter's 'Clear' button.
Cheaper than iterating toggleCategory over the active set (one state
update, one re-render)."
```

---

## Task 3: Build `DiscoverInlinePriceFilter` component

**Files:**
- Create: `apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.tsx`
- Create: `apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.module.scss`

This component is built before the Category one because its single-select interaction is simpler and validates the trigger-pill + popover scaffold the next component will reuse.

- [ ] **Step 1: Create the SCSS module**

Create `apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.module.scss` with the following content. Class names use kebab-case (CSS modules transform to camelCase in TS):

```scss
/* DiscoverInlinePriceFilter — trigger pill + popover for price preset buckets */

.wrapper {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}

.trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08));
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  outline: none;
  transition: border-color 0.12s, background-color 0.12s;

  &:hover { background-color: var(--bg-hover); }
  &:focus-visible { border-color: var(--accent); }
}

.trigger-active {
  border-color: var(--text-primary);
}

.chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.12s;
}

.chevron-open {
  transform: rotate(180deg);
}

.popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  min-width: 200px;
  padding: 6px;
  background: var(--bg-card);
  border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.option {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 8px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background 0.1s, color 0.1s;

  &:hover {
    background: var(--bg-hover);
    color: var(--text-primary);
  }
}

.option-selected {
  color: var(--text-primary);
  font-weight: 600;
}

.radio {
  flex-shrink: 0;
  width: 12px;
  height: 12px;
  border-radius: 50%;
  border: 1.5px solid var(--border-strong, rgba(0, 0, 0, 0.35));
  background: transparent;
  position: relative;
}

.radio-selected {
  border-color: var(--text-primary);

  &::after {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--text-primary);
  }
}

.custom-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 8px 6px;
  margin-top: 4px;
  border-top: 1px solid var(--border, rgba(0, 0, 0, 0.10));
  color: var(--text-muted);
  font-size: 11px;
  font-style: italic;
  cursor: default;
  user-select: text;
}
```

- [ ] **Step 2: Create the React component**

Create `apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { DiscoverFilterState } from '../../hooks/useDiscoverFilters';
import {
  PRICE_PRESETS,
  matchPricePreset,
  type PricePresetId,
} from './discover-filter-util';
import styles from './DiscoverInlinePriceFilter.module.scss';

type Props = { filters: DiscoverFilterState };

function triggerLabel(currentId: PricePresetId | 'custom'): string {
  if (currentId === 'any') return 'Price';
  if (currentId === 'custom') return 'Price: Custom';
  const preset = PRICE_PRESETS.find((p) => p.id === currentId)!;
  return `Price: ${preset.label}`;
}

export function DiscoverInlinePriceFilter({ filters }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const currentId = matchPricePreset(filters.maxInputPrice, filters.maxOutputPrice);
  const isActive = currentId !== 'any';

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const selectPreset = (cap: number) => {
    filters.setMaxInputPrice(cap);
    filters.setMaxOutputPrice(cap);
    setOpen(false);
  };

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        type="button"
        className={`${styles.trigger}${isActive ? ` ${styles.triggerActive}` : ''}`}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{triggerLabel(currentId)}</span>
        <svg
          className={`${styles.chevron}${open ? ` ${styles.chevronOpen}` : ''}`}
          width="10" height="6" viewBox="0 0 10 6" fill="none"
          aria-hidden="true"
        >
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className={styles.popover} role="listbox" aria-label="Price preset">
          {PRICE_PRESETS.map((p) => {
            const selected = currentId === p.id;
            return (
              <button
                key={p.id}
                type="button"
                role="option"
                aria-selected={selected}
                className={`${styles.option}${selected ? ` ${styles.optionSelected}` : ''}`}
                onClick={() => selectPreset(p.cap)}
              >
                <span className={`${styles.radio}${selected ? ` ${styles.radioSelected}` : ''}`} aria-hidden="true" />
                <span>{p.label}</span>
              </button>
            );
          })}
          {currentId === 'custom' && (
            <div className={styles.customRow} aria-live="polite">
              Custom: input ≤ ${filters.maxInputPrice.toFixed(2)}/M, output ≤ ${filters.maxOutputPrice.toFixed(2)}/M
            </div>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/desktop && npm run typecheck:renderer`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.tsx \
        apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.module.scss
git commit -m "feat(discover): inline Price filter dropdown component

Trigger pill + radio popover for the four price preset buckets.
Auto-closes on selection; outside-click and Esc dismiss. Reads
maxInputPrice/maxOutputPrice from useDiscoverFilters and writes both
on selection so input and output sliders stay in lockstep."
```

---

## Task 4: Build `DiscoverInlineCategoryFilter` component

**Files:**
- Create: `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.tsx`
- Create: `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.module.scss`

- [ ] **Step 1: Create the SCSS module**

Create `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.module.scss`:

```scss
/* DiscoverInlineCategoryFilter — trigger pill + chip popover (multi-select) */

.wrapper {
  position: relative;
  display: inline-flex;
  flex-shrink: 0;
}

.trigger {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 32px;
  padding: 0 10px 0 12px;
  border-radius: 8px;
  border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.08));
  background: var(--bg-card);
  color: var(--text-primary);
  font-size: 12px;
  font-family: inherit;
  font-weight: 500;
  cursor: pointer;
  outline: none;
  transition: border-color 0.12s, background-color 0.12s, opacity 0.12s;

  &:hover:not(:disabled) { background-color: var(--bg-hover); }
  &:focus-visible { border-color: var(--accent); }
  &:disabled { opacity: 0.5; cursor: default; }
}

.trigger-active {
  border-color: var(--text-primary);
}

.chevron {
  flex-shrink: 0;
  color: var(--text-muted);
  transition: transform 0.12s;
}

.chevron-open {
  transform: rotate(180deg);
}

.popover {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  z-index: 30;
  width: 240px;
  max-height: 320px;
  display: flex;
  flex-direction: column;
  background: var(--bg-card);
  border: 1px solid var(--border, rgba(0, 0, 0, 0.12));
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
}

.popover-header {
  display: flex;
  justify-content: flex-end;
  align-items: center;
  padding: 6px 8px 0;
  min-height: 14px;
}

.clear-btn {
  background: transparent;
  border: none;
  padding: 0;
  font-size: 11px;
  font-family: inherit;
  font-weight: 500;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.12s;

  &:hover { color: var(--text-primary); }
}

.chip-list {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  padding: 8px;
  overflow-y: auto;

  &::-webkit-scrollbar { width: 4px; }
  &::-webkit-scrollbar-thumb {
    background: var(--scrollbar-thumb);
    border-radius: 2px;
  }
}

.chip {
  display: inline-flex;
  align-items: center;
  padding: 3px 9px;
  font-size: 11px;
  font-family: inherit;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 999px;
  cursor: pointer;
  text-transform: capitalize;
  line-height: 1.4;
  transition: background 0.12s, color 0.12s, border-color 0.12s;
  user-select: none;

  &:hover {
    border-color: var(--border-strong);
    color: var(--text-primary);
  }
}

.chip-active {
  background: var(--text-primary);
  color: var(--bg-card);
  border-color: var(--text-primary);

  &:hover {
    background: var(--text-primary);
    color: var(--bg-card);
    border-color: var(--text-primary);
  }
}
```

- [ ] **Step 2: Create the React component**

Create `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.tsx`:

```tsx
import { useEffect, useRef, useState } from 'react';
import type { DiscoverFilterState } from '../../hooks/useDiscoverFilters';
import { formatCategoryLabel } from './discover-filter-util';
import styles from './DiscoverInlineCategoryFilter.module.scss';

type Props = { filters: DiscoverFilterState };

function triggerLabel(filters: DiscoverFilterState): string {
  const size = filters.categorySet.size;
  if (size === 0) return 'Categories';
  if (size === 1) {
    const only = filters.categorySet.values().next().value as string;
    return `Categories: ${formatCategoryLabel(only)}`;
  }
  return `Categories (${size})`;
}

export function DiscoverInlineCategoryFilter({ filters }: Props) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  const isActive = filters.categorySet.size > 0;
  const isEmpty = filters.availableCategories.length === 0;

  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current) return;
      if (!wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Close popover automatically if data drains and there's nothing to pick.
  useEffect(() => {
    if (isEmpty && open) setOpen(false);
  }, [isEmpty, open]);

  return (
    <div ref={wrapperRef} className={styles.wrapper}>
      <button
        type="button"
        className={`${styles.trigger}${isActive ? ` ${styles.triggerActive}` : ''}`}
        onClick={() => setOpen((v) => !v)}
        disabled={isEmpty}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>{triggerLabel(filters)}</span>
        <svg
          className={`${styles.chevron}${open ? ` ${styles.chevronOpen}` : ''}`}
          width="10" height="6" viewBox="0 0 10 6" fill="none"
          aria-hidden="true"
        >
          <path d="M1 1L5 5L9 1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className={styles.popover} role="listbox" aria-label="Categories" aria-multiselectable="true">
          <div className={styles.popoverHeader}>
            {isActive && (
              <button
                type="button"
                className={styles.clearBtn}
                onClick={() => filters.clearCategories()}
              >
                Clear
              </button>
            )}
          </div>
          <div className={styles.chipList}>
            {filters.availableCategories.map((c) => {
              const active = filters.categorySet.has(c.toLowerCase());
              return (
                <button
                  key={c}
                  type="button"
                  role="option"
                  aria-selected={active}
                  className={`${styles.chip}${active ? ` ${styles.chipActive}` : ''}`}
                  onClick={() => filters.toggleCategory(c)}
                >
                  {formatCategoryLabel(c)}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `cd apps/desktop && npm run typecheck:renderer`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.tsx \
        apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.module.scss
git commit -m "feat(discover): inline Category filter dropdown component

Trigger pill + multi-select chip popover. Stays open while toggling
chips; outside-click and Esc dismiss. Disabled until categories load
so the row doesn't reflow on first paint. Shares state with the
advanced-filters drawer via useDiscoverFilters."
```

---

## Task 5: Wire the new components into `DiscoverWelcome` and enable wrap

**Files:**
- Modify: `apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.tsx`
- Modify: `apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.module.scss`

- [ ] **Step 1: Add imports to `DiscoverWelcome.tsx`**

After the existing `import { DiscoverFilters } …` line near the top of the file, add:

```ts
import { DiscoverInlineCategoryFilter } from './DiscoverInlineCategoryFilter';
import { DiscoverInlinePriceFilter } from './DiscoverInlinePriceFilter';
```

- [ ] **Step 2: Render the two new components in the controls row**

In `DiscoverWelcome.tsx`, locate the `<button … filterTrigger>` block (around line 398) and the `<select … sortSelect>` block that follows it (around line 415). Insert the two new components between them:

```tsx
<button
  type="button"
  className={`${styles.filterTrigger}${drawerOpen && !drawerClosing ? ` ${styles.filterTriggerActive}` : ''}`}
  onClick={() => {
    if (drawerOpen && !drawerClosing) closeDrawer();
    else setDrawerOpen(true);
  }}
  aria-expanded={drawerOpen && !drawerClosing}
  aria-label={drawerOpen && !drawerClosing ? 'Close filters' : 'Open filters'}
  title="Filters"
>
  {/* … existing svg + dot, unchanged … */}
</button>

<DiscoverInlineCategoryFilter filters={filterState} />
<DiscoverInlinePriceFilter filters={filterState} />

<select
  className={styles.sortSelect}
  value={filterState.sortKey}
  onChange={(e) => filterState.setSortKey(e.target.value as DiscoverSortKey)}
  aria-label="Sort services"
>
  {/* … existing options, unchanged … */}
</select>
```

No other JSX changes are needed.

- [ ] **Step 3: Allow the controls row to wrap on narrow widths**

In `DiscoverWelcome.module.scss`, find the existing `.controls-row` block (around line 65):

```scss
.controls-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
```

Replace it with:

```scss
.controls-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  row-gap: 8px;
  width: 100%;
}
```

Also locate the existing `.filter-trigger` block (around line 134). It currently includes `margin-left: auto` to push the icon group to the right when the row is a single line. Wrapping breaks this on a wrapped row. Keep the `margin-left: auto` (it still pushes right when the row fits on one line) and add no further changes — when the row wraps, the trigger and pills sit naturally at the start of row 2.

- [ ] **Step 4: Type-check**

Run: `cd apps/desktop && npm run typecheck:renderer`
Expected: 0 errors.

- [ ] **Step 5: Build the renderer to catch any vite/css issues**

Run: `cd apps/desktop && npm run build:renderer`
Expected: build completes with no errors. (This compiles the SCSS modules and verifies class-name access patterns resolve.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.tsx \
        apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.module.scss
git commit -m "feat(discover): mount inline Category & Price filters in controls row

Renders the two new dropdown pills between the advanced-filters trigger
and the sort select. Adds flex-wrap to .controls-row so the pills wrap
to a second row at narrow viewports rather than squeezing the search box."
```

---

## Task 6: Manual verification in the desktop dev build

This task has no commits. It is a smoke-test checklist run in the dev electron app to confirm the feature works end-to-end before declaring the work done.

- [ ] **Step 1: Start the dev build**

Run from repo root: `cd apps/desktop && npm run dev`
Expected: Electron window opens with the desktop app running against the Vite dev server.

- [ ] **Step 2: Navigate to Discover and confirm layout**

In the running app, open the chat / Discover view. Confirm the controls row reads, left-to-right:
`[ search ] … [ filter-icon ] [ Categories ▾ ] [ Price ▾ ] [ sort ▾ ]`

The two new pills should sit immediately after the filter-icon and before the sort select.

- [ ] **Step 3: Verify Category dropdown — open & toggle**

Click `Categories ▾`. A popover opens beneath it with chips for every category in the data (alphabetical). Click two chips (e.g. "chat" and "code"). Confirm:
- Both chips show the active style.
- The trigger label updates to `Categories (2)`.
- The card grid below filters down to services that have at least one of those categories.
- A "Clear" link appears in the popover header. Clicking it empties the selection and the trigger label returns to `Categories`.

- [ ] **Step 4: Verify Category dropdown — drawer sync**

With one category selected inline, click the filter-icon to open the advanced-filters drawer. Confirm the same chip is highlighted in the drawer's Categories section. Toggle a chip in the drawer; confirm the inline trigger label updates accordingly.

- [ ] **Step 5: Verify Category dropdown — close behavior**

Open the popover. Click anywhere outside it (e.g. a card or the search box) → popover closes. Re-open and press Esc → popover closes.

- [ ] **Step 6: Verify Price dropdown — preset selection**

Click `Price ▾`. Popover shows: Any · Free only · Under $0.10/M · Under $1/M with "Any" highlighted (default state). Click "Under $1/M". Confirm:
- Popover closes.
- Trigger label reads `Price: Under $1/M`.
- Card grid filters to rows where both input AND output prices are ≤ $1/M.
- Open the drawer; both price sliders are at 1.0.

- [ ] **Step 7: Verify Price dropdown — custom state**

Open the drawer. Drag the Input price slider to $0.50. Close the drawer and click the `Price ▾` trigger. Confirm:
- Trigger label reads `Price: Custom`.
- No preset row is highlighted in the popover.
- A muted italic row at the bottom shows `Custom: input ≤ $0.50/M, output ≤ $X.XX/M`.
- Clicking the custom row does nothing (it is informational only).

Then click "Any" to reset; confirm trigger returns to `Price`.

- [ ] **Step 8: Verify "Reset all" still clears inline filters**

Set both filters inline (e.g. Categories: Chat + Price: Under $1/M). Open the drawer and click "Reset all". Confirm both inline triggers return to neutral labels (`Categories`, `Price`) immediately.

- [ ] **Step 9: Verify wrap behavior at narrow viewport**

Resize the Electron window narrower than ~560px wide. Confirm the search box stays full-width on row 1 and the filter icon + two new pills + sort select wrap to row 2 without overlapping or truncating.

- [ ] **Step 10: Verify pagination resets on filter change**

Page to page 2 of the card grid. Toggle a category inline. Confirm pagination snaps back to page 1 (already wired through the existing dependency list at `DiscoverWelcome.tsx:334`).

If any step fails, fix the underlying issue, re-run from Step 1, and do not mark this task complete until all steps pass.

---

## Acceptance criteria

- All tests pass: `cd apps/desktop && npx tsx --test src/renderer/ui/components/chat/discover-filter-util.test.ts src/renderer/ui/hooks/useDiscoverFilters.test.ts`
- Renderer type-check is clean: `cd apps/desktop && npm run typecheck:renderer`
- Renderer builds: `cd apps/desktop && npm run build:renderer`
- Manual verification (Task 6) passes every step.
- No new external dependencies in `apps/desktop/package.json`.
- No changes to `useDiscoverFilters.test.ts` (existing pipeline tests still pass unchanged).
