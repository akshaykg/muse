---
paths:
  - "apps/*/src/components/**"
  - "libs/ui-components/**"
---

# Shared UI Components Rule

All frontend components MUST use the shared UI component library from `libs/ui-components` (`@depotex/ui-components`) for common interactive elements. No inline reimplementation of buttons, inputs, alerts, modals, or spinners.

## Available Components

Import from `@depotex/ui-components`:

| Component | Use for |
|-----------|---------|
| `Button` | All clickable actions (primary, secondary, ghost, success variants) |
| `Input` | Text inputs, search fields, form fields |
| `PasswordInput` | Password fields with show/hide toggle |
| `Select` | Dropdown selects |
| `Textarea` | Multi-line text inputs |
| `Label` | Form field labels |
| `Alert` | Error, warning, success, info messages |
| `Spinner` | Loading indicators |
| `Skeleton` | Content loading placeholders |
| `Card` | Content containers |
| `Modal` | Dialog overlays (a native `<dialog>`: Escape and the backdrop close it) |
| `CopyButton` | Copies text, says "Copied" for a moment |
| `PageSpinner` | A whole page still loading (centered `Spinner`) |
| `ConfirmDialog` | "Are you sure?" before a delete, rotate or other risky action: `title`, body as children, `confirmLabel`, `tone="danger"` for destructive. Return a promise from `onConfirm` and the dialog is busy until it settles (Cancel, Escape and the backdrop refused) and shows a rejection's message; or drive `busy`/`error` yourself. It never closes itself on success |
| `EmptyState` | The box a list shows when it has nothing or nothing matches |
| `SectionSpinner` | A list or panel still loading (`size` `sm` / `md`) |
| `LoadMore` | The "Load more" button under a paged list (`busy` disables it and shows a spinner) |
| `Badge` | Every status or label chip: `tone` (`neutral` `muted` `info` `success` `warning` `danger` `primary`), `variant` (`soft` `outline` `solid`), `shape` (`tag` `pill`), `size` (`sm` `md`), `dot`, `icon`. Domain badges (a version's status, a severity) render through it |
| `Table`, `THead`, `Tr`, `Th`, `Td` | Data tables: the sideways-scrolling frame, cell padding by `size`, `hideBelow` for columns hidden on phones, `numeric`/`muted`/`mono`/`truncate` cells, sortable `Th` (`sort`, `onSort`, `aria-sort`) |
| `Meter` | A usage bar (storage against a quota, seats against a licence): `value`, `max`, `label`, `valueText`, `warnAt`/`dangerAt` or `tone`, `size`, `showLabel` |
| `DefinitionList` | Label/value rows: `items` (empty values left out) or `DefinitionList.Item`; stacked on phones, two columns from `sm` (`layout="inline"` keeps two columns) |
| `Tabs` | Every tab bar: `items` (`key`, `label`, `count`, `icon`, `disabled`, `dirty`), `value`, `onChange`, `aria-label`, `size`, `idBase` + `tabPanelProps` for the panel; arrow keys and roving tabindex built in. No hand-written `role="tablist"` |
| `Dropdown` | One choice from a list, drawn like an input (never a native `<select>` popup): `options` (`value`, `label`, `hint`, `disabled` + `reason`), `id` for a `<label htmlFor>`, a search above eight options, `mono` for technical values |
| `SegmentedControl` | A small set of choices: filters (`role="group"`, default), a view switch (`tablist`) or a value (`radiogroup`); `variant` `filled`/`outline`, `scroll`, `dot` and `count` per option |
| `Popover` | A panel anchored to its button (pickers, filters, "⋯" menus): `open`, `onClose`, `anchor` (node or render prop with the trigger's aria), `align`, `side`, `role` |
| `SafeLink` | Every external link from data (package metadata, a plugin, the API): `http(s)` only, new tab, `rel="noopener noreferrer nofollow"`; anything else is drawn as text |
| `safeHref(url, { schemes? })` | Every URL from data before it reaches `href`, `location` or `window.open`: a same-origin path or an allowed scheme (default `http:` `https:` `mailto:`), else `null` (draw text). See `frontend-security.md` |

Page building blocks that need Next.js live in `@depotex/platform-ui` (`src/components/`): `BackLink` (← link above a detail page's title, arrow mirrored in RTL), `PageHeader` (title, intro, actions; `variant` `serif` for product pages, `sans` for platform pages), `NoPermission` (the error shown instead of a page the viewer may not see; `title` draws it inside `SettingsPage`).

Shared hooks, for behaviour that every menu, search box and poller used to re-implement:

| Hook | Use for |
|---|---|
| `useDismiss(refs, onDismiss, open)` | Close a menu or popover on a click outside or Escape (`reason` tells which, to return focus) |
| `useMenu({ open?, onOpenChange?, role? })` | A menu behind a button: `{ open, toggle, close, wrapperProps, triggerProps, panelProps }`; dismissal, aria wiring, focus back to the trigger, arrow keys in a `menu` |
| `useTabParam(tabs, { param, fallback })` | The selected tab kept in `?tab=` (`@depotex/platform-ui`) |
| `useEscape(onClose, open)` | Escape only, for a panel or sheet with its own backdrop |
| `useDebouncedValue(value, ms)` | A search box feeding a request |
| `useCopy(resetMs)` | `{ copied, failed, copy }` behind any copy button |
| `usePolling(fn, ms, enabled)` | Refresh while something runs; skips ticks while the tab is hidden |
| `useOrigin()` | The page's origin after mount (addresses shown to the user) |
| `useRequestSequence()` | `{ begin, current, isCurrent, invalidate }`: a list's answers apply only while their ticket is current, so a late answer to an older search, filter or cursor is dropped and a load-more appends only to the query it started from |
| `useCursorList(fetch, deps, { enabled, errText })` | A cursor-paged list with Load more: `{ items, loading, loadingMore, hasMore, more, reload, error }`; first page on mount, deps change and `reload()`, `more()` appends only to the query it started from (`@depotex/ui-components`) |
| `useLoad(fn, deps, { enabled, errText, keep })` | A page's data: `{ data, loading, error, reload, setData }`; only the latest answer applies (`@depotex/platform-ui`) |
| `useAction(fn, { errText, success, onSuccess })` | A button's write: `{ run, busy, error }`; success toast, error text, a second click while busy ignored (`@depotex/platform-ui`) |
| `useErrorText(reasons, overrides?)` | `(err) => apiErrorMessage(...)` with the feature's reasons namespace, stable for dependency lists (`@depotex/platform-ui`) |

No component writes its own `document.addEventListener('mousedown' | 'keydown')`, `setTimeout` debounce, `clipboard.writeText` + "Copied" timer, or `setInterval` poller: use the hook (see `shared-requests.md` for what pollers must do).
| `ErrorBoundary` | Error boundary wrappers |
| `ThemeToggle` | Theme switching UI |

## Required Usage

### Buttons

Always use `<Button>` instead of raw `<button>` with inline Tailwind:

```tsx
import { Button } from '@depotex/ui-components';

// ✅ Good
<Button variant="primary" size="sm" onClick={handleClick}>Save</Button>
<Button variant="secondary" size="sm" onClick={handleCancel}>Cancel</Button>
<Button variant="ghost" size="sm" onClick={handleDismiss}>Close</Button>

// ❌ Bad — inline button with manual styling
<button className="bg-primary text-primary-fg px-4 py-2 ...">Save</button>
```

**Variants**: `primary` | `secondary` | `success` | `ghost`
**Sizes**: `sm` | `md`

### Inputs

Always use `<Input>` instead of raw `<input>`:

```tsx
import { Input } from '@depotex/ui-components';

// ✅ Good
<Input type="text" value={name} onChange={handleChange} placeholder="Enter name" />
<Input mono value={code} readOnly />

// ❌ Bad
<input className="w-full rounded-md border border-border bg-background ..." />
```

### Alerts / Error Messages

Always use `<Alert>` for status messages:

```tsx
import { Alert } from '@depotex/ui-components';

// ✅ Good
<Alert variant="error">{errorMessage}</Alert>
<Alert variant="warning">Token will expire soon</Alert>
<Alert variant="success">Token created successfully</Alert>

// ❌ Bad
<div className="rounded-md border border-error/30 bg-error/10 px-3 py-2 text-xs text-error">
  {errorMessage}
</div>
```

**Variants**: `error` | `warning` | `success` | `info`

### Loading States

Always use `<Spinner>` for loading indicators:

```tsx
import { Spinner } from '@depotex/ui-components';

// ✅ Good
<Spinner size="sm" />

// ❌ Bad
<div className="h-5 w-5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
```

**Sizes**: `sm` | `md` | `lg`

### Modals / Dialogs

Use `<Modal>` for dialog overlays when appropriate:

```tsx
import { Modal } from '@depotex/ui-components';

// ✅ Good
<Modal open={isOpen} onClose={handleClose} title="Confirm Action">
  <p>Are you sure?</p>
</Modal>
```

## Why This Matters

- **Consistency**: Shared components use the correct theme tokens (`text-primary-fg`, not `text-primary-foreground`)
- **Maintenance**: Style changes propagate from one place to all usages
- **Accessibility**: Shared components include proper ARIA attributes and focus management
- **Theme compatibility**: Components are tested against all theme variants (light, dark, high-contrast)

## Exceptions

Icon-only action buttons (rotate, delete) in table rows may use raw `<button>` with ghost styling when the shared Button's padding is too large for compact layouts. These must still use theme tokens for colors.

## Adding New Shared Components

When you find yourself building a UI element that is reusable across multiple features or apps, add it to `libs/ui-components/src/` instead of keeping it in the app.

### When to Create a Shared Component

Create a new shared component when:
- The same UI pattern appears (or will appear) in 2+ places across apps
- The element is generic and not tied to a specific feature's business logic
- It represents a common UI primitive (badge, tooltip, tabs, dropdown, toggle, avatar, etc.)

### How to Add

1. Create the component file in `libs/ui-components/src/ComponentName.tsx`
2. Follow the existing patterns:
   - `'use client'` directive at the top
   - Export a named function component (not default export)
   - Export the props interface
   - Use theme tokens only (`text-text`, `bg-primary`, `border-border`, etc.)
   - Accept a `className` prop for override flexibility
3. Export from `libs/ui-components/src/index.ts`
4. Use in apps via `import { ComponentName } from '@depotex/ui-components'`

### Component Template

```tsx
'use client';

import type { ReactNode } from 'react';
import { cn } from './cn';

export interface CalloutProps {
  variant?: 'default' | 'success' | 'warning' | 'error';
  children: ReactNode;
  className?: string;
}

const variants: Record<NonNullable<CalloutProps['variant']>, string> = {
  default: 'bg-surface text-text-muted border-border',
  success: 'bg-success/10 text-success-text border-success/30',
  warning: 'bg-warning/10 text-warning-text border-warning/30',
  error: 'bg-error/10 text-error-text border-error/30',
};

export function Callout({ variant = 'default', children, className }: CalloutProps) {
  return <div className={cn('rounded-sm border px-3 py-2 text-sm', variants[variant], className)}>{children}</div>;
}
```

Build the class string with `cn(base, …, className)`, never a template literal: `cn` lets the caller's class replace a base class for the same property (`className="p-3"` over `p-5`), where concatenation leaves both and the stylesheet order decides.

### Candidates for Future Shared Components

These patterns currently exist inline in app components and should be extracted when needed in a second location:

- **Tooltip** — hover information
- **Toggle/Switch** — boolean toggles
- **Avatar** — user avatar with fallback initials
- **CopyField** — read-only input with copy button

## Enforcement

- All new components MUST import from `@depotex/ui-components` for standard UI elements
- Code reviews MUST flag inline button/input/alert implementations
- Existing components SHOULD be migrated to use shared components
- When a UI pattern is used in 2+ places, it SHOULD be extracted to `libs/ui-components`
