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

Every admin-editable value (zip limits, token TTLs, session length, SMTP,
public URL) lives under **Admin → Settings** and takes effect immediately.

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
