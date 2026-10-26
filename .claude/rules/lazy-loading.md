---
paths:
  - "apps/*/src/**"
  - "libs/ui-components/**"
  - "libs/api-client/**"
  - "libs/shared-types/**"
---

# Lazy Loading & Code Splitting Rule

Minimize initial bundle size by lazy loading non-critical code. Only load what the user needs for the current view.

## Frontend — Next.js / React

### Route-Based Splitting (Automatic)

- Next.js handles route-based code splitting automatically — each page is its own chunk
- No additional configuration needed for page-level splitting

### Component-Level Lazy Loading

Use `React.lazy` + `next/dynamic` for heavy or non-critical components:

```tsx
import dynamic from 'next/dynamic'

const RichTextEditor = dynamic(() => import('@/components/RichTextEditor'), {
  loading: () => <Skeleton />,
  ssr: false, // disable SSR for client-only components
})
```

### What to Lazy Load

| Category | Examples | Approach |
|----------|----------|----------|
| Heavy feature modules | Analytics dashboard, report builder, bulk operations | `next/dynamic` with loading skeleton |
| Heavy third-party libs | Chart libraries, PDF generators, code editors, date pickers | Dynamic `import()` only when needed |
| Modal/dialog content | Settings panels, complex forms, confirmation dialogs | `React.lazy` — not in DOM until opened |
| Below-the-fold content | Content not visible in initial viewport | Intersection Observer or `React.lazy` |
| Plugin UI | Plugin iframes | Already lazy by design (loaded on demand) |
| Admin-only features | User management, audit log viewer, system settings | `next/dynamic` — most users never see these |

### What NOT to Lazy Load

- Navigation / layout shell — must be instant
- Above-the-fold content — visible on initial render
- Small components (buttons, inputs, badges) — overhead of splitting outweighs benefit
- Auth state / permission hooks — needed immediately
- Theme provider — must be available before first paint

### Loading States

- Every lazy-loaded component must have a loading fallback (skeleton, spinner, or placeholder)
- Use consistent skeleton components from `libs/ui-components/`
- Never show a blank space while a lazy component loads

### Prefetching

- Use `next/link` with default prefetching for likely navigation targets
- For heavy features, prefetch on hover or when the user approaches the feature (e.g. sidebar hover)

## Backend — Go

### Lazy Initialization

- Expensive connections (storage backends, external services) should be initialized on first use, not at startup
- Use `sync.Once` for thread-safe lazy initialization:

```go
var storageOnce sync.Once
var storageProvider StorageProvider

func getStorage() StorageProvider {
    storageOnce.Do(func() {
        storageProvider = initStorage()
    })
    return storageProvider
}
```

- Plugin WASM modules are loaded on demand when the plugin is first invoked — not at app startup
- External gRPC plugin connections are established on first call, not at registration

### What NOT to Lazy Init on Backend

- Database connection pool — must be ready at startup (`db.Connect()`)
- Redis connection — must be ready at startup (`cache.Connect()`, used for cluster coordination)
- Logger — must be ready immediately (`logger.Init()`)
- Config — loaded once at startup

## Rules

- Every new heavy component or feature module must evaluate whether it should be lazy loaded
- Lazy-loaded components must always have a loading fallback — no blank screens
- Never lazy load core layout, navigation, or auth components
- Dynamic imports must use named chunks for debuggability: `import(/* webpackChunkName: "analytics" */ './Analytics')`
- Monitor bundle size in CI — flag any single chunk exceeding 200KB (configurable via `BUNDLE_SIZE_WARN_KB`)
