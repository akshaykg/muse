// Thin API client. The JWT lives in localStorage as `vf_token`;
// API tokens (`vatt_…`) are only ever used by the skill, never the browser.

const KEY = "vf_token";

export function getToken(): string | null {
  return localStorage.getItem(KEY);
}
export function setToken(t: string | null) {
  if (t) localStorage.setItem(KEY, t);
  else localStorage.removeItem(KEY);
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers: Record<string, string> = { ...(init.headers as Record<string, string> ?? {}) };
  const token = getToken();
  if (token) headers["Authorization"] = `Bearer ${token}`;
  if (init.body && typeof init.body === "string") headers["Content-Type"] = "application/json";
  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) throw new Error(data?.error ?? `Request failed (${res.status})`);
  return data as T;
}

export const api = {
  login: (email: string, password: string) =>
    req<{ token: string; user: unknown }>("/api/v1/auth/login", {
      method: "POST", body: JSON.stringify({ email, password }),
    }),
  me: () => req<{ user: { id: string; email: string; display_name: string; is_platform_admin: boolean }; spaces: { id: string; name: string; slug: string; role: string }[] }>("/api/v1/me"),
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
  project: (id: string) => req<{ project: { id: string; name: string; slug: string; space_id: string }; summary: { languages: string[]; milestones: number; open_findings: number; vulnerabilities: number; secrets: number; fix_now: number; fix_soon: number; good_to_know: number; last_push: string | null }; milestones: { id: string; seq_no: number; label: string; scan_status: string; languages: string[]; created_at: string; findings: number; screenshots: string[] }[] }>(`/api/v1/projects/${id}`),
  milestone: (id: string) => req<{
    milestone: { id: string; label: string; scan_status: string; created_at: string; screenshots: string[]; manifest: { about: string; stage: string } };
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
    const token = getToken();
    const res = await fetch(`/api/v1/projects/${projectId}/favicon`, {
      headers: { Authorization: token ? `Bearer ${token}` : "" },
    });
    if (!res.ok) return null;
    return URL.createObjectURL(await res.blob());
  },

  async pushZip(projectId: string, file: File, label: string): Promise<unknown> {
    const token = getToken();
    const res = await fetch(`/api/v1/projects/${projectId}/milestones`, {
      method: "POST",
      headers: {
        Authorization: token ? `Bearer ${token}` : "",
        "Content-Type": "application/zip",
        "X-Milestone-Label": label || file.name,
      },
      body: file,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? data?.message ?? `Upload failed (${res.status})`);
    return data;
  },

  async downloadSbom(milestoneId: string): Promise<void> {
    const token = getToken();
    const res = await fetch(`/api/v1/milestones/${milestoneId}/sbom`, {
      headers: { Authorization: token ? `Bearer ${token}` : "" },
    });
    if (!res.ok) throw new Error("Could not download the SBOM.");
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "SBOM.json";
    a.click();
    URL.revokeObjectURL(url);
  },

  async downloadExport(milestoneId: string, format: "cyclonedx" | "spdx"): Promise<void> {
    const token = getToken();
    const res = await fetch(`/api/v1/milestones/${milestoneId}/export/${format}`, {
      headers: { Authorization: token ? `Bearer ${token}` : "" },
    });
    if (!res.ok) throw new Error(`Could not export ${format}.`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = format === "cyclonedx" ? "SBOM.cyclonedx.json" : "SBOM.spdx.json";
    a.click();
    URL.revokeObjectURL(url);
  },

  async addScreenshot(milestoneId: string, file: File): Promise<unknown> {
    const token = getToken();
    const res = await fetch(`/api/v1/milestones/${milestoneId}/screenshots`, {
      method: "POST",
      headers: {
        Authorization: token ? `Bearer ${token}` : "",
        "Content-Type": file.type || "image/png",
        "X-Filename": file.name,
      },
      body: file,
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error ?? `Upload failed (${res.status})`);
    return data;
  },
};
