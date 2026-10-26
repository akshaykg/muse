---
paths:
  - "apps/*/src/**"
  - "libs/ui-components/**"
  - "libs/api-client/**"
  - "libs/shared-types/**"
---

# Frontend Stack Rule

All frontend code is written in TypeScript. No plain JavaScript files are allowed.

## Core Stack

- **Language**: TypeScript (strict mode enabled)
- **UI Library**: React
- **Styling**: Tailwind CSS with CSS variables for theming
- **SSR Framework**: Next.js (for apps requiring SSR, server components, or API routes)
- **SPA Bundler**: Vite (for lightweight apps that don't need SSR)

## When to Use Next.js vs Vite

| Use Next.js when | Use Vite when |
|------------------|---------------|
| SSR is needed (theming FOUC, SEO) | Pure SPA with no SSR requirement |
| Server components are beneficial | Lightweight app or micro-frontend |
| API routes are needed on the frontend | Plugin UI components |
| Core frontend, admin panels | Simple dashboard apps |

## TypeScript Configuration

- `strict: true` in all `tsconfig.json` files
- No `any` types unless explicitly justified with a comment
- All API request/response types defined in `libs/shared-types/`
- All component props must be typed — no implicit `any`

## File Conventions

- Components: `.tsx` files, PascalCase filenames (e.g. `SetupWizard.tsx`)
- Hooks: `.ts` files, camelCase with `use` prefix (e.g. `useSetupWizard.ts`)
- Utilities: `.ts` files, camelCase filenames
- Types: `.ts` files in `libs/shared-types/`, exported as named types
- No `.js` or `.jsx` files — TypeScript only

## Rules

- All frontend apps must use TypeScript strict mode
- Shared components go in `libs/ui-components/` — app-specific components stay in the app
- Shared types go in `libs/shared-types/` — never duplicate types across apps
- API calls go through `libs/api-client/` — no raw `fetch` in components
- Tailwind classes only — no inline styles, no CSS modules, no styled-components
- All colors via CSS variables / semantic theme tokens — no hardcoded colors
