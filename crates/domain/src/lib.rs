//! Shared domain types. No I/O here — the API crate owns storage and HTTP,
//! the scanner crate owns file analysis. Keeping rules in one place means
//! the web UI, the skill and any competitor client all enforce the same RBAC.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpaceRole {
    Owner,
    Coder,
    Reader,
}

impl SpaceRole {
    pub fn rank(&self) -> u8 {
        match self {
            SpaceRole::Reader => 1,
            SpaceRole::Coder => 2,
            SpaceRole::Owner => 3,
        }
    }
    /// Space Owners and Coders create projects; Readers browse only.
    /// Flip a single value here if you want Readers to create projects too.
    pub fn can_create_project(&self) -> bool {
        matches!(self, SpaceRole::Owner | SpaceRole::Coder)
    }
    pub fn can_push_milestone(&self) -> bool {
        matches!(self, SpaceRole::Owner | SpaceRole::Coder)
    }
    pub fn can_manage_members(&self) -> bool {
        matches!(self, SpaceRole::Owner)
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct User {
    pub id: String,
    pub email: String,
    pub display_name: String,
    /// Argon2id hash. Stored in the private DB file; API responses use `PublicUser`.
    pub password_hash: String,
    pub is_platform_admin: bool,
    pub is_blocked: bool,
    pub blocked_reason: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PublicUser {
    pub id: String,
    pub email: String,
    pub display_name: String,
    pub is_platform_admin: bool,
    pub is_blocked: bool,
}

impl From<&User> for PublicUser {
    fn from(u: &User) -> Self {
        Self {
            id: u.id.clone(),
            email: u.email.clone(),
            display_name: u.display_name.clone(),
            is_platform_admin: u.is_platform_admin,
            is_blocked: u.is_blocked,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Group {
    pub id: String,
    pub name: String,
    pub description: String,
    pub member_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Space {
    pub id: String,
    pub slug: String,
    pub name: String,
    pub created_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpaceMember {
    pub space_id: String,
    /// "user" or "group"
    pub principal_kind: String,
    pub principal_id: String,
    pub role: SpaceRole,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Project {
    pub id: String,
    pub space_id: String,
    pub slug: String,
    pub name: String,
    pub visibility: String, // "private" | "space"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ArtifactManifest {
    pub spec: String, // "vibe-artifact/1.0"
    pub project: String,
    pub label: String,
    #[serde(default)]
    pub about: String,
    #[serde(default)]
    pub stage: String, // idea | building | live
    #[serde(default)]
    pub screenshots: Vec<String>,
}

impl Default for ArtifactManifest {
    fn default() -> Self {
        Self {
            spec: "vibe-artifact/1.0".into(),
            project: String::new(),
            label: String::new(),
            about: String::new(),
            stage: "building".into(),
            screenshots: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Milestone {
    pub id: String,
    pub project_id: String,
    pub seq_no: u32,
    pub label: String,
    pub parent_milestone_id: Option<String>,
    /// Original pushed zip, content-addressed under data/blobs/.
    pub blob_key: String,
    pub manifest: ArtifactManifest,
    pub scan_status: String, // scanning | done | failed
    /// Languages/ecosystems detected at push time (for the project summary).
    #[serde(default)]
    pub languages: Vec<String>,
    pub created_by: String,
    pub created_at: String,
    #[serde(default)]
    pub screenshots: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredFile {
    pub milestone_id: String,
    pub path: String,
    pub blob_key: String,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Finding {
    pub id: String,
    pub milestone_id: String,
    /// secret | practice | unused_dep | cve
    pub kind: String,
    /// critical | high | medium | low
    pub severity: String,
    /// Plain-English title a non-technical vibe coder understands.
    pub plain_title: String,
    pub plain_explain: String,
    /// Copy-paste fix or dependency bump for the "Fix it" tab.
    pub fix_text: String,
    pub file_path: Option<String>,
    pub line_no: Option<usize>,
    pub cve_id: Option<String>,
    pub package: Option<String>,
    /// Version found in the SBOM for `package`.
    #[serde(default)]
    pub current_version: Option<String>,
    pub fixed_version: Option<String>,
    /// CVSS v3.1 base score computed from the OSV severity vector.
    #[serde(default)]
    pub cvss_score: Option<f64>,
    #[serde(default)]
    pub cvss_vector: Option<String>,
    pub status: String, // open | fixed | ignored
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TodoItem {
    pub id: String,
    pub milestone_id: String,
    pub body: String,
    pub done: bool,
    /// survey | scanner | admin | manual
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiToken {
    pub id: String,
    pub user_id: String,
    pub name: String,
    /// First 12 chars of the raw token, safe to store/display.
    pub prefix: String,
    /// SHA-256 of the full token. The full token is shown exactly once.
    pub token_hash: String,
    pub scopes: Vec<String>, // read | push
    pub last_used_at: Option<String>,
    pub expires_at: Option<String>,
    pub revoked_at: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub id: String,
    pub actor_id: String,
    pub action: String, // resource:action
    pub resource_type: String,
    pub resource_id: String,
    pub outcome: String, // success | failure
    pub created_at: String,
}

/// One settings object edited from Admin → Settings. Env vars only seed the
/// first boot; afterwards the DB copy is the source of truth so every node
/// and every admin sees the same values.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Settings {
    pub max_compressed_mb: u64,
    pub max_uncompressed_mb: u64,
    pub max_entries: usize,
    pub max_file_mb: u64,
    pub max_ratio: f64,
    pub block_push_on_critical: bool,
    pub osv_timeout_s: u64,
    pub unused_dep_check: bool,
    pub token_default_ttl_days: i64,
    pub max_active_tokens_per_user: usize,
    pub session_hours: i64,
    pub allow_registration: bool,
    pub smtp_host: String,
    pub smtp_from: String,
    pub public_base_url: String,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            max_compressed_mb: 200,
            max_uncompressed_mb: 1024,
            max_entries: 10_000,
            max_file_mb: 25,
            max_ratio: 100.0,
            block_push_on_critical: false,
            osv_timeout_s: 20,
            unused_dep_check: true,
            token_default_ttl_days: 90,
            max_active_tokens_per_user: 10,
            session_hours: 12,
            allow_registration: false,
            smtp_host: String::new(),
            smtp_from: String::new(),
            public_base_url: "http://localhost:8080".into(),
        }
    }
}

impl Settings {
    pub fn zip_limits(&self) -> ZipLimits {
        ZipLimits {
            max_compressed: self.max_compressed_mb * 1024 * 1024,
            max_uncompressed: self.max_uncompressed_mb * 1024 * 1024,
            max_entries: self.max_entries,
            max_file_bytes: self.max_file_mb * 1024 * 1024,
            max_ratio: self.max_ratio,
        }
    }
}

#[derive(Debug, Clone)]
pub struct ZipLimits {
    pub max_compressed: u64,
    pub max_uncompressed: u64,
    pub max_entries: usize,
    pub max_file_bytes: u64,
    pub max_ratio: f64,
}
