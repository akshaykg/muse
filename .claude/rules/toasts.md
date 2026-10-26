---
paths:
  - "apps/*/src/**"
  - "libs/platform-ui/**"
  - "libs/ui-components/**"
  - "libs/plugin-ui-sdk/**"
---

# Toast Rule

Every short-lived message ("saved", "installed", a policy warning, a plugin notice, a new version, a critical alert) is a toast, shown through `useToast()` from `@depotex/platform-ui` into the one region `AuthGuard` mounts (`ToastProvider`, `libs/platform-ui/src/toast`). Pages, plugins and background listeners never render their own toasts, success boxes or floating notices.

## Using it

```tsx
const toast = useToast();

toast.success(t('storage.saved'));
toast.error(t('storage.saveFailed'), { action: { label: t('common.retry'), onClick: save } });
toast.warning(text, { title: t('common.policyWarning.title', { policy }) });
toast.info(t('common.update.body'), { title: t('common.update.title'), persist: true, action: { label: t('common.update.reload'), onClick: reload } });
toast.error(message, { title, persist: true, key: `alert-${id}` }); // key: shown again, it counts instead of stacking
```

- The message is the title; with `title`, the message becomes a one-line body.
- At most one action. Text comes from the catalogs like any other (see `i18n.md`).
- After a successful save, show a success toast and keep the form as it is: no `notice` / `saved` state, no `<Alert variant="success">` in the page.
- A partial success (some items failed) is a warning, not a success.

## What the region does

- **Position:** bottom end corner on wide screens (bottom-right, bottom-left in RTL), 384px wide, 16px from the edges; full width on phones, above the safe area. A sticky save bar keeps toasts above it with `useToastInset(height)`.
- **Stack:** up to 3 visible, newest nearest the edge; more wait behind a "+N more" chip. The same message (or `key`) again bumps a counter and restarts its timer.
- **Time:** success 4 s, info 6 s, warning 8 s; errors stay; a toast with an action (Reload, Retry) or `persist` stays. Pointer over the region, focus inside it, or a hidden tab pauses every timer. A thin bar shows the time left.
- **Look:** surface, neutral border, overlay shadow; colour only in the icon. Title 14/500, body muted, close button with a touch-sized target. Rises and fades in, the stack opens and closes room; no motion with `prefers-reduced-motion`.
- **Access:** the region is `role="status" aria-live="polite"`, errors are `role="alert"`. Toasts never take focus. Esc closes the focused toast; swipe down closes it on touch screens.

## Not a toast

| Message | Where it goes |
|---|---|
| A field is invalid | Inline, under the field |
| A page failed to load, no permission | Inline `Alert` in the page |
| An ongoing state (paused, unlicensed, an incident) | Page or system banner |
| Unsaved changes | Save bar |
| Copied to clipboard | The button shows "Copied" for 1.5 s |
| Delete, enforce, anything irreversible | Confirm dialog first, then a success toast |
| The page's own result (a sign-in link sent, an npm login approved) | The page itself |

## Plugins

`ui.notify` from a plugin shows a toast titled with the plugin's slot title. A slot may pass `onNotify` to handle it itself, but must not render its own floating message.

## Review checklist

- [ ] No `<Alert variant="success">` or `setNotice`/`setSaved` state for something that just happened
- [ ] One `useToast()` call per message; errors with an action (Retry) when retrying makes sense
- [ ] Partial failures are warnings; the page's own result stays in the page
- [ ] Tests render pages inside `ToastProvider` (`render(<Page />, { wrapper: ToastProvider })`) when they check a toast
