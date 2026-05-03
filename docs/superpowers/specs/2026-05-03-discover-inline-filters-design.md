# Discover — Inline Category & Price Filters

**Date:** 2026-05-03
**Area:** `apps/desktop` — Discover/marketplace view (`DiscoverWelcome`)
**Author:** Dean (designed with Claude)

## Problem

The Discover view's only filter affordance besides search is the sliders icon
that opens an "advanced filters" drawer. Users cannot apply common filters
(category, price) without first opening the drawer, which adds an extra step
and hides the most discoverable filtering axes behind an icon. The colored
tags on each card (Chat, Code, Reasoning, Vision, Privacy, Free, …) and the
prominent per-million pricing already invite filtering by category and price,
so those two axes deserve first-class inline controls.

## Goal

Surface **two** common filters as dropdown pills in the Discover controls
row, sitting between the existing filter-drawer trigger and the sort select:

- **Categories** — multi-select chip popover. Same selection model as the
  drawer's Categories section.
- **Price** — single-select preset popover (radio list).

Both dropdowns share state with the existing `useDiscoverFilters` hook. The
drawer remains the escape hatch for everything else (peers, channel count,
last seen / settled, etc.).

## Non-goals

- Replacing or restructuring the advanced-filters drawer.
- Persisting filter state across sessions or in URL/query string.
- Keyboard arrow-key navigation through popover items (Tab + click works).
- Animations on popover open/close.
- A "recently used categories" ordering in the popover.

## User flow

1. User lands on Discover. Controls row reads:
   `[ search ] [ filter-icon ] [ Categories ▾ ] [ Price ▾ ] [ sort ▾ ]`
2. User clicks `Categories ▾`. A popover opens beneath it with a wrapped
   chip list of all categories present in the current data
   (`filterState.availableCategories`). User toggles one or more chips. The
   popover stays open during multi-select; closes on outside click or Esc.
3. The trigger label updates: `Categories` → `Categories: Chat` → `Categories (3)`.
4. User clicks `Price ▾`. A popover opens with a single-select radio list:
   - Any
   - Free only
   - Under $0.10/M
   - Under $1/M
5. Selecting a row sets BOTH `maxInputPrice` and `maxOutputPrice` to the
   bucket's cap value, then auto-closes the popover.
6. The trigger label updates to e.g. `Price: Under $1/M`. If the user has
   custom slider values from the drawer that don't match a preset, the label
   reads `Price: Custom` and a read-only "Custom: input ≤ $X.XX/M, output ≤
   $Y.YY/M" row appears at the bottom of the popover.
7. The drawer's existing "Reset all" continues to clear both inline filters
   automatically (they read from the same state).

## Architecture

### State model — unchanged

Both dropdowns are thin readers/writers on `useDiscoverFilters`. They use the
existing setters and existing derived data:

| Read from hook              | Write through hook                       |
| --------------------------- | ---------------------------------------- |
| `categorySet`               | `toggleCategory(cat)`                    |
| `availableCategories`       | new `clearCategories()` (added — see below) |
| `maxInputPrice`             | `setMaxInputPrice(v)`                    |
| `maxOutputPrice`            | `setMaxOutputPrice(v)`                   |

The hook gains exactly one new method:

```ts
// useDiscoverFilters.ts
const clearCategories = useCallback(() => setCategorySet(new Set()), []);
// …included in the returned DiscoverFilterState
```

This is a small, real improvement over iterating `toggleCategory` over the
active set (single state update, one re-render). It is also reused if the
drawer ever adds a per-section "clear" affordance.

### File layout

**New files**

- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.tsx`
- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlineCategoryFilter.module.scss`
- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.tsx`
- `apps/desktop/src/renderer/ui/components/chat/DiscoverInlinePriceFilter.module.scss`

**Modified files**

- `apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.tsx` — render
  the two new components inside `controlsRow`, between `filterTrigger` and
  `sortSelect`.
- `apps/desktop/src/renderer/ui/components/chat/DiscoverWelcome.module.scss`
  — set `controlsRow { flex-wrap: wrap }` so the two new pills wrap to a
  second row at narrow viewports rather than squeezing the search box. No
  other structural changes.
- `apps/desktop/src/renderer/ui/components/chat/discover-filter-util.ts` —
  add `PRICE_PRESETS` constant and `matchPricePreset(input, output)` helper.
- `apps/desktop/src/renderer/ui/components/chat/discover-filter-util.test.ts`
  — add unit tests for `matchPricePreset` (epsilon match, custom fallback).
- `apps/desktop/src/renderer/ui/hooks/useDiscoverFilters.ts` — add
  `clearCategories` to the returned state.

No new dependencies.

## Component designs

### `DiscoverInlineCategoryFilter`

**Props**

```ts
type Props = { filters: DiscoverFilterState };
```

**Trigger button**

Same height/border/radius as `sortSelect` and `filterTrigger`. Chevron-down
icon on the right. Subtle accent border when `categorySet.size > 0`.

Label rules:

- 0 selected → `"Categories"`
- 1 selected → `"Categories: <formatCategoryLabel(only)>"`
- 2+ selected → `"Categories (N)"`

**Popover**

- Anchored below the trigger, left-aligned.
- Width ~240px, max-height ~320px with internal scroll.
- Header row: small text-button `"Clear"`, only visible when
  `categorySet.size > 0`. Calls `filters.clearCategories()`.
- Body: a wrapped chip list reusing the same `tag` / `tagActive` styles as
  `DiscoverFilters.tsx` Categories section so the visual language matches
  the drawer. Each chip toggles via `filters.toggleCategory(c)`.
- Source list: `filters.availableCategories` (already restricted to what's
  present in the current rows).

**Open/close behavior**

- Toggle on trigger click.
- Outside click closes (single `useEffect` listener inside the component).
- Escape key closes.
- Selecting a chip does NOT close (multi-select).

**Empty data**

If `availableCategories.length === 0`, render the trigger as `disabled` so
the row layout doesn't reflow when data eventually arrives.

**ARIA**

- Trigger: `aria-haspopup="listbox"`, `aria-expanded={open}`.
- Each chip: `role="option"`, `aria-selected={active}`.

### `DiscoverInlinePriceFilter`

**Props**

```ts
type Props = { filters: DiscoverFilterState };
```

**Trigger button**

Identical chrome to the Category trigger.

Label rules (using `matchPricePreset(maxInputPrice, maxOutputPrice)`):

- `'any'`    → `"Price"` (no accent — this is the default state)
- `'free'`   → `"Price: Free only"`
- `'p10'`    → `"Price: Under $0.10/M"`
- `'p100'`   → `"Price: Under $1/M"`
- `'custom'` → `"Price: Custom"`

Accent border whenever the result is not `'any'`.

**Popover**

- Anchored below the trigger, ~200px wide.
- Body: single-select radio list of the four presets. Each row click:
  1. `filters.setMaxInputPrice(preset.cap)`
  2. `filters.setMaxOutputPrice(preset.cap)`
  3. Close the popover (single-select feels snappier when it auto-closes).
- The currently active preset (per `matchPricePreset`) renders with the
  selected radio dot. In the default state this is `'any'`. When the
  current state is `'custom'`, no preset row is highlighted.
- If the current state is `'custom'`, append a 5th read-only row at the
  bottom showing `"Custom: input ≤ $X.XX/M, output ≤ $Y.YY/M"` (two
  decimal places). Clicking it is a no-op (does not select Any — avoids
  surprising the user).

**Open/close behavior**

- Same as Category: outside-click + Esc close, trigger toggles.

**ARIA**

- Trigger: `aria-haspopup="listbox"`, `aria-expanded={open}`.
- Each preset row: `role="option"`, `aria-selected={preset.id === currentId}`.

### `discover-filter-util.ts` additions

```ts
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

Note: because `MAX_INPUT_PRICE_SLIDER_USD === MAX_OUTPUT_PRICE_SLIDER_USD === 3`,
the `'any'` preset matches both prices at MAX with a single `cap` value.
If the two slider maxes ever diverge, this helper must be revisited (the
`'any'` row would need separate input/output caps).

## Integration in `DiscoverWelcome.tsx`

In the `controlsRow` block (~line 414, after the `filterTrigger` button):

```tsx
<button … filterTrigger>{/* unchanged */}</button>

<DiscoverInlineCategoryFilter filters={filterState} />
<DiscoverInlinePriceFilter filters={filterState} />

<select … sortSelect>{/* unchanged */}</select>
```

The page-reset effect at line 334 already lists `categorySet`, `maxInputPrice`,
and `maxOutputPrice` in its deps, so paging back to page 1 on filter change
already works.

`hasActiveFilters` (line 310) already reflects `categorySet.size > 0` and
both price values being below MAX, so the dot indicator on the drawer
trigger lights up correctly when the user picks something inline. No
change needed.

## Layout — narrow viewports

`controlsRow` becomes `flex-wrap: wrap`. At widths below ~560px the search
box stays full-width on row 1 and the trigger + two new pills + sort wrap
to row 2. Inline filters are a discoverability feature — hiding them on
narrow widths defeats the purpose.

## Testing

- **Unit:** `discover-filter-util.test.ts` — add tests for `matchPricePreset`:
  exact match for each preset, custom fallback, epsilon edge values.
- **Existing tests:** `useDiscoverFilters.test.ts` should continue to pass.
  Add one test covering `clearCategories()` resetting `categorySet` to empty.
- **Manual verification:** with the desktop dev build:
  - Open Discover, confirm the two new pills render between filter icon and
    sort, and that label states update as expected.
  - Toggle a category inline → drawer's matching chip reflects it.
  - Toggle a category in the drawer → inline label updates.
  - Pick "Under $1/M" inline → drawer sliders both snap to 1.0.
  - Drag drawer slider to $0.50 → inline label reads "Price: Custom" and the
    popover shows the read-only Custom row.
  - "Reset all" in drawer clears both inline triggers.
  - Verify wrap behavior at <560px viewport width.

## Open follow-ups (not in scope)

- If the inline filter pattern proves popular, consider promoting **Peers**
  to a third inline dropdown (it's already in the drawer and is the next
  most-glanced filter).
- Persist filter state in `localStorage` so it survives reloads — applies
  to all filters, drawer included; out of scope for this change.
