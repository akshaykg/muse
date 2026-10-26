# Monorepo Structure Rule

The project uses an Nx-managed monorepo to support a shared core platform with multiple apps built on top of it.

## Tooling

- **Nx** — monorepo orchestration, build caching, affected-based builds, dependency graph
- **Makefile** — root-level orchestration for Go-specific builds and cross-language tasks

## Directory Structure

```
/
├── apps/
│   ├── core-backend/           # Go — shared core backend
│   ├── core-frontend/          # Next.js — shared core frontend (setup wizard, admin, etc.)
│   ├── app-one/                # App 1
│   ├── app-two/                # App 2
│   ├── app-three/              # App 3
│   ├── app-four/               # App 4
│   └── app-five/               # App 5
├── libs/
│   ├── shared-types/           # Shared TypeScript types (API contracts, DTOs)
│   ├── ui-components/          # Shared React/Next.js components
│   ├── api-client/             # Shared API client (fetch wrapper, error handling)
│   └── go-common/              # Shared Go packages (logger, config, pagination, errors, etc.)
├── migrations/                 # Database migrations (shared across all apps)
├── nx.json                     # Nx workspace configuration
├── Makefile                    # Root-level build orchestration
├── .env.example                # Documented env vars
└── .claude/
```

## Rules

### Apps

- Each app lives in `apps/{app-name}/`
- Apps can import from `libs/` but never from other apps
- Each app has its own `project.json` (Nx) defining build, test, and serve targets
- Go apps use the standard Go module layout inside their directory
- Frontend apps use Next.js project structure

### Libs (Shared Libraries)

- Shared code lives in `libs/{lib-name}/`
- Libs can import from other libs but never from apps
- Every shared package must have a clear public API — no reaching into internal files
- `go-common/` contains shared Go packages: logger, config loader, pagination, error builders, middleware, etc.
- `shared-types/` contains TypeScript types that mirror Go API contracts — kept in sync manually or via code generation
- `ui-components/` contains reusable React components that follow the theming rule (CSS variables only)

### Dependency Direction

```
apps → libs → (no further imports)
```

- Apps depend on libs — never the reverse
- Libs can depend on other libs — no circular dependencies
- The core backend/frontend are apps, not libs — other apps don't import from them directly; shared code goes in libs

### Build & CI

- Use `nx affected` to only build/test what changed — critical as the repo grows
- Go builds use the Makefile for compilation, but Nx orchestrates when they run
- Frontend builds use Nx natively
- Build caching is enabled for all targets

### Naming Convention

- App directories: kebab-case (e.g. `core-backend`, `app-one`)
- Lib directories: kebab-case (e.g. `shared-types`, `go-common`)
- Go packages inside `go-common/`: standard Go naming (lowercase, no hyphens)

### New App / Lib Checklist

When adding a new app or lib:
1. Create the directory under `apps/` or `libs/`
2. Add a `project.json` with build, test, and lint targets
3. Update the root `nx.json` if needed
4. Document any new shared types or API contracts
5. Verify the dependency graph has no circular dependencies (`nx graph`)
