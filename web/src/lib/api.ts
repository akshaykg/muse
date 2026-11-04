// Thin API client. The JWT lives in localStorage as `vf_token`;
// API tokens (`vatt_…`) are only ever used by the skill, never the browser.

const KEY = "vf_token";
const REFRESH_KEY = "vf_refresh";

export function getToken(): string | null {
  return localStorage.getItem(KEY);
}
export function setToken(t: string | null) {
  if (t) localStorage.setItem(KEY, t);
  else localStorage.removeItem(KEY);
}
export function setRefreshToken(t: string | null) {
  if (t) localStorage.setItem(REFRESH_KEY, t);
  else localStorage.removeItem(REFRESH_KEY);
}

/** Sign out locally and revoke the refresh token on the server (best effort). */
export async function signOutEverywhere(): Promise<void> {
  const refresh = localStorage.getItem(REFRESH_KEY);
  setToken(null);
  setRefreshToken(null);
  if (refresh) {
    await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: refresh }),
    }).catch(() => {});
  }
}

// One refresh at a time, shared by every request that hit an expired session.
let refreshing: Promise<boolean> | null = null;
async function tryRefresh(): Promise<boolean> {
  const refresh = localStorage.getItem(REFRESH_KEY);
  if (!refresh) return false;
  refreshing ??= (async () => {
    try {
      const res = await fetch("/api/v1/auth/refresh", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: refresh }),
      });
      if (!res.ok) { setRefreshToken(null); return false; }
      const data = (await res.json()) as { token: string; refresh_token: string };
      setToken(data.token);
      setRefreshToken(data.refresh_token);
      return true;
    } catch {
      return false;
    } finally {
      window.setTimeout(() => { refreshing = null; }, 0);
    }
  })();
  return refreshing;
}

/** fetch with the session token; on 401 refresh the session once and retry. */
async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const run = () => {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) };
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
    return fetch(path, { ...init, headers });
  };
  let res = await run();
  if (res.status === 401 && getToken() && (await tryRefresh())) res = await run();
  return res;
}

async function parse(res: Response): Promise<{ error?: string; message?: string } & Record<string, unknown> | null> {
  const text = await res.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return { error: text.slice(0, 200) }; }
}

function failure(res: Response, data: { error?: string; message?: string } | null, fallback: string): Error {
  if (res.status === 413) return new Error("That file is larger than the server allows.");
  return new Error(data?.error ?? data?.message ?? `${fallback} (${res.status})`);
}

export async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) };
  if (init.body && typeof init.body === "string") headers["Content-Type"] = "application/json";
  const res = await authedFetch(path, { ...init, headers });
  const data = await parse(res);
  if (!res.ok) throw failure(res, data, "Request failed");
  return data as T;
}

async function download(path: string, filename: string, error: string): Promise<void> {
  const res = await authedFetch(path);
  if (!res.ok) throw new Error(error);
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export type PushResult = { milestone_id: string; seq_no?: number; findings: number; blocked?: boolean; message?: string };

export const api = {
  refresh: (refresh_token: string) =>
    req<{ token: string; refresh_token: string }>("/api/v1/auth/refresh", { method: "POST", body: JSON.stringify({ refresh_token }) }),
  forgot: (email: string) =>
    req<{ ok: boolean; reset_token?: string; message: string }>("/api/v1/auth/forgot", { method: "POST", body: JSON.stringify({ email }) }),
  resetPassword: (token: string, password: string) =>
    req("/api/v1/auth/reset", { method: "POST", body: JSON.stringify({ token, password }) }),
  registry: (q = "") => req<{ id: string; name: string; slug: string; milestones: number; latest_milestone: string | null; languages: string[]; open_findings: number }[]>(`/api/v1/registry?q=${encodeURIComponent(q)}`),
  setVisibility: (id: string, visibility: string) =>
    req(`/api/v1/projects/${id}/visibility`, { method: "POST", body: JSON.stringify({ visibility }) }),
  applyFix: (findingId: string) => req<{ milestone_id: string }>(`/api/v1/findings/${findingId}/apply-fix`, { method: "POST" }),
  mfaSetup: () => req<{ secret: string; otpauth_uri: string }>("/api/v1/me/mfa/setup", { method: "POST" }),
  mfaEnable: (code: string) => req("/api/v1/me/mfa/enable", { method: "POST", body: JSON.stringify({ code }) }),
  mfaDisable: (code: string) => req("/api/v1/me/mfa/disable", { method: "POST", body: JSON.stringify({ code }) }),
  myExport: () => download("/api/v1/me/export", "vibeforge-export.json", "Export failed."),
  deleteMe: (password: string) => req("/api/v1/me/delete", { method: "DELETE", body: JSON.stringify({ password }) }),
  login: (email: string, password: string, totp_code?: string) =>
    req<{ token: string; refresh_token: string; user: unknown }>("/api/v1/auth/login", {
      method: "POST", body: JSON.stringify({ email, password, totp_code }),
    }),
  me: () => req<{ user: { id: string; email: string; display_name: string; is_platform_admin: boolean }; mfa_enabled?: boolean; spaces: { id: string; name: string; slug: string; role: string }[] }>("/api/v1/me"),
  myProjects: () => req<{ id: string; space_id: string; slug: string; name: string; milestones: number }[]>("/api/v1/me/projects"),
  tokens: () => req<{ id: string; name: string; prefix: string; scopes: string[]; revoked: boolean; created_at: string }[]>("/api/v1/me/tokens"),
  createToken: (name: string) =>
    req<{ id: string; token: string; note: string }>("/api/v1/me/tokens", { method: "POST", body: JSON.stringify({ name, scopes: ["read", "push"] }) }),
  revokeToken: (id: string) => req(`/api/v1/me/tokens/${id}`, { method: "DELETE" }),
  spaces: () => req<{ id: string; slug: string; name: string; role: string; projects: number; milestones: number; members: number; open_findings: number; vulnerabilities: number; last_activity: string | null }[]>("/api/v1/spaces"),
  createSpace: (name: string) => req("/api/v1/spaces", { method: "POST", body: JSON.stringify({ name }) }),
  members: (spaceId: string) => req<{ principal_kind: string; principal_id: string; label: string; role: string }[]>(`/api/v1/spaces/${spaceId}/members`),
  addMember: (spaceId: string, body: { principal_kind: string; principal_id: string; role: string }) =>
    req(`/api/v1/spaces/${spaceId}/members`, { method: "POST", body: JSON.stringify(body) }),
  spaceProjects: (spaceId: string) => req<{ id: string; slug: string; name: string; milestones: number; languages: string[]; last_activity: string | null; open_findings: number; vulnerabilities: number }[]>(`/api/v1/spaces/${spaceId}/projects`),
  createProject: (spaceId: string, name: string) =>
    req<{ id: string }>(`/api/v1/spaces/${spaceId}/projects`, { method: "POST", body: JSON.stringify({ name }) }),
  project: (id: string) => req<{ project: { id: string; name: string; slug: string; space_id: string; visibility?: string }; summary: { languages: string[]; milestones: number; open_findings: number; vulnerabilities: number; secrets: number; fix_now: number; fix_soon: number; good_to_know: number; last_push: string | null }; milestones: { id: string; seq_no: number; label: string; scan_status: string; languages: string[]; created_at: string; findings: number; screenshots: string[] }[] }>(`/api/v1/projects/${id}`),
  milestone: (id: string) => req<{
    milestone: { id: string; seq_no: number; label: string; scan_status: string; created_at: string; screenshots: string[]; manifest: { about: string; stage: string } };
    files: { path: string; size_bytes: number }[];
    findings: { id: string; kind: string; severity: string; plain_title: string; plain_explain: string; fix_text: string; file_path: string | null; status: string; cve_id: string | null; package: string | null; current_version: string | null; fixed_version: string | null; cvss_score: number | null; cvss_vector: string | null }[];
    todos: { id: string; body: string; done: boolean; source: string }[];
    sbom: { tool: string; total: number; packages: { name: string; version: string; type: string; purl: string; ecosystem: string | null }[] };
  }>(`/api/v1/milestones/${id}`),
  fileContent: (id: string, path: string) =>
    req<{ path: string; text: string }>(`/api/v1/milestones/${id}/files/content?path=${encodeURIComponent(path)}`),
  ignoreFinding: (id: string) => req(`/api/v1/findings/${id}/ignore`, { method: "POST" }),
  fork: (id: string, to_project_id: string, label: string) =>
    req(`/api/v1/milestones/${id}/fork`, { method: "POST", body: JSON.stringify({ to_project_id, label }) }),
  adminUsers: () => req<{ id: string; email: string; display_name: string; is_platform_admin: boolean; is_blocked: boolean }[]>("/api/v1/admin/users"),
  adminCreateUser: (body: { email: string; display_name: string; password: string; is_platform_admin: boolean }) =>
    req("/api/v1/admin/users", { method: "POST", body: JSON.stringify(body) }),
  adminBlock: (id: string, reason: string) => req(`/api/v1/admin/users/${id}/block`, { method: "POST", body: JSON.stringify({ reason }) }),
  adminUnblock: (id: string) => req(`/api/v1/admin/users/${id}/unblock`, { method: "POST" }),
  adminNudge: (id: string, message: string) => req(`/api/v1/admin/users/${id}/nudge`, { method: "POST", body: JSON.stringify({ message }) }),
  adminGroups: () => req<{ id: string; name: string; description: string; member_ids: string[] }[]>("/api/v1/admin/groups"),
  adminCreateGroup: (body: { name: string; description: string; member_ids: string[] }) =>
    req("/api/v1/admin/groups", { method: "POST", body: JSON.stringify(body) }),
  adminVulns: () => req<{ total_open: number; critical: number; rows: { finding_id: string; severity: string; title: string; project: string; owner: string; owner_id: string }[] }>("/api/v1/admin/vulns"),
  settings: () => req<Record<string, unknown>>("/api/v1/admin/settings"),
  putSettings: (body: Record<string, unknown>) => req("/api/v1/admin/settings", { method: "PUT", body: JSON.stringify(body) }),

  async faviconUrl(projectId: string): Promise<string | null> {
    const res = await authedFetch(`/api/v1/projects/${projectId}/favicon`);
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  },

  /** Signed-in image fetch (screenshots) as an object URL. */
  async blobUrl(key: string): Promise<string | null> {
    const res = await authedFetch(`/api/v1/blobs/${key.split("/").map(encodeURIComponent).join("/")}`);
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  },

  /** Push a zip. A policy-blocked push is still saved, so it resolves with blocked: true. */
  async pushZip(projectId: string, file: File, label: string): Promise<PushResult> {
    // Header values must be ISO-8859-1; strip anything else so fetch never throws on emoji.
    const safeLabel = (label || file.name).replace(/[^\x20-\x7E\u00A0-\u00FF]/g, "").slice(0, 200);
    const res = await authedFetch(`/api/v1/projects/${projectId}/milestones`, {
      method: "POST",
      headers: { "Content-Type": "application/zip", "X-Milestone-Label": safeLabel || "Milestone" },
      body: file,
    });
    const data = await parse(res);
    if (res.status === 422 && data?.blocked) return data as unknown as PushResult;
    if (!res.ok) throw failure(res, data, "Upload failed");
    return data as unknown as PushResult;
  },

  downloadSbom: (milestoneId: string) => download(`/api/v1/milestones/${milestoneId}/sbom`, "SBOM.json", "Could not download the SBOM."),
  downloadMilestone: (milestoneId: string, filename: string) =>
    download(`/api/v1/milestones/${milestoneId}/download`, filename, "Could not download this milestone."),

  downloadExport: (milestoneId: string, format: "cyclonedx" | "spdx") =>
    download(`/api/v1/milestones/${milestoneId}/export/${format}`, format === "cyclonedx" ? "SBOM.cyclonedx.json" : "SBOM.spdx.json", `Could not export ${format}.`),

  async addScreenshot(milestoneId: string, file: File): Promise<unknown> {
    const res = await authedFetch(`/api/v1/milestones/${milestoneId}/screenshots`, {
      method: "POST",
      headers: {
        "Content-Type": file.type || "image/png",
        "X-Filename": file.name.replace(/[^\x20-\x7E]/g, "_"),
      },
      body: file,
    });
    const data = await parse(res);
    if (!res.ok) throw failure(res, data, "Upload failed");
    return data;
  },
};
