import { useEffect, useState } from "react";
import { gitApi, type GitConfig, type HookPolicy } from "../lib/gitApi";
import { Alert, Badge, Button, Card, Input, Label, Select, Skeleton, Toggle, useToast } from "./ui";
import { IconGit } from "./GitPanel";
import { IconSparkles } from "./AiReview";

const PROVIDERS = [
  { value: "github", label: "GitHub", host: "https://github.com/your-org" },
  { value: "gitlab", label: "GitLab", host: "https://gitlab.com/your-group" },
  { value: "bitbucket", label: "Bitbucket", host: "https://bitbucket.org/your-workspace" },
  { value: "azure", label: "Azure DevOps", host: "https://dev.azure.com/your-org/your-project/_git" },
  { value: "gitea", label: "Gitea / Forgejo", host: "https://git.example.com/team" },
  { value: "other", label: "Other", host: "https://git.example.com/team" },
];

function Section({ title, description, children, aside }: { title: string; description?: string; children: React.ReactNode; aside?: React.ReactNode }) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-3.5">
        <div>
          <h3 className="font-serif text-base font-bold text-text">{title}</h3>
          {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
        </div>
        {aside}
      </div>
      <div className="mt-4 space-y-4">{children}</div>
    </Card>
  );
}

const textarea = "min-h-32 w-full rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs leading-relaxed text-text shadow-xs transition duration-fast ease-standard hover:border-text-muted/50 focus:border-primary focus:outline-none focus:ring-4 focus:ring-primary/15";

export function GitSettings() {
  const [cfg, setCfg] = useState<GitConfig | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  useEffect(() => { gitApi.config().then(setCfg).catch((e) => setError(e instanceof Error ? e.message : "Could not load Git settings.")); }, []);

  if (error && !cfg) return <Alert>{error}</Alert>;
  if (!cfg) return <div className="space-y-3"><Skeleton className="h-28" /><Skeleton className="h-64" /></div>;

  const set = <K extends keyof GitConfig>(k: K, v: GitConfig[K]) => setCfg({ ...cfg, [k]: v });
  const hook = <K extends keyof HookPolicy>(k: K, v: HookPolicy[K]) => setCfg({ ...cfg, hooks: { ...cfg.hooks, [k]: v } });
  const provider = PROVIDERS.find((p) => p.value === cfg.provider) ?? PROVIDERS[0];
  const hookCount = [cfg.hooks.secret_scan, cfg.hooks.block_large_files, cfg.hooks.lint_format, cfg.hooks.conventional_commits, cfg.hooks.run_tests_pre_push, cfg.hooks.protect_default_branch].filter(Boolean).length;

  const save = async () => {
    setSaving(true); setError("");
    try { setCfg(await gitApi.saveConfig(cfg)); toast.success("Git settings saved."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save."); }
    finally { setSaving(false); }
  };

  return (
    <div className="space-y-5">
      <Card className="relative overflow-hidden p-5">
        <div aria-hidden className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex items-start gap-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-info text-primary-fg shadow-raised"><IconGit width={20} height={20} /></span>
          <div className="min-w-0 flex-1">
            <Toggle
              checked={cfg.prompt_git}
              onChange={(v) => set("prompt_git", v)}
              label="Ask people to use Git"
              description="Projects without a Git remote show a short “Use Git with this project” card. Every milestone gets a Git tab with a ready .gitignore, hooks and a one-step setup script."
            />
          </div>
        </div>
      </Card>

      <Section title="Git host" description="Where your team keeps repositories. VibeForge uses it to suggest remote URLs people can paste.">
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <Label>Host</Label>
            <Select className="w-full" value={cfg.provider} onChange={(e) => set("provider", e.target.value)}>
              {PROVIDERS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
            </Select>
          </label>
          <label className="block space-y-1.5">
            <Label>Team or organisation URL</Label>
            <Input value={cfg.host_url} onChange={(e) => set("host_url", e.target.value)} placeholder={provider.host} className="font-mono" spellCheck={false} />
            <span className="block text-xs text-text-muted">Leave empty and each person's own account is used.</span>
          </label>
          <label className="block space-y-1.5">
            <Label>Default branch</Label>
            <Input value={cfg.default_branch} onChange={(e) => set("default_branch", e.target.value)} className="font-mono" spellCheck={false} />
          </label>
          <label className="block space-y-1.5">
            <Label>Connect with</Label>
            <Select className="w-full" value={cfg.remote_protocol} onChange={(e) => set("remote_protocol", e.target.value)}>
              <option value="https">HTTPS (recommended for beginners)</option>
              <option value="ssh">SSH</option>
            </Select>
            <span className="block text-xs text-text-muted">People can override this in Profile → Git details.</span>
          </label>
        </div>
      </Section>

      <Section
        title="Meta Muse suggestions"
        description="Muse reads a milestone's file list and config files and tailors the .gitignore and the lint, format and test commands for that project."
        aside={<Badge tone="primary"><IconSparkles width={12} height={12} /> Uses AI review's model and key</Badge>}
      >
        <Toggle
          checked={cfg.ai_suggestions}
          onChange={(v) => set("ai_suggestions", v)}
          label="Let Muse tailor .gitignore and hooks"
          description="Only file names and a few manifest files (package.json, pyproject.toml…) are sent, with secrets masked. Off: everyone still gets the starter plan, built on this server."
        />
      </Section>

      <Section title="Hooks every project gets" description="Small checks Git runs on each person's computer. Muse fills in the project's own commands; you choose which checks exist." aside={<Badge>{hookCount} on</Badge>}>
        <Toggle checked={cfg.hooks.secret_scan} onChange={(v) => hook("secret_scan", v)} label="Block secrets before commit" description="Stops .env files, private keys and API-key-looking strings from being committed. Strongly recommended." />
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
          <div className="flex-1"><Toggle checked={cfg.hooks.block_large_files} onChange={(v) => hook("block_large_files", v)} label="Block large files" description="Videos, builds and databases make a repository slow forever." /></div>
          <label className="block w-full space-y-1.5 sm:w-36">
            <Label>Limit (MB)</Label>
            <Input type="number" min={1} max={500} value={cfg.hooks.large_file_mb} onChange={(e) => hook("large_file_mb", Number(e.target.value))} disabled={!cfg.hooks.block_large_files} />
          </label>
        </div>
        <Toggle checked={cfg.hooks.lint_format} onChange={(v) => hook("lint_format", v)} label="Lint and format check before commit" description="Runs the project's lint and format commands that Muse picked." />
        <Toggle checked={cfg.hooks.run_tests_pre_push} onChange={(v) => hook("run_tests_pre_push", v)} label="Run tests before push" description="Nothing broken leaves a laptop." />
        <Toggle checked={cfg.hooks.conventional_commits} onChange={(v) => hook("conventional_commits", v)} label="Require clear commit messages" description="Messages start with a type such as feat:, fix: or docs:." />
        <Toggle checked={cfg.hooks.protect_default_branch} onChange={(v) => hook("protect_default_branch", v)} label={`Block direct pushes to ${cfg.default_branch || "main"}`} description="People push a branch and open a pull request instead." />
        <label className="block space-y-1.5">
          <Label>Extra pre-commit commands for every project</Label>
          <textarea className={textarea} value={cfg.custom_pre_commit} onChange={(e) => set("custom_pre_commit", e.target.value)} placeholder={"npx tsc --noEmit\ngitleaks protect --staged"} spellCheck={false} />
          <span className="block text-xs text-text-muted">One plain command per line. Lines with ; &gt; &lt; ` $( or downloads are refused.</span>
        </label>
      </Section>

      <Section title="Team .gitignore" description="Lines every project's .gitignore gets, whatever Muse suggests. Muse is told not to repeat them.">
        <textarea className={`${textarea} min-h-48`} value={cfg.baseline_gitignore} onChange={(e) => set("baseline_gitignore", e.target.value)} spellCheck={false} aria-label="Team .gitignore" />
      </Section>

      {error && <Alert>{error}</Alert>}
      <div className="sticky bottom-3 z-sticky flex justify-end">
        <Button busy={saving} onClick={() => void save()} className="shadow-raised">Save Git settings</Button>
      </div>
    </div>
  );
}
