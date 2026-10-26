---
paths:
  - "apps/*/src/**"
  - "apps/*/frontend/src/**"
  - "libs/platform-ui/**"
  - "libs/ui-components/**"
---

# Shared Requests Rule

A piece of server state is requested once per tab, however many components show it. Every page already runs inside the navigation shell, so a request the shell makes is multiplied by every open tab of every user; a widget that owns its own copy of a shared request doubles that for nothing.

## One owner per shared resource

- State several components read (alerts, help links, about, banners, setup status, plugin slots, the signed-in user, the space a page is in) lives in **one provider** mounted once (`PlatformGuard`, the shell, or a route layout), or in one module-level cached promise. Components read it through a context hook; they never fetch it themselves. Models: `PluginSlotsProvider` (`plugins/slots.tsx`), `AlertsProvider` (`admin/components/alerts/AlertsProvider.tsx`), `HelpProvider` (`help/HelpProvider.tsx`: links, about, banners), `SpaceContext`, `BrandingProvider`.
- A component the shell mounts more than once (a desktop and a phone copy, a header and a footer copy) must not own a request, a WebSocket, a poller or a listener that does work: both copies render from the same provider.
- A WebSocket is opened in exactly one place per tab (`useAlerts` inside `AlertsProvider`). Nothing else calls the hook that opens it.
- Before adding `useEffect` + `apiClient.get` to a component, check whether a provider or hook already holds that data. If two places need it, make the provider; don't copy the effect.

## Refresh on a signal, not on every render or route

- Never refetch on `pathname` change. A route change isn't new information. Refresh on `visibilitychange`/`focus` with a minimum gap (`HelpProvider`, `PluginSlotsProvider`, `useSetupStatus`: 60 s), on a WebSocket message, after a write the user made (`refreshLinks()` after Settings → General saves), or on a user action that needs the freshest answer (`refreshAbout()` when the About dialog opens).
- Pollers (`setInterval`) skip ticks while `document.visibilityState === 'hidden'` and stop on unmount. Poll only while something is running; stop when it finished.
- A guard that re-checks something (setup status, session) uses one shared hook with its own gap (`guards/useSetupStatus.ts`), not an effect per guard.
- State kept across a remount lives in the provider, not in a component ref: a `lastFetch` ref dies with the component, so a widget mounted by two shells (`BannerBar`, `AppFooter` in the navigation and settings shells) refetched on every crossing until the provider held it.

## Requests that must happen

- A write (`post`, `patch`, `delete`) runs once, where the user acted; the provider updates its state from the response or a server message, so other readers follow without a refetch.
- Page data a route owns (a list, a detail) is that route's own request; the rule is about data shared across components, not about every page fetching its own.

## Review checklist

- [ ] The data has one owner; new readers use its hook
- [ ] Nothing mounted twice fetches, opens a socket or polls on its own
- [ ] Refreshes happen on focus/visibility with a gap, a server message or a user write, never on route change
- [ ] Pollers pause while the tab is hidden
- [ ] A test proves one connection or one request for the shell when it's cheap to (`alerts-provider.test.tsx`)
