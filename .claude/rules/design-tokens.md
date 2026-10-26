---
paths:
  - "apps/*/src/**"
  - "apps/*/frontend/src/**"
  - "libs/ui-components/**"
  - "libs/platform-ui/**"
  - "libs/design-tokens/**"
  - "**/*.css"
---

# Design Tokens Rule

Every visual value in a frontend or plugin UI comes from a design token in `libs/design-tokens`. Tokens are the contract plugins build against, so any UI element — host app, shared library or plugin — that uses a raw value instead of a token will look wrong in some theme and drift from the rest of the product.

## Source of truth

- `libs/design-tokens/src/tokens.ts` holds every value. The CSS in `libs/design-tokens/css/` is **generated** from it:
  - `tokens.css`: plain CSS variables (`--dx-*`) for every theme. Host apps and plugin UIs both load it.
  - `tailwind.css`: maps Tailwind v4's theme onto the tokens, so `bg-surface`, `rounded-md`, `shadow-lg`, `text-sm`, `p-4` all read tokens.
- Never edit the generated CSS. Change `tokens.ts`, run `pnpm --filter @depotex/design-tokens build`, and commit both. A test fails if they drift.
- Apps get tokens through `libs/platform-ui/src/styles/platform.css`. Don't import the token CSS a second time or redefine a token in app CSS.

## Using tokens

| Need | Use | Never |
|---|---|---|
| Color | `bg-surface`, `text-text-muted`, `border-border`, `text-success-fg` | `bg-white`, `text-gray-500`, `#fff`, `rgb()` |
| Text on a filled color | the matching `*-fg` token (`primary-fg`, `success-fg`) | `text-white` / `text-black` |
| Corner radius | `rounded-xs … rounded-2xl`, `rounded-full` | `rounded-[6px]` |
| Shadow | `shadow-xs … shadow-2xl`, `shadow-surface`, `shadow-raised`, `shadow-overlay`, `shadow-glow-*` | `style={{ boxShadow }}`, `shadow-[…]` |
| Spacing | Tailwind spacing scale (`p-4`, `gap-2`) | arbitrary px (`p-[13px]`) |
| Font size / family / weight | `text-sm`, `font-mono`, `font-semibold` | `text-[15px]`, font names in components |
| Motion | `duration-fast / normal / slow / slower`, `ease-standard / emphasized` | `duration-200`, literal `ms` or `cubic-bezier()` |
| Stacking | `z-base / raised / sticky / overlay / dropdown / modal / toast` | `z-10`, `z-50`, `z-[999]` |
| Touch target | `min-h-touch`, `min-w-touch` (44px) | hardcoded `44px` |
| Custom CSS | `var(--dx-…)` | literal values, legacy `--color-*` names |

- Inline `style` is allowed only for values computed at runtime (positions, progress widths). Colors, shadows, radii and timings in `style` must be `var(--dx-…)`.
- Canvas and SVG drawing reads tokens at runtime with `getComputedStyle(document.documentElement).getPropertyValue('--dx-…')` and redraws on theme change.
- Opacity modifiers on tokens (`bg-primary/60`) are fine.
- The legacy `--color-*` variables exist only so old CSS keeps working. Don't use them in new code; move a file to `--dx-*` when you touch it.

## Adding or changing a token

1. Add it to `tokens.ts`. A theme-dependent token goes in every theme (a test enforces identical keys).
2. Name it by role, not by look: `color-surface-elevated`, not `color-gray-100`; `shadow-overlay`, not `shadow-big`.
3. Run the build, then check it in light, dark and high-contrast.
4. Colors must meet WCAG AA: 4.5:1 for text pairs, 3:1 for UI parts. The contrast tests cover the core pairs; add a pair when a new token is meant to carry text.
5. Versioning (`TOKENS_VERSION`): adding a token is a minor bump. Renaming, removing or changing a token's meaning is a **major** bump, because it breaks plugins. Keep the old name as an alias for at least one release.
6. Update the developer doc (`doc/internal-dev-doc/design-tokens/`) and, once plugins ship, the product token reference on docs-site.

## Plugin UIs

- Plugin UIs run in a sandboxed iframe and can't inherit host CSS. `PluginSlot` sends every `--dx-*` value (computed from the document) into the iframe on load and on every theme change; the SDK applies them. Plugins style themselves only with `--dx-*` variables — see `plugin-ui.md`.
- Never expose Tailwind class names or legacy `--color-*` names to plugins. `--dx-*` is the only public surface.

## Review checklist

- [ ] No raw colors, radii, shadows, font sizes, durations or z-index numbers in components or CSS
- [ ] Text on filled backgrounds uses the matching `*-fg` token
- [ ] New tokens added to every theme, generated CSS rebuilt and committed
- [ ] Checked in light, dark and high-contrast
- [ ] Token renames or removals bump the major version and keep an alias
