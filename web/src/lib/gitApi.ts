// Git setup client. Kept apart from api.ts so the feature stays in its own files.
import { req } from "./api";

export type HookPolicy = {
  secret_scan: boolean;
  block_large_files: boolean;
  large_file_mb: number;
  lint_format: boolean;
  conventional_commits: boolean;
  run_tests_pre_push: boolean;
  protect_default_branch: boolean;
};

export type GitConfig = {
  prompt_git: boolean;
  provider: "github" | "gitlab" | "bitbucket" | "azure" | "gitea" | "other" | string;
  host_url: string;
  default_branch: string;
  remote_protocol: "https" | "ssh" | string;
  ai_suggestions: boolean;
  hooks: HookPolicy;
  baseline_gitignore: string;
  custom_pre_commit: string;
};

export type GitStatus = {
  prompt_git: boolean;
  provider: string;
  host_url: string;
  default_branch: string;
  remote_protocol: string;
  ai_suggestions: boolean;
  ai_ready: boolean;
  profile_complete: boolean;
};

export type GitProfile = { name: string; email: string; username: string; remote_protocol: string; updated_at: string };

export type ProjectGit = {
  remote_url: string;
  branch: string;
  suggested_remote: string;
  connected: boolean;
  can_edit: boolean;
  prompt_git: boolean;
  updated_at: string;
};

export type HookFile = { name: string; title: string; why: string[]; script: string };

export type GitPlan = {
  source: "muse" | "starter";
  stack: string[];
  summary: string;
  gitignore: string;
  notes: { pattern: string; why: string }[];
  commands: { lint: string; format: string; test: string };
  hooks: HookFile[];
  tips: string[];
  would_ignore: string[];
  exposed: string[];
  existing_gitignore: boolean;
};

export type GitSuggestion = {
  milestone_id: string;
  status: "running" | "done" | "failed";
  model: string;
  started_at: string;
  finished_at: string | null;
  duration_ms: number;
  error: string | null;
};

export type GitPlanResponse = {
  plan: GitPlan;
  suggestion: GitSuggestion | null;
  setup_script: string;
  remote: string;
  branch: string;
  profile: GitProfile | null;
};

export const gitApi = {
  status: () => req<GitStatus>("/api/v1/git/status"),
  config: () => req<GitConfig>("/api/v1/admin/git"),
  saveConfig: (body: GitConfig) => req<GitConfig>("/api/v1/admin/git", { method: "PUT", body: JSON.stringify(body) }),
  profile: () => req<GitProfile>("/api/v1/me/git"),
  saveProfile: (body: Pick<GitProfile, "name" | "email" | "username" | "remote_protocol">) =>
    req<GitProfile>("/api/v1/me/git", { method: "PUT", body: JSON.stringify(body) }),
  project: (projectId: string) => req<ProjectGit>(`/api/v1/projects/${projectId}/git`),
  saveProject: (projectId: string, body: { remote_url: string; branch: string }) =>
    req<ProjectGit>(`/api/v1/projects/${projectId}/git`, { method: "PUT", body: JSON.stringify(body) }),
  plan: (milestoneId: string) => req<GitPlanResponse>(`/api/v1/milestones/${milestoneId}/git`),
  suggest: (milestoneId: string) => req<{ suggestion: GitSuggestion }>(`/api/v1/milestones/${milestoneId}/git/suggest`, { method: "POST" }),
};
