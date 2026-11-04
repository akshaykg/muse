// AI review client (Meta Muse). Kept apart from api.ts so the feature stays in its own files.
import { req } from "./api";

export type AiIssue = {
  id: string;
  category: "secrets" | "security" | "privacy" | "best_practice" | "reliability" | "performance" | string;
  severity: "critical" | "high" | "medium" | "low" | string;
  title: string;
  explain: string;
  why_it_matters: string;
  file: string | null;
  line: number | null;
  fix_steps: string[];
  ai_prompt: string;
  status: "open" | "ignored" | string;
};

export type AiReview = {
  milestone_id: string;
  status: "running" | "done" | "failed";
  model: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  error: string | null;
  files_reviewed: number;
  files_skipped: number;
  chars_sent: number;
  secrets_masked: number;
  score: number;
  grade: string;
  headline: string;
  summary: string;
  strengths: string[];
  issues: AiIssue[];
  fix_all_prompt: string;
};

export type AiStatus = { enabled: boolean; configured: boolean; model: string; model_label: string };

export type AiConfig = {
  enabled: boolean;
  base_url: string;
  model: string;
  redact_secrets: boolean;
  max_chars: number;
  reasoning_effort: string;
  auto_preview: boolean;
  api_key_set: boolean;
  api_key_source: "settings" | "env" | "none";
  api_key_hint: string;
};

export type AiModel = { id: string; label: string; note?: string; price?: string; recommended?: boolean; trains_on_data?: boolean };

export type AiConfigUpdate = Omit<AiConfig, "api_key_set" | "api_key_source" | "api_key_hint"> & { api_key?: string; clear_api_key?: boolean };

export type AiPreview = { milestone_id: string; status: "running" | "done" | "failed"; model: string; started_at: string; finished_at: string | null; duration_ms: number; error: string | null; title: string; caption: string; html: string };

export const aiApi = {
  preview: (milestoneId: string) => req<{ preview: AiPreview | null }>(`/api/v1/milestones/${milestoneId}/ai-preview`),
  startPreview: (milestoneId: string) => req<{ preview: AiPreview }>(`/api/v1/milestones/${milestoneId}/ai-preview`, { method: "POST" }),
  status: () => req<AiStatus>("/api/v1/ai/status"),
  review: (milestoneId: string) => req<{ review: AiReview | null }>(`/api/v1/milestones/${milestoneId}/ai-review`),
  start: (milestoneId: string) => req<{ review: AiReview }>(`/api/v1/milestones/${milestoneId}/ai-review`, { method: "POST" }),
  toggleIgnore: (milestoneId: string, issueId: string) =>
    req<{ ok: boolean; status: string }>(`/api/v1/milestones/${milestoneId}/ai-review/issues/${issueId}/ignore`, { method: "POST" }),
  config: () => req<AiConfig>("/api/v1/admin/ai"),
  saveConfig: (body: AiConfigUpdate) => req<AiConfig>("/api/v1/admin/ai", { method: "PUT", body: JSON.stringify(body) }),
  models: () => req<{ live: boolean; models: AiModel[] }>("/api/v1/admin/ai/models"),
  test: (body: { model?: string; api_key?: string; base_url?: string }) =>
    req<{ ok: boolean; model: string; latency_ms: number; reply: string }>("/api/v1/admin/ai/test", { method: "POST", body: JSON.stringify(body) }),
};
