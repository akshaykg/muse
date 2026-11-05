// AI assessment client (Meta Muse release-readiness report). Kept in its own file like aiApi.ts.
import { req } from "./api";

export type Verdict = { value: string; detail: string; confidence: "high" | "medium" | "low" | string };

export type AssessAsset = {
  name: string;
  kind: string;
  file: string | null;
  source: string;
  license: string;
  status: "ok" | "needs_check" | "paid" | "unlicensed" | string;
  note: string;
};

export type AssessIssue = {
  id: string;
  category: "licensing" | "third_party_assets" | "paid_media" | "deployment" | "audience" | "privacy" | "mobile" | "compliance" | string;
  severity: "critical" | "high" | "medium" | "low" | string;
  title: string;
  explain: string;
  evidence: string | null;
  line: number | null;
  recommendation: string;
  ai_prompt: string;
  source: "ai" | "check" | string;
  status: "open" | "ignored" | string;
};

export type AssessSignals = {
  license_files: string[];
  license_text_id: string;
  declared_licenses: string[];
  attribution_files: string[];
  policy_files: string[];
  mobile: string[];
  deployment: string[];
  ci: string[];
  media: { path: string; kind: string; size_bytes: number }[];
  media_total: number;
  stock_hints: string[];
  asset_hosts: string[];
  paid_hosts: string[];
  external_domains: string[];
};

export type AiAssessment = {
  milestone_id: string;
  project_id: string;
  status: "running" | "done" | "failed";
  model: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  error: string | null;
  files_read: number;
  secrets_masked: number;
  readiness: number;
  risk: "low" | "medium" | "high" | "critical" | string;
  headline: string;
  summary: string;
  audience: Verdict;
  platforms: string[];
  mobile: Verdict;
  deployment: Verdict;
  deploy_targets: string[];
  license: Verdict;
  project_license: string;
  personal_data: boolean;
  payments: boolean;
  data_detail: string;
  assets: AssessAsset[];
  issues: AssessIssue[];
  strengths: string[];
  tags: string[];
  signals: AssessSignals;
};

export type AssessRow = {
  milestone_id: string;
  project_id: string | null;
  project: string | null;
  space: string | null;
  owner: string | null;
  owner_id: string | null;
  seq_no: number | null;
  label: string | null;
  is_latest: boolean;
  finished_at: string | null;
  model: string;
  readiness: number;
  risk: string;
  headline: string;
  audience: string;
  platforms: string[];
  mobile: boolean;
  deployment: string;
  deploy_targets: string[];
  license: string;
  license_status: string;
  paid_media: boolean;
  unlicensed_assets: number;
  personal_data: boolean;
  payments: boolean;
  tags: string[];
  issues_open: number;
  urgent: number;
  top_issues: { title: string; severity: string; category: string }[];
  score: number;
};

export type AssessSearch = {
  total: number;
  indexed: number;
  projects: number;
  rows: AssessRow[];
  facets: Partial<Record<"audience" | "risk" | "license" | "deployment" | "platform" | "category" | "flag", Record<string, number>>>;
};

export type AssessFilters = {
  q?: string; audience?: string; platform?: string; risk?: string; license?: string;
  category?: string; deployment?: string; flag?: string; scope?: string; sort?: string;
};

export const assessApi = {
  get: (milestoneId: string) => req<{ assessment: AiAssessment | null }>(`/api/v1/milestones/${milestoneId}/ai-assessment`),
  start: (milestoneId: string) => req<{ assessment: AiAssessment }>(`/api/v1/milestones/${milestoneId}/ai-assessment`, { method: "POST" }),
  toggleIgnore: (milestoneId: string, issueId: string) =>
    req<{ ok: boolean; status: string }>(`/api/v1/milestones/${milestoneId}/ai-assessment/issues/${issueId}/ignore`, { method: "POST" }),
  search: (f: AssessFilters) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(f)) if (v) p.set(k, v);
    return req<AssessSearch>(`/api/v1/admin/assessments?${p.toString()}`);
  },
};

// ------------------------------------------------------------------ shared words

export const AUDIENCE: Record<string, { label: string; emoji: string }> = {
  internal: { label: "Internal", emoji: "🏢" },
  external: { label: "External", emoji: "🌍" },
  public: { label: "Public", emoji: "📣" },
  mixed: { label: "Internal + external", emoji: "🔀" },
  unknown: { label: "Unclear", emoji: "❔" },
};

export const PLATFORM: Record<string, string> = {
  web: "Web", ios: "iOS", android: "Android", desktop: "Desktop", cli: "Command line", api: "API", library: "Library", other: "Other",
};

export const MOBILE: Record<string, string> = {
  native: "Native mobile app", cross_platform: "Cross-platform mobile", pwa: "Installable web app (PWA)", none: "Not a mobile app",
};

export const DEPLOY: Record<string, string> = {
  configured: "Deploy configured", planned: "Deploy planned", unclear: "Deploy unclear", none: "No deploy plan",
};

export const LICENSE_STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  ok: { label: "Licence OK", tone: "success" },
  missing: { label: "No licence", tone: "danger" },
  conflict: { label: "Licence conflict", tone: "danger" },
  unclear: { label: "Licence unclear", tone: "warning" },
};

export const RISK: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  low: { label: "Low risk", tone: "success" },
  medium: { label: "Medium risk", tone: "warning" },
  high: { label: "High risk", tone: "danger" },
  critical: { label: "Critical risk", tone: "danger" },
};

export const ISSUE_CATEGORY: Record<string, { label: string; emoji: string }> = {
  licensing: { label: "Licensing", emoji: "📜" },
  third_party_assets: { label: "Third-party assets", emoji: "🧩" },
  paid_media: { label: "Paid media", emoji: "💳" },
  deployment: { label: "Deployment", emoji: "🚀" },
  audience: { label: "Audience & access", emoji: "👥" },
  privacy: { label: "Privacy", emoji: "👁️" },
  mobile: { label: "Mobile & stores", emoji: "📱" },
  compliance: { label: "Compliance", emoji: "⚖️" },
};

export const ASSET_STATUS: Record<string, { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  ok: { label: "OK to use", tone: "success" },
  needs_check: { label: "Check source", tone: "warning" },
  paid: { label: "Needs paid licence", tone: "danger" },
  unlicensed: { label: "No permission", tone: "danger" },
};

export const FLAG: Record<string, string> = {
  paid_media: "Paid media", unlicensed: "Unlicensed assets", personal_data: "Personal data", payments: "Takes payments", mobile: "Mobile",
};

/** The report as Markdown, for download or pasting into a ticket. */
export function assessmentMarkdown(a: AiAssessment, projectName: string, label: string): string {
  const lines: string[] = [];
  const open = a.issues.filter((i) => i.status !== "ignored");
  lines.push(`# AI assessment: ${projectName}`, "", `Milestone: ${label}  `, `Assessed by Meta Muse (${a.model}) on ${a.finished_at?.slice(0, 10) ?? ""}`, "");
  lines.push(`**Readiness ${a.readiness}/100 · ${RISK[a.risk]?.label ?? a.risk}**`, "", a.headline, "", a.summary, "");
  lines.push("## Profile", "", "| | |", "|---|---|");
  lines.push(`| Audience | ${AUDIENCE[a.audience.value]?.label ?? a.audience.value}: ${a.audience.detail} |`);
  lines.push(`| Platforms | ${a.platforms.map((p) => PLATFORM[p] ?? p).join(", ") || "—"} (${MOBILE[a.mobile.value] ?? a.mobile.value}) |`);
  lines.push(`| Deployment | ${DEPLOY[a.deployment.value] ?? a.deployment.value}${a.deploy_targets.length ? ` (${a.deploy_targets.join(", ")})` : ""}: ${a.deployment.detail} |`);
  lines.push(`| Licence | ${a.project_license} · ${LICENSE_STATUS[a.license.value]?.label ?? a.license.value}: ${a.license.detail} |`);
  lines.push(`| Data | ${a.personal_data ? "Collects personal data" : "No personal data found"}; ${a.payments ? "takes payments" : "no payments"}. ${a.data_detail} |`, "");
  lines.push(`## Possible issues (${open.length})`, "");
  open.forEach((i, n) => {
    lines.push(`### ${n + 1}. ${i.title}`, "", `*${i.severity} · ${ISSUE_CATEGORY[i.category]?.label ?? i.category}${i.evidence ? ` · ${i.evidence}${i.line ? `:${i.line}` : ""}` : ""}*`, "", i.explain, "", `**What to do:** ${i.recommendation}`, "");
    if (i.ai_prompt) lines.push("```", i.ai_prompt, "```", "");
  });
  if (a.assets.length) {
    lines.push("## Third-party assets", "", "| Asset | Kind | Source | Licence | Status |", "|---|---|---|---|---|");
    for (const x of a.assets) lines.push(`| ${x.name}${x.file ? ` (${x.file})` : ""} | ${x.kind} | ${x.source} | ${x.license} | ${ASSET_STATUS[x.status]?.label ?? x.status} |`);
    lines.push("");
  }
  lines.push("---", "AI can be wrong and this is not legal advice. Check anything important with the owner or your legal contact.");
  return lines.join("\n");
}
