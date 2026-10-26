//! Milestone scanning: safe unzip, secret / practice rules, unused deps,
//! OSV CVE lookup. Plain-English findings — the UI never shows a bare CVE
//! id to a non-technical user without a sentence explaining it.

use async_trait::async_trait;
use domain::{Finding, ZipLimits};
use regex::Regex;
use serde::Deserialize;
use std::collections::HashSet;
use std::io::Read;
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Dep {
    pub ecosystem: String, // npm | PyPI | Go | crates.io | Maven | Packagist | RubyGems
    pub name: String,
    pub version: String,
}

#[derive(Debug)]
pub enum IngestError {
    TooManyEntries,
    TooLarge,
    FileTooLarge(String),
    ZipBomb,
    Traversal(String),
    BadZip(String),
    Io(std::io::Error),
}
impl std::fmt::Display for IngestError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::TooManyEntries => write!(f, "too many files in zip"),
            Self::TooLarge => write!(f, "unpacked project is too large"),
            Self::FileTooLarge(p) => write!(f, "file too large: {p}"),
            Self::ZipBomb => write!(f, "zip looks like a zip bomb (extreme compression ratio)"),
            Self::Traversal(p) => write!(f, "unsafe path in zip: {p}"),
            Self::BadZip(m) => write!(f, "not a readable zip: {m}"),
            Self::Io(e) => write!(f, "io error: {e}"),
        }
    }
}
impl std::error::Error for IngestError {}
impl From<std::io::Error> for IngestError {
    fn from(e: std::io::Error) -> Self {
        Self::Io(e)
    }
}

/// Stream-extract with every limit checked *before* the bytes land on disk.
/// Never trust the zip's declared sizes alone: bytes are also counted while copying.
pub fn extract_zip_safely(zip_bytes: &[u8], dest: &Path, limits: &ZipLimits) -> Result<Vec<PathBuf>, IngestError> {
    if zip_bytes.len() as u64 > limits.max_compressed {
        return Err(IngestError::TooLarge);
    }
    let mut archive = zip::ZipArchive::new(std::io::Cursor::new(zip_bytes.to_vec()))
        .map_err(|e| IngestError::BadZip(e.to_string()))?;
    if archive.len() > limits.max_entries {
        return Err(IngestError::TooManyEntries);
    }
    let mut written = Vec::new();
    let mut total: u64 = 0;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| IngestError::BadZip(e.to_string()))?;
        let name = entry.name().to_string();
        if name.contains("..") || Path::new(&name).is_absolute() || name.contains('\\') && name.contains("..") {
            return Err(IngestError::Traversal(name));
        }
        // Symlinks can point outside the sandbox — store the link target as text, never follow.
        let is_symlink = entry.unix_mode().map(|m| (m >> 16) & 0o170000 == 0o120000).unwrap_or(false);
        if entry.is_dir() {
            std::fs::create_dir_all(dest.join(&name))?;
            continue;
        }
        let ratio = if entry.compressed_size() > 0 {
            entry.size() as f64 / entry.compressed_size() as f64
        } else {
            1.0
        };
        if ratio > limits.max_ratio && entry.size() > 1_000_000 {
            return Err(IngestError::ZipBomb);
        }
        if entry.size() > limits.max_file_bytes {
            return Err(IngestError::FileTooLarge(name));
        }
        total += entry.size();
        if total > limits.max_uncompressed {
            return Err(IngestError::TooLarge);
        }
        let out = dest.join(&name);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if is_symlink {
            let mut target = String::new();
            entry.read_to_string(&mut target).ok();
            std::fs::write(&out, format!("[symlink -> {target}]"))?;
        } else {
            let mut file = std::fs::File::create(&out)?;
            let copied = std::io::copy(&mut entry.take(limits.max_file_bytes + 1), &mut file)?;
            if copied > limits.max_file_bytes {
                return Err(IngestError::FileTooLarge(name));
            }
        }
        written.push(out);
    }
    Ok(written)
}

pub fn sha256_hex(bytes: &[u8]) -> String {
    use sha2::Digest;
    let mut h = sha2::Sha256::new();
    h.update(bytes);
    format!("{:x}", h.finalize())
}

// ---------------------------------------------------------------- secrets

fn secret_patterns() -> Vec<(Regex, &'static str, &'static str)> {
    vec![
        (Regex::new(r"AKIA[0-9A-Z]{16}").unwrap(), "AWS access key", "critical"),
        (Regex::new(r"ghp_[A-Za-z0-9]{20,}").unwrap(), "GitHub token", "critical"),
        (Regex::new(r"sk-[A-Za-z0-9]{20,}").unwrap(), "API secret key", "critical"),
        (Regex::new(r#"(?i)(password|passwd|pwd)\s*=\s*[\"'][^\"'\s]{4,}[\"']"#).unwrap(), "Hard-coded password", "high"),
        (Regex::new(r#"(?i)(api[_-]?key|secret|token)\s*=\s*[\"'][A-Za-z0-9_\-]{12,}[\"']"#).unwrap(), "Hard-coded secret", "high"),
        (Regex::new(r"-----BEGIN (RSA |EC )?PRIVATE KEY-----").unwrap(), "Private key file", "critical"),
    ]
}

pub fn scan_secrets(root: &Path, milestone_id: &str) -> Vec<Finding> {
    let pats = secret_patterns();
    let mut out = Vec::new();
    for path in text_files(root) {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let rel = rel_path(root, &path);
        if rel.ends_with(".env") || rel.ends_with(".env.local") {
            out.push(mk(milestone_id, "secret", "critical",
                "A secrets file was uploaded",
                "This project includes a file that usually holds passwords and keys. Anyone who can download this project can read them.",
                "Remove the file from the project, add it to .gitignore, and rotate (change) every key inside it.",
                Some(rel.clone()), None));
            continue;
        }
        for (i, line) in text.lines().enumerate() {
            for (re, label, sev) in &pats {
                if re.is_match(line) {
                    out.push(mk(milestone_id, "secret", sev,
                        label,
                        "This looks like a password or key written directly in the code. Anyone who downloads this project can read it and use it.",
                        "Move the value into an environment variable, then change (rotate) the exposed value — deleting the line is not enough once it was shared.",
                        Some(rel.clone()), Some(i + 1)));
                    break;
                }
            }
        }
    }
    out
}

// ------------------------------------------------------------- bad practice

pub fn scan_practices(root: &Path, milestone_id: &str) -> Vec<Finding> {
    let rules: Vec<(Regex, &str, &str, &str, &str)> = vec![
        (Regex::new(r"\beval\s*\(").unwrap(), "medium", "Code that runs text as code",
         "This runs text as if it were code. If any of that text comes from a user, they can run anything on your server.",
         "Replace eval with a direct call or a lookup table of allowed actions."),
        (Regex::new(r"dangerouslySetInnerHTML").unwrap(), "medium", "Raw HTML rendered without cleaning",
         "This shows raw HTML in the page. A visitor could slip in a script that runs in other visitors' browsers.",
         "Render plain text instead, or sanitise the HTML with DOMPurify before showing it."),
        (Regex::new(r"verify\s*=\s*False|rejectUnauthorized\s*:\s*false|InsecureSkipVerify\s*:\s*true").unwrap(), "high", "Security check switched off",
         "A safety check that protects the connection to another service is turned off, so traffic can be intercepted.",
         "Turn the check back on and fix the certificate/configuration problem instead."),
        (Regex::new("(?i)(SELECT|INSERT|UPDATE|DELETE)[^\"]*(\\+|%s)").unwrap(), "high", "Database query built from text",
         "This database query is built by gluing text together. A user can change the query and read or delete data they should not see.",
         "Use parameterised queries ($1 / ? placeholders) so user text is always treated as data."),
        (Regex::new(r"DEBUG\s*=\s*[Tt]rue").unwrap(), "low", "Debug mode left on",
         "Debug mode can show error pages with internal details to visitors.",
         "Set DEBUG to False for the live version."),
    ];
    let mut out = Vec::new();
    for path in text_files(root) {
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let rel = rel_path(root, &path);
        for (i, line) in text.lines().enumerate() {
            for (re, sev, title, explain, fix) in &rules {
                if re.is_match(line) {
                    out.push(mk(milestone_id, "practice", sev, title, explain, fix, Some(rel.clone()), Some(i + 1)));
                }
            }
        }
    }
    out
}

// ------------------------------------------------------------------- deps

#[async_trait]
pub trait LangScanner: Send + Sync {
    fn name(&self) -> &'static str;
    fn collect_deps(&self, root: &Path) -> Vec<Dep>;
}

pub struct JsScanner;
pub struct PyScanner;
pub struct GoScanner;
pub struct RustScanner;
pub struct JavaScanner;
pub struct PhpScanner;
pub struct RubyScanner;


/// Manifests can live in subfolders (e.g. web/package.json in a monorepo),
/// not only at the zip root. Search recursively, skipping vendored/build dirs.
fn find_manifests(root: &Path, names: &[&str]) -> Vec<PathBuf> {
    let skip = ["node_modules", "target", ".git", "dist", "vendor", ".next"];
    walkdir::WalkDir::new(root).max_depth(6).into_iter().filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .filter(|p| {
            let rel = rel_path(root, p);
            if rel.split('/').any(|part| skip.contains(&part)) { return false; }
            p.file_name().and_then(|n| n.to_str()).map(|n| names.contains(&n)).unwrap_or(false)
        })
        .collect()
}

fn read_json(p: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

impl LangScanner for JsScanner {
    fn name(&self) -> &'static str { "JavaScript / TypeScript" }
    fn collect_deps(&self, root: &Path) -> Vec<Dep> {
        let mut out = Vec::new();
        for manifest in find_manifests(root, &["package.json"]) {
            let Some(v) = read_json(&manifest) else { continue };
            for sect in ["dependencies", "devDependencies"] {
                if let Some(map) = v.get(sect).and_then(|s| s.as_object()) {
                    for (name, ver) in map {
                        let version = ver.as_str().unwrap_or("").trim_start_matches(['^', '~', '>', '=', ' ']).to_string();
                        if !version.is_empty() && version.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(false) {
                            out.push(Dep { ecosystem: "npm".into(), name: name.clone(), version });
                        }
                    }
                }
            }
        }
        out
    }
}

#[derive(Deserialize)]
struct CargoToml { #[serde(default)] dependencies: std::collections::HashMap<String, toml::Value> }
#[derive(Deserialize)]
struct CargoPkg { name: String, version: String }
#[derive(Deserialize)]
struct CargoLock { #[serde(default)] package: Vec<CargoPkg> }

impl LangScanner for RustScanner {
    fn name(&self) -> &'static str { "Rust" }
    fn collect_deps(&self, root: &Path) -> Vec<Dep> {
        let lock = root.join("Cargo.lock");
        if let Ok(text) = std::fs::read_to_string(&lock) {
            if let Ok(parsed) = toml::from_str::<CargoLock>(&text) {
                return parsed.package.into_iter().map(|p| Dep { ecosystem: "crates.io".into(), name: p.name, version: p.version }).collect();
            }
        }
        if let Ok(text) = std::fs::read_to_string(root.join("Cargo.toml")) {
            if let Ok(parsed) = toml::from_str::<CargoToml>(&text) {
                return parsed.dependencies.keys().map(|k| Dep { ecosystem: "crates.io".into(), name: k.clone(), version: "0.0.0".into() }).collect();
            }
        }
        Vec::new()
    }
}

impl LangScanner for PyScanner {
    fn name(&self) -> &'static str { "Python" }
    fn collect_deps(&self, root: &Path) -> Vec<Dep> {
        let mut out = Vec::new();
        for manifest in find_manifests(root, &["requirements.txt"]) {
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            for line in text.lines() {
                let line = line.trim();
                if line.is_empty() || line.starts_with('#') { continue }
                if let Some((n, v)) = line.split_once("==") {
                    out.push(Dep { ecosystem: "PyPI".into(), name: n.trim().into(), version: v.trim().into() });
                } else if let Some((n, _)) = line.split_once(">=") {
                    out.push(Dep { ecosystem: "PyPI".into(), name: n.trim().into(), version: "0.0.0".into() });
                }
            }
        }
        }
        out
    }
}

impl LangScanner for GoScanner {
    fn name(&self) -> &'static str { "Go" }
    fn collect_deps(&self, root: &Path) -> Vec<Dep> {
        let mut out = Vec::new();
        for manifest in find_manifests(root, &["go.mod"]) {
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            let mut in_require = false;
            for line in text.lines() {
                let t = line.trim();
                if t.starts_with("require (") { in_require = true; continue }
                if in_require && t == ")" { in_require = false; continue }
                let dep_line = if t.starts_with("require ") { t.trim_start_matches("require ").trim() } else if in_require { t } else { continue };
                let mut parts = dep_line.split_whitespace();
                if let (Some(n), Some(v)) = (parts.next(), parts.next()) {
                    out.push(Dep { ecosystem: "Go".into(), name: n.into(), version: v.trim_start_matches('v').into() });
                }
            }
        }
        }
        out
    }
}

impl LangScanner for JavaScanner {
    fn name(&self) -> &'static str { "Java" }
    fn collect_deps(&self, root: &Path) -> Vec<Dep> {
        let mut out = Vec::new();
        // Maven pom.xml — lightweight extraction (no XML dep needed for v1).
        for manifest in find_manifests(root, &["pom.xml"]) {
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            let re = Regex::new(r"<dependency>\s*<groupId>([^<]+)</groupId>\s*<artifactId>([^<]+)</artifactId>\s*<version>([^<]+)</version>").unwrap();
            for c in re.captures_iter(&text) {
                out.push(Dep { ecosystem: "Maven".into(), name: format!("{}:{}", &c[1], &c[2]), version: c[3].to_string() });
            }
        }
        }
        out
    }
}

impl LangScanner for PhpScanner {
    fn name(&self) -> &'static str { "PHP" }
    fn collect_deps(&self, root: &Path) -> Vec<Dep> {
        let mut out = Vec::new();
        for manifest in find_manifests(root, &["composer.json"]) {
        if let Some(v) = read_json(&manifest) {
            if let Some(map) = v.get("require").and_then(|s| s.as_object()) {
                for (name, ver) in map {
                    if name == "php" { continue }
                    let version = ver.as_str().unwrap_or("").trim_start_matches(['^', '~', '>', '=', ' ']).to_string();
                    out.push(Dep { ecosystem: "Packagist".into(), name: name.clone(), version });
                }
            }
        }
        }
        out
    }
}

impl LangScanner for RubyScanner {
    fn name(&self) -> &'static str { "Ruby" }
    fn collect_deps(&self, root: &Path) -> Vec<Dep> {
        let mut out = Vec::new();
        for manifest in find_manifests(root, &["Gemfile.lock"]) {
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            let re = Regex::new(r"^\s{4}([a-zA-Z0-9_\-]+) \(([^)]+)\)").unwrap();
            for line in text.lines() {
                if let Some(c) = re.captures(line) {
                    out.push(Dep { ecosystem: "RubyGems".into(), name: c[1].to_string(), version: c[2].to_string() });
                }
            }
        }
        }
        out
    }
}

pub fn all_scanners() -> Vec<Box<dyn LangScanner>> {
    vec![
        Box::new(JsScanner), Box::new(PyScanner), Box::new(GoScanner),
        Box::new(RustScanner), Box::new(JavaScanner), Box::new(PhpScanner),
        Box::new(RubyScanner),
    ]
}

pub fn collect_all_deps(root: &Path) -> Vec<Dep> {
    all_scanners().iter().flat_map(|s| s.collect_deps(root)).collect()
}

/// Import-graph unused check (JS/TS + Python in v1; other languages rely on OSV only).
pub fn scan_unused_deps(root: &Path, deps: &[Dep], milestone_id: &str) -> Vec<Finding> {
    let mut corpus = String::new();
    for path in text_files(root) {
        let rel = rel_path(root, &path);
        if rel == "package.json" || rel.ends_with("lock.json") || rel == "requirements.txt" { continue }
        if let Ok(t) = std::fs::read_to_string(&path) { corpus.push_str(&t); corpus.push('\n'); }
    }
    let mut out = Vec::new();
    for d in deps {
        if d.ecosystem != "npm" && d.ecosystem != "PyPI" { continue }
        let needle = d.name.trim_start_matches('@').split('/').next().unwrap_or(&d.name);
        if !corpus.contains(needle) {
            out.push(mk(milestone_id, "unused_dep", "low",
                &format!("“{}” may not be used", d.name),
                "This library is listed for the project but nothing in the code seems to use it. Unused libraries add weight and can still carry security problems.",
                &format!("If nothing uses it, remove it: npm uninstall {}  (or pip uninstall {})", d.name, d.name),
                None, None));
        }
    }
    out
}

/// Blocked-license findings from package.json / Cargo.toml license fields.
pub fn scan_licenses(root: &Path, blocklist: &[String], milestone_id: &str) -> Vec<Finding> {
    if blocklist.is_empty() { return Vec::new(); }
    let mut found: Vec<(String, String)> = Vec::new(); // (license, file)
    for manifest in find_manifests(root, &["package.json", "Cargo.toml", "composer.json"]) {
        let rel = rel_path(root, &manifest);
        if let Some(v) = read_json(&manifest) {
            if let Some(lic) = v.get("license").and_then(|l| l.as_str().or_else(|| l.get("type").and_then(|t| t.as_str()))) {
                found.push((lic.to_string(), rel));
            }
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(&manifest) {
            for line in text.lines() {
                let t = line.trim();
                if t.starts_with("license") && t.contains('=') {
                    let lic = t.split('=').nth(1).unwrap_or("").trim().trim_matches('"').to_string();
                    if !lic.is_empty() { found.push((lic, rel.clone())); }
                }
            }
        }
    }
    let mut out = Vec::new();
    for (lic, file) in found {
        for blocked in blocklist {
            if lic.to_uppercase().contains(&blocked.to_uppercase()) {
                out.push(mk(milestone_id, "license", "high",
                    &format!("License {lic} needs legal review"),
                    "This project declares a license your admin has flagged. It can limit how you sell or share the app.",
                    "Check the license terms, pick a compatible library, or ask your admin/legal contact before shipping.",
                    Some(file.clone()), None));
            }
        }
    }
    out
}

// ------------------------------------------------------------------- OSV

#[derive(Deserialize)]
struct OsvBatchResp { results: Vec<OsvResult> }
#[derive(Deserialize)]
struct OsvResult { #[serde(default)] vulns: Vec<OsvVuln> }
#[derive(Deserialize)]
struct OsvVuln {
    id: String,
    #[serde(default)] summary: Option<String>,
    #[serde(default)] aliases: Vec<String>,
    #[serde(default)] affected: Vec<OsvAffected>,
    #[serde(default)] severity: Vec<OsvSeverity>,
    #[serde(default)] database_specific: OsvDbSpecific,
}
#[derive(Deserialize, Default)]
struct OsvDbSpecific {
    #[serde(default)] severity: Option<String>,
}
#[derive(Deserialize)]
struct OsvSeverity {
    #[serde(rename = "type", default)] kind: String,
    #[serde(default)] score: String,
}
#[derive(Deserialize)]
struct OsvAffected { #[serde(default)] ranges: Vec<OsvRange> }
#[derive(Deserialize)]
struct OsvRange { #[serde(default)] events: Vec<OsvEvent> }
#[derive(Deserialize)]
struct OsvEvent { #[serde(default)] fixed: Option<String> }

/// POST /v1/querybatch — https://google.github.io/osv.dev/api/
/// Failures return an empty vec: a milestone is never blocked by OSV being down.
pub async fn query_osv(deps: &[Dep], timeout_s: u64, milestone_id: &str) -> Vec<Finding> {
    if deps.is_empty() { return Vec::new(); }
    let queries: Vec<_> = deps.iter().map(|d| serde_json::json!({
        "package": { "name": d.name, "ecosystem": d.ecosystem },
        "version": d.version
    })).collect();
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(timeout_s)).build() {
        Ok(c) => c,
        Err(_) => return Vec::new(),
    };
    let resp = match client.post("https://api.osv.dev/v1/querybatch")
        .json(&serde_json::json!({ "queries": queries })).send().await {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };
    let batch: OsvBatchResp = match resp.json().await { Ok(v) => v, Err(_) => return Vec::new() };

    // querybatch returns IDs only — fetch each advisory once for severity
    // (CVSS), affected ranges (fixed version) and summary. Details are cached
    // on disk (OSV_CACHE_FILE, default data/osv-cache.json) for OSV_CACHE_HOURS.
    let cache_path = std::env::var("OSV_CACHE_FILE").unwrap_or_else(|_| "data/osv-cache.json".into());
    let cache_ttl_s: i64 = std::env::var("OSV_CACHE_HOURS").ok().and_then(|v| v.parse().ok()).unwrap_or(24) * 3600;
    let mut cache: std::collections::HashMap<String, (i64, serde_json::Value)> =
        std::fs::read_to_string(&cache_path).ok()
            .and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
    let now_ts = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() as i64).unwrap_or(0);
    let mut details: std::collections::HashMap<String, OsvVuln> = std::collections::HashMap::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    for result in &batch.results {
        for vuln in &result.vulns {
            if seen.insert(vuln.id.clone()) && details.len() < 120 {
                if let Some((ts, raw)) = cache.get(&vuln.id) {
                    if now_ts - ts < cache_ttl_s {
                        if let Ok(full) = serde_json::from_value::<OsvVuln>(raw.clone()) {
                            details.insert(full.id.clone(), full);
                            continue;
                        }
                    }
                }
                if let Ok(r) = client.get(format!("https://api.osv.dev/v1/vulns/{}", vuln.id)).send().await {
                    if let Ok(raw) = r.json::<serde_json::Value>().await {
                        cache.insert(vuln.id.clone(), (now_ts, raw.clone()));
                        if let Ok(full) = serde_json::from_value::<OsvVuln>(raw) {
                            details.insert(full.id.clone(), full);
                        }
                    }
                }
            }
        }
    }

    if let Ok(text) = serde_json::to_string(&cache) {
        if let Some(parent) = Path::new(&cache_path).parent() { let _ = std::fs::create_dir_all(parent); }
        let _ = std::fs::write(&cache_path, text);
    }

    let mut out = Vec::new();
    for (dep, result) in deps.iter().zip(batch.results.iter()) {
        for stub in &result.vulns {
            let vuln = details.get(&stub.id).unwrap_or(stub);
            let fixed = vuln.affected.iter().flat_map(|a| a.ranges.iter())
                .flat_map(|r| r.events.iter()).find_map(|e| e.fixed.clone());
            let vector = vuln.severity.iter()
                .find(|sev| sev.kind.starts_with("CVSS"))
                .map(|sev| sev.score.clone())
                .filter(|v| !v.is_empty());
            let cvss_score = vector.as_deref().and_then(cvss_base_score);
            let severity = match cvss_score {
                Some(score) if score >= 9.0 => "critical".to_string(),
                Some(score) if score >= 7.0 => "high".to_string(),
                Some(score) if score >= 4.0 => "medium".to_string(),
                Some(_) => "low".to_string(),
                None => match vuln.database_specific.severity.as_deref().map(|v| v.to_uppercase()).as_deref() {
                    Some("CRITICAL") => "critical".to_string(),
                    Some("HIGH") => "high".to_string(),
                    Some("MODERATE") | Some("MEDIUM") => "medium".to_string(),
                    Some("LOW") => "low".to_string(),
                    _ => "high".to_string(),
                },
            };
            let title = vuln.summary.clone().unwrap_or_else(|| format!("Known problem in {}", dep.name));
            out.push(Finding {
                id: uuid_like(),
                milestone_id: milestone_id.to_string(),
                kind: "cve".into(),
                severity,
                plain_title: format!("Update {} — {}", dep.name, title),
                plain_explain: format!("The version of {} in this project ({}) has a publicly known security problem ({}). Attackers look for exactly these.",
                    dep.name, dep.version, vuln.id),
                fix_text: match &fixed {
                    Some(v) => format!("Update {} from {} to {} (or later), run your tests, then push a new milestone.", dep.name, dep.version, v),
                    None => format!("No fixed version is published yet for {}. Check the advisory {} and update {} to the latest version, or replace the library.", vuln.id, vuln.id, dep.name),
                },
                file_path: None,
                line_no: None,
                cve_id: Some(vuln.aliases.first().cloned().unwrap_or_else(|| vuln.id.clone())),
                package: Some(dep.name.clone()),
                current_version: Some(dep.version.clone()),
                fixed_version: fixed,
                cvss_score,
                cvss_vector: vector,
                status: "open".into(),
            });
        }
    }
    out
}

// ---------------------------------------------------------------- helpers

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let n = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    format!("find-{}-{}", n, std::process::id())
}

fn mk(milestone_id: &str, kind: &str, severity: &str, title: &str, explain: &str, fix: &str,
      file: Option<String>, line: Option<usize>) -> Finding {
    Finding {
        id: uuid_like(), milestone_id: milestone_id.to_string(), kind: kind.into(),
        severity: severity.into(), plain_title: title.into(), plain_explain: explain.into(),
        fix_text: fix.into(), file_path: file, line_no: line,
        cve_id: None, package: None, current_version: None, fixed_version: None,
        cvss_score: None, cvss_vector: None, status: "open".into(),
    }
}

fn text_files(root: &Path) -> Vec<PathBuf> {
    let text_ext = ["rs","js","jsx","ts","tsx","py","go","java","php","rb","json","toml","yaml","yml","env","md","html","css"];
    walkdir::WalkDir::new(root).into_iter().filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
        .map(|e| e.path().to_path_buf())
        .filter(|p| {
            let rel = rel_path(root, p);
            if rel.starts_with("node_modules/") || rel.starts_with(".git/") || rel.starts_with("target/") { return false; }
            p.extension().and_then(|e| e.to_str()).map(|e| text_ext.contains(&e)).unwrap_or(false)
        })
        .collect::<HashSet<_>>().into_iter().collect()
}

fn rel_path(root: &Path, p: &Path) -> String {
    p.strip_prefix(root).unwrap_or(p).to_string_lossy().replace('\\', "/")
}

pub fn count_languages(root: &Path) -> Vec<String> {
    // Cheap signal for the UI: which of the 7 supported ecosystems are present.
    let checks: Vec<(&str, &str)> = vec![
        ("JavaScript / TypeScript", "package.json"), ("Python", "requirements.txt"),
        ("Go", "go.mod"), ("Rust", "Cargo.toml"), ("Java", "pom.xml"),
        ("PHP", "composer.json"), ("Ruby", "Gemfile.lock"),
    ];
    checks.iter().filter(|(_, f)| !find_manifests(root, &[f]).is_empty()).map(|(n, _)| n.to_string()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn limits() -> ZipLimits {
        ZipLimits { max_compressed: 50_000_000, max_uncompressed: 50_000_000, max_entries: 1000, max_file_bytes: 10_000_000, max_ratio: 100.0 }
    }
    fn make_zip(entries: &[(&str, &[u8])]) -> Vec<u8> {
        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut w = zip::ZipWriter::new(&mut buf);
            for (name, data) in entries {
                w.start_file(*name, zip::write::SimpleFileOptions::default()).unwrap();
                w.write_all(data).unwrap();
            }
            w.finish().unwrap();
        }
        buf.into_inner()
    }

    #[test]
    fn rejects_traversal_entry() {
        let zip = make_zip(&[("../evil.txt", b"x")]);
        let dir = std::env::temp_dir().join("vf-test-traversal");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        assert!(matches!(extract_zip_safely(&zip, &dir, &limits()), Err(IngestError::Traversal(_))));
    }

    #[test]
    fn extracts_normal_project() {
        let zip = make_zip(&[("package.json", br#"{"name":"x","dependencies":{"lodash":"4.17.20"}}"#), ("src/index.js", b"console.log(1)")]);
        let dir = std::env::temp_dir().join("vf-test-ok");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let files = extract_zip_safely(&zip, &dir, &limits()).unwrap();
        assert_eq!(files.len(), 2);
        assert_eq!(collect_all_deps(&dir).len(), 1);
    }

    #[test]
    fn finds_nested_node_manifest() {
        let dir = std::env::temp_dir().join("vf-test-nested");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("web/src")).unwrap();
        std::fs::write(dir.join("Cargo.toml"), "[package]\\nname = \"x\"\\n").unwrap();
        std::fs::write(dir.join("web/package.json"), br#"{"name":"web","dependencies":{"react":"19.1.0"}}"#).unwrap();
        let langs = count_languages(&dir);
        assert!(langs.iter().any(|l| l.contains("JavaScript")), "langs: {langs:?}");
        assert!(langs.iter().any(|l| l == "Rust"), "langs: {langs:?}");
        assert!(collect_all_deps(&dir).iter().any(|d| d.name == "react"));
    }

    #[test]
    fn cvss_known_vectors() {
        // Network-exploitable, no auth, full impact = 9.8 (textbook example).
        assert_eq!(cvss_base_score("CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H"), Some(9.8));
        assert_eq!(cvss_base_score("CVSS:3.1/AV:P/AC:H/PR:H/UI:R/S:U/C:N/I:N/A:N"), Some(0.0));
        assert_eq!(cvss_base_score("not-a-vector"), None);
        assert_eq!(cvss_severity_word(9.8), "Critical");
    }

    #[test]
    fn sbom_has_purls_for_all_ecosystems() {
        let deps = vec![
            Dep { ecosystem: "npm".into(), name: "react".into(), version: "19.1.0".into() },
            Dep { ecosystem: "crates.io".into(), name: "serde".into(), version: "1.0.0".into() },
        ];
        let pkgs = sbom_packages(&deps);
        assert_eq!(pkgs[0].purl, "pkg:npm/react@19.1.0");
        assert_eq!(pkgs[1].purl, "pkg:cargo/serde@1.0.0");
        let doc = sbom_document(&pkgs, "demo", "vibeforge");
        assert_eq!(doc["artifacts"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn finds_hardcoded_secret() {
        let dir = std::env::temp_dir().join("vf-test-secret");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("app.js"), "const password = \"hunter2secret\";\n").unwrap();
        assert!(!scan_secrets(&dir, "ms-1").is_empty());
    }
}

// ------------------------------------------------------------------ SBOM
// Syft SBOM for every milestone. If a real `syft` binary is on PATH (or
// $SYFT_BIN) we shell out to it; otherwise we emit the same syft-json shape
// from the parsed manifests so the feature works with zero installs.
// Either way the document is stored as SBOM.json inside the milestone and
// its package list is what feeds the OSV query — one source of truth.

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct SbomPackage {
    pub name: String,
    pub version: String,
    pub ecosystem: String,
    /// Package URL, e.g. pkg:npm/react@19.1.0
    pub purl: String,
    /// Syft package type: npm, python, golang, rust-crate, java-archive, composer, gem
    #[serde(rename = "type")]
    pub pkg_type: String,
}

fn purl_for(dep: &Dep) -> (String, String) {
    let v = &dep.version;
    match dep.ecosystem.as_str() {
        "npm" => (format!("pkg:npm/{}@{}", dep.name.replace('@', "%40"), v), "npm".into()),
        "PyPI" => (format!("pkg:pypi/{}@{}", dep.name.to_lowercase(), v), "python".into()),
        "Go" => (format!("pkg:golang/{}@{}", dep.name, v), "golang".into()),
        "crates.io" => (format!("pkg:cargo/{}@{}", dep.name, v), "rust-crate".into()),
        "Maven" => {
            let (g, a) = dep.name.split_once(':').unwrap_or(("unknown", dep.name.as_str()));
            (format!("pkg:maven/{}/{}@{}", g, a, v), "java-archive".into())
        }
        "Packagist" => (format!("pkg:composer/{}@{}", dep.name, v), "composer".into()),
        "RubyGems" => (format!("pkg:gem/{}@{}", dep.name, v), "gem".into()),
        _ => (format!("pkg:generic/{}@{}", dep.name, v), "generic".into()),
    }
}

pub fn sbom_packages(deps: &[Dep]) -> Vec<SbomPackage> {
    let mut seen = std::collections::HashSet::new();
    deps.iter()
        .filter(|d| seen.insert(format!("{}:{}@{}", d.ecosystem, d.name, d.version)))
        .map(|d| {
            let (purl, pkg_type) = purl_for(d);
            SbomPackage { name: d.name.clone(), version: d.version.clone(), ecosystem: d.ecosystem.clone(), purl, pkg_type }
        })
        .collect()
}

/// Full syft-json document (schema 16.x shape: artifacts/source/descriptor).
pub fn sbom_document(packages: &[SbomPackage], project_slug: &str, tool: &str) -> serde_json::Value {
    let artifacts: Vec<serde_json::Value> = packages.iter().enumerate().map(|(i, p)| serde_json::json!({
        "id": format!("sbom-pkg-{i}"),
        "name": p.name,
        "version": p.version,
        "type": p.pkg_type,
        "foundBy": "vibeforge-manifest-cataloger",
        "purl": p.purl,
        "metadata": { "ecosystem": p.ecosystem }
    })).collect();
    serde_json::json!({
        "artifacts": artifacts,
        "artifactRelationships": [],
        "source": { "id": "", "name": project_slug, "version": "", "type": "directory" },
        "distro": {},
        "descriptor": { "name": tool, "version": "vibeforge", "configuration": {} },
        "schema": { "version": "16.0.0", "url": "https://raw.githubusercontent.com/anchore/syft/main/schema/json/schema.json" }
    })
}

/// Try real syft first (`syft packages <dir> -o syft-json`), fall back to the
/// built-in cataloger. Returns (document, packages, tool label).
pub fn generate_sbom(root: &Path, deps: &[Dep], project_slug: &str) -> (serde_json::Value, Vec<SbomPackage>, String) {
    let packages = sbom_packages(deps);
    if let Some(bin) = syft_binary() {
        if let Some(doc) = run_syft(&bin, root) {
            return (doc, packages, "syft".into());
        }
    }
    (sbom_document(&packages, project_slug, "vibeforge (syft-compatible)"), packages, "vibeforge".into())
}

fn syft_binary() -> Option<PathBuf> {
    if let Ok(b) = std::env::var("SYFT_BIN") {
        let p = PathBuf::from(b);
        if p.exists() { return Some(p); }
    }
    std::env::var_os("PATH").and_then(|paths| {
        std::env::split_paths(&paths).find_map(|dir| {
            let cand = dir.join("syft");
            if cand.exists() { Some(cand) } else { None }
        })
    })
}

fn run_syft(bin: &Path, root: &Path) -> Option<serde_json::Value> {
    let out = std::process::Command::new(bin)
        .args(["packages", &format!("dir:{}", root.display()), "-o", "syft-json", "-q"])
        .output()
        .ok()?;
    if !out.status.success() { return None; }
    serde_json::from_slice(&out.stdout).ok()
}

// ------------------------------------------------------------------ CVSS

/// CVSS v3.1 base score from a vector string like
/// "CVSS:3.1/AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H" (first.org spec).
/// Returns None for vectors we cannot parse — UI then shows the OSV severity word only.
pub fn cvss_base_score(vector: &str) -> Option<f64> {
    let mut m: std::collections::HashMap<&str, &str> = std::collections::HashMap::new();
    for part in vector.split('/') {
        if let Some((k, v)) = part.split_once(':') {
            if k != "CVSS" { m.insert(k, v); }
        }
    }
    let av: f64 = match *m.get("AV")? { "N" => 0.85, "A" => 0.62, "L" => 0.55, "P" => 0.20, _ => return None };
    let ac: f64 = match *m.get("AC")? { "L" => 0.77, "H" => 0.44, _ => return None };
    let (pr_u, pr_c): (f64, f64) = match *m.get("PR")? {
        "N" => (0.85, 0.85), "L" => (0.62, 0.68), "H" => (0.27, 0.50), _ => return None,
    };
    let ui: f64 = match *m.get("UI")? { "N" => 0.85, "R" => 0.62, _ => return None };
    let scope_changed = *m.get("S")? == "C";
    let c: f64 = match *m.get("C")? { "H" => 0.56, "L" => 0.22, "N" => 0.0, _ => return None };
    let i: f64 = match *m.get("I")? { "H" => 0.56, "L" => 0.22, "N" => 0.0, _ => return None };
    let a: f64 = match *m.get("A")? { "H" => 0.56, "L" => 0.22, "N" => 0.0, _ => return None };
    let pr = if scope_changed { pr_c } else { pr_u };
    let iss = 1.0 - ((1.0 - c) * (1.0 - i) * (1.0 - a));
    let impact = if scope_changed {
        7.52 * (iss - 0.029) - 3.25 * (iss - 0.02).powf(15.0)
    } else {
        6.42 * iss
    };
    let exploitability = 8.22 * av * ac * pr * ui;
    if impact <= 0.0 { return Some(0.0); }
    let raw = if scope_changed {
        (1.08 * (impact + exploitability)).min(10.0)
    } else {
        (impact + exploitability).min(10.0)
    };
    // Round up to one decimal (spec "roundup").
    Some((raw * 10.0).ceil() / 10.0)
}

pub fn cvss_severity_word(score: f64) -> &'static str {
    if score >= 9.0 { "Critical" } else if score >= 7.0 { "High" } else if score >= 4.0 { "Medium" } else if score > 0.0 { "Low" } else { "None" }
}

// ------------------------------------------------------- SBOM conversions
// The stored document stays syft-json; CycloneDX / SPDX are generated on
// demand from the same package list so all three formats always agree.

pub fn cyclonedx_document(packages: &[SbomPackage], project_slug: &str) -> serde_json::Value {
    let components: Vec<serde_json::Value> = packages.iter().map(|p| serde_json::json!({
        "type": "library",
        "bom-ref": p.purl,
        "name": p.name,
        "version": p.version,
        "purl": p.purl,
        "properties": [{ "name": "vibeforge:ecosystem", "value": p.ecosystem }]
    })).collect();
    serde_json::json!({
        "bomFormat": "CycloneDX",
        "specVersion": "1.5",
        "version": 1,
        "metadata": {
            "tools": ["vibeforge"],
            "component": { "type": "application", "name": project_slug }
        },
        "components": components
    })
}

pub fn spdx_document(packages: &[SbomPackage], project_slug: &str, document_id: &str) -> serde_json::Value {
    let pkgs: Vec<serde_json::Value> = packages.iter().enumerate().map(|(i, p)| serde_json::json!({
        "SPDXID": format!("SPDXRef-Package-{}", i + 1),
        "name": p.name,
        "versionInfo": p.version,
        "downloadLocation": "NOASSERTION",
        "filesAnalyzed": false,
        "externalRefs": [{
            "referenceCategory": "PACKAGE-MANAGER",
            "referenceType": "purl",
            "referenceLocator": p.purl
        }]
    })).collect();
    serde_json::json!({
        "spdxVersion": "SPDX-2.3",
        "dataLicense": "CC0-1.0",
        "SPDXID": "SPDXRef-DOCUMENT",
        "name": project_slug,
        "documentNamespace": format!("https://vibeforge.local/sbom/{document_id}"),
        "creationInfo": { "creators": ["Tool: vibeforge"], "created": "1970-01-01T00:00:00Z" },
        "packages": pkgs,
        "hasExtractedLicensingInfos": [],
        "documentDescribes": pkgs.iter().map(|p| p["SPDXID"].clone()).collect::<Vec<_>>()
    })
}

#[cfg(test)]
mod export_tests {
    use super::*;

    fn sample() -> Vec<SbomPackage> {
        sbom_packages(&[
            Dep { ecosystem: "npm".into(), name: "react".into(), version: "19.1.0".into() },
            Dep { ecosystem: "crates.io".into(), name: "serde".into(), version: "1.0.0".into() },
        ])
    }

    #[test]
    fn cyclonedx_shape() {
        let doc = cyclonedx_document(&sample(), "demo");
        assert_eq!(doc["bomFormat"], "CycloneDX");
        assert_eq!(doc["specVersion"], "1.5");
        assert_eq!(doc["components"].as_array().unwrap().len(), 2);
        assert_eq!(doc["components"][0]["purl"], "pkg:npm/react@19.1.0");
    }

    #[test]
    fn spdx_shape() {
        let doc = spdx_document(&sample(), "demo", "ms-123");
        assert_eq!(doc["spdxVersion"], "SPDX-2.3");
        assert_eq!(doc["packages"].as_array().unwrap().len(), 2);
        assert_eq!(doc["packages"][1]["externalRefs"][0]["referenceLocator"], "pkg:cargo/serde@1.0.0");
        assert!(doc["documentNamespace"].as_str().unwrap().contains("ms-123"));
    }
}
