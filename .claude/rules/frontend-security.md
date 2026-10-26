---
paths:
  - "apps/*/src/**"
  - "apps/*/frontend/src/**"
  - "apps/*/next.config.ts"
  - "apps/*/frontend/next.config.ts"
  - "libs/platform-ui/**"
  - "libs/ui-components/**"
  - "libs/api-client/**"
  - "libs/plugin-ui-sdk/**"
---

# Frontend Security Rule

The browser is the one client we don't control: every page is served to strangers, every value the API returns was once typed by someone, and the Next.js server stands between the internet and the Go backend. These are the things that must be true in the frontend apps, `platform-ui`, `ui-components`, `api-client` and the plugin SDK. The backend's own rules (`rbac.md`, `http-middleware.md`, `error-response.md`) stay where they are.

## Response headers

- Every app's `next.config.ts` is `platformNextConfig(...)` from `@depotex/platform-ui/next-config`, never a hand-written config. It sets `images: { unoptimized: true }` (no page uses `next/image`; the optimizer is an unauthenticated attack surface) and the security headers on every page: `X-Frame-Options: DENY` and `frame-ancestors 'none'` (sign-in, OAuth consent, device approval and `npm login` pages are one click on a session; framing them is clickjacking), `Referrer-Policy: strict-origin-when-cross-origin`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `Permissions-Policy` with camera, microphone and geolocation off.
- The Content-Security-Policy is set per request by `securityProxy()` from `@depotex/platform-ui/security`, called from each app's `src/proxy.ts`, because `script-src` needs a nonce. Machine paths (`/repository/*`, `/v2/*`, `/v1/*`, `/terraform/*`, `/mcp/*`, `/api/*`) get no CSP: their clients are package managers. `CSP_ENFORCE` picks `Content-Security-Policy` over `Content-Security-Policy-Report-Only`; reports go to `/csp-report` and the server log.
- A new source a page needs (a font host, an image host, a frame) is added to the policy in `security.ts` with a comment saying which page needs it. Never `'unsafe-inline'` for scripts, never `*`.

## Secrets and tokens

- A secret never travels in a URL: not in a query string, not in a hash, not in a path. The setup and recovery keys arrive as `?token=` from the link the backend logs; the page reads it once (`setup/keyStore.ts`), keeps it in `sessionStorage`, removes it with `history.replaceState` and sends it only as the `X-Setup-Token` / `X-Recovery-Token` header; a key typed into `KeyRequired` goes the same way. The API proxy and the backend accept those headers (and `SETUP_TOKEN` / `RECOVERY_TOKEN` from the environment), never the query parameter. The one-time tokens in invitation and password-reset emails are the exception the email medium forces: single use, short-lived, consumed by the page that reads them (known gap: not yet stripped from the address).
- Session cookies are set by the backend only: `HttpOnly`, `Secure` (off only through `AUTH_COOKIE_SECURE=false` for local development; the system check warns when it is off for a non-localhost address), `SameSite`. The frontend never reads a session cookie and never mints one. Preference cookies written by `writeCookie` carry `Secure` on https and `SameSite=Lax`.
- `localStorage` / `sessionStorage` hold conveniences (dismissed banners, sidebar state, the activity timestamp, shown-toast ids, the saved list view) and the setup key while the wizard runs. Nothing else: no tokens, no user data, no API responses with other people's data.
- `NEXT_PUBLIC_*` is public. A value that must not reach the bundle (`SETUP_TOKEN`, `RECOVERY_TOKEN`, `BACKEND_URL`) has no `NEXT_PUBLIC_` prefix and is read only in server code (route handlers, `proxy.ts`, `next.config.ts`).

## Navigation and links from data

- A URL that came from the API, a plugin, a package's metadata, a query string or a banner is never assigned to `window.location`, `href`, `src` or `window.open` as it is. It goes through `safeHref(url)` from `@depotex/ui-components` (same-origin path starting with one `/`, or an absolute `http:` / `https:` / `mailto:` URL; everything else is `null` and the link is drawn as text) or through `SafeLink` (external links: `http(s)` only, `rel="noopener noreferrer nofollow"`, `target="_blank"`). React refuses `javascript:` in `href` but not in `location.assign`, so the check is in code, not in React.
- The backend validates the same way where it stores a URL a page will navigate to (alert actions: `actions[].url` must be a same-origin path or `https:`; help links: `http`, `https`, `mailto`). Both sides check; neither trusts the other.
- Return-to parameters (`?next=`) pass `safeNext` (`guards/publicPages.ts`): one leading `/`, no `//`, no CR/LF, no scheme. Nothing else decides where to go after sign-in.
- A query value is never rendered as text. It maps to a catalog key (`i18n.has`) or a fixed set; an unknown value falls back to the generic message.

## Rendering untrusted text

- `dangerouslySetInnerHTML` is allowed in exactly one place: the branding `<style>` in the root layout, whose only input is `brandingCss()` output where every colour passes `HEX.test`. Anything else renders through React, which escapes.
- Markdown (package READMEs, descriptions) renders with `react-markdown` + `remark-gfm` and `skipHtml`; its default `urlTransform` drops `javascript:`. No `rehype-raw`.
- Banner text uses the mini-parser in `BannerBar.tsx` (`[label](https://…)` and `mailto:` only). It is not Markdown and never becomes HTML.
- Error boundaries (`admin/routes/error.tsx`) show no message, stack or request detail; the console gets them.

## The Next.js server as a proxy

- The API proxy (`createApiProxy`, `proxy.ts`) and the artifact proxy (`createArtifactProxy`, `artifactProxy.ts`) forward an allowlist of request headers (`Cookie`, `Authorization`, `Accept`, `X-CSRF-Token`, `X-Captcha-Response`, `X-Request-ID`, `X-Depotex-Via` (only `plugin:<name>`, set by the host for `api.request`), the setup and recovery headers) and drop hop-by-hop headers both ways. A new header is added to the list with a comment saying which backend code reads it.
- Request bodies are streamed to the backend (`body: req.body`, `duplex: 'half'`), never read into memory. A `Content-Length` above the proxy's limit is refused with 413 before the backend is asked; the backend enforces the same limit per route (`http.MaxBytesReader`).
- `X-Forwarded-For`, `X-Forwarded-Host` and `X-Forwarded-Proto` from the client are forwarded only when `FRONTEND_BEHIND_PROXY=true`, which says a reverse proxy that rewrites them sits in front of the Next.js server. Otherwise the proxy drops them and sends the request's own `Host` and protocol, so the backend sees its loopback peer and nobody can pick their own address for the login lockout, the rate limits or the audit log. Next.js keeps a forwarded header the client sent (`base-server.js`, `??=`), so there is no way to tell a forged one from a proxy's.
- Redirects from the backend are passed to the browser unfollowed. Responses get `Cache-Control: no-store` unless the backend set caching itself.
- `/app-version` discloses the build id on purpose (the update prompt compares it). Nothing else about the build, the host or the environment is served without a session.

## Plugins

- Plugin UI runs in `PluginSlot`'s iframe with `sandbox="allow-scripts allow-forms"` (never `allow-same-origin`), `allow=""`, `referrerPolicy="no-referrer"`, from a document the backend serves with its own `sandbox` CSP (`default-src 'none'`, `connect-src 'none'`, `form-action 'none'`, `base-uri 'none'`). A plugin cannot call the API; it asks the host through `bridge.ts`.
- The host accepts a message only from `event.source === frame`; the plugin pins the host origin from `init`. The `context` the host posts is public to the plugin: no key named `token`, `secret`, `password`, `email` or `cookie` goes in it, and no secret the host mints (an API key, a token) is handed to the frame; the host shows it itself.
- Host method handlers check the viewer's permissions like the matching API and never return internals in an error (`bridge.ts` maps errors to a code and a short message).

## Dependencies

- `make audit-frontend` (`pnpm audit --prod --audit-level=high`) runs before a release and whenever `next` or a dependency with native code is bumped. A high or critical advisory in a production dependency is fixed by upgrading, not by an override, unless the fixed version doesn't exist.
- `next` stays on the newest patch of its major; the image optimizer, `next/og` and middleware have had unauthenticated RCE and bypass advisories in the past, and every one was a patch upgrade.

## Enforcement

`apps/core-frontend/src/__tests__/frontend-security.test.ts` scans the frontend sources: both `next.config.ts` files call `platformNextConfig`; both `src/proxy.ts` files call `securityProxy`; `dangerouslySetInnerHTML` appears only in the branding style allowlist; `window.location.assign`, `.href =`, `window.open(` and `location.replace(` with a non-literal argument appear only in the allowlist of files that call `safeHref` first; `searchParams.get('token')` appears only in the setup and recovery modules; `PluginSlot`'s context never carries a key named `token`, `secret`, `password`, `email` or `cookie`. Allowlist entries carry a reason a reviewer can check against this rule.

## Review checklist

- [ ] New page or route: headers come from `platformNextConfig` / `securityProxy`; nothing sets its own CSP except the plugin document
- [ ] No secret in a URL, in `NEXT_PUBLIC_*`, in browser storage or in a plugin `context`
- [ ] Every `href`, `src`, `location` or `window.open` built from data goes through `safeHref` or `SafeLink`; the backend validates the stored URL too
- [ ] No `dangerouslySetInnerHTML`, no `rehype-raw`, no query value rendered raw
- [ ] A new proxy header is allowlisted with its reader named; bodies stream; the size limit matches the backend's
- [ ] `make audit-frontend` is clean at high and above
