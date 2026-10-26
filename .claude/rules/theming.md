---
paths:
  - "apps/*/src/**"
  - "libs/ui-components/**"
  - "libs/api-client/**"
  - "libs/shared-types/**"
---

# Theming Rule

All UI elements must use theme variables for colors. No hardcoded color values (hex, rgb, named colors) anywhere in components or styles.

## Approach

> Values live in `libs/design-tokens` — see the `design-tokens` rule. The examples below show the idea; the real variables are `--dx-*`, generated from `src/tokens.ts`, and the Tailwind mapping is generated CSS (`@theme`), not `tailwind.config.ts`.

- Themes are defined as CSS custom properties (CSS variables) on the `:root` or a `[data-theme]` attribute
- Tailwind is configured to use these CSS variables via `var(--color-*)` in `tailwind.config.ts`
- Switching themes = swapping CSS variable values — no component changes needed

## Theme Structure

Two base modes, each with a customisable color palette:

- `light` — default light theme
- `dark` — default dark theme

Each theme defines a standard set of semantic color tokens:

```css
[data-theme="light"] {
  --color-background: #ffffff;
  --color-surface: #f9fafb;
  --color-primary: #6366f1;
  --color-primary-hover: #4f46e5;
  --color-secondary: #8b5cf6;
  --color-text: #111827;
  --color-text-muted: #6b7280;
  --color-border: #e5e7eb;
  --color-error: #ef4444;
  --color-warning: #f59e0b;
  --color-success: #10b981;
  --color-info: #3b82f6;
}

[data-theme="dark"] {
  --color-background: #0f172a;
  --color-surface: #1e293b;
  --color-primary: #818cf8;
  /* ... */
}
```

## Tailwind Configuration

Map CSS variables to Tailwind theme tokens in `tailwind.config.ts`:

```ts
theme: {
  extend: {
    colors: {
      background: 'var(--color-background)',
      surface: 'var(--color-surface)',
      primary: 'var(--color-primary)',
      'primary-hover': 'var(--color-primary-hover)',
      secondary: 'var(--color-secondary)',
      text: 'var(--color-text)',
      'text-muted': 'var(--color-text-muted)',
      border: 'var(--color-border)',
      error: 'var(--color-error)',
      warning: 'var(--color-warning)',
      success: 'var(--color-success)',
      info: 'var(--color-info)',
    }
  }
}
```

Use Tailwind tokens in components:
```tsx
// Good
<div className="bg-background text-text border-border">

// Bad — never do this
<div className="bg-white text-gray-900 border-gray-200">
```

## Per-User Customisation

- Users can customise their color palette via Settings
- Custom palette overrides the base theme's CSS variables for that user
- User theme preferences (mode + custom colors) are persisted in the DB per user
- On load, user preferences are injected as inline CSS variables on the root element
- Theme preference is loaded server-side (SSR) to avoid flash of unstyled content (FOUC)

## Rules

- No hardcoded hex, rgb, hsl, or Tailwind default color classes (e.g. `text-gray-900`, `bg-blue-500`) in components
- Always use semantic token names (`text-primary`, `bg-surface`) — never raw color values
- New color tokens must be added to both `light` and `dark` theme definitions
- Custom user palettes must validate color contrast ratios meet minimum readability standards (WCAG AA)
- Theme switching must be instant — no page reload required
