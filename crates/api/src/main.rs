//! VibeForge server — a Nexus-style artifactory for AI-built projects.
//! The versioned unit is a Milestone (zip + manifest + scan), never a git commit.
//! Storage is a JSON file + content-addressed blobs so the demo runs with
//! zero setup; the Store methods are the seam where Postgres slots in.

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::Argon2;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use chrono::Utc;
use domain::*;
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;

// ------------------------------------------------------------------ store

#[derive(Default, Serialize, Deserialize)]
pub struct Store {
    pub users: HashMap<String, User>,
    pub groups: HashMap<String, Group>,
    pub spaces: HashMap<String, Space>,
    pub members: Vec<SpaceMember>,
    pub projects: HashMap<String, Project>,
    pub milestones: HashMap<String, Milestone>,
    pub files: Vec<StoredFile>,
    pub findings: HashMap<String, Finding>,
    pub todos: Vec<TodoItem>,
    pub tokens: HashMap<String, ApiToken>,
    pub settings: Settings,
    pub audit: Vec<AuditEntry>,
}

pub struct AppState {
    pub store: RwLock<Store>,
    pub data_dir: PathBuf,
    pub jwt_secret: String,
}

type Shared = Arc<AppState>;

fn now() -> String {
    Utc::now().to_rfc3339()
}
fn new_id(prefix: &str) -> String {
    format!("{prefix}-{}", uuid::Uuid::new_v4())
}
fn slugify(s: &str) -> String {
    s.to_lowercase().chars().map(|c| if c.is_alphanumeric() { c } else { '-' }).collect::<String>()
        .split('-').filter(|p| !p.is_empty()).collect::<Vec<_>>().join("-")
}
fn hash_password(pw: &str) -> String {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default().hash_password(pw.as_bytes(), &salt).unwrap().to_string()
}
fn verify_password(pw: &str, hash: &str) -> bool {
    match PasswordHash::new(hash) {
        Ok(h) => Argon2::default().verify_password(pw.as_bytes(), &h).is_ok(),
        Err(_) => false,
    }
}
fn hash_token(raw: &str) -> String {
    scanner::sha256_hex(raw.as_bytes())
}

async fn persist(state: &Shared) {
    let store = state.store.read().await;
    let path = state.data_dir.join("db.json");
    if let Ok(text) = serde_json::to_string(&*store) {
        let _ = tokio::fs::write(&path, text).await;
    }
}

async fn audit(state: &Shared, actor: &str, action: &str, rtype: &str, rid: &str, outcome: &str) {
    let mut s = state.store.write().await;
    s.audit.push(AuditEntry {
        id: new_id("aud"), actor_id: actor.into(), action: action.into(),
        resource_type: rtype.into(), resource_id: rid.into(),
        outcome: outcome.into(), created_at: now(),
    });
}

// ------------------------------------------------------------------ auth

#[derive(Serialize, Deserialize)]
struct Claims {
    sub: String,
    exp: usize,
    iat: usize,
}

fn make_jwt(state: &Shared, user_id: &str, hours: i64) -> String {
    let now_s = Utc::now().timestamp() as usize;
    let claims = Claims { sub: user_id.into(), exp: now_s + (hours.max(1) * 3600) as usize, iat: now_s };
    jsonwebtoken::encode(
        &jsonwebtoken::Header::default(),
        &claims,
        &jsonwebtoken::EncodingKey::from_secret(state.jwt_secret.as_bytes()),
    ).unwrap_or_default()
}

#[derive(Clone)]
pub struct Authed(pub User);

async fn authenticate(state: &Shared, headers: &HeaderMap) -> Result<Authed, StatusCode> {
    let raw = headers.get("authorization").and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ")).ok_or(StatusCode::UNAUTHORIZED)?.to_string();
    let store = state.store.read().await;
    if let Some(tok) = raw.strip_prefix("vatt_") {
        let _ = tok;
        let hashed = hash_token(&raw);
        let token = store.tokens.values()
            .find(|t| t.token_hash == hashed && t.revoked_at.is_none())
            .ok_or(StatusCode::UNAUTHORIZED)?;
        if let Some(exp) = &token.expires_at {
            if exp.as_str() < now().as_str() { return Err(StatusCode::UNAUTHORIZED); }
        }
        let user = store.users.get(&token.user_id).cloned().ok_or(StatusCode::UNAUTHORIZED)?;
        if user.is_blocked { return Err(StatusCode::FORBIDDEN); }
        return Ok(Authed(user));
    }
    let data = jsonwebtoken::decode::<Claims>(
        &raw,
        &jsonwebtoken::DecodingKey::from_secret(state.jwt_secret.as_bytes()),
        &jsonwebtoken::Validation::default(),
    ).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let user = store.users.get(&data.claims.sub).cloned().ok_or(StatusCode::UNAUTHORIZED)?;
    if user.is_blocked { return Err(StatusCode::FORBIDDEN); }
    Ok(Authed(user))
}

macro_rules! auth {
    ($state:expr, $headers:expr) => {
        match authenticate($state, $headers).await {
            Ok(a) => a,
            Err(c) => return c.into_response(),
        }
    };
}

fn err(status: StatusCode, msg: &str) -> Response {
    (status, Json(serde_json::json!({ "error": msg }))).into_response()
}

/// Effective role: direct grant wins over group grant; platform admin = Owner everywhere.
fn space_role(store: &Store, user: &User, space_id: &str) -> Option<SpaceRole> {
    if user.is_platform_admin { return Some(SpaceRole::Owner); }
    let mut best: Option<SpaceRole> = None;
    for m in &store.members {
        if m.space_id != space_id { continue; }
        let hit = if m.principal_kind == "user" {
            m.principal_id == user.id
        } else {
            store.groups.get(&m.principal_id).map(|g| g.member_ids.contains(&user.id)).unwrap_or(false)
        };
        if hit && best.map(|b| m.role.rank() > b.rank()).unwrap_or(true) {
            best = Some(m.role);
        }
    }
    best
}

fn can_read_project(store: &Store, user: &User, project_id: &str) -> Option<Project> {
    let p = store.projects.get(project_id)?.clone();
    space_role(store, user, &p.space_id)?;
    Some(p)
}

#[derive(Deserialize)]
struct LoginBody { email: String, password: String }

async fn login(State(state): State<Shared>, Json(body): Json<LoginBody>) -> Response {
    let store = state.store.read().await;
    let user = store.users.values().find(|u| u.email.eq_ignore_ascii_case(&body.email)).cloned();
    drop(store);
    let Some(user) = user else { return err(StatusCode::UNAUTHORIZED, "Wrong email or password."); };
    if user.is_blocked {
        return err(StatusCode::FORBIDDEN, "This account is blocked. Contact your admin.");
    }
    if !verify_password(&body.password, &user.password_hash) {
        return err(StatusCode::UNAUTHORIZED, "Wrong email or password.");
    }
    let hours = state.store.read().await.settings.session_hours;
    let token = make_jwt(&state, &user.id, hours);
    audit(&state, &user.id, "auth:login", "user", &user.id, "success").await;
    Json(serde_json::json!({ "token": token, "user": PublicUser::from(&user) })).into_response()
}

async fn me(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    let mut spaces: Vec<_> = store.spaces.values().filter_map(|sp| {
        space_role(&store, &a.0, &sp.id).map(|role| serde_json::json!({
            "id": sp.id, "slug": sp.slug, "name": sp.name, "role": role
        }))
    }).collect();
    spaces.sort_by(|x, y| x["name"].as_str().cmp(&y["name"].as_str()));
    Json(serde_json::json!({
        "user": PublicUser::from(&a.0), "spaces": spaces,
        "skill_url": "/skill/SKILL.md"
    })).into_response()
}

async fn my_projects(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    let mut out: Vec<_> = store.projects.values()
        .filter(|p| space_role(&store, &a.0, &p.space_id).is_some())
        .map(|p| serde_json::json!({
            "id": p.id, "space_id": p.space_id, "slug": p.slug, "name": p.name,
            "milestones": store.milestones.values().filter(|m| m.project_id == p.id).count()
        })).collect();
    out.sort_by(|x, y| x["name"].as_str().cmp(&y["name"].as_str()));
    Json(out).into_response()
}

// ---------------------------------------------------------------- tokens

#[derive(Deserialize)]
struct CreateTokenBody { name: String, #[serde(default)] scopes: Vec<String>, ttl_days: Option<i64> }

async fn create_token(State(state): State<Shared>, headers: HeaderMap, Json(body): Json<CreateTokenBody>) -> Response {
    let a = auth!(&state, &headers);
    let raw = format!("vatt_{}", uuid::Uuid::new_v4().simple());
    let settings = state.store.read().await.settings.clone();
    let mut store = state.store.write().await;
    let active = store.tokens.values().filter(|t| t.user_id == a.0.id && t.revoked_at.is_none()).count();
    if active >= settings.max_active_tokens_per_user {
        return err(StatusCode::BAD_REQUEST, "Too many active tokens. Revoke one first.");
    }
    let ttl = body.ttl_days.unwrap_or(settings.token_default_ttl_days);
    let expires = if ttl > 0 { Some((Utc::now() + chrono::Duration::days(ttl)).to_rfc3339()) } else { None };
    let token = ApiToken {
        id: new_id("tok"), user_id: a.0.id.clone(), name: body.name,
        prefix: raw.chars().take(12).collect(), token_hash: hash_token(&raw),
        scopes: if body.scopes.is_empty() { vec!["read".into(), "push".into()] } else { body.scopes },
        last_used_at: None, expires_at: expires, revoked_at: None, created_at: now(),
    };
    let id = token.id.clone();
    store.tokens.insert(id.clone(), token);
    drop(store);
    persist(&state).await;
    audit(&state, &a.0.id, "token:create", "token", &id, "success").await;
    // Raw token returned exactly once — only its hash is kept.
    Json(serde_json::json!({ "id": id, "token": raw,
        "note": "Copy this now. It will not be shown again. Keep it secret like a password." })).into_response()
}

async fn list_tokens(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    let mut out: Vec<_> = store.tokens.values().filter(|t| t.user_id == a.0.id).map(|t| serde_json::json!({
        "id": t.id, "name": t.name, "prefix": t.prefix, "scopes": t.scopes,
        "last_used_at": t.last_used_at, "expires_at": t.expires_at,
        "revoked": t.revoked_at.is_some(), "created_at": t.created_at
    })).collect();
    out.sort_by(|x, y| y["created_at"].as_str().cmp(&x["created_at"].as_str()));
    Json(out).into_response()
}

async fn revoke_token(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    let mut store = state.store.write().await;
    let Some(t) = store.tokens.get_mut(&id) else { return err(StatusCode::NOT_FOUND, "Token not found."); };
    if t.user_id != a.0.id && !a.0.is_platform_admin { return err(StatusCode::FORBIDDEN, "Not your token."); }
    t.revoked_at = Some(now());
    drop(store);
    persist(&state).await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

// ---------------------------------------------------------------- spaces

#[derive(Deserialize)]
struct CreateSpaceBody { name: String }

async fn list_spaces(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    let mut out: Vec<_> = store.spaces.values().filter_map(|sp| {
        space_role(&store, &a.0, &sp.id).map(|role| {
            let project_ids: Vec<&String> = store.projects.values().filter(|p| p.space_id == sp.id).map(|p| &p.id).collect();
            let space_milestones: Vec<&Milestone> = store.milestones.values().filter(|m| project_ids.contains(&&m.project_id)).collect();
            let open: Vec<&Finding> = store.findings.values().filter(|f| f.status == "open"
                && store.milestones.get(&f.milestone_id).map(|m| project_ids.contains(&&m.project_id)).unwrap_or(false)).collect();
            serde_json::json!({
                "id": sp.id, "slug": sp.slug, "name": sp.name, "role": role,
                "projects": project_ids.len(),
                "milestones": space_milestones.len(),
                "members": store.members.iter().filter(|m| m.space_id == sp.id).count(),
                "open_findings": open.len(),
                "vulnerabilities": open.iter().filter(|f| f.kind == "cve").count(),
                "last_activity": space_milestones.iter().map(|m| m.created_at.clone()).max()
            })
        })
    }).collect();
    out.sort_by(|x, y| x["name"].as_str().cmp(&y["name"].as_str()));
    Json(out).into_response()
}

async fn create_space(State(state): State<Shared>, headers: HeaderMap, Json(body): Json<CreateSpaceBody>) -> Response {
    let a = auth!(&state, &headers);
    if !a.0.is_platform_admin { return err(StatusCode::FORBIDDEN, "Only admins can create spaces."); }
    let space = Space { id: new_id("spc"), slug: slugify(&body.name), name: body.name, created_by: a.0.id.clone() };
    let id = space.id.clone();
    let mut store = state.store.write().await;
    // Creator becomes Owner so the space is usable immediately.
    store.members.push(SpaceMember { space_id: id.clone(), principal_kind: "user".into(), principal_id: a.0.id.clone(), role: SpaceRole::Owner });
    store.spaces.insert(id.clone(), space);
    drop(store);
    persist(&state).await;
    audit(&state, &a.0.id, "space:create", "space", &id, "success").await;
    (StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response()
}

#[derive(Deserialize)]
struct AddMemberBody { principal_kind: String, principal_id: String, role: SpaceRole }

async fn add_member(State(state): State<Shared>, headers: HeaderMap, Path(space_id): Path<String>, Json(body): Json<AddMemberBody>) -> Response {
    let a = auth!(&state, &headers);
    {
        let store = state.store.read().await;
        match space_role(&store, &a.0, &space_id) {
            Some(r) if r.can_manage_members() => {}
            _ => return err(StatusCode::FORBIDDEN, "Only a Space Owner can change members."),
        }
        if body.principal_kind == "user" && !store.users.contains_key(&body.principal_id) {
            return err(StatusCode::BAD_REQUEST, "That user does not exist.");
        }
        if body.principal_kind == "group" && !store.groups.contains_key(&body.principal_id) {
            return err(StatusCode::BAD_REQUEST, "That group does not exist.");
        }
    }
    let mut store = state.store.write().await;
    store.members.retain(|m| !(m.space_id == space_id && m.principal_kind == body.principal_kind && m.principal_id == body.principal_id));
    store.members.push(SpaceMember { space_id: space_id.clone(), principal_kind: body.principal_kind, principal_id: body.principal_id, role: body.role });
    drop(store);
    persist(&state).await;
    audit(&state, &a.0.id, "space:member", "space", &space_id, "success").await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

async fn list_members(State(state): State<Shared>, headers: HeaderMap, Path(space_id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    if space_role(&store, &a.0, &space_id).is_none() { return err(StatusCode::FORBIDDEN, "Not a member of this space."); }
    let out: Vec<_> = store.members.iter().filter(|m| m.space_id == space_id).map(|m| {
        let label = if m.principal_kind == "user" {
            store.users.get(&m.principal_id).map(|u| u.display_name.clone()).unwrap_or_else(|| m.principal_id.clone())
        } else {
            store.groups.get(&m.principal_id).map(|g| g.name.clone()).unwrap_or_else(|| m.principal_id.clone())
        };
        serde_json::json!({ "principal_kind": m.principal_kind, "principal_id": m.principal_id, "label": label, "role": m.role })
    }).collect();
    Json(out).into_response()
}

#[derive(Deserialize)]
struct CreateProjectBody { name: String }

async fn create_project(State(state): State<Shared>, headers: HeaderMap, Path(space_id): Path<String>, Json(body): Json<CreateProjectBody>) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    match space_role(&store, &a.0, &space_id) {
        Some(r) if r.can_create_project() => {}
        _ => return err(StatusCode::FORBIDDEN, "Your role in this space cannot create projects."),
    }
    drop(store);
    let project = Project { id: new_id("prj"), space_id, slug: slugify(&body.name), name: body.name, visibility: "space".into() };
    let id = project.id.clone();
    state.store.write().await.projects.insert(id.clone(), project);
    persist(&state).await;
    audit(&state, &a.0.id, "project:create", "project", &id, "success").await;
    (StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response()
}

async fn list_projects(State(state): State<Shared>, headers: HeaderMap, Path(space_id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    if space_role(&store, &a.0, &space_id).is_none() { return err(StatusCode::FORBIDDEN, "Not a member of this space."); }
    let out: Vec<_> = store.projects.values().filter(|p| p.space_id == space_id).map(|p| {
        let pms: Vec<&Milestone> = store.milestones.values().filter(|m| m.project_id == p.id).collect();
        let mut langs: Vec<String> = Vec::new();
        for m in &pms { for l in &m.languages { if !langs.contains(l) { langs.push(l.clone()); } } }
        serde_json::json!({
            "id": p.id, "slug": p.slug, "name": p.name,
            "milestones": pms.len(),
            "languages": langs,
            "last_activity": pms.iter().map(|m| m.created_at.clone()).max(),
            "open_findings": store.findings.values().filter(|f| f.status == "open"
                && store.milestones.get(&f.milestone_id).map(|m| m.project_id == p.id).unwrap_or(false)).count(),
            "vulnerabilities": store.findings.values().filter(|f| f.status == "open" && f.kind == "cve"
                && store.milestones.get(&f.milestone_id).map(|m| m.project_id == p.id).unwrap_or(false)).count()
        })
    }).collect();
    Json(out).into_response()
}

async fn get_project(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    let Some(p) = can_read_project(&store, &a.0, &id) else { return err(StatusCode::NOT_FOUND, "Project not found."); };
    let mut ms: Vec<_> = store.milestones.values().filter(|m| m.project_id == id).collect();
    ms.sort_by_key(|m| m.seq_no);
    let project_findings: Vec<&Finding> = store.findings.values().filter(|f| f.status == "open"
        && store.milestones.get(&f.milestone_id).map(|m| m.project_id == id).unwrap_or(false)).collect();
    let mut lang_set: Vec<String> = Vec::new();
    for m in ms.iter() { for l in &m.languages { if !lang_set.contains(l) { lang_set.push(l.clone()); } } }
    let last_push = ms.iter().map(|m| m.created_at.clone()).max();
    Json(serde_json::json!({
        "project": { "id": p.id, "space_id": p.space_id, "slug": p.slug, "name": p.name },
        "summary": {
            "languages": lang_set,
            "milestones": ms.len(),
            "open_findings": project_findings.len(),
            "vulnerabilities": project_findings.iter().filter(|f| f.kind == "cve").count(),
            "secrets": project_findings.iter().filter(|f| f.kind == "secret").count(),
            "fix_now": project_findings.iter().filter(|f| f.severity == "critical" || f.severity == "high").count(),
            "fix_soon": project_findings.iter().filter(|f| f.severity == "medium").count(),
            "good_to_know": project_findings.iter().filter(|f| f.severity == "low").count(),
            "last_push": last_push
        },
        "milestones": ms.iter().map(|m| serde_json::json!({
            "id": m.id, "seq_no": m.seq_no, "label": m.label, "scan_status": m.scan_status,
            "languages": m.languages,
            "created_at": m.created_at, "screenshots": m.screenshots,
            "findings": store.findings.values().filter(|f| f.milestone_id == m.id && f.status == "open").count()
        })).collect::<Vec<_>>()
    })).into_response()
}

// ------------------------------------------------------------ milestones

fn header_str(headers: &HeaderMap, name: &str) -> String {
    headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("").to_string()
}

/// Push a milestone: raw zip body. Headers: X-Milestone-Label, X-About, X-Stage.
/// The skill sends exactly this; the web UI uses the same route.
async fn push_milestone(State(state): State<Shared>, headers: HeaderMap, Path(project_id): Path<String>, body: Bytes) -> Response {
    let a = auth!(&state, &headers);
    let (project, settings) = {
        let store = state.store.read().await;
        let Some(p) = store.projects.get(&project_id).cloned() else {
            return err(StatusCode::NOT_FOUND, "Project not found.");
        };
        match space_role(&store, &a.0, &p.space_id) {
            Some(r) if r.can_push_milestone() => {}
            _ => return err(StatusCode::FORBIDDEN, "Your role cannot push milestones."),
        }
        (p, store.settings.clone())
    };
    if body.is_empty() { return err(StatusCode::BAD_REQUEST, "Send a zip file as the request body."); }

    let milestone_id = new_id("ms");
    let tmp = state.data_dir.join("tmp").join(&milestone_id);
    let _ = tokio::fs::create_dir_all(&tmp).await;
    let extract = {
        let bytes = body.to_vec();
        let dest = tmp.clone();
        let limits = settings.zip_limits();
        tokio::task::spawn_blocking(move || scanner::extract_zip_safely(&bytes, &dest, &limits)).await
    };
    let files = match extract {
        Ok(Ok(f)) => f,
        Ok(Err(e)) => {
            let _ = tokio::fs::remove_dir_all(&tmp).await;
            return err(StatusCode::BAD_REQUEST, &format!("Upload rejected: {e}"));
        }
        Err(_) => return err(StatusCode::INTERNAL_SERVER_ERROR, "Scan worker failed."),
    };

    // Blob-store the original zip + index every file for browsing without unzip.
    let blob_key = format!("blobs/{}/{}.zip", &project.id, scanner::sha256_hex(&body));
    let blob_path = state.data_dir.join(&blob_key);
    if let Some(parent) = blob_path.parent() { let _ = tokio::fs::create_dir_all(parent).await; }
    let _ = tokio::fs::write(&blob_path, &body).await;

    // Open-standard manifest: vibe/manifest.json wins, headers are the fallback.
    let mut manifest = ArtifactManifest::default();
    manifest.project = project.slug.clone();
    manifest.label = header_str(&headers, "x-milestone-label");
    manifest.about = header_str(&headers, "x-about");
    manifest.stage = { let s = header_str(&headers, "x-stage"); if s.is_empty() { "building".into() } else { s } };
    if let Ok(text) = tokio::fs::read_to_string(tmp.join("vibe/manifest.json")).await {
        if let Ok(parsed) = serde_json::from_str::<ArtifactManifest>(&text) { manifest = parsed; }
    }
    if manifest.label.is_empty() { manifest.label = format!("Milestone pushed {}", now()); }

    // Copy extracted files into the blob store, hash each one.
    let mut stored: Vec<StoredFile> = Vec::new();
    for f in &files {
        let rel = f.strip_prefix(&tmp).unwrap_or(f).to_string_lossy().replace('\\', "/");
        let bytes = tokio::fs::read(f).await.unwrap_or_default();
        let key = format!("files/{}/{}", milestone_id, scanner::sha256_hex(&bytes));
        let dest = state.data_dir.join(&key);
        if let Some(parent) = dest.parent() { let _ = tokio::fs::create_dir_all(parent).await; }
        let _ = tokio::fs::write(&dest, &bytes).await;
        stored.push(StoredFile { milestone_id: milestone_id.clone(), path: rel, blob_key: key, size_bytes: bytes.len() as u64, sha256: scanner::sha256_hex(&bytes) });
    }

    // SBOM (Syft) from the same manifests that feed OSV — stored in the milestone.
    let deps = scanner::collect_all_deps(&tmp);
    let (sbom_doc, sbom_pkgs, sbom_tool) = scanner::generate_sbom(&tmp, &deps, &project.slug);
    let sbom_bytes = serde_json::to_vec_pretty(&sbom_doc).unwrap_or_default();
    let sbom_key = format!("files/{}/{}", milestone_id, scanner::sha256_hex(&sbom_bytes));
    let sbom_dest = state.data_dir.join(&sbom_key);
    if let Some(parent) = sbom_dest.parent() { let _ = tokio::fs::create_dir_all(parent).await; }
    let _ = tokio::fs::write(&sbom_dest, &sbom_bytes).await;
    stored.push(StoredFile {
        milestone_id: milestone_id.clone(), path: "SBOM.json".into(),
        blob_key: sbom_key, size_bytes: sbom_bytes.len() as u64, sha256: scanner::sha256_hex(&sbom_bytes),
    });
    let _ = sbom_tool;

    // Scan: secrets + practices + unused deps + OSV CVEs (from SBOM packages).
    let mut findings = scanner::scan_secrets(&tmp, &milestone_id);
    findings.extend(scanner::scan_practices(&tmp, &milestone_id));
    if settings.unused_dep_check {
        findings.extend(scanner::scan_unused_deps(&tmp, &deps, &milestone_id));
    }
    findings.extend(scanner::query_osv(&deps, settings.osv_timeout_s, &milestone_id).await);
    let languages = scanner::count_languages(&tmp);

    // Todos come from TODO.md checkboxes the skill (or user) wrote.
    let mut todos: Vec<TodoItem> = Vec::new();
    if let Ok(text) = tokio::fs::read_to_string(tmp.join("TODO.md")).await {
        for line in text.lines() {
            let t = line.trim();
            if let Some(rest) = t.strip_prefix("- [ ]") {
                todos.push(TodoItem { id: new_id("todo"), milestone_id: milestone_id.clone(), body: rest.trim().into(), done: false, source: "survey".into() });
            } else if let Some(rest) = t.strip_prefix("- [x]") {
                todos.push(TodoItem { id: new_id("todo"), milestone_id: milestone_id.clone(), body: rest.trim().into(), done: true, source: "survey".into() });
            }
        }
    }
    // Critical secrets become a todo automatically — visible without opening Findings.
    for f in findings.iter().filter(|f| f.severity == "critical") {
        todos.push(TodoItem { id: new_id("todo"), milestone_id: milestone_id.clone(), body: f.plain_title.clone(), done: false, source: "scanner".into() });
    }

    let seq = {
        let store = state.store.read().await;
        store.milestones.values().filter(|m| m.project_id == project_id).map(|m| m.seq_no).max().unwrap_or(0) + 1
    };
    let milestone = Milestone {
        id: milestone_id.clone(), project_id: project_id.clone(), seq_no: seq,
        label: manifest.label.clone(), parent_milestone_id: None, blob_key,
        manifest, scan_status: "done".into(), languages: languages.clone(), created_by: a.0.id.clone(), created_at: now(), screenshots: Vec::new(),
    };
    {
        let mut store = state.store.write().await;
        store.milestones.insert(milestone_id.clone(), milestone);
        store.files.extend(stored);
        for f in findings.iter() { store.findings.insert(f.id.clone(), f.clone()); }
        store.todos.extend(todos.iter().cloned());
    }
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    persist(&state).await;
    audit(&state, &a.0.id, "milestone:push", "milestone", &milestone_id, "success").await;
    if settings.block_push_on_critical && findings.iter().any(|f| f.severity == "critical" && f.status == "open") {
        return (StatusCode::UNPROCESSABLE_ENTITY, Json(serde_json::json!({
            "milestone_id": milestone_id, "blocked": true,
            "message": "Saved, but your admin blocks milestones with critical secrets. Fix them and push again.",
            "findings": findings.len(), "sbom_packages": sbom_pkgs.len(), "languages": languages
        }))).into_response();
    }
    (StatusCode::CREATED, Json(serde_json::json!({
        "milestone_id": milestone_id, "seq_no": seq, "findings": findings.len(), "sbom_packages": sbom_pkgs.len(), "languages": languages
    }))).into_response()
}

async fn list_milestones(State(state): State<Shared>, headers: HeaderMap, Path(project_id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    if can_read_project(&store, &a.0, &project_id).is_none() { return err(StatusCode::NOT_FOUND, "Project not found."); }
    let mut ms: Vec<_> = store.milestones.values().filter(|m| m.project_id == project_id).collect();
    ms.sort_by_key(|m| m.seq_no);
    Json(ms.iter().map(|m| serde_json::json!({
        "id": m.id, "seq_no": m.seq_no, "label": m.label, "scan_status": m.scan_status,
        "created_at": m.created_at, "parent_milestone_id": m.parent_milestone_id, "screenshots": m.screenshots
    })).collect::<Vec<_>>()).into_response()
}

async fn get_milestone(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    let Some(m) = store.milestones.get(&id).cloned() else { return err(StatusCode::NOT_FOUND, "Milestone not found."); };
    if can_read_project(&store, &a.0, &m.project_id).is_none() { return err(StatusCode::FORBIDDEN, "No access to this project."); }
    let files: Vec<_> = store.files.iter().filter(|f| f.milestone_id == id)
        .map(|f| serde_json::json!({ "path": f.path, "size_bytes": f.size_bytes, "sha256": f.sha256 })).collect();
    let findings: Vec<_> = store.findings.values().filter(|f| f.milestone_id == id).cloned().collect();
    let todos: Vec<_> = store.todos.iter().filter(|t| t.milestone_id == id).cloned().collect();
    let sbom_key = store.files.iter().find(|f| f.milestone_id == id && f.path == "SBOM.json").map(|f| f.blob_key.clone());
    drop(store);
    let mut sbom_packages: Vec<serde_json::Value> = Vec::new();
    let mut sbom_tool = "vibeforge".to_string();
    if let Some(key) = sbom_key {
        if let Ok(bytes) = tokio::fs::read(state.data_dir.join(&key)).await {
            if let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&bytes) {
                sbom_tool = doc["descriptor"]["name"].as_str().unwrap_or("syft").to_string();
                if let Some(arts) = doc["artifacts"].as_array() {
                    sbom_packages = arts.iter().map(|a| serde_json::json!({
                        "name": a["name"], "version": a["version"], "type": a["type"],
                        "purl": a["purl"], "ecosystem": a["metadata"]["ecosystem"]
                    })).collect();
                }
            }
        }
    }
    let store = state.store.read().await;
    let Some(m) = store.milestones.get(&id).cloned() else { return err(StatusCode::NOT_FOUND, "Milestone not found."); };
    Json(serde_json::json!({
        "milestone": { "id": m.id, "project_id": m.project_id, "seq_no": m.seq_no, "label": m.label,
            "scan_status": m.scan_status, "created_at": m.created_at, "manifest": m.manifest,
            "screenshots": m.screenshots, "parent_milestone_id": m.parent_milestone_id },
        "files": files, "findings": findings, "todos": todos,
        "sbom": { "tool": sbom_tool, "total": sbom_packages.len(), "packages": sbom_packages }
    })).into_response()
}

#[derive(Deserialize)]
struct FileQuery { path: String }

async fn file_content(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>, Query(q): Query<FileQuery>) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    let Some(m) = store.milestones.get(&id) else { return err(StatusCode::NOT_FOUND, "Milestone not found."); };
    if can_read_project(&store, &a.0, &m.project_id).is_none() { return err(StatusCode::FORBIDDEN, "No access."); }
    let Some(f) = store.files.iter().find(|f| f.milestone_id == id && f.path == q.path) else {
        return err(StatusCode::NOT_FOUND, "File not found in this milestone.");
    };
    let key = f.blob_key.clone();
    drop(store);
    match tokio::fs::read(state.data_dir.join(&key)).await {
        Ok(bytes) if bytes.len() <= 512_000 => {
            match String::from_utf8(bytes) {
                Ok(text) => Json(serde_json::json!({ "path": q.path, "text": text })).into_response(),
                Err(_) => err(StatusCode::UNSUPPORTED_MEDIA_TYPE, "This file is not text and cannot be previewed."),
            }
        }
        Ok(_) => err(StatusCode::BAD_REQUEST, "File is too large to preview."),
        Err(_) => err(StatusCode::NOT_FOUND, "File data missing."),
    }
}

async fn milestone_findings(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    let Some(m) = store.milestones.get(&id) else { return err(StatusCode::NOT_FOUND, "Milestone not found."); };
    if can_read_project(&store, &a.0, &m.project_id).is_none() { return err(StatusCode::FORBIDDEN, "No access."); }
    let mut out: Vec<_> = store.findings.values().filter(|f| f.milestone_id == id).cloned().collect();
    out.sort_by(|x, y| x.severity.cmp(&y.severity));
    Json(out).into_response()
}

async fn ignore_finding(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    let mut store = state.store.write().await;
    let Some(f) = store.findings.get(&id) else { return err(StatusCode::NOT_FOUND, "Finding not found."); };
    let project_id = store.milestones.get(&f.milestone_id).map(|m| m.project_id.clone()).unwrap_or_default();
    if space_role(&store, &a.0, &store.projects.get(&project_id).map(|p| p.space_id.clone()).unwrap_or_default())
        .map(|r| r.can_push_milestone()).unwrap_or(false) == false && !a.0.is_platform_admin {
        return err(StatusCode::FORBIDDEN, "Your role cannot dismiss findings.");
    }
    store.findings.get_mut(&id).unwrap().status = "ignored".into();
    drop(store);
    persist(&state).await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct ForkBody { to_project_id: String, label: String }

async fn fork_milestone(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>, Json(body): Json<ForkBody>) -> Response {
    let a = auth!(&state, &headers);
    let mut store = state.store.write().await;
    let Some(src) = store.milestones.get(&id).cloned() else { return err(StatusCode::NOT_FOUND, "Milestone not found."); };
    let Some(dst_project) = store.projects.get(&body.to_project_id).cloned() else {
        return err(StatusCode::NOT_FOUND, "Target project not found.");
    };
    match space_role(&store, &a.0, &dst_project.space_id) {
        Some(r) if r.can_push_milestone() => {}
        _ => return err(StatusCode::FORBIDDEN, "Your role cannot fork into that project."),
    }
    let seq = store.milestones.values().filter(|m| m.project_id == body.to_project_id).map(|m| m.seq_no).max().unwrap_or(0) + 1;
    let forked_id = new_id("ms");
    let files: Vec<StoredFile> = store.files.iter().filter(|f| f.milestone_id == id)
        .map(|f| StoredFile { milestone_id: forked_id.clone(), ..f.clone() }).collect();
    let findings: Vec<Finding> = store.findings.values().filter(|f| f.milestone_id == id)
        .map(|f| { let mut c = f.clone(); c.id = new_id("find"); c.milestone_id = forked_id.clone(); c }).collect();
    let mut copy = src.clone();
    copy.id = forked_id.clone();
    copy.project_id = body.to_project_id.clone();
    copy.seq_no = seq;
    copy.label = body.label;
    copy.parent_milestone_id = Some(id.clone());
    copy.created_by = a.0.id.clone();
    copy.created_at = now();
    store.milestones.insert(forked_id.clone(), copy);
    store.files.extend(files);
    for f in findings { store.findings.insert(f.id.clone(), f); }
    drop(store);
    persist(&state).await;
    audit(&state, &a.0.id, "milestone:fork", "milestone", &forked_id, "success").await;
    (StatusCode::CREATED, Json(serde_json::json!({ "milestone_id": forked_id, "seq_no": seq }))).into_response()
}

async fn add_screenshot(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>, body: Bytes) -> Response {
    let a = auth!(&state, &headers);
    let (project_id, space_id) = {
        let store = state.store.read().await;
        let Some(m) = store.milestones.get(&id) else { return err(StatusCode::NOT_FOUND, "Milestone not found."); };
        let space_id = store.projects.get(&m.project_id).map(|p| p.space_id.clone()).unwrap_or_default();
        (m.project_id.clone(), space_id)
    };
    {
        let store = state.store.read().await;
        match space_role(&store, &a.0, &space_id) {
            Some(r) if r.can_push_milestone() => {}
            _ => return err(StatusCode::FORBIDDEN, "Your role cannot add screenshots."),
        }
        let _ = project_id;
    }
    if body.is_empty() || body.len() > 10 * 1024 * 1024 { return err(StatusCode::BAD_REQUEST, "Send one image (max 10 MB)."); }
    let name = { let n = header_str(&headers, "x-filename"); if n.is_empty() { "screenshot.png".into() } else { n } };
    let key = format!("shots/{}/{}-{}", id, scanner::sha256_hex(&body), name);
    let dest = state.data_dir.join(&key);
    if let Some(parent) = dest.parent() { let _ = tokio::fs::create_dir_all(parent).await; }
    let _ = tokio::fs::write(&dest, &body).await;
    let mut store = state.store.write().await;
    if let Some(m) = store.milestones.get_mut(&id) { m.screenshots.push(key.clone()); }
    drop(store);
    persist(&state).await;
    Json(serde_json::json!({ "key": key, "url": format!("/api/v1/blobs/{key}") })).into_response()
}

// ---------------------------------------------------------------- admin

fn require_admin(a: &Authed) -> Result<(), Response> {
    if a.0.is_platform_admin { Ok(()) } else { Err(err(StatusCode::FORBIDDEN, "Admins only.")) }
}

async fn admin_users(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let a = auth!(&state, &headers);
    if let Err(r) = require_admin(&a) { return r; }
    let store = state.store.read().await;
    let mut out: Vec<_> = store.users.values().map(|u| serde_json::json!({
        "id": u.id, "email": u.email, "display_name": u.display_name,
        "is_platform_admin": u.is_platform_admin, "is_blocked": u.is_blocked
    })).collect();
    out.sort_by(|x, y| x["email"].as_str().cmp(&y["email"].as_str()));
    Json(out).into_response()
}

#[derive(Deserialize)]
struct AdminCreateUser { email: String, display_name: String, password: String, #[serde(default)] is_platform_admin: bool }

async fn admin_create_user(State(state): State<Shared>, headers: HeaderMap, Json(body): Json<AdminCreateUser>) -> Response {
    let a = auth!(&state, &headers);
    if let Err(r) = require_admin(&a) { return r; }
    if body.password.len() < 8 { return err(StatusCode::BAD_REQUEST, "Password needs at least 8 characters."); }
    let mut store = state.store.write().await;
    if store.users.values().any(|u| u.email.eq_ignore_ascii_case(&body.email)) {
        return err(StatusCode::CONFLICT, "A user with that email already exists.");
    }
    let user = User {
        id: new_id("usr"), email: body.email.to_lowercase(), display_name: body.display_name,
        password_hash: hash_password(&body.password), is_platform_admin: body.is_platform_admin,
        is_blocked: false, blocked_reason: None, created_at: now(),
    };
    let id = user.id.clone();
    store.users.insert(id.clone(), user);
    drop(store);
    persist(&state).await;
    audit(&state, &a.0.id, "user:create", "user", &id, "success").await;
    (StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response()
}

#[derive(Deserialize)]
struct BlockBody { reason: String }

async fn admin_block(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>, Json(body): Json<BlockBody>) -> Response {
    let a = auth!(&state, &headers);
    if let Err(r) = require_admin(&a) { return r; }
    let mut store = state.store.write().await;
    let Some(u) = store.users.get_mut(&id) else { return err(StatusCode::NOT_FOUND, "User not found."); };
    u.is_blocked = true;
    u.blocked_reason = Some(body.reason);
    drop(store);
    persist(&state).await;
    audit(&state, &a.0.id, "user:block", "user", &id, "success").await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

async fn admin_unblock(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    if let Err(r) = require_admin(&a) { return r; }
    let mut store = state.store.write().await;
    let Some(u) = store.users.get_mut(&id) else { return err(StatusCode::NOT_FOUND, "User not found."); };
    u.is_blocked = false;
    u.blocked_reason = None;
    drop(store);
    persist(&state).await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct NudgeBody { message: String, project_id: Option<String> }

/// "Contact the member": leaves a todo on their latest milestone + audit row.
/// Email is sent when SMTP is configured in Settings; the todo always lands.
async fn admin_nudge(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>, Json(body): Json<NudgeBody>) -> Response {
    let a = auth!(&state, &headers);
    if let Err(r) = require_admin(&a) { return r; }
    let mut store = state.store.write().await;
    let target = store.milestones.values()
        .filter(|m| m.created_by == id)
        .filter(|m| body.project_id.as_deref().map(|p| m.project_id == p).unwrap_or(true))
        .max_by_key(|m| m.seq_no).map(|m| m.id.clone());
    let Some(mid) = target else { return err(StatusCode::NOT_FOUND, "That user has no milestones yet."); };
    store.todos.push(TodoItem { id: new_id("todo"), milestone_id: mid.clone(), body: format!("Message from admin: {}", body.message), done: false, source: "admin".into() });
    drop(store);
    persist(&state).await;
    audit(&state, &a.0.id, "user:nudge", "user", &id, "success").await;
    Json(serde_json::json!({ "ok": true, "milestone_id": mid,
        "note": "Added as a to-do on their latest milestone. Connect SMTP in Settings to also email it." })).into_response()
}

async fn admin_groups(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let a = auth!(&state, &headers);
    if let Err(r) = require_admin(&a) { return r; }
    let store = state.store.read().await;
    Json(store.groups.values().collect::<Vec<_>>()).into_response()
}

#[derive(Deserialize)]
struct CreateGroupBody { name: String, description: String, #[serde(default)] member_ids: Vec<String> }

async fn admin_create_group(State(state): State<Shared>, headers: HeaderMap, Json(body): Json<CreateGroupBody>) -> Response {
    let a = auth!(&state, &headers);
    if let Err(r) = require_admin(&a) { return r; }
    let group = Group { id: new_id("grp"), name: body.name, description: body.description, member_ids: body.member_ids };
    let id = group.id.clone();
    state.store.write().await.groups.insert(id.clone(), group);
    persist(&state).await;
    (StatusCode::CREATED, Json(serde_json::json!({ "id": id }))).into_response()
}

/// Fleet vulnerability view: every open CVE/secret across every project.
async fn admin_vulns(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let a = auth!(&state, &headers);
    if let Err(r) = require_admin(&a) { return r; }
    let store = state.store.read().await;
    let mut rows: Vec<_> = store.findings.values().filter(|f| f.status == "open").filter_map(|f| {
        let m = store.milestones.get(&f.milestone_id)?;
        let p = store.projects.get(&m.project_id)?;
        let owner = store.users.get(&m.created_by);
        Some(serde_json::json!({
            "finding_id": f.id, "kind": f.kind, "severity": f.severity, "title": f.plain_title,
            "package": f.package, "cve_id": f.cve_id, "fixed_version": f.fixed_version,
            "project_id": p.id, "project": p.name, "milestone_id": m.id,
            "owner_id": m.created_by, "owner": owner.map(|u| u.display_name.clone()).unwrap_or_default(),
            "owner_blocked": owner.map(|u| u.is_blocked).unwrap_or(false)
        }))
    }).collect();
    rows.sort_by(|x, y| x["severity"].as_str().cmp(&y["severity"].as_str()));
    let critical = rows.iter().filter(|r| r["severity"] == "critical").count();
    Json(serde_json::json!({ "total_open": rows.len(), "critical": critical, "rows": rows })).into_response()
}

async fn get_settings(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let a = auth!(&state, &headers);
    if let Err(r) = require_admin(&a) { return r; }
    let store = state.store.read().await;
    Json(serde_json::to_value(&store.settings).unwrap_or_default()).into_response()
}

async fn put_settings(State(state): State<Shared>, headers: HeaderMap, Json(body): Json<Settings>) -> Response {
    let a = auth!(&state, &headers);
    if let Err(r) = require_admin(&a) { return r; }
    state.store.write().await.settings = body;
    persist(&state).await;
    audit(&state, &a.0.id, "settings:update", "settings", "global", "success").await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

/// Download the milestone's SBOM.json (Syft format) as a file.
async fn download_sbom(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    let Some(m) = store.milestones.get(&id) else { return err(StatusCode::NOT_FOUND, "Milestone not found."); };
    if can_read_project(&store, &a.0, &m.project_id).is_none() { return err(StatusCode::FORBIDDEN, "No access."); }
    let Some(f) = store.files.iter().find(|f| f.milestone_id == id && f.path == "SBOM.json") else {
        return err(StatusCode::NOT_FOUND, "No SBOM for this milestone yet — push again to generate one.");
    };
    let key = f.blob_key.clone();
    drop(store);
    match tokio::fs::read(state.data_dir.join(&key)).await {
        Ok(bytes) => (
            StatusCode::OK,
            [(axum::http::header::CONTENT_TYPE, "application/json"),
             (axum::http::header::CONTENT_DISPOSITION, "attachment; filename=SBOM.json")],
            bytes,
        ).into_response(),
        Err(_) => err(StatusCode::NOT_FOUND, "SBOM data missing."),
    }
}

/// Export the milestone SBOM as CycloneDX 1.5 or SPDX 2.3 JSON.
/// Converted on demand from the stored syft-json so formats never drift.
async fn export_sbom(State(state): State<Shared>, headers: HeaderMap, Path((id, format)): Path<(String, String)>) -> Response {
    let a = auth!(&state, &headers);
    if format != "cyclonedx" && format != "spdx" {
        return err(StatusCode::BAD_REQUEST, "Format must be cyclonedx or spdx.");
    }
    let store = state.store.read().await;
    let Some(m) = store.milestones.get(&id) else { return err(StatusCode::NOT_FOUND, "Milestone not found."); };
    if can_read_project(&store, &a.0, &m.project_id).is_none() { return err(StatusCode::FORBIDDEN, "No access."); }
    let slug = store.projects.get(&m.project_id).map(|p| p.slug.clone()).unwrap_or_else(|| "project".into());
    let Some(f) = store.files.iter().find(|f| f.milestone_id == id && f.path == "SBOM.json") else {
        return err(StatusCode::NOT_FOUND, "No SBOM for this milestone yet — push again to generate one.");
    };
    let key = f.blob_key.clone();
    drop(store);
    let Ok(bytes) = tokio::fs::read(state.data_dir.join(&key)).await else {
        return err(StatusCode::NOT_FOUND, "SBOM data missing.");
    };
    let Ok(doc) = serde_json::from_slice::<serde_json::Value>(&bytes) else {
        return err(StatusCode::INTERNAL_SERVER_ERROR, "Stored SBOM is unreadable.");
    };
    let packages: Vec<scanner::SbomPackage> = doc["artifacts"].as_array().map(|arts| arts.iter().map(|a| {
        let name = a["name"].as_str().unwrap_or("").to_string();
        let version = a["version"].as_str().unwrap_or("").to_string();
        let ecosystem = a["metadata"]["ecosystem"].as_str().unwrap_or("").to_string();
        scanner::SbomPackage {
            name, version, ecosystem,
            purl: a["purl"].as_str().unwrap_or("").to_string(),
            pkg_type: a["type"].as_str().unwrap_or("").to_string(),
        }
    }).collect()).unwrap_or_default();
    let (out, filename) = if format == "cyclonedx" {
        (scanner::cyclonedx_document(&packages, &slug), "SBOM.cyclonedx.json")
    } else {
        (scanner::spdx_document(&packages, &slug, &id), "SBOM.spdx.json")
    };
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json"),
         (axum::http::header::CONTENT_DISPOSITION, &*format!("attachment; filename={filename}"))],
        serde_json::to_vec_pretty(&out).unwrap_or_default(),
    ).into_response()
}

/// Latest favicon found in the project's newest milestone (for project cards).
async fn project_favicon(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    let Some(p) = can_read_project(&store, &a.0, &id) else { return err(StatusCode::NOT_FOUND, "Project not found."); };
    let _ = p;
    let mut ms: Vec<&Milestone> = store.milestones.values().filter(|m| m.project_id == id).collect();
    ms.sort_by_key(|m| m.seq_no);
    // Newest milestone first; prefer exact favicon names over generic icons.
    let mut found: Option<(String, String)> = None;
    for m in ms.iter().rev() {
        let mut best: Option<(u8, &StoredFile)> = None;
        for f in store.files.iter().filter(|f| f.milestone_id == m.id) {
            let lower = f.path.to_lowercase();
            let score = if lower.ends_with("favicon.ico") { 0 }
                else if lower.ends_with("favicon.png") { 1 }
                else if lower.ends_with("favicon.svg") { 2 }
                else if lower.contains("favicon") { 3 }
                else if lower.ends_with("apple-touch-icon.png") { 4 }
                else if lower.ends_with("/icon.png") || lower == "icon.png" { 5 }
                else { continue };
            if best.map(|(b, _)| score < b).unwrap_or(true) { best = Some((score, f)); }
        }
        if let Some((_, f)) = best {
            let ctype = if f.path.ends_with(".ico") { "image/x-icon" }
                else if f.path.ends_with(".svg") { "image/svg+xml" }
                else if f.path.ends_with(".jpg") || f.path.ends_with(".jpeg") { "image/jpeg" }
                else { "image/png" }.to_string();
            found = Some((f.blob_key.clone(), ctype));
            break;
        }
    }
    let Some((key, ctype)) = found else { return err(StatusCode::NOT_FOUND, "No favicon in the latest milestone."); };
    drop(store);
    match tokio::fs::read(state.data_dir.join(&key)).await {
        Ok(bytes) => (StatusCode::OK, [(axum::http::header::CONTENT_TYPE, ctype)], bytes).into_response(),
        Err(_) => err(StatusCode::NOT_FOUND, "Favicon data missing."),
    }
}

async fn serve_blob(State(state): State<Shared>, headers: HeaderMap, Path(key): Path<String>) -> Response {
    let _ = auth!(&state, &headers);
    // Keys are content-addressed; the milestone ACL was checked when the key was handed out.
    match tokio::fs::read(state.data_dir.join(&key)).await {
        Ok(bytes) => (StatusCode::OK, bytes).into_response(),
        Err(_) => err(StatusCode::NOT_FOUND, "Not found."),
    }
}

// ------------------------------------------------------------------ main

fn load_store(data_dir: &PathBuf) -> Store {
    let path = data_dir.join("db.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        match serde_json::from_str::<Store>(&text) {
            Ok(s) => return s,
            Err(e) => {
                // Never silently reseed over real data: keep the old file for recovery.
                eprintln!("warning: could not read {} ({e}); backing it up before reseeding", path.display());
                let _ = std::fs::rename(&path, data_dir.join("db.json.bak"));
            }
        }
    }
    // First boot: seed admin + demo space from env (defaults for local dev).
    let email = std::env::var("ADMIN_EMAIL").unwrap_or_else(|_| "admin@vibeforge.local".into());
    let password = std::env::var("ADMIN_PASSWORD").unwrap_or_else(|_| "admin12345".into());
    let mut store = Store::default();
    store.settings = Settings::default();
    if let Ok(v) = std::env::var("PUBLIC_BASE_URL") { store.settings.public_base_url = v; }
    let admin = User {
        id: new_id("usr"), email, display_name: "Admin".into(),
        password_hash: hash_password(&password), is_platform_admin: true,
        is_blocked: false, blocked_reason: None, created_at: now(),
    };
    let space = Space { id: new_id("spc"), slug: "my-space".into(), name: "My Space".into(), created_by: admin.id.clone() };
    store.members.push(SpaceMember { space_id: space.id.clone(), principal_kind: "user".into(), principal_id: admin.id.clone(), role: SpaceRole::Owner });
    store.spaces.insert(space.id.clone(), space);
    store.users.insert(admin.id.clone(), admin);
    store
}

#[tokio::main]
async fn main() {
    let data_dir = PathBuf::from(std::env::var("DATA_DIR").unwrap_or_else(|_| "data".into()));
    let _ = std::fs::create_dir_all(data_dir.join("tmp"));
    let store = load_store(&data_dir);
    let state: Shared = Arc::new(AppState {
        store: RwLock::new(store),
        data_dir: data_dir.clone(),
        jwt_secret: std::env::var("JWT_SECRET").unwrap_or_else(|_| "dev-secret-change-me".into()),
    });
    persist(&state).await;

    let web_dist = PathBuf::from("web/dist");
    let skill_dir = PathBuf::from("skill");
    let mut app = Router::new()
        .route("/health", get(|| async { Json(serde_json::json!({ "ok": true, "service": "vibeforge" })) }))
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/me", get(me))
        .route("/api/v1/me/projects", get(my_projects))
        .route("/api/v1/me/tokens", get(list_tokens).post(create_token))
        .route("/api/v1/me/tokens/{id}", axum::routing::delete(revoke_token))
        .route("/api/v1/spaces", get(list_spaces).post(create_space))
        .route("/api/v1/spaces/{id}/members", get(list_members).post(add_member))
        .route("/api/v1/spaces/{id}/projects", get(list_projects).post(create_project))
        .route("/api/v1/projects/{id}", get(get_project))
        .route("/api/v1/projects/{id}/favicon", get(project_favicon))
        .route("/api/v1/projects/{id}/milestones", get(list_milestones).post(push_milestone))
        .route("/api/v1/milestones/{id}", get(get_milestone))
        .route("/api/v1/milestones/{id}/files/content", get(file_content))
        .route("/api/v1/milestones/{id}/findings", get(milestone_findings))
        .route("/api/v1/milestones/{id}/sbom", get(download_sbom))
        .route("/api/v1/milestones/{id}/export/{format}", get(export_sbom))
        .route("/api/v1/milestones/{id}/fork", post(fork_milestone))
        .route("/api/v1/milestones/{id}/screenshots", post(add_screenshot))
        .route("/api/v1/findings/{id}/ignore", post(ignore_finding))
        .route("/api/v1/blobs/{key}", get(serve_blob))
        .route("/api/v1/admin/users", get(admin_users).post(admin_create_user))
        .route("/api/v1/admin/users/{id}/block", post(admin_block))
        .route("/api/v1/admin/users/{id}/unblock", post(admin_unblock))
        .route("/api/v1/admin/users/{id}/nudge", post(admin_nudge))
        .route("/api/v1/admin/groups", get(admin_groups).post(admin_create_group))
        .route("/api/v1/admin/vulns", get(admin_vulns))
        .route("/api/v1/admin/settings", get(get_settings).put(put_settings))
        .layer(tower_http::cors::CorsLayer::permissive());
    if skill_dir.exists() {
        app = app.nest_service("/skill", tower_http::services::ServeDir::new(skill_dir));
    }
    if web_dist.exists() {
        // SPA fallback: unknown paths (share links like /projects/:id) get the app shell.
        let index = web_dist.join("index.html");
        app = app.fallback_service(
            tower_http::services::ServeDir::new(web_dist.clone())
                .not_found_service(tower_http::services::ServeFile::new(index)),
        );
    }
    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8080);
    let app = app.with_state(state);
    let listener = match tokio::net::TcpListener::bind(("0.0.0.0", port)).await {
        Ok(l) => l,
        Err(e) if e.kind() == std::io::ErrorKind::AddrInUse => {
            eprintln!("vibeforge is already running on http://localhost:{port} — open that instead, or stop it first (lsof -ti :{port} | xargs kill).");
            return;
        }
        Err(e) => {
            eprintln!("could not start vibeforge on port {port}: {e}");
            return;
        }
    };
    println!("vibeforge listening on http://localhost:{port}  data={}", data_dir.display());
    axum::serve(listener, app).await.unwrap();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn role_matrix_matches_plan() {
        assert!(SpaceRole::Owner.can_create_project());
        assert!(SpaceRole::Coder.can_create_project());
        assert!(!SpaceRole::Reader.can_create_project());
        assert!(SpaceRole::Owner.can_manage_members());
        assert!(!SpaceRole::Coder.can_manage_members());
    }

    #[test]
    fn token_hash_never_equals_raw() {
        let raw = "vatt_testtoken123";
        assert_ne!(hash_token(raw), raw);
        assert_eq!(hash_token(raw), hash_token(raw));
    }

    #[test]
    fn password_roundtrip() {
        let h = hash_password("correct horse battery");
        assert!(verify_password("correct horse battery", &h));
        assert!(!verify_password("wrong", &h));
    }
}



