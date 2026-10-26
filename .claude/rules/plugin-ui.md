---
paths:
  - "apps/*/src/**"
  - "apps/*/frontend/src/**"
  - "apps/*/frontend/plugins/**"
  - "libs/platform-ui/**"
  - "libs/plugin-ui-sdk/**"
---

# Plugin UI Rule

Plugin UI runs in a sandboxed iframe and talks to the host only through the typed protocol in `libs/plugin-ui-sdk`. The host side is `PluginSlot` / `PluginBridge` in `libs/platform-ui/src/plugins`. The backend rules for plugins (manifest, signing, permissions) are in `plugin-system.md`; this rule covers the frontend boundary.

## Host (apps and platform-ui)

- Render plugin UI only through `<PluginSlot>`. No hand-rolled iframes, no `dangerouslySetInnerHTML` of plugin markup, no loading plugin scripts into the host page.
- The iframe sandbox is `allow-scripts allow-forms`. **Never add `allow-same-origin`**: plugin assets are served from the host's origin, so a same-origin sandboxed frame could remove its own sandbox. Adding `allow-popups`, `allow-top-navigation` or `allow-modals` needs a security review.
- Pass unsigned plugins with `trusted={false}` so the slot shows the warning (signing enforcement off).
- `context` is posted with targetOrigin `'*'` (the frame's origin is opaque), so it must never hold tokens, credentials, session data or anything the user couldn't see on screen.
- Host methods a slot exposes (`methods` prop) are an API: validate `params` (throw `ParamsError`), check the user's permission with the same RBAC as the equivalent UI, and never return raw errors. The bridge already turns thrown errors into a generic `handler_failed`.
- Pass the plugin's RBAC-approved capabilities only: capability methods come from the slot's `grants` (`useCapabilityMethods`), are about the calling plugin only and fail closed without a signed-in viewer. A method that writes data must go through the backend API as the current user, never around it.
- Refuse with `HostMethodError` (`forbidden`, or `rejected` with a stable reason), never with raw API text. A risky change is confirmed in a host dialog and a secret the host makes is shown by `revealSecret` (`HostDialogsProvider`), never trusted from or returned to the frame.

## Serving plugin assets

- Every plugin document is served with a `Content-Security-Policy` that starts with `sandbox allow-scripts allow-forms`, so it is sandboxed even when opened directly. Also set `X-Content-Type-Options: nosniff` and `frame-ancestors 'self'`.
- Resolve asset paths inside the plugin's own directory and reject anything that escapes it. Serve only known content types.
- Installed plugins' `ui/` files are served by the backend (`GET /api/plugin-ui/{name}/…`, `libs/platform/plugin/ui.go`) only while the plugin is active; that handler shows the headers.
- Core draws plugin screens only from the manifest's `ui.slots`, through `PluginSlotList` / `usePluginSlots(slot)` (see `plugin-boundary.md`).

## Protocol and SDK (`libs/plugin-ui-sdk`)

- Every message has `channel: 'depotex-plugin'` and `v: PROTOCOL_VERSION`. Both sides validate every message with `isPluginToHost` / `isHostToPlugin` and drop anything else. Never act on an unvalidated `event.data`.
- The host identifies its frame by `event.source` only. The SDK accepts messages only from `window.parent` and pins the host origin from the init message.
- Protocol changes: a new optional field or a new method is compatible. A new message type, a changed field or a removed method is a breaking change: bump `PROTOCOL_VERSION`, and the host must keep answering the previous version for at least one release.
- `src/index.ts` stays one file of erasable TypeScript (no enums, namespaces, parameter properties or imports): `scripts/build.ts` emits `dist/sdk.js` by stripping types. `src/kit.ts` (the UI kit, `dist/kit.js` + `kit.css`) is the same, with type-only imports.
- Plugin pages in TypeScript live in the plugin's `ui-src/` (erasable TypeScript, type-only imports of the SDK and kit) and are built into committed `ui/*.js` by `scripts/plugin-pages.ts`; its `--check` must pass. Plugin pages set text with the kit's `h`/`render` (or `textContent`), never `innerHTML` with host data.

## Plugin UI styling

- Style only with `--dx-*` variables (see `design-tokens.md`). The SDK applies them and `data-theme` to `<html>` and updates them on theme change.
- Language: the SDK sets `lang` and `dir` on `<html>` from the host. Text comes from the plugin's own catalogs, picked with `dx.pickLocale()` and re-rendered on `dx.onLocaleChange()`; use logical CSS so the frame mirrors in RTL (see `i18n.md`).
- Keep the frame background transparent; the slot supplies the surface.
- Plugins must work at 375px wide and use `--dx-size-touch-target` for tap targets (see `mobile-compatibility.md`), or declare `mobile: false` in the manifest when their screens can't (a dense tool such as an API explorer). The host then draws only their Settings slots (`settings.page`, `settings.section`, `plugin.details`, `setup.step`) below the `md` breakpoint and shows a "larger screens" page for their `nav.page`; Settings → Plugins marks them **Desktop only**. Their Settings slots must still work at 375px.
- A plugin's own icon is an SVG in its package (`icon: ui/icon.svg`, at most 32 KB): plain shapes, no scripts, event attributes, external links or embedded content (checked at install). The host draws it only as a CSS mask in the theme's text colour (`pluginIcon`, `PluginIcon`), never inline or as `<img>`, so it is single-colour and follows light, dark and high contrast. A slot's named `icon` still wins over it.

## Review checklist

- [ ] Plugin UI rendered only via `PluginSlot`; sandbox unchanged (no `allow-same-origin`)
- [ ] No secrets or session data in `context`
- [ ] Every host method validates params and checks permissions
- [ ] Plugin documents served with the sandbox CSP and path containment
- [ ] Protocol changes versioned; SDK still builds by type stripping
