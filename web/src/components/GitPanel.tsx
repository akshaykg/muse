import { useCallback, useEffect, useRef, useState, type SVGProps } from "react";
import { gitApi, type GitPlanResponse, type GitProfile, type GitStatus, type HookFile, type ProjectGit } from "../lib/gitApi";
import { Alert, Badge, Button, Card, CopyButton, Input, Label, Select, Skeleton, useToast } from "./ui";
import { IconSparkles } from "./AiReview";

// ------------------------------------------------------------------ icons

export function IconGit(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <circle cx="6" cy="5.5" r="2.2" />
      <circle cx="6" cy="18.5" r="2.2" />
      <circle cx="18" cy="9" r="2.2" />
      <path d="M6 7.7v8.6" />
      <path d="M18 11.2c0 3.3-3.5 4.3-10.2 6" />
    </svg>
  );
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const a = document.createElement("a");
  a.href = url; a.download = name; a.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function CodeBlock({ title, text, file, maxH = "max-h-72" }: { title: string; text: string; file?: string; maxH?: string }) {
  return (
    <div className="overflow-hidden rounded-md border border-border bg-background">
      <div className="flex items-center justify-between gap-2 border-b border-border px-3 py-1.5">
        <span className="truncate font-mono text-xs font-semibold text-text-muted">{title}</span>
        <span className="flex shrink-0 gap-1.5">
          {file && <Button variant="ghost" size="sm" onClick={() => download(file, text)}>Download</Button>}
          <CopyButton text={text} />
        </span>
      </div>
      <pre className={`${maxH} overflow-auto px-3 py-2.5 font-mono text-xs leading-relaxed text-text`}>{text}</pre>
    </div>
  );
}

// ------------------------------------------------------------------ identity

/** Profile → Git details. Also shown inline in the Git tab until it is filled in. */
export function GitIdentityCard({ compact = false, onSaved }: { compact?: boolean; onSaved?: (p: GitProfile) => void }) {
  const [p, setP] = useState<GitProfile | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  useEffect(() => { gitApi.profile().then(setP).catch((e) => setError(e instanceof Error ? e.message : "Could not load your Git details.")); }, []);
  if (!p) return error ? <Alert>{error}</Alert> : <Skeleton className="h-40" />;
  const set = (k: keyof GitProfile, v: string) => setP({ ...p, [k]: v });
  const saved = !!p.updated_at;
  return (
    <Card className={compact ? "p-4" : "p-5"}>
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-start gap-3">
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary"><IconGit /></span>
          <div>
            <h3 className="font-serif text-lg font-bold">Your Git details</h3>
            <p className="mt-0.5 text-sm text-text-muted">Git stamps your name and email on every commit. VibeForge uses them to write setup commands you can paste as-is.</p>
          </div>
        </div>
        {saved ? <Badge tone="success">Saved</Badge> : <Badge tone="warning">Not set up</Badge>}
      </div>
      <form
        className="mt-4 grid gap-3 sm:grid-cols-2"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true); setError("");
          try {
            const next = await gitApi.saveProfile({ name: p.name, email: p.email, username: p.username, remote_protocol: p.remote_protocol });
            setP(next); onSaved?.(next); toast.success("Git details saved.");
          } catch (err) { setError(err instanceof Error ? err.message : "Could not save."); }
          finally { setBusy(false); }
        }}
      >
        <label className="block space-y-1.5"><Label>Name on commits</Label><Input value={p.name} onChange={(e) => set("name", e.target.value)} required autoComplete="name" /></label>
        <label className="block space-y-1.5"><Label>Email on commits</Label><Input type="email" value={p.email} onChange={(e) => set("email", e.target.value)} required autoComplete="email" /></label>
        <label className="block space-y-1.5">
          <Label>Username on your Git host</Label>
          <Input value={p.username} onChange={(e) => set("username", e.target.value)} placeholder="e.g. ada-builds" spellCheck={false} />
          <span className="block text-xs text-text-muted">Used to suggest remote URLs like github.com/<span className="font-mono">{p.username || "you"}</span>/project.</span>
        </label>
        <label className="block space-y-1.5">
          <Label>Connect with</Label>
          <Select className="w-full" value={p.remote_protocol} onChange={(e) => set("remote_protocol", e.target.value)}>
            <option value="">Team default</option>
            <option value="https">HTTPS (easiest, signs in through your browser)</option>
            <option value="ssh">SSH key</option>
          </Select>
        </label>
        {error && <div className="sm:col-span-2"><Alert>{error}</Alert></div>}
        <div className="flex flex-wrap items-center gap-2 sm:col-span-2">
          <Button type="submit" busy={busy}>Save Git details</Button>
          {saved && <CopyButton text={`git config --global user.name "${p.name}"\ngit config --global user.email "${p.email}"`} label="Copy git config commands" />}
        </div>
      </form>
    </Card>
  );
}

// ------------------------------------------------------------------ project prompt

const DISMISS_KEY = "vf_git_prompt_dismissed";

function dismissed(projectId: string): boolean {
  try { return (JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]") as string[]).includes(projectId); } catch { return false; }
}

/** "Use Git with this project" — shown on projects without a remote while the team asks for it. */
export function UseGitBanner({ projectId, onOpen }: { projectId: string; onOpen: () => void }) {
  const [git, setGit] = useState<ProjectGit | null>(null);
  const [hidden, setHidden] = useState(() => dismissed(projectId));
  useEffect(() => { setHidden(dismissed(projectId)); gitApi.project(projectId).then(setGit).catch(() => setGit(null)); }, [projectId]);
  if (!git || hidden || git.connected || !git.prompt_git) return null;
  const hide = () => {
    try { const ids = JSON.parse(localStorage.getItem(DISMISS_KEY) ?? "[]") as string[]; localStorage.setItem(DISMISS_KEY, JSON.stringify([...ids, projectId])); } catch { /* fine */ }
    setHidden(true);
  };
  return (
    <div className="vf-page relative mt-4 overflow-hidden rounded-lg border border-primary/25 bg-gradient-to-r from-primary/8 via-surface to-info/8 p-4 shadow-surface">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-info text-primary-fg shadow-raised"><IconGit width={20} height={20} /></span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-text">Use Git with this project</p>
          <p className="text-sm text-text-muted">Milestones are your big saves. Git keeps every small step in between, so you can undo one bad AI edit without losing the day. Muse writes the .gitignore and safety hooks for you.</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button onClick={onOpen}><IconSparkles width={15} height={15} /> Set up Git</Button>
          <Button variant="ghost" onClick={hide} aria-label="Not now">Not now</Button>
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ milestone tab

const STEPS = ["Reading the file list", "Recognising your stack", "Muse is writing your .gitignore", "Choosing lint and test commands"];

function Running({ startedAt, model }: { startedAt: string; model: string }) {
  const [step, setStep] = useState(0);
  useEffect(() => {
    const start = Date.parse(startedAt) || Date.now();
    const id = window.setInterval(() => setStep(Math.min(STEPS.length - 1, Math.floor((Date.now() - start) / 3000))), 400);
    return () => window.clearInterval(id);
  }, [startedAt]);
  return (
    <Card className="relative overflow-hidden p-5">
      <style>{`@keyframes vf-git-beam{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}.vf-git-beam{animation:vf-git-beam 1.6s cubic-bezier(.4,0,.2,1) infinite}@media (prefers-reduced-motion: reduce){.vf-git-beam{animation:none}}`}</style>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-primary/10"><div className="vf-git-beam h-full w-2/5 bg-gradient-to-r from-transparent via-primary to-transparent" /></div>
      <p className="flex items-center gap-2 font-semibold"><IconSparkles className="text-primary" /> Muse is tailoring Git for this project…</p>
      <p className="text-sm text-text-muted">Usually 10–30 seconds with {model}. Only file names and a few config files are sent.</p>
      <ol className="mt-3 grid gap-1.5 sm:grid-cols-2" aria-live="polite">
        {STEPS.map((s, i) => (
          <li key={s} className={`flex items-center gap-2 text-sm ${i > step ? "opacity-40" : ""}`}>
            <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${i < step ? "bg-success/15 text-success" : i === step ? "bg-primary text-primary-fg" : "bg-border text-text-muted"}`}>{i < step ? "✓" : i + 1}</span>
            {s}
          </li>
        ))}
      </ol>
    </Card>
  );
}

function StepCard({ n, title, ok, children }: { n: number; title: string; ok: boolean; children: React.ReactNode }) {
  return (
    <div className={`rounded-lg border p-3.5 ${ok ? "border-success/30 bg-success/5" : "border-border bg-surface"}`}>
      <p className="flex items-center gap-2 text-sm font-semibold">
        <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${ok ? "bg-success text-white" : "bg-primary/15 text-primary"}`}>{ok ? "✓" : n}</span>
        {title}
      </p>
      <div className="mt-1.5 text-xs leading-relaxed text-text-muted">{children}</div>
    </div>
  );
}

/** Show `command` spans from the server as inline code. */
function Ticks({ text }: { text: string }) {
  return <>{text.split("`").map((part, i) => i % 2 ? <code key={i} className="rounded bg-background px-1 py-px font-mono text-[11px] text-text">{part}</code> : part)}</>;
}

function HookCard({ hook }: { hook: HookFile }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="rounded-md border border-border bg-surface">
      <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open} className="flex w-full cursor-pointer items-start gap-3 p-3 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
        <span className="mt-0.5 rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[11px] font-semibold text-primary">{hook.name}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">{hook.title}</span>
          <ul className="mt-1 space-y-0.5">{hook.why.map((w, i) => <li key={i} className="text-xs leading-relaxed text-text-muted">• <Ticks text={w} /></li>)}</ul>
        </span>
        <span aria-hidden className={`text-text-muted transition-transform duration-normal ${open ? "rotate-180" : ""}`}>▾</span>
      </button>
      {open && <div className="px-3 pb-3"><CodeBlock title={`.githooks/${hook.name}`} text={hook.script} file={hook.name} maxH="max-h-64" /></div>}
    </li>
  );
}

export function GitPanel({ milestoneId, projectId, canPush, isAdmin, onOpenSettings, onOpenProfile }: {
  milestoneId: string;
  projectId: string;
  canPush: boolean;
  isAdmin?: boolean;
  onOpenSettings?: () => void;
  onOpenProfile?: () => void;
}) {
  const [data, setData] = useState<GitPlanResponse | null>(null);
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [project, setProject] = useState<ProjectGit | null>(null);
  const [remote, setRemote] = useState("");
  const [branch, setBranch] = useState("");
  const [savingRemote, setSavingRemote] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showIgnored, setShowIgnored] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const load = useCallback(async () => {
    try { const d = await gitApi.plan(milestoneId); setData(d); return d; }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load the Git plan."); return null; }
  }, [milestoneId]);

  useEffect(() => {
    setData(null); setError("");
    void load();
    void gitApi.status().then(setStatus).catch(() => setStatus(null));
    void gitApi.project(projectId).then((p) => { setProject(p); setRemote(p.remote_url); setBranch(p.branch); }).catch(() => setProject(null));
  }, [load, projectId]);

  const running = data?.suggestion?.status === "running";
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(async () => {
      const d = await load();
      const s = d?.suggestion;
      if (s && s.status !== "running") {
        if (s.status === "done") toastRef.current.success("Muse tailored your .gitignore and hooks.");
        else toastRef.current.error(s.error ?? "Muse could not finish.");
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [running, load]);

  if (!data) return error ? <Alert>{error}</Alert> : <div className="space-y-2"><Skeleton className="h-36" /><Skeleton className="h-24" /><Skeleton className="h-64" /></div>;

  const { plan } = data;
  const identityOk = !!data.profile?.updated_at && !!data.profile.name && !!data.profile.email;
  const remoteOk = !!project?.connected;
  const fromMuse = plan.source === "muse";

  const ask = async () => {
    setStarting(true); setError("");
    try { const r = await gitApi.suggest(milestoneId); setData({ ...data, suggestion: r.suggestion }); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not ask Muse."); }
    finally { setStarting(false); }
  };

  const saveRemote = async (e: React.FormEvent) => {
    e.preventDefault();
    setSavingRemote(true);
    try {
      const p = await gitApi.saveProject(projectId, { remote_url: remote.trim(), branch: branch.trim() });
      setProject(p); setRemote(p.remote_url); setBranch(p.branch);
      toast.success(p.connected ? "Remote saved. Everyone on this project sees it." : "Remote cleared.");
      await load();
    } catch (err) { toast.error(err instanceof Error ? err.message : "Could not save the remote."); }
    finally { setSavingRemote(false); }
  };

  const quick = `git remote add origin ${data.remote}\ngit push -u origin ${data.branch}`;

  return (
    <div className="space-y-4">
      <Card className="relative overflow-hidden p-5 sm:p-6">
        <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-3.5">
            <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-info text-primary-fg shadow-raised"><IconGit width={22} height={22} /></span>
            <div>
              <h3 className="font-serif text-xl font-bold">Git for this project</h3>
              <p className="mt-0.5 max-w-xl text-sm text-text-muted">
                Milestones are your big saves; Git keeps every small step. Here is a <span className="font-medium text-text">.gitignore</span> and safety <span className="font-medium text-text">hooks</span> made for this exact project, and one script that sets it all up.
              </p>
              <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-text-muted">
                {fromMuse ? <Badge tone="primary"><IconSparkles width={12} height={12} /> Tailored by Meta Muse</Badge> : <Badge>Starter plan</Badge>}
                {plan.stack.map((s) => <Badge key={s}>{s}</Badge>)}
              </p>
            </div>
          </div>
          <div className="flex shrink-0 flex-wrap gap-2">
            {canPush && status?.ai_ready && (
              <Button onClick={ask} busy={starting} disabled={running}>
                <IconSparkles width={16} height={16} /> {fromMuse ? "Ask Muse again" : "Tailor with Muse"}
              </Button>
            )}
            <Button variant="secondary" onClick={() => download("vibeforge-git-setup.sh", data.setup_script)}>Download setup script</Button>
          </div>
        </div>
      </Card>

      {error && <Alert>{error}</Alert>}
      {status && !status.ai_ready && canPush && (
        <Alert variant="info">
          {status.ai_suggestions ? "Muse can tailor this plan once AI review has an API key." : "Muse Git suggestions are turned off for this team."}{" "}
          {isAdmin && onOpenSettings
            ? <button type="button" className="cursor-pointer font-semibold underline underline-offset-2" onClick={onOpenSettings}>Open Admin settings</button>
            : "The starter plan below is ready to use."}
        </Alert>
      )}

      {running && data.suggestion && <Running startedAt={data.suggestion.started_at} model={data.suggestion.model} />}
      {data.suggestion?.status === "failed" && !running && <Alert><span className="font-semibold">Muse didn't finish.</span> {data.suggestion.error} The starter plan below still works.</Alert>}

      {plan.exposed.length > 0 && (
        <Alert>
          <span className="font-semibold">Secrets would go into Git today:</span> {plan.exposed.join(", ")}. Add them to .gitignore below before your first commit, and change any keys inside them if they were ever shared.
        </Alert>
      )}

      <div className="grid gap-2.5 sm:grid-cols-3">
        <StepCard n={1} title="Your Git details" ok={identityOk}>
          {identityOk ? <>{data.profile!.name} · {data.profile!.email}</> : <>Add your name and email so commits are yours. {onOpenProfile && <button type="button" onClick={onOpenProfile} className="cursor-pointer font-semibold text-primary underline-offset-2 hover:underline">Open Profile</button>}</>}
        </StepCard>
        <StepCard n={2} title="Where the code lives" ok={remoteOk}>
          <span className="break-all font-mono">{data.remote}</span>{!remoteOk && <> (suggested)</>}
        </StepCard>
        <StepCard n={3} title=".gitignore and hooks" ok={fromMuse}>
          {plan.hooks.length} hook{plan.hooks.length === 1 ? "" : "s"} · keeps {plan.would_ignore.length} file{plan.would_ignore.length === 1 ? "" : "s"} of this milestone out of Git
        </StepCard>
      </div>

      {!identityOk && <GitIdentityCard compact onSaved={() => void load()} />}

      {plan.summary && <p className="text-sm leading-relaxed text-text-muted">{plan.summary}</p>}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h4 className="font-semibold">.gitignore</h4>
            {plan.existing_gitignore && <Badge tone="success">Keeps your existing rules</Badge>}
          </div>
          <CodeBlock title=".gitignore" text={plan.gitignore} file="gitignore.txt" maxH="max-h-80" />
          {plan.notes.length > 0 && (
            <ul className="mt-3 space-y-1.5">
              {plan.notes.map((n, i) => (
                <li key={i} className="flex gap-2 text-sm">
                  <code className="shrink-0 rounded bg-background px-1.5 py-0.5 font-mono text-xs text-primary">{n.pattern}</code>
                  <span className="text-text-muted">{n.why}</span>
                </li>
              ))}
            </ul>
          )}
          {plan.would_ignore.length > 0 && (
            <div className="mt-3">
              <button type="button" onClick={() => setShowIgnored((s) => !s)} className="cursor-pointer text-xs font-medium text-text-muted underline-offset-2 hover:underline">
                {showIgnored ? "Hide" : "Show"} the {plan.would_ignore.length} file{plan.would_ignore.length === 1 ? "" : "s"} it keeps out of Git
              </button>
              {showIgnored && <ul className="mt-1.5 max-h-40 overflow-auto rounded-md bg-background p-2 font-mono text-[11px] text-text-muted">{plan.would_ignore.map((f) => <li key={f}>{f}</li>)}</ul>}
            </div>
          )}
        </Card>

        <Card className="p-4">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h4 className="font-semibold">Hooks</h4>
            <span className="text-xs text-text-muted">Saved in <code className="font-mono">.githooks/</code> so the team shares them</span>
          </div>
          {plan.hooks.length === 0
            ? <p className="text-sm text-text-muted">Your team has turned every hook off in Admin → Settings → Git.</p>
            : <ul className="space-y-2">{plan.hooks.map((h) => <HookCard key={h.name} hook={h} />)}</ul>}
          {plan.tips.length > 0 && (
            <div className="mt-4 rounded-md bg-primary/5 p-3">
              <p className="flex items-center gap-1.5 text-xs font-semibold text-primary"><IconSparkles width={13} height={13} /> Tips from Muse</p>
              <ul className="mt-1.5 space-y-1 text-sm text-text">{plan.tips.map((t, i) => <li key={i}>• {t}</li>)}</ul>
            </div>
          )}
        </Card>
      </div>

      <Card className="p-4">
        <h4 className="font-semibold">Set it all up in one go</h4>
        <p className="mt-0.5 text-sm text-text-muted">Run this in your project folder. It starts Git if needed, sets your name and email, writes the .gitignore and hooks, connects the remote and makes the first commit. Read it first: it's short.</p>
        <div className="mt-3"><CodeBlock title="vibeforge-git-setup.sh" text={data.setup_script} file="vibeforge-git-setup.sh" maxH="max-h-56" /></div>
        <p className="mt-3 text-sm font-medium">Then push</p>
        <pre className="mt-1 overflow-x-auto rounded-md bg-background p-3 font-mono text-xs">{quick}</pre>
      </Card>

      {project && (
        <Card className="p-4">
          <h4 className="font-semibold">Project remote</h4>
          <p className="mt-0.5 text-sm text-text-muted">Where this project's Git repository lives. Saved for everyone on the project{project.can_edit ? "" : "; Owners and Coders can change it"}.</p>
          <form className="mt-3 grid gap-2 sm:grid-cols-[1fr_10rem_auto]" onSubmit={saveRemote}>
            <Input value={remote} onChange={(e) => setRemote(e.target.value)} placeholder={project.suggested_remote} disabled={!project.can_edit} className="font-mono" spellCheck={false} aria-label="Remote URL" />
            <Input value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="main" disabled={!project.can_edit} className="font-mono" spellCheck={false} aria-label="Branch" />
            {project.can_edit && <Button type="submit" busy={savingRemote}>Save</Button>}
          </form>
          <p className="mt-1.5 text-xs text-text-muted">Never put a password or token in the URL; your Git host signs you in.</p>
        </Card>
      )}
    </div>
  );
}
