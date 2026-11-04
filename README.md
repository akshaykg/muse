# VibeForge — artifactory for AI-built projects

A Nexus-style artifactory built only for vibe coders. Projects are stored as
**milestones** (zip + scan + survey notes), never as git history. Push from
any AI tool with the VibeForge skill; browse, fix and fork from the web UI.

- **Backend:** Rust (Axum) workspace — `crates/domain` (rules), `crates/scanner` (zip safety + scans + OSV), `crates/api` (server, `vibeforge-server`)
- **Frontend:** React + TypeScript + Tailwind CSS v4 in `web/`
- **Skill:** `skill/SKILL.md` (any SKILL.md-compatible AI tool)
- **Open standard:** `spec/vibe-artifact-1.0.md` — any client/server can interoperate

## Run it (two terminals)

```bash
# 1 — backend (needs a Rust toolchain: https://rustup.rs)
export PATH="$HOME/.cargo/bin:$PATH"
cargo run -p api
# → http://localhost:8080  (health: GET /health)

# 2 — frontend
cd web && npm install && npm run dev
# → http://localhost:5173
```

Sign in with `admin@vibeforge.local` / `admin12345` (first boot only; set
`ADMIN_EMAIL` / `ADMIN_PASSWORD` / `JWT_SECRET` / ` DATA_DIR` to change).
In production the server also serves `web/dist` (`npm run build`) and
`/skill/SKILL.md` itself — one binary, port 8080.

## First five minutes

1. **Admin** → create people (and a group if you want team roles).
2. **Spaces** → create a space; as Space Owner give a person *or a group* a role: Owner / Coder / Reader.
3. Inside the project, use the skill or the upload box to save milestone #1.
4. Open **Findings** (what to fix, in plain words) and **Fix it** (copy-paste fixes).
5. **Profile** → create an API token, download `SKILL.md`, connect your AI tool.

## Connect an AI tool with MCP

VibeForge is also an MCP server at `POST /mcp` (Streamable HTTP, JSON
responses). Create an API token under **Profile**, then:

```bash
claude mcp add --transport http vibeforge http://localhost:8080/mcp \
  --header "Authorization: Bearer vatt_…"
```

Other clients use the same URL and header in their `mcp.json`. Tools:
`list_projects`, `list_milestones`, `push_milestone`, `get_findings`,
`restore_milestone`. To revert a local folder, open a milestone and use
**Restore this milestone locally** (or `GET /api/v1/milestones/{id}/download`).

Every admin-editable value (zip limits, token TTLs, session length, SMTP,
public URL) lives under **Admin → Settings** and takes effect immediately.

## Git setup (with Meta Muse)

Milestones are the big saves; Git keeps every small step. VibeForge asks people
to use both and writes the fiddly parts for them.

- **Admin → Settings → Git:** turn the "Use Git with this project" prompt on or
  off, set the team's Git host, org URL, default branch and HTTPS/SSH, choose the
  hooks every project gets (block secrets, block large files, lint/format, tests
  before push, clear commit messages, no direct pushes to `main`), extra team
  pre-commit commands and the lines every `.gitignore` must have.
- **Profile → Your Git details:** name, email and host username, used to write
  `git config` and remote URLs you can paste as-is.
- **Milestone → Git tab:** a `.gitignore` and `.githooks/` made for that project,
  the files it keeps out of Git, secrets that would be committed today, and one
  `vibeforge-git-setup.sh` that sets it all up. "Tailor with Muse" sends only the
  file list and a few masked manifest files to the AI review model (same key).
  Muse proposes lint/format/test commands; VibeForge builds the hook scripts itself
  and refuses commands with `;`, redirects, `$(` or downloads.

## AI review (Meta Muse)

Every milestone has an **✦ AI review** tab. Meta Muse reads the code and lists,
in plain words, what pattern scanners and OSV miss: secrets hiding in context
(keys in frontend code, passwords in logs), missing auth checks, injection,
unsafe defaults and bad habits. Each item has "why it matters", fix steps and a
ready-to-paste prompt for your AI coding tool, plus one "fix everything" prompt.

- **Set up:** Admin → Settings → **AI review**. Paste a Meta Model API key
  (dev.meta.ai), press *Test connection*, pick a model (Muse Spark 1.3 by
  default; 1.2, 1.1, Wonder 1.0, Contributor variants or any id), save.
  Or start the server with `MODEL_API_KEY=... cargo run -p api`.
- **Safety:** secret-looking values are replaced with `[MASKED:kind:Nchars]`
  before code leaves the server; lockfiles, builds and binaries are never
  sent. The key is stored sealed (AES-GCM) in `data/db.json`, shown only as
  `••••last4`, and never sent to browsers. Never commit a key: `.env` and
  `data/` are git-ignored.
- **Who can run it:** Owners and Coders of the space. Results are saved per milestone.
- **How it looks:** screenshots are shown big at the top of every milestone
  (not in a tab). When a push has no screenshot, Muse reads the screen code
  about 20 s later and sketches the app as static HTML, shown in a sandboxed
  iframe (no scripts, CSP `default-src 'none'`) and labelled "AI preview".
  Turn it off under Admin → AI review → Screenshots; "Sketch it with Muse"
  makes one on demand.
- **Provider:** any OpenAI-compatible `/chat/completions` endpoint
  (Advanced → provider URL; default `https://api.meta.ai/v1`).

## Layout

```
crates/domain   RBAC, settings, manifest — no I/O
crates/scanner  safe unzip, secrets, bad practices, unused deps, OSV CVEs (7 languages)
crates/api      HTTP API, blob store (data/), auth (JWT + vatt_ tokens)
web/            React UI (login, spaces, projects, milestones, profile, admin)
skill/          SKILL.md installed into the user's AI tool
spec/           vibe-artifact/1.0 open standard
data/           runtime store (db.json + content-addressed blobs), git-ignored
```

Supported scan languages: JavaScript/TypeScript, Python, Go, Rust, Java, PHP,
Ruby. CVE data comes from the OSV API (`POST /v1/querybatch`); if OSV is
unreachable the milestone still saves.

## Test

```bash
cargo test        # RBAC matrix, token hashing, zip-bomb/traversal, secret scan
cd web && npx tsc --noEmit
```
