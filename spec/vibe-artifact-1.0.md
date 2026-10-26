# vibe-artifact/1.0 — open milestone standard

Any client (including a competitor's) can push to any server that implements
this spec. No git is involved at any point.

## Milestone zip layout

```
<project>.zip
  vibe/manifest.json   REQUIRED for full fidelity (see below)
  TODO.md              checkboxes become the milestone to-do list
  KNOWN_GAPS.md        known gaps, plain words
  README.md            what the app is + how to run it
  …project files…
```

`vibe/manifest.json`:

```json
{
  "spec": "vibe-artifact/1.0",
  "project": "<project slug>",
  "label": "<one-line summary of this milestone>",
  "about": "<one sentence: what the app is>",
  "stage": "idea | building | live",
  "screenshots": ["vibe/shots/home.png"]
}
```

Servers MUST accept a zip without the manifest (headers `X-Milestone-Label`,
`X-About`, `X-Stage` are the fallback) and MUST reject unsafe archives:
path traversal, absolute paths, symlink escapes, entry/size/ratio limits.

## API contract (all under `/api/v1`, `Authorization: Bearer <jwt|vatt_token>`)

| Action | Route |
|---|---|
| Sign in (web) | `POST /auth/login` → `{ token }` |
| My projects (skill picker) | `GET /me/projects` |
| Create API token | `POST /me/tokens` → raw token shown once |
| Push milestone | `POST /projects/{id}/milestones` (raw zip body) → `{ milestone_id, findings }` |
| Browse milestone | `GET /milestones/{id}` (files, findings, todos) |
| Read a file | `GET /milestones/{id}/files/content?path=` |
| Attach screenshot | `POST /milestones/{id}/screenshots` (raw image body) |
| Fork | `POST /milestones/{id}/fork` `{ to_project_id, label }` |

Findings are plain-English first: `plain_title`, `plain_explain`, `fix_text`,
then machine fields (`kind`, `severity`, `cve_id`, `fixed_version`).
Severities: `critical | high | medium | low`. Kinds:
`secret | practice | unused_dep | cve`.

## Roles

Platform admin manages users, groups, spaces and settings. Inside a space:
**Owner** (members + everything), **Coder** (create projects, push),
**Reader** (browse only). A principal is a user or a group; the higher grant
wins. Blocked users fail every authenticated route.
