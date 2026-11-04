//! MCP (Model Context Protocol) endpoint and milestone download.
//!
//! `POST /mcp` speaks JSON-RPC 2.0 over MCP's Streamable HTTP transport
//! (plain JSON responses, no SSE). AI tools connect with an API token
//! (`Authorization: Bearer vatt_…`) and get the same tools the skill uses:
//! list projects and milestones, push a milestone, read findings, and
//! restore a milestone to a local folder.
//!
//! Every tool calls the matching REST handler, so RBAC, quotas, scanning and
//! audit logging are exactly the same as for the REST API.

use super::*;
use base64::Engine;

const PROTOCOL_VERSION: &str = "2025-06-18";

/// `GET /api/v1/milestones/{id}/download` — the original zip of one milestone.
/// Used by "Restore this milestone locally" in the web UI and by the MCP
/// `restore_milestone` tool.
pub async fn download_milestone(State(state): State<Shared>, headers: HeaderMap, Path(id): Path<String>) -> Response {
    let a = auth!(&state, &headers);
    let (key, filename) = {
        let store = state.store.read().await;
        let Some(m) = store.milestones.get(&id) else { return err(StatusCode::NOT_FOUND, "Milestone not found."); };
        let Some(p) = can_read_project(&store, &a.0, &m.project_id) else { return err(StatusCode::NOT_FOUND, "Milestone not found."); };
        (m.blob_key.clone(), format!("{}-milestone-{}.zip", p.slug, m.seq_no))
    };
    match blob_get(&state, &key).await {
        Ok(bytes) => {
            audit(&state, &a.0.id, "milestone:download", "milestone", &id, "success").await;
            (
                StatusCode::OK,
                [
                    (axum::http::header::CONTENT_TYPE, "application/zip".to_string()),
                    (axum::http::header::CONTENT_DISPOSITION, format!("attachment; filename=\"{filename}\"")),
                ],
                bytes,
            ).into_response()
        }
        Err(_) => err(StatusCode::NOT_FOUND, "The zip for this milestone is missing."),
    }
}

fn rpc_result(id: &serde_json::Value, result: serde_json::Value) -> Response {
    Json(serde_json::json!({ "jsonrpc": "2.0", "id": id, "result": result })).into_response()
}

fn rpc_error(id: &serde_json::Value, code: i64, message: &str) -> Response {
    Json(serde_json::json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })).into_response()
}

fn tool_text(value: serde_json::Value, is_error: bool) -> serde_json::Value {
    let text = if let Some(s) = value.as_str() { s.to_string() } else { serde_json::to_string_pretty(&value).unwrap_or_default() };
    serde_json::json!({ "content": [{ "type": "text", "text": text }], "isError": is_error })
}

fn tools() -> serde_json::Value {
    serde_json::json!([
        {
            "name": "list_projects",
            "description": "List the VibeForge projects you can see, with their ids and milestone counts.",
            "inputSchema": { "type": "object", "properties": {} }
        },
        {
            "name": "list_milestones",
            "description": "List every milestone of a project, oldest first (seq_no 1, 2, 3 …).",
            "inputSchema": { "type": "object", "properties": {
                "project_id": { "type": "string", "description": "Project id from list_projects" }
            }, "required": ["project_id"] }
        },
        {
            "name": "push_milestone",
            "description": "Save the project as a new milestone. Zip the project folder (no .git, node_modules or .env). For small zips pass it base64-encoded as zip_base64; leave zip_base64 out to get a curl command that uploads the zip file directly (better for large projects). Each push is a new milestone; nothing is overwritten.",
            "inputSchema": { "type": "object", "properties": {
                "project_id": { "type": "string" },
                "label": { "type": "string", "description": "One line: what changed, e.g. 'login page works'" },
                "zip_base64": { "type": "string", "description": "The project zip, base64-encoded (optional)" }
            }, "required": ["project_id", "label"] }
        },
        {
            "name": "get_findings",
            "description": "Security and quality findings for one milestone (secrets, CVEs, bad practices), with plain-language fixes.",
            "inputSchema": { "type": "object", "properties": {
                "milestone_id": { "type": "string" }
            }, "required": ["milestone_id"] }
        },
        {
            "name": "restore_milestone",
            "description": "Get what you need to revert the local project folder to an earlier milestone: a download URL for its zip and the commands to unpack it. Ask the user before replacing local files.",
            "inputSchema": { "type": "object", "properties": {
                "milestone_id": { "type": "string" }
            }, "required": ["milestone_id"] }
        }
    ])
}

/// Turn a REST handler's response into (ok, json body).
async fn response_json(resp: Response) -> (bool, serde_json::Value) {
    let ok = resp.status().is_success();
    let bytes = axum::body::to_bytes(resp.into_body(), 16 * 1024 * 1024).await.unwrap_or_default();
    let value = serde_json::from_slice(&bytes).unwrap_or(serde_json::Value::Null);
    (ok, value)
}

fn base_url(settings: &Settings, headers: &HeaderMap) -> String {
    if !settings.public_base_url.trim().is_empty() {
        return settings.public_base_url.trim().trim_end_matches('/').to_string();
    }
    let host = header_str(headers, "host");
    if host.is_empty() { "http://localhost:8080".into() } else { format!("http://{host}") }
}

fn arg(args: &serde_json::Value, name: &str) -> Option<String> {
    args.get(name).and_then(|v| v.as_str()).map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

async fn call_tool(state: &Shared, headers: &HeaderMap, name: &str, args: &serde_json::Value) -> serde_json::Value {
    let auth_only = {
        let mut h = HeaderMap::new();
        if let Some(v) = headers.get("authorization") { h.insert("authorization", v.clone()); }
        h
    };
    match name {
        "list_projects" => {
            let (ok, v) = response_json(my_projects(State(state.clone()), auth_only).await).await;
            tool_text(v, !ok)
        }
        "list_milestones" => {
            let Some(pid) = arg(args, "project_id") else { return tool_text("project_id is required.".into(), true) };
            let (ok, v) = response_json(list_milestones(State(state.clone()), auth_only, Path(pid)).await).await;
            tool_text(v, !ok)
        }
        "get_findings" => {
            let Some(mid) = arg(args, "milestone_id") else { return tool_text("milestone_id is required.".into(), true) };
            let (ok, v) = response_json(milestone_findings(State(state.clone()), auth_only, Path(mid)).await).await;
            tool_text(v, !ok)
        }
        "push_milestone" => {
            let (Some(pid), Some(label)) = (arg(args, "project_id"), arg(args, "label")) else {
                return tool_text("project_id and label are required.".into(), true);
            };
            let Some(b64) = arg(args, "zip_base64") else {
                let settings = state.store.read().await.settings.clone();
                let url = format!("{}/api/v1/projects/{}/milestones", base_url(&settings, headers), pid);
                let safe_label = label.replace(['"', '\\', '$', '`'], "");
                return tool_text(serde_json::json!({
                    "upload_with": [
                        "zip -r /tmp/vibeforge-push.zip . -x \".git/*\" \"node_modules/*\" \".env\" \".env.*\"",
                        format!("curl -fsS -X POST \"{url}\" -H \"Authorization: Bearer $VIBEFORGE_TOKEN\" -H \"Content-Type: application/zip\" -H \"X-Milestone-Label: {safe_label}\" --data-binary @/tmp/vibeforge-push.zip")
                    ]
                }), false);
            };
            let Ok(zip) = base64::engine::general_purpose::STANDARD.decode(b64.as_bytes()) else {
                return tool_text("zip_base64 is not valid base64.".into(), true);
            };
            let mut h = auth_only;
            let label: String = label.chars().filter(|c| !c.is_control()).take(200).collect();
            match axum::http::HeaderValue::from_str(&label) {
                Ok(v) => { h.insert("x-milestone-label", v); }
                Err(_) => return tool_text("label must be plain text.".into(), true),
            }
            let (ok, v) = response_json(push_milestone(State(state.clone()), h, Path(pid), Bytes::from(zip)).await).await;
            tool_text(v, !ok)
        }
        "restore_milestone" => {
            let Some(mid) = arg(args, "milestone_id") else { return tool_text("milestone_id is required.".into(), true) };
            let (ok, v) = response_json(get_milestone(State(state.clone()), auth_only, Path(mid.clone())).await).await;
            if !ok { return tool_text(v, true); }
            let settings = state.store.read().await.settings.clone();
            let url = format!("{}/api/v1/milestones/{}/download", base_url(&settings, headers), mid);
            let m = &v["milestone"];
            tool_text(serde_json::json!({
                "milestone_id": mid,
                "seq_no": m["seq_no"],
                "label": m["label"],
                "download_url": url,
                "steps": [
                    "Confirm with the user before replacing local files, and offer to push the current state as a milestone first so nothing is lost.",
                    format!("curl -fsSL -H \"Authorization: Bearer $VIBEFORGE_TOKEN\" -o /tmp/vibeforge-restore.zip \"{url}\""),
                    "Remove the project's tracked files (keep .git, node_modules, .env and other ignored files), then: unzip -o /tmp/vibeforge-restore.zip -d .",
                    "Tell the user which milestone the folder now matches."
                ]
            }), false)
        }
        _ => tool_text(format!("Unknown tool: {name}").into(), true),
    }
}

/// `POST /mcp` — one JSON-RPC message per request.
pub async fn mcp_post(State(state): State<Shared>, headers: HeaderMap, body: Bytes) -> Response {
    // Every MCP call needs a valid token, including initialize.
    if let Err(code) = authenticate(&state, &headers).await {
        return (code, [("WWW-Authenticate", "Bearer")], Json(serde_json::json!({ "error": "Send an API token: Authorization: Bearer vatt_…" }))).into_response();
    }
    let Ok(msg) = serde_json::from_slice::<serde_json::Value>(&body) else {
        return rpc_error(&serde_json::Value::Null, -32700, "Parse error");
    };
    if msg.is_array() {
        return rpc_error(&serde_json::Value::Null, -32600, "Batches are not supported");
    }
    let method = msg["method"].as_str().unwrap_or("");
    let Some(id) = msg.get("id").cloned() else {
        // Notifications (e.g. notifications/initialized) get no body.
        return StatusCode::ACCEPTED.into_response();
    };
    match method {
        "initialize" => rpc_result(&id, serde_json::json!({
            "protocolVersion": msg["params"]["protocolVersion"].as_str().unwrap_or(PROTOCOL_VERSION),
            "capabilities": { "tools": { "listChanged": false } },
            "serverInfo": { "name": "vibeforge", "version": env!("CARGO_PKG_VERSION") },
            "instructions": "VibeForge stores AI-built projects as milestones (zip + scan). Use list_projects, then push_milestone to save, list_milestones to see history, and restore_milestone to revert the local folder to an earlier milestone."
        })),
        "ping" => rpc_result(&id, serde_json::json!({})),
        "tools/list" => rpc_result(&id, serde_json::json!({ "tools": tools() })),
        "tools/call" => {
            let name = msg["params"]["name"].as_str().unwrap_or("").to_string();
            let args = msg["params"]["arguments"].clone();
            let result = call_tool(&state, &headers, &name, &args).await;
            rpc_result(&id, result)
        }
        _ => rpc_error(&id, -32601, "Method not found"),
    }
}

/// `GET /mcp` — this server does not open server-initiated streams.
pub async fn mcp_get() -> Response {
    StatusCode::METHOD_NOT_ALLOWED.into_response()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tools_have_schemas() {
        let t = tools();
        let names: Vec<_> = t.as_array().unwrap().iter().map(|x| x["name"].as_str().unwrap().to_string()).collect();
        assert_eq!(names, ["list_projects", "list_milestones", "push_milestone", "get_findings", "restore_milestone"]);
        for x in t.as_array().unwrap() { assert_eq!(x["inputSchema"]["type"], "object"); }
    }
}
