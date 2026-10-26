# Documentation Rule

Documentation lives in two places with no overlap. Every change updates whichever of the two it affects before the work is considered done.

| Kind | Audience | Location |
|------|----------|----------|
| **Developer docs** | People working on this codebase | `doc/internal-dev-doc/` in this repo |
| **Product docs** | Customers: end users, admins, operators, API consumers | `~/Documents/GitHub/docs-site/depotex/` (separate repo) |

Product docs never live in this repo, and developer docs never go on docs-site.

## Which one to update

| Change | Developer docs | Product docs |
|--------|:-:|:-:|
| Architecture, package layout, module wiring, internal APIs, library usage | ✓ | |
| How to build, run, test or debug the code | ✓ | |
| Known gaps, design decisions, internal conventions | ✓ | |
| New or changed feature a user or admin can see or configure | | ✓ |
| New or changed screen | | ✓ screenshot (`SHOT`) where possible |
| Public REST/WebSocket API, permissions, license tiers | | ✓ |
| Environment variables an operator sets | | ✓ |
| Behavior fix a user would notice | | ✓ changelog line |
| New or changed event (`events.Define`) | ✓ catalog regenerated, feature guide lists it | ✓ events reference, feature page (see `event-hooks.md`) |
| Refactor, tests, internal-only fix | ✓ if it changes how code is organised | |

A feature usually needs both: developer docs for how it's built, product docs for how it's used.

Every new feature is also checked for events (the checklist in `event-hooks.md`): if it raises or changes one, both doc sets are updated.

## Developer docs — `doc/internal-dev-doc/`

- One folder per area, each with a `README.md` (`scheduler/`, `api-tokens/`, `common-lib/<package>/`, `platform-modules/`, …). Add a folder for a new area, and a row for it in `doc/internal-dev-doc/README.md` (the index).
- Every new developer doc starts from `doc/internal-dev-doc/TEMPLATE.md` and keeps its sections in this order: title `# <Area> — Developer Guide`, one-paragraph intro, `Quick Start`, `Architecture`, `Package Structure`, `API Reference`, `Configuration`, `Cluster Behavior`, `Do's`, `Don'ts`, `Known Gaps & Limitations`, `Testing`. Drop sections that don't apply; add area-specific sections (`Database Schema`, `Job Types`, …) between `API Reference` and `Configuration`. Don't rename the standard ones.
- When substantially rewriting an existing doc, bring it onto the template. Small edits don't require restructuring.
- `file:line` pointers into `apps/` and `libs/` are welcome; use repo-relative links so they open from the viewer.
- Keep `known-gaps/README.md` current: remove gaps that are fixed, add ones found.
- Rules in `.claude/rules/` state *what must be true*; developer docs explain *how the code does it*. Don't duplicate rules into docs.
- Developer docs may list the configuration needed to run and test locally; the operator-facing reference for configuration belongs in product docs.
- Browse and search them locally with `make docs` (http://127.0.0.1:8765) — see `doc/viewer/README.md`.

## Product docs — docs-site

- Source: `docs-site/depotex/_build/content.py` and the `content_*.py` modules it imports. Edit these, never the generated HTML.
- Build: `python3 ~/Documents/GitHub/docs-site/depotex/_build/build.py`
- Block syntax: see `docs-site/timesheets/_build/README.md` (`P`, `H`, `UL`, `OL`, `STEPS`, `TABLE`, `NOTE`, `WARN`, `CODE`, `SHOT`).
- Write for the reader of the product: where it is in the UI, what it does, what it needs (license tier, permission, Redis). No internal package names.
- **Screenshots, where possible.** A new or changed screen gets a `SHOT("<page>-<subject>.png", "What it shows")` next to the text that describes it (kebab-case file name, one subject per shot), and the image saved as `docs-site/depotex/assets/<file>`. A changed screen replaces its existing image under the same name.
  - Take it yourself whenever the screen can be shown: the running local install, or a harness page with fictional data for a plugin screen (as the plugin's own tests render it). Light theme, about 1440px wide (an extra shot for dark mode or a phone only when that is the point), cropped to the part the text talks about.
  - Fictional data only: no real people, email addresses, hostnames, tokens, keys or other secrets in the image.
  - When it can't be taken (it needs a sign-in, licence or service you don't have), add the `SHOT` anyway: the page shows a placeholder and `SCREENSHOTS.md` lists it as work to do. Say in your summary which shots are still missing.
- Changelog (`docs/changelog.html`): only changes people using or running Depotex notice; internal changes never go in. Add a line at the top of `CHANGELOG` in `content.py` (the `changelog` page) for each change a user or operator notices, dated the day it lands: `(YYYY-MM-DD, "Feature", "One-sentence change")`. The **Initial release** table describes the first release and stays as it is: a new feature gets its dated line, not a row folded into that table.
- The `depotex/` folder is committed in docs-site but unlisted until launch: don't link it from the homepage, `assets/nav.js` (`tools/gen_nav.py`), the sitemap or the `llms` files. Its pages are reached only by their address.
- Commit and push docs-site only when asked, and only `depotex/` paths (other products' work is often uncommitted there; leave it alone). Skip `__pycache__`. When the local `main` is behind or has other changes, commit from a clean worktree of `origin/main` instead of pulling over them.

## Enforcement

`.claude/hooks/docs-sync-check.sh` runs as a Stop hook (configured in `.claude/settings.local.json`). It blocks stopping when files under `apps/`, `libs/` or `migrations/` (tests excluded) were modified after the docs, checking developer docs and product docs separately. If a change genuinely needs no update to one of them, `touch` that side's marker as the hook message says.
