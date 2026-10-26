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

fn read_json(p: &Path) -> Option<serde_json::Value> {
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

impl LangScanner for JsScanner {
    fn name(&self) -> &'static str { "JavaScript / TypeScript" }
    fn collect_deps(&self, root: &Path) -> Vec<Dep> {
        let mut out = Vec::new();
        if let Some(v) = read_json(&root.join("package.json")) {
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
        if let Ok(text) = std::fs::read_to_string(root.join("requirements.txt")) {
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
        out
    }
}

impl LangScanner for GoScanner {
    fn name(&self) -> &'static str { "Go" }
    fn collect_deps(&self, root: &Path) -> Vec<Dep> {
        let mut out = Vec::new();
        if let Ok(text) = std::fs::read_to_string(root.join("go.mod")) {
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
        out
    }
}

impl LangScanner for JavaScanner {
    fn name(&self) -> &'static str { "Java" }
    fn collect_deps(&self, root: &Path) -> Vec<Dep> {
        let mut out = Vec::new();
        // Maven pom.xml — lightweight extraction (no XML dep needed for v1).
        if let Ok(text) = std::fs::read_to_string(root.join("pom.xml")) {
            let re = Regex::new(r"<dependency>\s*<groupId>([^<]+)</groupId>\s*<artifactId>([^<]+)</artifactId>\s*<version>([^<]+)</version>").unwrap();
            for c in re.captures_iter(&text) {
                out.push(Dep { ecosystem: "Maven".into(), name: format!("{}:{}", &c[1], &c[2]), version: c[3].to_string() });
            }
        }
        out
    }
}

impl LangScanner for PhpScanner {
    fn name(&self) -> &'static str { "PHP" }
    fn collect_deps(&self, root: &Path) -> Vec<Dep> {
        let mut out = Vec::new();
        if let Some(v) = read_json(&root.join("composer.json")) {
            if let Some(map) = v.get("require").and_then(|s| s.as_object()) {
                for (name, ver) in map {
                    if name == "php" { continue }
                    let version = ver.as_str().unwrap_or("").trim_start_matches(['^', '~', '>', '=', ' ']).to_string();
                    out.push(Dep { ecosystem: "Packagist".into(), name: name.clone(), version });
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
        if let Ok(text) = std::fs::read_to_string(root.join("Gemfile.lock")) {
            let re = Regex::new(r"^\s{4}([a-zA-Z0-9_\-]+) \(([^)]+)\)").unwrap();
            for line in text.lines() {
                if let Some(c) = re.captures(line) {
                    out.push(Dep { ecosystem: "RubyGems".into(), name: c[1].to_string(), version: c[2].to_string() });
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
    let mut out = Vec::new();
    for (dep, result) in deps.iter().zip(batch.results.iter()) {
        for vuln in &result.vulns {
            let fixed = vuln.affected.iter().flat_map(|a| a.ranges.iter())
                .flat_map(|r| r.events.iter()).find_map(|e| e.fixed.clone());
            let title = vuln.summary.clone().unwrap_or_else(|| format!("Known problem in {}", dep.name));
            out.push(Finding {
                id: uuid_like(),
                milestone_id: milestone_id.to_string(),
                kind: "cve".into(),
                severity: "high".into(),
                plain_title: format!("Update {} — {}", dep.name, title),
                plain_explain: format!("The version of {} in this project ({}) has a publicly known security problem ({}). Attackers look for exactly these.",
                    dep.name, dep.version, vuln.id),
                fix_text: match &fixed {
                    Some(v) => format!("Update {} to {} or later, then push a new milestone.", dep.name, v),
                    None => format!("Check the advisory for {} and update {} to the latest version.", vuln.id, dep.name),
                },
                file_path: None,
                line_no: None,
                cve_id: Some(vuln.aliases.first().cloned().unwrap_or_else(|| vuln.id.clone())),
                package: Some(dep.name.clone()),
                fixed_version: fixed,
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
        cve_id: None, package: None, fixed_version: None, status: "open".into(),
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
    checks.iter().filter(|(_, f)| root.join(f).exists()).map(|(n, _)| n.to_string()).collect()
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
    fn finds_hardcoded_secret() {
        let dir = std::env::temp_dir().join("vf-test-secret");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("app.js"), "const password = \"hunter2secret\";\n").unwrap();
        assert!(!scan_secrets(&dir, "ms-1").is_empty());
    }
}
