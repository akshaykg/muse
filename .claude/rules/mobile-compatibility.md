---
paths:
  - "apps/*/src/**"
  - "libs/ui-components/**"
  - "libs/api-client/**"
  - "libs/shared-types/**"
---

# Mobile Compatibility Rule

Every UI change must be compatible with mobile devices. No desktop-only implementations are acceptable.

The one exception is a plugin that declares `mobile: false` in its manifest: the host hides its screens on small screens and keeps its Settings slots (see `plugin-ui.md`). Core and product screens never get this exception.

## Principles

- Mobile-first approach — design for small screens first, then scale up
- Use Tailwind's responsive prefixes (`sm:`, `md:`, `lg:`, `xl:`) consistently
- Never use fixed pixel widths that break on small screens
- Touch targets must be at least 44x44px (buttons, links, interactive elements)

## Layout

- All layouts must be tested at common breakpoints: 375px (mobile), 768px (tablet), 1280px (desktop)
- Use flexbox or grid with responsive wrapping — no rigid multi-column layouts without mobile fallback
- Horizontal scrolling is forbidden except for explicitly scrollable components (e.g. data tables with overflow-x-auto)

## Navigation

- Mobile navigation must be usable without hover (no hover-only menus)
- Provide a hamburger/drawer pattern or bottom nav for mobile where applicable

## Typography & Spacing

- Font sizes must be readable on mobile — minimum 14px body text
- Adequate spacing between interactive elements to avoid mis-taps

## Images & Media

- Images must be responsive (`w-full`, `max-w-*`, or Next.js `<Image>` with proper sizing)
- No fixed-size media that overflows on small screens

## Testing

- Every UI component or page change must be visually verified at mobile viewport before considered done
