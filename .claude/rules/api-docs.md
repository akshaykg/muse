---
paths:
  - "apps/*/**/*.go"
  - "libs/go-common/**/*.go"
  - "libs/platform/**/*.go"
---

# API Documentation Rule

The REST API is documented from the code: every `/api/...` route carries its own description, and the OpenAPI document (`GET /api/openapi.json`, shown by the API explorer plugin) is built from those descriptions. A route that changes without its description is a wrong contract for everyone who reads it (people, generated clients, AI agents).

**After every change to the backend, check whether an API route was added, changed or removed, and update its API documentation in the same change.** Don't leave it for later and don't report the work as done until it is updated.

## What counts as an API change

| Change | Update |
|---|---|
| New route (`mux.HandleFunc("METHOD /api/...")`) | Add its description, with the `Permission` it needs (`"signed in"` when sign-in is enough) or `Public`; the test fails a description with neither |
| Path, method, path or query parameters | Update the description |
| Request body or response fields (added, renamed, removed, type changed) | Update the request or response type the description points at |
| Permission, licence tier, sign-in requirement | Update `Permission` / tier / auth in the description |
| A new error `reason` the route can return | Add it to the description's reasons |
| A route that now returns a secret (raw token, key, client secret, recovery code) | Mark it `ReturnsSecret`, so the API explorer never shows it in a plugin frame |
| Route removed | Remove its description (a test fails on descriptions of routes that don't exist) |
| Package-format and protocol routes (`/repository/...`, `/v2/...`) | Not in the OpenAPI document; their format's product docs page instead |

## Where

- **Route description:** `apidoc.Describe(pattern, apidoc.Op{...})` from `libs/go-common/apidoc`, in the package's `apidoc.go` `init` (beside its `RegisterRoutes`; the pattern exactly as passed to `HandleFunc`): summary, query parameters, request and response Go types (schemas are generated from their `json` tags), permission, tier, error reasons, `ReturnsSecret`. Request and response bodies are named structs, so their schema stays in step with the code. Routes are registered on `apidoc.Mux` (`RegisterRoutes(mux apidoc.Mux)`), never a concrete `*http.ServeMux`, so the server lists them.
- **Secret routes:** a route that starts returning a secret is also added to the secret-route list of `TestAPIDescriptions` (`libs/platform/kernel/apidoc_test.go` for platform routes, `apps/depotex/backend/cmd/server/apidoc_test.go` for Depotex).
- **Developer docs:** the feature's guide (`doc/internal-dev-doc/<area>/README.md`) keeps its `API Reference` table in step: route, who may call it, what it does.
- **Product docs:** routes customers use (API tokens, automation, CI) are on the feature's docs-site page; a changelog line when a public route is added or changes in a way callers notice.

How it works, and what isn't described yet: `doc/internal-dev-doc/api-docs/README.md`.

## Checks

- `TestAPIDescriptions` (`apidoctest.Check`) fails on a description whose route doesn't exist and on a listed secret route not marked `ReturnsSecret`, and reports coverage (`-v` lists routes without a description).
- `docs-sync.md` still applies: the docs-sync Stop hook checks developer and product docs; this rule adds the route descriptions.

## Review checklist

- [ ] Every added or changed `/api` route has an up-to-date `apidoc.Describe`
- [ ] Request and response bodies are named structs with `json` tags
- [ ] Permission, tier and new reasons are in the description
- [ ] Secret-returning routes are marked `ReturnsSecret`
- [ ] Developer guide's API Reference and product docs updated
