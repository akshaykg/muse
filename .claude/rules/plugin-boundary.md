# Plugin Boundary Rule

The core platform provides capabilities; plugins provide features. Core never holds code, screens or text that exist for one plugin or for one kind of plugin, because that code is not reusable: the platform must work the same whichever plugins are installed. A product (`apps/<product>`) follows the same rule: it builds on the platform, it doesn't reach into plugins.

Core here means `libs/platform`, `libs/platform-ui`, `libs/go-common`, `libs/shared-types`, `libs/api-client`, `libs/ui-components`, `libs/i18n`, `libs/design-tokens`, `libs/plugin-ui-sdk`, `apps/core-*` and `migrations/`. Plugins live in their own folders (`apps/*/backend/plugins/*`, `apps/*/frontend/plugins/*`).

## Core may

- Offer a **capability** any plugin can declare in its manifest: database, KV, outbound calls, settings, secrets, limits, UI slots, host data calls, a protected endpoint (today: MCP at `/mcp/{plugin}`).
- Hold the **security part** of a capability that a sandboxed plugin can't do for itself: token binding and checks, key hashing, consent, rate limits, RBAC. It is named by the capability, never by a plugin, and works for any plugin that declares the capability.
- Draw **generic plugin management** from manifest data: install, permissions, the settings form, limits, data, health, uninstall.

## Core must not

- Name a plugin (its `name`, `id`, package or asset path) outside tests and fixtures.
- Render a plugin's or a capability's feature UI itself: no menu item, nav entry, settings section, card, wizard step, dialog or catalog text that only makes sense while a certain plugin is installed (no `McpKeysCard`, no "Connect an AI agent" in core).
- Add an endpoint whose only purpose is one plugin feature's screen. Plugin screens get their data through host methods.

## Plugin UI

- The plugin's own icon (`icon`, an SVG in its package) and whether its screens work on small screens (`mobile`) are manifest fields too; core draws the icon and hides slots generically, for any plugin.
- Declared only in the plugin manifest (`ui.slots`): each slot names where it goes (`nav.page`, `profile.menu`, `profile.settings`, `settings.page`, `settings.section`, `plugin.details`, `setup.step`, `dashboard.widget`), its label per locale, the permission a viewer needs, and its entry page in the plugin package.
- `nav.page` is a plugin's own full page: core lists it as a sub-item of the left nav's Plugins entry and draws the frame over everything but the left and top nav, with the footer unless the slot turns it off. Core never adds a nav entry for a plugin any other way.
- Drawn only while the plugin is active: activating adds its slots on every node, deactivating or uninstalling removes them (persist, then publish through the broker; see `cluster-compatibility.md`). Core places ask for slots by slot name only.
- Rendered through `PluginSlot` (`plugin-ui.md`). Data comes from host methods that the plugin's approved permissions allow, each checking the viewer's own RBAC like the matching API. A secret the host makes (a key, a token) is shown by the host, never handed to the plugin frame.

The slot platform: manifest and serving in `libs/platform/plugin/ui.go`, the core places in `libs/platform-ui/src/plugins/slots.tsx` (`usePluginSlots`, `PluginSlotList`). New plugin screens go there, never into core.

## Enforcement

- `apps/core-frontend/src/__tests__/plugin-boundary.test.ts` (frontend code and catalogs) and `libs/platform/kernel/boundary_test.go` (`TestPluginBoundary`: Go code and migrations) fail when core or product code names a plugin, or holds a plugin capability's feature words (`MCP`), outside their allowlists. Comments may name a capability to explain code; code may not.
- Each allowlist entry carries its reason: `capability` entries are the generic, security part and stay; `row N` entries are known violations waiting to move into their plugin. The lists only shrink: an entry whose file no longer needs it fails the test, so it goes with the code.
- Adding an entry needs a reason a reviewer can check against this rule. "It was quicker" is not one.

## Review checklist

- [ ] No plugin name and no plugin-only feature (screen, text, endpoint) in core or product code
- [ ] Plugin UI comes from the manifest's `ui.slots` and disappears when the plugin is deactivated
- [ ] Host methods validate params and check the viewer's permissions; no secret reaches a plugin frame
- [ ] Capability code is generic: a second plugin could declare the capability with no core change
- [ ] Boundary tests pass, and no allowlist entry was added without a reason
