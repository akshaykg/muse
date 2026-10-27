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
    #[serde(default)]
    pub refresh_tokens: Vec<RefreshToken>,
    #[serde(default)]
    pub password_resets: Vec<PasswordReset>,
    pub settings: Settings,
    pub audit: Vec<AuditEntry>,
}

pub struct AppState {
    pub store: RwLock<Store>,
    pub data_dir: PathBuf,
    pub jwt_secret: String,
    pub login_fails: RwLock<HashMap<String, Vec<std::time::Instant>>>,
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
fn base32_decode(input: &str) -> Vec<u8> {
    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut bits = String::new();
    let mut out = Vec::new();
    for c in input.to_uppercase().chars() {
        if c == '=' { break; }
        let Some(v) = alphabet.find(c) else { continue };
        bits.push_str(&format!("{v:05b}"));
        while bits.len() >= 8 {
            let (byte, rest) = bits.split_at(8);
            out.push(u8::from_str_radix(byte, 2).unwrap_or(0));
            bits = rest.to_string();
        }
    }
    out
}

fn base32_encode(bytes: &[u8]) -> String {
    let alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut bits = String::new();
    for b in bytes { bits.push_str(&format!("{b:08b}")); }
    bits.as_bytes().chunks(5).map(|chunk| {
        let mut v: u32 = 0;
        for (i, bit) in chunk.iter().enumerate() { if *bit == b'1' { v |= 1 << (4 - i); } }
        alphabet.chars().nth(v as usize).unwrap_or('=')
    }).collect()
}

/// Current TOTP code for a base32 secret (accepts +/- 1 step at verify time).
pub fn totp_code(secret_b32: &str, at_unix: u64) -> String {
    use hmac::{Hmac, Mac};
    let key = base32_decode(secret_b32);
    let counter = at_unix / 30;
    let mut mac = <Hmac<sha1::Sha1>>::new_from_slice(&key).expect("hmac key");
    mac.update(&counter.to_be_bytes());
    let digest = mac.finalize().into_bytes();
    let offset = (digest[digest.len() - 1] & 0x0f) as usize;
    let code = ((u32::from(digest[offset] & 0x7f) << 24)
        | (u32::from(digest[offset + 1]) << 16)
        | (u32::from(digest[offset + 2]) << 8)
        | u32::from(digest[offset + 3])) % 1_000_000;
    format!("{code:06}")
}

fn totp_valid(secret_b32: &str, code: &str) -> bool {
    let now_s = Utc::now().timestamp().max(0) as u64;
    [-30i64, 0, 30].iter().any(|step| {
        totp_code(secret_b32, (now_s as i64 + step).max(0) as u64) == code.trim()
    })
}

fn make_refresh_token() -> String {
    format!("vfr_{}", uuid::Uuid::new_v4().simple())
}

fn hash_token(raw: &str) -> String {
    scanner::sha256_hex(raw.as_bytes())
}

/// Store bytes under a content key: local disk, or S3 (SigV4) when configured.
async fn blob_put(state: &Shared, key: &str, bytes: &[u8]) -> Result<(), String> {
    if let Ok(bucket) = std::env::var("S3_BUCKET") {
        if !bucket.is_empty() { return s3_put(&bucket, key, bytes).await; }
    }
    let dest = state.data_dir.join(key);
    if let Some(parent) = dest.parent() { let _ = tokio::fs::create_dir_all(parent).await; }
    tokio::fs::write(&dest, bytes).await.map_err(|e| e.to_string())
}

async fn blob_get(state: &Shared, key: &str) -> Result<Vec<u8>, String> {
    if let Ok(bucket) = std::env::var("S3_BUCKET") {
        if !bucket.is_empty() { return s3_get(&bucket, key).await; }
    }
    tokio::fs::read(state.data_dir.join(key)).await.map_err(|e| e.to_string())
}

fn s3_config() -> (String, String, String, String) {
    (
        std::env::var("S3_ENDPOINT").unwrap_or_else(|_| "https://s3.amazonaws.com".into()),
        std::env::var("S3_REGION").unwrap_or_else(|_| "us-east-1".into()),
        std::env::var("AWS_ACCESS_KEY_ID").unwrap_or_default(),
        std::env::var("AWS_SECRET_ACCESS_KEY").unwrap_or_default(),
    )
}

async fn s3_signed(method: &str, bucket: &str, key: &str, bytes: Option<&[u8]>) -> Result<Vec<u8>, String> {
    use hmac::{Hmac, Mac};
    let (endpoint, region, access, secret) = s3_config();
    let endpoint = endpoint.trim_end_matches('/');
    let url = format!("{endpoint}/{bucket}/{key}");
    let now_dt = chrono::Utc::now();
    let amz_date = now_dt.format("%Y%m%dT%H%M%SZ").to_string();
    let date_stamp = now_dt.format("%Y%m%d").to_string();
    let payload_hash = scanner::sha256_hex(bytes.unwrap_or(&[]));
    let canonical_headers = format!("host:{}\nx-amz-date:{amz_date}\n", url.split('/').nth(2).unwrap_or("localhost"));
    let signed_headers = "host;x-amz-date";
    let canonical = format!("{method}\n/{bucket}/{key}\n\n{canonical_headers}\n{signed_headers}\n{payload_hash}");
    let scope = format!("{date_stamp}/{region}/s3/aws4_request");
    let string_to_sign = format!("AWS4-HMAC-SHA256\n{amz_date}\n{scope}\n{}", scanner::sha256_hex(canonical.as_bytes()));
    let mac = |key_bytes: &[u8], msg: &[u8]| -> Vec<u8> {
        let mut m = <Hmac<sha2::Sha256>>::new_from_slice(key_bytes).expect("hmac");
        m.update(msg);
        m.finalize().into_bytes().to_vec()
    };
    let k_date = mac(format!("AWS4{secret}").as_bytes(), date_stamp.as_bytes());
    let k_region = mac(&k_date, region.as_bytes());
    let k_service = mac(&k_region, b"s3");
    let k_signing = mac(&k_service, b"aws4_request");
    let signature = hex::encode(mac(&k_signing, string_to_sign.as_bytes()));
    let auth = format!("AWS4-HMAC-SHA256 Credential={access}/{scope}, SignedHeaders={signed_headers}, Signature={signature}");
    let client = reqwest::Client::new();
    let mut req = match method {
        "PUT" => client.put(&url),
        _ => client.get(&url),
    };
    req = req.header("x-amz-date", &amz_date).header("x-amz-content-sha256", &payload_hash).header("authorization", auth);
    if let Some(b) = bytes { req = req.body(b.to_vec()); }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("S3 {method} failed: {}", resp.status()));
    }
    resp.bytes().await.map(|b| b.to_vec()).map_err(|e| e.to_string())
}

async fn s3_put(bucket: &str, key: &str, bytes: &[u8]) -> Result<(), String> {
    s3_signed("PUT", bucket, key, Some(bytes)).await.map(|_| ())
}
async fn s3_get(bucket: &str, key: &str) -> Result<Vec<u8>, String> {
    s3_signed("GET", bucket, key, None).await
}

/// AES-256-GCM seal for settings secrets (item 6). Key = SHA-256(ENCRYPTION_KEY || JWT secret).
fn seal_secret(state: &Shared, plain: &str) -> String {
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    use aes_gcm::aead::Aead;
    if plain.is_empty() || plain.starts_with("enc:v1:") || plain == "********" { return plain.to_string(); }
    let material = std::env::var("ENCRYPTION_KEY").unwrap_or_default();
    let key_bytes = scanner::sha256_hex(format!("{material}:{}", state.jwt_secret).as_bytes());
    let key_raw = hex::decode(&key_bytes).unwrap_or_default();
    let key = aes_gcm::Key::<Aes256Gcm>::from_slice(&key_raw[..32]);
    let cipher = Aes256Gcm::new(key);
    let nonce_bytes: [u8; 12] = uuid::Uuid::new_v4().as_bytes()[..12].try_into().unwrap();
    match cipher.encrypt(Nonce::from_slice(&nonce_bytes), plain.as_bytes()) {
        Ok(ct) => format!("enc:v1:{}:{}", hex::encode(nonce_bytes), hex::encode(ct)),
        Err(_) => plain.to_string(),
    }
}

fn open_secret(state: &Shared, stored: &str) -> String {
    use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
    use aes_gcm::aead::Aead;
    let Some(rest) = stored.strip_prefix("enc:v1:") else { return stored.to_string() };
    let Some((nonce_hex, ct_hex)) = rest.split_once(':') else { return String::new() };
    let material = std::env::var("ENCRYPTION_KEY").unwrap_or_default();
    let key_bytes = scanner::sha256_hex(format!("{material}:{}", state.jwt_secret).as_bytes());
    let key_raw = hex::decode(&key_bytes).unwrap_or_default();
    let key = aes_gcm::Key::<Aes256Gcm>::from_slice(&key_raw[..32]);
    let cipher = Aes256Gcm::new(key);
    let (Ok(nonce), Ok(ct)) = (hex::decode(nonce_hex), hex::decode(ct_hex)) else { return String::new() };
    cipher.decrypt(Nonce::from_slice(&nonce), ct.as_ref())
        .map(|pt| String::from_utf8_lossy(&pt).to_string())
        .unwrap_or_default()
}

/// Signing key for SBOM attestations (item 9): ed25519, persisted in data/.
fn signing_keypair(state: &Shared) -> (String, String) {
    use ed25519_dalek::SigningKey;
    let path = state.data_dir.join("signing.key");
    let seed: [u8; 32] = if let Ok(text) = std::fs::read_to_string(&path) {
        let raw = hex::decode(text.trim()).unwrap_or_default();
        raw.try_into().unwrap_or([0u8; 32])
    } else {
        let raw = *uuid::Uuid::new_v4().as_bytes();
        let mut seed = [0u8; 32];
        seed[..16].copy_from_slice(&raw);
        seed[16..].copy_from_slice(&raw);
        let _ = std::fs::write(&path, hex::encode(seed));
        seed
    };
    let signing = SigningKey::from_bytes(&seed);
    (hex::encode(signing.to_bytes()), hex::encode(signing.verifying_key().to_bytes()))
}

async fn fire_webhook(state: &Shared, payload: serde_json::Value) {
    let url = state.store.read().await.settings.webhook_url.clone();
    if url.is_empty() { return; }
    let state2 = state.clone();
    tokio::spawn(async move {
        let _ = reqwest::Client::new().post(&url).json(&payload).send().await;
        audit(&state2, "system", "webhook:fire", "webhook", &url, "success").await;
    });
}

/// Minimal plain-SMTP send (item 10). TLS/STARTTLS should terminate at your relay.
async fn send_email(state: &Shared, to: &str, subject: &str, body_text: &str) -> Result<(), String> {
    let settings = state.store.read().await.settings.clone();
    if settings.smtp_host.is_empty() { return Err("SMTP not configured".into()); }
    let addr = format!("{}:{}", settings.smtp_host, settings.smtp_port);
    let mut stream = tokio::net::TcpStream::connect(&addr).await.map_err(|e| e.to_string())?;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut buf = [0u8; 1024];
    let _ = stream.read(&mut buf).await;
    let from = if settings.smtp_from.is_empty() { "vibeforge@localhost".to_string() } else { settings.smtp_from.clone() };
    let auth = if !settings.smtp_user.is_empty() {
        use base64::Engine;
        let enc = base64::engine::general_purpose::STANDARD;
        let user_b64 = enc.encode(&settings.smtp_user);
        let pass_b64 = enc.encode(open_secret(state, &settings.smtp_password));
        format!("AUTH LOGIN\r\n{user_b64}\r\n{pass_b64}\r\n")
    } else { String::new() };
    let script = format!("HELO vibeforge\r\n{auth}MAIL FROM:<{from}>\r\nRCPT TO:<{to}>\r\nDATA\r\nSubject: {subject}\r\nFrom: {from}\r\nTo: {to}\r\n\r\n{body_text}\r\n.\r\nQUIT\r\n");
    stream.write_all(script.as_bytes()).await.map_err(|e| e.to_string())?;
    let n = stream.read(&mut buf).await.map_err(|e| e.to_string())?;
    let resp = String::from_utf8_lossy(&buf[..n]).to_string();
    if resp.contains("250") || resp.contains("354") { Ok(()) } else { Err(format!("SMTP said: {resp}")) }
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
struct LoginBody { email: String, password: String, #[serde(default)] totp_code: Option<String> }

async fn login(State(state): State<Shared>, headers: HeaderMap, Json(body): Json<LoginBody>) -> Response {
    // Rate limit: 10 failed attempts per email+IP in 15 minutes.
    let ip = headers.get("x-forwarded-for").and_then(|v| v.to_str().ok()).unwrap_or("local").to_string();
    let limit_key = format!("{}|{ip}", body.email.to_lowercase());
    {
        let fails = state.login_fails.read().await;
        let recent = fails.get(&limit_key).map(|v| v.iter().filter(|t| t.elapsed() < std::time::Duration::from_secs(900)).count()).unwrap_or(0);
        if recent >= 10 {
            return err(StatusCode::TOO_MANY_REQUESTS, "Too many sign-in attempts. Try again in a few minutes.");
        }
    }
    let fail = |state: Shared, key: String| async move {
        state.login_fails.write().await.entry(key).or_default().push(std::time::Instant::now());
    };
    let store = state.store.read().await;
    let user = store.users.values().find(|u| u.email.eq_ignore_ascii_case(&body.email)).cloned();
    drop(store);
    let Some(user) = user else {
        fail(state.clone(), limit_key).await;
        return err(StatusCode::UNAUTHORIZED, "Wrong email or password.");
    };
    if user.is_blocked {
        return err(StatusCode::FORBIDDEN, "This account is blocked. Contact your admin.");
    }
    if !verify_password(&body.password, &user.password_hash) {
        fail(state.clone(), limit_key).await;
        audit(&state, &user.id, "auth:login", "user", &user.id, "failure").await;
        return err(StatusCode::UNAUTHORIZED, "Wrong email or password.");
    }
    if user.mfa_enabled {
        let ok = match (&user.mfa_secret, &body.totp_code) {
            (Some(secret), Some(code)) => totp_valid(secret, code),
            _ => false,
        };
        if !ok {
            return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({
                "error": "Enter the 6-digit code from your authenticator app.", "mfa_required": true
            }))).into_response();
        }
    }
    state.login_fails.write().await.remove(&limit_key);
    let hours = state.store.read().await.settings.session_hours;
    let token = make_jwt(&state, &user.id, hours);
    // Refresh token: hashed at rest, rotated on every use, 30-day life.
    let refresh_raw = make_refresh_token();
    {
        let mut store = state.store.write().await;
        store.refresh_tokens.push(RefreshToken {
            id: new_id("rft"), user_id: user.id.clone(), token_hash: hash_token(&refresh_raw),
            expires_at: (Utc::now() + chrono::Duration::days(30)).to_rfc3339(),
            revoked_at: None, created_at: now(),
        });
    }
    persist(&state).await;
    audit(&state, &user.id, "auth:login", "user", &user.id, "success").await;
    Json(serde_json::json!({ "token": token, "refresh_token": refresh_raw, "user": PublicUser::from(&user) })).into_response()
}

#[derive(Deserialize)]
struct RefreshBody { refresh_token: String }

async fn refresh(State(state): State<Shared>, Json(body): Json<RefreshBody>) -> Response {
    let hashed = hash_token(&body.refresh_token);
    let mut store = state.store.write().await;
    let Some(rt) = store.refresh_tokens.iter_mut().find(|t| t.token_hash == hashed && t.revoked_at.is_none()) else {
        return err(StatusCode::UNAUTHORIZED, "Refresh token is invalid or revoked.");
    };
    if rt.expires_at.as_str() < now().as_str() {
        return err(StatusCode::UNAUTHORIZED, "Refresh token expired. Sign in again.");
    }
    rt.revoked_at = Some(now());
    let user_id = rt.user_id.clone();
    let refresh_raw = make_refresh_token();
    store.refresh_tokens.push(RefreshToken {
        id: new_id("rft"), user_id: user_id.clone(), token_hash: hash_token(&refresh_raw),
        expires_at: (Utc::now() + chrono::Duration::days(30)).to_rfc3339(),
        revoked_at: None, created_at: now(),
    });
    let Some(user) = store.users.get(&user_id).cloned() else {
        return err(StatusCode::UNAUTHORIZED, "Account no longer exists.");
    };
    drop(store);
    persist(&state).await;
    if user.is_blocked { return err(StatusCode::FORBIDDEN, "This account is blocked."); }
    let hours = state.store.read().await.settings.session_hours;
    Json(serde_json::json!({
        "token": make_jwt(&state, &user.id, hours), "refresh_token": refresh_raw, "user": PublicUser::from(&user)
    })).into_response()
}

async fn logout(State(state): State<Shared>, Json(body): Json<RefreshBody>) -> Response {
    let hashed = hash_token(&body.refresh_token);
    let mut store = state.store.write().await;
    for rt in store.refresh_tokens.iter_mut().filter(|t| t.token_hash == hashed) {
        rt.revoked_at = Some(now());
    }
    drop(store);
    persist(&state).await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

#[derive(Deserialize)]
struct ForgotBody { email: String }

async fn forgot_password(State(state): State<Shared>, Json(body): Json<ForgotBody>) -> Response {
    let mut store = state.store.write().await;
    let Some(user) = store.users.values().find(|u| u.email.eq_ignore_ascii_case(&body.email)).map(|u| (u.id.clone(), u.email.clone())) else {
        // Same answer either way — never reveal whether an email exists.
        return Json(serde_json::json!({ "ok": true, "message": "If that email has an account, a reset link is on its way." })).into_response();
    };
    let raw = format!("vfrst_{}", uuid::Uuid::new_v4().simple());
    store.password_resets.push(PasswordReset {
        id: new_id("rst"), user_id: user.0.clone(), token_hash: hash_token(&raw),
        expires_at: (Utc::now() + chrono::Duration::hours(1)).to_rfc3339(),
        used_at: None, created_at: now(),
    });
    let smtp_ready = !store.settings.smtp_host.is_empty();
    drop(store);
    persist(&state).await;
    if smtp_ready {
        Json(serde_json::json!({ "ok": true, "message": "If that email has an account, a reset link is on its way." })).into_response()
    } else {
        // No mail server configured (dev/demo): return the token so the flow is usable.
        Json(serde_json::json!({ "ok": true, "reset_token": raw,
            "message": "No SMTP configured — use this one-time token within an hour (dev mode only)." })).into_response()
    }
}

#[derive(Deserialize)]
struct ResetBody { token: String, password: String }

async fn reset_password(State(state): State<Shared>, Json(body): Json<ResetBody>) -> Response {
    if body.password.len() < 8 { return err(StatusCode::BAD_REQUEST, "Password needs at least 8 characters."); }
    let hashed = hash_token(&body.token);
    let mut store = state.store.write().await;
    let Some(rst) = store.password_resets.iter_mut().find(|r| r.token_hash == hashed && r.used_at.is_none()) else {
        return err(StatusCode::BAD_REQUEST, "Reset token is invalid or already used.");
    };
    if rst.expires_at.as_str() < now().as_str() {
        return err(StatusCode::BAD_REQUEST, "Reset token expired. Request a new one.");
    }
    rst.used_at = Some(now());
    let user_id = rst.user_id.clone();
    if let Some(u) = store.users.get_mut(&user_id) {
        u.password_hash = hash_password(&body.password);
    }
    // Changing the password revokes every refresh token.
    for rt in store.refresh_tokens.iter_mut().filter(|t| t.user_id == user_id) {
        rt.revoked_at = Some(now());
    }
    drop(store);
    persist(&state).await;
    audit(&state, &user_id, "auth:reset", "user", &user_id, "success").await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

// MFA (TOTP authenticator apps)
async fn mfa_setup(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let a = auth!(&state, &headers);
    let secret = base32_encode(uuid::Uuid::new_v4().as_bytes());
    let mut store = state.store.write().await;
    if let Some(u) = store.users.get_mut(&a.0.id) { u.mfa_secret = Some(secret.clone()); }
    drop(store);
    persist(&state).await;
    Json(serde_json::json!({
        "secret": secret,
        "otpauth_uri": format!("otpauth://totp/VibeForge:{}?secret={secret}&issuer=VibeForge", a.0.email),
        "note": "Scan with any authenticator app, then call /me/mfa/enable with a code."
    })).into_response()
}

#[derive(Deserialize)]
struct MfaCodeBody { code: String }

async fn mfa_enable(State(state): State<Shared>, headers: HeaderMap, Json(body): Json<MfaCodeBody>) -> Response {
    let a = auth!(&state, &headers);
    let secret = state.store.read().await.users.get(&a.0.id).and_then(|u| u.mfa_secret.clone());
    let Some(secret) = secret else { return err(StatusCode::BAD_REQUEST, "Run MFA setup first."); };
    if !totp_valid(&secret, &body.code) {
        return err(StatusCode::BAD_REQUEST, "That code did not match. Check the app and try again.");
    }
    let mut store = state.store.write().await;
    if let Some(u) = store.users.get_mut(&a.0.id) { u.mfa_enabled = true; }
    drop(store);
    persist(&state).await;
    audit(&state, &a.0.id, "auth:mfa_enable", "user", &a.0.id, "success").await;
    Json(serde_json::json!({ "ok": true, "mfa_enabled": true })).into_response()
}

async fn mfa_disable(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let a = auth!(&state, &headers);
    let mut store = state.store.write().await;
    if let Some(u) = store.users.get_mut(&a.0.id) { u.mfa_enabled = false; u.mfa_secret = None; }
    drop(store);
    persist(&state).await;
    Json(serde_json::json!({ "ok": true, "mfa_enabled": false })).into_response()
}

// OIDC (item 3): generic OpenID Connect code flow against Settings' issuer.
async fn oidc_login(State(state): State<Shared>) -> Response {
    let settings = state.store.read().await.settings.clone();
    if settings.oidc_issuer.is_empty() || settings.oidc_client_id.is_empty() {
        return err(StatusCode::NOT_FOUND, "OIDC is not configured. Set the issuer and client ID in Admin → Settings.");
    }
    let issuer = settings.oidc_issuer.trim_end_matches('/');
    let discovery = reqwest::get(format!("{issuer}/.well-known/openid-configuration")).await;
    let Ok(resp) = discovery else { return err(StatusCode::BAD_GATEWAY, "Could not reach the identity provider."); };
    let Ok(doc) = resp.json::<serde_json::Value>().await else { return err(StatusCode::BAD_GATEWAY, "Identity provider returned an invalid discovery document."); };
    let Some(auth_ep) = doc["authorization_endpoint"].as_str() else {
        return err(StatusCode::BAD_GATEWAY, "Discovery document has no authorization_endpoint.");
    };
    let redirect = format!("{}/api/v1/auth/oidc/callback", settings.public_base_url.trim_end_matches('/'));
    let url = format!("{auth_ep}?response_type=code&client_id={}&redirect_uri={}&scope=openid%20email%20profile",
        settings.oidc_client_id, urlencoding(&redirect));
    axum::response::Redirect::temporary(&url).into_response()
}

fn urlencoding(s: &str) -> String {
    s.chars().map(|c| match c {
        'A'..='Z' | 'a'..='z' | '0'..='9' | '-' | '_' | '.' | '~' => c.to_string(),
        _ => format!("%{:02X}", c as u32),
    }).collect()
}

#[derive(Deserialize)]
struct OidcCallbackQuery { code: Option<String>, error: Option<String> }

async fn oidc_callback(State(state): State<Shared>, Query(q): Query<OidcCallbackQuery>) -> Response {
    if let Some(e) = q.error { return err(StatusCode::BAD_REQUEST, &format!("Identity provider error: {e}")); }
    let Some(code) = q.code else { return err(StatusCode::BAD_REQUEST, "Missing code."); };
    let settings = state.store.read().await.settings.clone();
    let issuer = settings.oidc_issuer.trim_end_matches('/');
    let Ok(resp) = reqwest::get(format!("{issuer}/.well-known/openid-configuration")).await else {
        return err(StatusCode::BAD_GATEWAY, "Could not reach the identity provider.");
    };
    let Ok(doc) = resp.json::<serde_json::Value>().await else {
        return err(StatusCode::BAD_GATEWAY, "Invalid discovery document.");
    };
    let Some(token_ep) = doc["token_endpoint"].as_str() else {
        return err(StatusCode::BAD_GATEWAY, "Discovery document has no token_endpoint.");
    };
    let redirect = format!("{}/api/v1/auth/oidc/callback", settings.public_base_url.trim_end_matches('/'));
    let client = reqwest::Client::new();
    let Ok(token_resp) = client.post(token_ep).form(&[
        ("grant_type", "authorization_code"), ("code", code.as_str()),
        ("redirect_uri", redirect.as_str()), ("client_id", settings.oidc_client_id.as_str()),
        ("client_secret", settings.oidc_client_secret.as_str()),
    ]).send().await else {
        return err(StatusCode::BAD_GATEWAY, "Token exchange failed.");
    };
    let Ok(token_json) = token_resp.json::<serde_json::Value>().await else {
        return err(StatusCode::BAD_GATEWAY, "Token exchange returned invalid JSON.");
    };
    let Some(id_token) = token_json["id_token"].as_str() else {
        return err(StatusCode::BAD_GATEWAY, "No id_token in response. Ensure the openid scope is granted.");
    };
    // Decode claims (signature verified by TLS to the issuer's token endpoint
    // in this flow; production deployments should also verify via JWKS).
    let parts: Vec<&str> = id_token.split('.').collect();
    if parts.len() != 3 { return err(StatusCode::BAD_GATEWAY, "Malformed id_token."); }
    let Ok(payload) = base64_decode_url(parts[1]) else { return err(StatusCode::BAD_GATEWAY, "Malformed id_token payload."); };
    let Ok(claims) = serde_json::from_slice::<serde_json::Value>(&payload) else {
        return err(StatusCode::BAD_GATEWAY, "Malformed id_token claims.");
    };
    let (Some(sub), Some(email)) = (claims["sub"].as_str(), claims["email"].as_str()) else {
        return err(StatusCode::BAD_GATEWAY, "id_token needs sub and email claims.");
    };
    if claims["iss"].as_str() != Some(issuer) {
        return err(StatusCode::UNAUTHORIZED, "id_token issuer does not match the configured issuer.");
    }
    // Link or provision the local account.
    let mut store = state.store.write().await;
    let existing = store.users.values().find(|u| u.oidc_subject.as_deref() == Some(sub) || u.email.eq_ignore_ascii_case(email))
        .map(|u| u.id.clone());
    let user_id = match existing {
        Some(id) => {
            if let Some(u) = store.users.get_mut(&id) { u.oidc_subject = Some(sub.to_string()); }
            id
        }
        None => {
            if !settings.allow_registration {
                return err(StatusCode::FORBIDDEN, "No local account for that identity and self-registration is off. Ask an admin to create your user first.");
            }
            let user = User {
                id: new_id("usr"), email: email.to_lowercase(),
                display_name: claims["name"].as_str().unwrap_or(email).to_string(),
                password_hash: hash_password(&format!("oidc-{}", uuid::Uuid::new_v4())),
                is_platform_admin: false, mfa_secret: None, mfa_enabled: false,
                oidc_subject: Some(sub.to_string()), is_blocked: false, blocked_reason: None, created_at: now(),
            };
            let id = user.id.clone();
            store.users.insert(id.clone(), user);
            id
        }
    };
    let user = store.users.get(&user_id).cloned().unwrap();
    drop(store);
    persist(&state).await;
    if user.is_blocked { return err(StatusCode::FORBIDDEN, "This account is blocked."); }
    let hours = state.store.read().await.settings.session_hours;
    let jwt = make_jwt(&state, &user.id, hours);
    // Hand the JWT to the SPA via fragment (never logged in URLs/servers).
    axum::response::Redirect::temporary(&format!("{}/#oidc_token={jwt}", settings.public_base_url.trim_end_matches('/'))).into_response()
}

fn base64_decode_url(input: &str) -> Result<Vec<u8>, ()> {
    use base64::Engine;
    let mut padded = input.replace('-', "+").replace('_', "/");
    while padded.len() % 4 != 0 { padded.push('='); }
    base64::engine::general_purpose::STANDARD.decode(padded).map_err(|_| ())
}

// SCIM 2.0 provisioning (bearer = Settings scim_token)
fn scim_authorized(state: &Shared, state_settings: &Settings, headers: &HeaderMap) -> bool {
    if state_settings.scim_token.is_empty() { return false; }
    let expected = open_secret(state, &state_settings.scim_token);
    headers.get("authorization").and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .map(|t| t == expected).unwrap_or(false)
}

async fn scim_create_user(State(state): State<Shared>, headers: HeaderMap, Json(body): Json<serde_json::Value>) -> Response {
    let settings = state.store.read().await.settings.clone();
    if !scim_authorized(&state, &settings, &headers) { return err(StatusCode::UNAUTHORIZED, "SCIM token required."); }
    let email = body["userName"].as_str().or_else(|| body["emails"][0]["value"].as_str()).unwrap_or("").to_lowercase();
    let name = body["displayName"].as_str().unwrap_or(&email).to_string();
    if email.is_empty() { return err(StatusCode::BAD_REQUEST, "userName (email) is required."); }
    let mut store = state.store.write().await;
    if let Some(existing) = store.users.values().find(|u| u.email == email) {
        return (StatusCode::CONFLICT, Json(serde_json::json!({
            "schemas": ["urn:ietf:params:scim:api:messages:2.0:Error"], "detail": "User already exists", "id": existing.id
        }))).into_response();
    }
    let user = User {
        id: new_id("usr"), email: email.clone(), display_name: name,
        password_hash: hash_password(&format!("scim-{}", uuid::Uuid::new_v4())),
        is_platform_admin: false, mfa_secret: None, mfa_enabled: false, oidc_subject: None,
        is_blocked: body["active"].as_bool().map(|a| !a).unwrap_or(false), blocked_reason: None, created_at: now(),
    };
    let id = user.id.clone();
    store.users.insert(id.clone(), user);
    drop(store);
    persist(&state).await;
    (StatusCode::CREATED, Json(serde_json::json!({
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"], "id": id, "userName": email, "active": true
    }))).into_response()
}

async fn scim_list_users(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let settings = state.store.read().await.settings.clone();
    if !scim_authorized(&state, &settings, &headers) { return err(StatusCode::UNAUTHORIZED, "SCIM token required."); }
    let store = state.store.read().await;
    let resources: Vec<_> = store.users.values().map(|u| serde_json::json!({
        "schemas": ["urn:ietf:params:scim:schemas:core:2.0:User"], "id": u.id, "userName": u.email,
        "displayName": u.display_name, "active": !u.is_blocked
    })).collect();
    Json(serde_json::json!({
        "schemas": ["urn:ietf:params:scim:api:messages:2.0:ListResponse"],
        "totalResults": resources.len(), "Resources": resources
    })).into_response()
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
    {
        let store = state.store.read().await;
        let quota = store.settings.space_member_quota;
        if quota > 0 {
            let count = store.members.iter().filter(|m| m.space_id == space_id).count();
            let replacing = store.members.iter().any(|m| m.space_id == space_id && m.principal_kind == body.principal_kind && m.principal_id == body.principal_id);
            if !replacing && count >= quota {
                return err(StatusCode::BAD_REQUEST, &format!("This space has reached its member limit ({quota}). Raise it in Admin → Settings."));
            }
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

    // ClamAV INSTREAM scan when CLAMD is configured in Settings (host:port).
    if !settings.clamd_host.is_empty() {
        match clam_scan(&settings.clamd_host, &body).await {
            Ok(true) => return err(StatusCode::UNPROCESSABLE_ENTITY, "This zip failed the antivirus scan and was rejected."),
            Ok(false) => {}
            Err(e) => eprintln!("clamav unavailable ({e}); continuing without it"),
        }
    }

    // Space storage quota (item 12).
    if settings.space_quota_mb > 0 {
        let store = state.store.read().await;
        let used: u64 = store.files.iter()
            .filter(|f| store.milestones.get(&f.milestone_id)
                .and_then(|m| store.projects.get(&m.project_id))
                .map(|p| p.space_id == project.space_id).unwrap_or(false))
            .map(|f| f.size_bytes).sum();
        if used + body.len() as u64 > settings.space_quota_mb * 1024 * 1024 {
            return err(StatusCode::PAYLOAD_TOO_LARGE, "This space has reached its storage quota. Raise it in Admin → Settings or delete old milestones.");
        }
    }

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
    let _ = blob_put(&state, &blob_key, &body).await;

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
        let _ = blob_put(&state, &key, &bytes).await;
        stored.push(StoredFile { milestone_id: milestone_id.clone(), path: rel, blob_key: key, size_bytes: bytes.len() as u64, sha256: scanner::sha256_hex(&bytes) });
    }

    // SBOM (Syft) from the same manifests that feed OSV — stored in the milestone.
    let deps = scanner::collect_all_deps(&tmp);
    let (sbom_doc, sbom_pkgs, sbom_tool) = scanner::generate_sbom(&tmp, &deps, &project.slug);
    let sbom_bytes = serde_json::to_vec_pretty(&sbom_doc).unwrap_or_default();
    let sbom_key = format!("files/{}/{}", milestone_id, scanner::sha256_hex(&sbom_bytes));
    let _ = blob_put(&state, &sbom_key, &sbom_bytes).await;
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
    let blocklist: Vec<String> = settings.license_blocklist.split(',').map(|v| v.trim().to_string()).filter(|v| !v.is_empty()).collect();
    findings.extend(scanner::scan_licenses(&tmp, &blocklist, &milestone_id));
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
    let threshold_hit = {
        let rank = |sev: &str| match sev { "critical" => 4, "high" => 3, "medium" => 2, _ => 1 };
        let min = rank(&settings.block_severity);
        settings.block_severity != "none" && findings.iter().any(|f| f.status == "open" && rank(&f.severity) >= min)
    };
    let critical_hit = findings.iter().any(|f| f.severity == "critical" && f.status == "open");
    if settings.block_push_on_critical && critical_hit || threshold_hit {
        return (StatusCode::UNPROCESSABLE_ENTITY, Json(serde_json::json!({
            "milestone_id": milestone_id, "blocked": true,
            "message": "Saved, but your admin's policy blocks milestones at this severity. Fix them and push again.",
            "findings": findings.len(), "sbom_packages": sbom_pkgs.len(), "languages": languages
        }))).into_response();
    }
    if critical_hit || findings.iter().any(|f| f.severity == "high" && f.status == "open") {
        fire_webhook(&state, serde_json::json!({
            "event": "milestone.pushed", "project_id": project_id, "milestone_id": milestone_id,
            "critical": findings.iter().filter(|f| f.severity == "critical").count(),
            "high": findings.iter().filter(|f| f.severity == "high").count()
        })).await;
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
        if let Ok(bytes) = blob_get(&state, &key).await {
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
    match blob_get(&state, &key).await {
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
    let _ = blob_put(&state, &key, &body).await;
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
        mfa_secret: None, mfa_enabled: false, oidc_subject: None,
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
    let target_email = state.store.read().await.users.get(&id).map(|u| u.email.clone()).unwrap_or_default();
    drop(store);
    persist(&state).await;
    audit(&state, &a.0.id, "user:nudge", "user", &id, "success").await;
    let emailed = if target_email.is_empty() { false } else {
        send_email(&state, &target_email, "VibeForge: a message from your admin", &body.message).await.is_ok()
    };
    Json(serde_json::json!({ "ok": true, "milestone_id": mid, "emailed": emailed,
        "note": if emailed { "Added as a to-do and emailed." } else { "Added as a to-do on their latest milestone. Connect SMTP in Settings to also email it." } })).into_response()
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
    let mut value = serde_json::to_value(&store.settings).unwrap_or_default();
    for field in ["smtp_password", "oidc_client_secret", "scim_token"] {
        if value[field].as_str().map(|v| !v.is_empty()).unwrap_or(false) {
            value[field] = serde_json::json!("********");
        }
    }
    Json(value).into_response()
}

async fn put_settings(State(state): State<Shared>, headers: HeaderMap, Json(mut body): Json<Settings>) -> Response {
    let a = auth!(&state, &headers);
    if let Err(r) = require_admin(&a) { return r; }
    {
        let current = state.store.read().await.settings.clone();
        if body.smtp_password == "********" { body.smtp_password = current.smtp_password; }
        if body.oidc_client_secret == "********" { body.oidc_client_secret = current.oidc_client_secret; }
        if body.scim_token == "********" { body.scim_token = current.scim_token; }
    }
    body.smtp_password = seal_secret(&state, &body.smtp_password);
    body.oidc_client_secret = seal_secret(&state, &body.oidc_client_secret);
    body.scim_token = seal_secret(&state, &body.scim_token);
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
    match blob_get(&state, &key).await {
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
    let Ok(bytes) = blob_get(&state, &key).await else {
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
    match blob_get(&state, &key).await {
        Ok(bytes) => (StatusCode::OK, [(axum::http::header::CONTENT_TYPE, ctype)], bytes).into_response(),
        Err(_) => err(StatusCode::NOT_FOUND, "Favicon data missing."),
    }
}

async fn serve_blob(State(state): State<Shared>, headers: HeaderMap, Path(key): Path<String>) -> Response {
    let _ = auth!(&state, &headers);
    // Keys are content-addressed; the milestone ACL was checked when the key was handed out.
    match blob_get(&state, &key).await {
        Ok(bytes) => {
            let lower = key.to_lowercase();
            let ctype = if lower.ends_with(".png") { "image/png" }
                else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") { "image/jpeg" }
                else if lower.ends_with(".svg") { "image/svg+xml" }
                else if lower.ends_with(".ico") { "image/x-icon" }
                else if lower.ends_with(".webp") { "image/webp" }
                else if lower.ends_with(".gif") { "image/gif" }
                else if lower.ends_with(".json") { "application/json" }
                else if lower.ends_with(".zip") { "application/zip" }
                else { "application/octet-stream" };
            (StatusCode::OK, [(axum::http::header::CONTENT_TYPE, ctype)], bytes).into_response()
        }
        Err(_) => err(StatusCode::NOT_FOUND, "Not found."),
    }
}

async fn clam_scan(host_port: &str, bytes: &[u8]) -> Result<bool, String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let mut stream = tokio::net::TcpStream::connect(host_port).await.map_err(|e| e.to_string())?;
    stream.write_all(b"zINSTREAM\0").await.map_err(|e| e.to_string())?;
    for chunk in bytes.chunks(8192) {
        stream.write_all(&(chunk.len() as u32).to_be_bytes()).await.map_err(|e| e.to_string())?;
        stream.write_all(chunk).await.map_err(|e| e.to_string())?;
    }
    stream.write_all(&0u32.to_be_bytes()).await.map_err(|e| e.to_string())?;
    let mut resp = String::new();
    stream.read_to_string(&mut resp).await.map_err(|e| e.to_string())?;
    Ok(resp.contains("FOUND"))
}

async fn readyz(State(state): State<Shared>) -> Response {
    let store_ok = state.store.try_read().is_ok();
    let data_ok = state.data_dir.exists();
    let storage = if std::env::var("S3_BUCKET").map(|b| !b.is_empty()).unwrap_or(false) { "s3" } else { "local" };
    let db_mode = if std::env::var("DATABASE_URL").map(|v| !v.is_empty()).unwrap_or(false) { "postgres-configured" } else { "embedded" };
    Json(serde_json::json!({
        "ready": store_ok && data_ok, "store": store_ok, "data_dir": data_ok,
        "storage": storage, "db_mode": db_mode
    })).into_response()
}

async fn metrics(State(state): State<Shared>) -> Response {
    let store = state.store.read().await;
    let open = store.findings.values().filter(|f| f.status == "open");
    let count = |sev: &str| open.clone().filter(|f| f.severity == sev).count();
    let body = format!(
        "# TYPE vibeforge_users gauge\nvibeforge_users {}\n# TYPE vibeforge_projects gauge\nvibeforge_projects {}\n# TYPE vibeforge_milestones gauge\nvibeforge_milestones {}\n# TYPE vibeforge_open_findings gauge\nvibeforge_open_findings{{severity=\"critical\"}} {}\nvibeforge_open_findings{{severity=\"high\"}} {}\nvibeforge_open_findings{{severity=\"medium\"}} {}\nvibeforge_open_findings{{severity=\"low\"}} {}\n",
        store.users.len(), store.projects.len(), store.milestones.len(),
        count("critical"), count("high"), count("medium"), count("low"));
    (StatusCode::OK, [(axum::http::header::CONTENT_TYPE, "text/plain")], body).into_response()
}

async fn signing_key(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let _ = auth!(&state, &headers);
    let (_, public) = signing_keypair(&state);
    Json(serde_json::json!({ "algorithm": "ed25519", "public_key_hex": public })).into_response()
}

async fn sbom_attestation(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    use ed25519_dalek::{Signer, SigningKey};
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    let Some(m) = store.milestones.get(&id) else { return err(StatusCode::NOT_FOUND, "Milestone not found."); };
    if can_read_project(&store, &a.0, &m.project_id).is_none() { return err(StatusCode::FORBIDDEN, "No access."); }
    let Some(f) = store.files.iter().find(|f| f.milestone_id == id && f.path == "SBOM.json") else {
        return err(StatusCode::NOT_FOUND, "No SBOM for this milestone yet.");
    };
    let (key, sha) = (f.blob_key.clone(), f.sha256.clone());
    drop(store);
    let (seed_hex, public_hex) = signing_keypair(&state);
    let seed: [u8; 32] = hex::decode(&seed_hex).unwrap_or_default().try_into().unwrap_or([0u8; 32]);
    let signing = SigningKey::from_bytes(&seed);
    let signature = signing.sign(sha.as_bytes());
    let sbom_bytes = blob_get(&state, &key).await.unwrap_or_default();
    Json(serde_json::json!({
        "milestone_id": id, "sbom_sha256": sha, "sbom_bytes": sbom_bytes.len(),
        "algorithm": "ed25519", "public_key_hex": public_hex,
        "signature_hex": hex::encode(signature.to_bytes()),
        "signed_at": now()
    })).into_response()
}

// GDPR (item 12): export + delete my account
async fn my_export(State(state): State<Shared>, headers: HeaderMap) -> Response {
    let a = auth!(&state, &headers);
    let store = state.store.read().await;
    let spaces: Vec<_> = store.spaces.values().filter_map(|sp| {
        space_role(&store, &a.0, &sp.id).map(|role| serde_json::json!({ "id": sp.id, "name": sp.name, "role": role }))
    }).collect();
    let milestones: Vec<_> = store.milestones.values().filter(|m| m.created_by == a.0.id)
        .map(|m| serde_json::json!({ "id": m.id, "project_id": m.project_id, "label": m.label, "created_at": m.created_at })).collect();
    (
        StatusCode::OK,
        [(axum::http::header::CONTENT_TYPE, "application/json"),
         (axum::http::header::CONTENT_DISPOSITION, "attachment; filename=vibeforge-export.json")],
        serde_json::to_vec_pretty(&serde_json::json!({
            "user": PublicUser::from(&a.0), "spaces": spaces, "milestones": milestones,
            "tokens": store.tokens.values().filter(|t| t.user_id == a.0.id).count()
        })).unwrap_or_default(),
    ).into_response()
}

#[derive(Deserialize)]
struct DeleteMeBody { password: String }

async fn my_delete(State(state): State<Shared>, headers: HeaderMap, Json(body): Json<DeleteMeBody>) -> Response {
    let a = auth!(&state, &headers);
    if !verify_password(&body.password, &a.0.password_hash) {
        return err(StatusCode::UNAUTHORIZED, "Password did not match.");
    }
    let mut store = state.store.write().await;
    store.tokens.retain(|_, t| t.user_id != a.0.id);
    store.refresh_tokens.retain(|t| t.user_id != a.0.id);
    store.members.retain(|m| !(m.principal_kind == "user" && m.principal_id == a.0.id));
    for m in store.milestones.values_mut().filter(|m| m.created_by == a.0.id) {
        m.created_by = "deleted-user".into();
    }
    store.users.remove(&a.0.id);
    drop(store);
    persist(&state).await;
    audit(&state, &a.0.id, "user:delete", "user", &a.0.id, "success").await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

// Marketplace (item 15): public projects + fix automation (item 14)
async fn set_visibility(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>, Json(body): Json<serde_json::Value>) -> Response {
    let a = auth!(&state, &headers);
    let visibility = body["visibility"].as_str().unwrap_or("space").to_string();
    if visibility != "public" && visibility != "space" {
        return err(StatusCode::BAD_REQUEST, "visibility must be public or space.");
    }
    let mut store = state.store.write().await;
    let Some(p) = store.projects.get(&id).cloned() else { return err(StatusCode::NOT_FOUND, "Project not found."); };
    match space_role(&store, &a.0, &p.space_id) {
        Some(r) if r.can_manage_members() || a.0.is_platform_admin => {}
        _ => return err(StatusCode::FORBIDDEN, "Only a Space Owner can change visibility."),
    }
    store.projects.get_mut(&id).unwrap().visibility = visibility;
    drop(store);
    persist(&state).await;
    Json(serde_json::json!({ "ok": true })).into_response()
}

async fn registry(State(state): State<Shared>, headers: HeaderMap, Query(q): Query<HashMap<String, String>>) -> Response {
    let a = auth!(&state, &headers);
    let _ = a;
    let store = state.store.read().await;
    let needle = q.get("q").cloned().unwrap_or_default().to_lowercase();
    let mut out: Vec<_> = store.projects.values().filter(|p| p.visibility == "public")
        .filter(|p| needle.is_empty() || p.name.to_lowercase().contains(&needle))
        .map(|p| {
            let mut ms: Vec<&Milestone> = store.milestones.values().filter(|m| m.project_id == p.id).collect();
            ms.sort_by_key(|m| m.seq_no);
            let latest = ms.last();
            serde_json::json!({
                "id": p.id, "name": p.name, "slug": p.slug,
                "milestones": ms.len(), "latest_milestone": latest.map(|m| m.id.clone()),
                "languages": latest.map(|m| m.languages.clone()).unwrap_or_default(),
                "open_findings": store.findings.values().filter(|f| f.status == "open"
                    && store.milestones.get(&f.milestone_id).map(|m| m.project_id == p.id).unwrap_or(false)).count()
            })
        }).collect();
    out.sort_by(|x, y| x["name"].as_str().cmp(&y["name"].as_str()));
    Json(out).into_response()
}

async fn apply_fix(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    let (finding, milestone) = {
        let store = state.store.read().await;
        let Some(f) = store.findings.get(&id).cloned() else { return err(StatusCode::NOT_FOUND, "Finding not found."); };
        let Some(m) = store.milestones.get(&f.milestone_id).cloned() else { return err(StatusCode::NOT_FOUND, "Milestone not found."); };
        (f, m)
    };
    if finding.kind != "cve" {
        return err(StatusCode::BAD_REQUEST, "Auto-fix only bumps vulnerable libraries. Use the Fix it instructions for this one.");
    }
    let (Some(pkg), Some(fixed)) = (finding.package.clone(), finding.fixed_version.clone()) else {
        return err(StatusCode::BAD_REQUEST, "No fixed version is known for this finding yet.");
    };
    let project = {
        let store = state.store.read().await;
        let Some(p) = store.projects.get(&milestone.project_id).cloned() else { return err(StatusCode::NOT_FOUND, "Project not found."); };
        match space_role(&store, &a.0, &p.space_id) {
            Some(r) if r.can_push_milestone() => {}
            _ => return err(StatusCode::FORBIDDEN, "Your role cannot apply fixes."),
        }
        p
    };
    // Rebuild the project in a temp dir from stored files, bump the version, re-push.
    let tmp = state.data_dir.join("tmp").join(format!("fix-{}", uuid::Uuid::new_v4()));
    let _ = tokio::fs::create_dir_all(&tmp).await;
    {
        let store = state.store.read().await;
        let files: Vec<StoredFile> = store.files.iter().filter(|f| f.milestone_id == milestone.id && f.path != "SBOM.json").cloned().collect();
        drop(store);
        for f in &files {
            let Ok(bytes) = blob_get(&state, &f.blob_key).await else { continue };
            let dest = tmp.join(&f.path);
            if let Some(parent) = dest.parent() { let _ = tokio::fs::create_dir_all(parent).await; }
            let _ = tokio::fs::write(&dest, &bytes).await;
        }
    }
    let mut bumped = false;
    for manifest_name in ["package.json", "requirements.txt", "Cargo.toml", "composer.json"] {
        for entry in walk_manifests(&tmp, manifest_name) {
            let Ok(mut text) = tokio::fs::read_to_string(&entry).await else { continue };
            let before = text.clone();
            if manifest_name == "package.json" || manifest_name == "composer.json" {
                if let Ok(mut v) = serde_json::from_str::<serde_json::Value>(&text) {
                    for sect in ["dependencies", "devDependencies", "require"] {
                        if let Some(obj) = v[sect].as_object_mut() {
                            if let Some(cur) = obj.get_mut(&pkg) {
                                if let Some(cur_s) = cur.as_str().map(|x| x.to_string()) {
                                    let prefix: String = cur_s.chars().take_while(|c| !c.is_ascii_digit()).collect();
                                    *cur = serde_json::json!(format!("{prefix}{fixed}"));
                                    bumped = true;
                                }
                            }
                        }
                    }
                    text = serde_json::to_string_pretty(&v).unwrap_or(text);
                }
            } else if manifest_name == "requirements.txt" {
                text = text.lines().map(|line| {
                    if line.to_lowercase().starts_with(&pkg.to_lowercase()) {
                        bumped = true;
                        format!("{pkg}=={fixed}")
                    } else { line.to_string() }
                }).collect::<Vec<_>>().join("\n");
            } else if manifest_name == "Cargo.toml" {
                let mut in_deps = false;
                text = text.lines().map(|line| {
                    let t = line.trim();
                    if t.starts_with('[') { in_deps = t.contains("dependencies"); }
                    if in_deps && t.starts_with(&pkg) && t.contains("version") {
                        bumped = true;
                        let re = regex_lite_version(line, &fixed);
                        return re;
                    }
                    line.to_string()
                }).collect::<Vec<_>>().join("\n");
            }
            if text != before { let _ = tokio::fs::write(&entry, &text).await; }
        }
    }
    if !bumped {
        let _ = tokio::fs::remove_dir_all(&tmp).await;
        return err(StatusCode::BAD_REQUEST, &format!("Could not find {pkg} in a manifest to bump. Apply the Fix it instructions manually."));
    }
    // Zip the fixed tree and push it as a new milestone through the same ingest path.
    let zip_path = state.data_dir.join("tmp").join(format!("fix-{}.zip", uuid::Uuid::new_v4()));
    {
        let tmp2 = tmp.clone();
        let zip_path2 = zip_path.clone();
        let _ = tokio::task::spawn_blocking(move || {
            use std::io::Write;
            let file = std::fs::File::create(&zip_path2)?;
            let mut zip = zip::ZipWriter::new(file);
            for entry in walkdir::WalkDir::new(&tmp2).into_iter().filter_map(|e| e.ok()) {
                if entry.file_type().is_file() {
                    let rel = entry.path().strip_prefix(&tmp2).unwrap().to_string_lossy().replace('\\', "/");
                    zip.start_file(rel, zip::write::SimpleFileOptions::default())?;
                    let bytes = std::fs::read(entry.path())?;
                    zip.write_all(&bytes)?;
                }
            }
            zip.finish()?;
            Ok::<(), std::io::Error>(())
        }).await;
    }
    let zip_bytes = tokio::fs::read(&zip_path).await.unwrap_or_default();
    let _ = tokio::fs::remove_dir_all(&tmp).await;
    let _ = tokio::fs::remove_file(&zip_path).await;
    let mut hdrs = HeaderMap::new();
    hdrs.insert("x-milestone-label", format!("Auto-fix: {pkg} → {fixed}").parse().unwrap());
    // Reuse push by direct internal call shape: emulate headers via a fresh request is
    // not possible here, so store the milestone through push_milestone with Bytes.
    let resp = push_milestone(State(state.clone()), {
        let mut h = headers.clone();
        h.insert("x-milestone-label", format!("Auto-fix: {pkg} to {fixed}").parse().unwrap());
        h
    }, Path(project.id.clone()), Bytes::from(zip_bytes)).await;
    let _ = hdrs;
    resp
}

fn walk_manifests(root: &std::path::Path, name: &str) -> Vec<PathBuf> {
    walkdir::WalkDir::new(root).max_depth(6).into_iter().filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file() && e.file_name().to_str() == Some(name))
        .map(|e| e.path().to_path_buf()).collect()
}

fn regex_lite_version(line: &str, fixed: &str) -> String {
    // Replace the first quoted x.y.z-looking version on the line.
    let mut out = String::new();
    let mut in_quotes = false;
    let mut replaced = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '"' {
            if in_quotes && !replaced {
                out.push_str(fixed);
                replaced = true;
                in_quotes = false;
                continue;
            }
            in_quotes = !in_quotes;
            if in_quotes { continue; }
            out.push(c);
            continue;
        }
        if !in_quotes { out.push(c); }
    }
    out
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
        mfa_secret: None, mfa_enabled: false, oidc_subject: None,
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
        login_fails: RwLock::new(HashMap::new()),
    });
    persist(&state).await;

    let web_dist = PathBuf::from("web/dist");
    let skill_dir = PathBuf::from("skill");
    let mut app = Router::new()
        .route("/health", get(|| async { Json(serde_json::json!({ "ok": true, "service": "vibeforge" })) }))
        .route("/api/v1/auth/login", post(login))
        .route("/api/v1/auth/refresh", post(refresh))
        .route("/api/v1/auth/logout", post(logout))
        .route("/api/v1/auth/forgot", post(forgot_password))
        .route("/api/v1/auth/reset", post(reset_password))
        .route("/api/v1/auth/oidc/login", get(oidc_login))
        .route("/api/v1/auth/oidc/callback", get(oidc_callback))
        .route("/scim/v2/Users", get(scim_list_users).post(scim_create_user))
        .route("/api/v1/me/mfa/setup", post(mfa_setup))
        .route("/api/v1/me/mfa/enable", post(mfa_enable))
        .route("/api/v1/me/mfa/disable", post(mfa_disable))
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
        .route("/api/v1/blobs/{*key}", get(serve_blob))
        .route("/api/v1/admin/users", get(admin_users).post(admin_create_user))
        .route("/api/v1/admin/users/{id}/block", post(admin_block))
        .route("/api/v1/admin/users/{id}/unblock", post(admin_unblock))
        .route("/api/v1/admin/users/{id}/nudge", post(admin_nudge))
        .route("/api/v1/admin/groups", get(admin_groups).post(admin_create_group))
        .route("/api/v1/admin/vulns", get(admin_vulns))
        .route("/api/v1/admin/settings", get(get_settings).put(put_settings))
        .route("/readyz", get(readyz))
        .route("/metrics", get(metrics))
        .route("/api/v1/signing-key", get(signing_key))
        .route("/api/v1/milestones/{id}/sbom/attestation", get(sbom_attestation))
        .route("/api/v1/me/export", get(my_export))
        .route("/api/v1/me/delete", axum::routing::delete(my_delete))
        .route("/api/v1/projects/{id}/visibility", post(set_visibility))
        .route("/api/v1/registry", get(registry))
        .route("/api/v1/findings/{id}/apply-fix", post(apply_fix))
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
    fn totp_rfc6238_vector() {
        // RFC 6238 test secret (ASCII "12345678901234567890") at T=59 -> 287082.
        assert_eq!(totp_code("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ", 59), "287082");
    }

    #[test]
    fn secret_seal_roundtrip_needs_state() {
        // Seal/open are exercised end-to-end in the settings smoke test; here
        // we pin the base32 helpers TOTP depends on.
        assert_eq!(base32_encode(b"hello"), "NBSWY3DP");
        assert_eq!(base32_decode("NBSWY3DP"), b"hello".to_vec());
    }

    #[test]
    fn password_roundtrip() {
        let h = hash_password("correct horse battery");
        assert!(verify_password("correct horse battery", &h));
        assert!(!verify_password("wrong", &h));
    }
}



