import { useCallback, useEffect, useMemo, useState } from "react";
import { api, getToken, setToken } from "./lib/api";
import {
  Alert,
  Avatar,
  Badge,
  Button,
  Card,
  CopyButton,
  EmptyState,
  Input,
  Label,
  Menu,
  MenuItem,
  Modal,
  PermissionsProvider,
  Select,
  Skeleton,
  Tabs,
  ToastProvider,
  usePermission,
  useToast,
  type SpaceRoleName,
} from "./components/ui";

type Me = Awaited<ReturnType<typeof api.me>>;
type View =
  | { name: "spaces" }
  | { name: "space"; id: string; label: string }
  | { name: "project"; id: string; milestoneId?: string }
  | { name: "profile" }
  | { name: "admin"; tab: string };

/** Shareable URLs: /spaces/:id  /projects/:id  /projects/:id/milestones/:mid  /profile  /admin/:tab */
function parsePath(path: string): View {
  const parts = path.split("/").filter(Boolean);
  if (parts[0] === "spaces" && parts[1]) return { name: "space", id: parts[1], label: "" };
  if (parts[0] === "projects" && parts[1]) {
    return parts[2] === "milestones" && parts[3]
      ? { name: "project", id: parts[1], milestoneId: parts[3] }
      : { name: "project", id: parts[1] };
  }
  if (parts[0] === "profile") return { name: "profile" };
  if (parts[0] === "admin") return { name: "admin", tab: parts[1] ?? "vulns" };
  return { name: "spaces" };
}

function toPath(v: View): string {
  switch (v.name) {
    case "space": return `/spaces/${v.id}`;
    case "project": return v.milestoneId ? `/projects/${v.id}/milestones/${v.milestoneId}` : `/projects/${v.id}`;
    case "profile": return "/profile";
    case "admin": return `/admin/${v.tab}`;
    default: return "/";
  }
}

const SEV_WORD: Record<string, string> = {
  critical: "Fix now",
  high: "Fix now",
  medium: "Fix soon",
  low: "Good to know",
};

function cvssLabel(score: number | null): string | null {
  if (score == null) return null;
  const word = score >= 9 ? "Critical" : score >= 7 ? "High" : score >= 4 ? "Medium" : "Low";
  return `CVSS ${score.toFixed(1)} · ${word}`;
}

function sevTone(sev: string): "danger" | "warning" | "neutral" {
  if (sev === "critical" || sev === "high") return "danger";
  if (sev === "medium") return "warning";
  return "neutral";
}

export default function App() {
  return (
    <ToastProvider>
      <Shell />
    </ToastProvider>
  );
}

function Shell() {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setViewState] = useState<View>(() => parsePath(window.location.pathname));
  const toast = useToast();

  const setView = useCallback((v: View, replace = false) => {
    const path = toPath(v);
    if (replace) window.history.replaceState(null, "", path);
    else if (window.location.pathname !== path) window.history.pushState(null, "", path);
    setViewState(v);
  }, []);

  useEffect(() => {
    const onPop = () => setViewState(parsePath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const refreshMe = useCallback(async () => {
    if (!getToken()) return;
    try {
      setMe(await api.me());
    } catch {
      setToken(null);
      setMe(null);
    }
  }, []);

  useEffect(() => { void refreshMe(); }, [refreshMe]);

  const perms = useMemo(
    () => ({
      isAdmin: me?.user.is_platform_admin ?? false,
      roleIn: (spaceId: string): SpaceRoleName | null => {
        const found = me?.spaces.find((s) => s.id === spaceId);
        return (found?.role as SpaceRoleName | undefined) ?? null;
      },
    }),
    [me],
  );

  if (!getToken() || !me) {
    return (
      <Login
        onDone={async () => {
          await refreshMe();
          setView({ name: "spaces" });
          toast.success("Welcome back.");
        }}
      />
    );
  }

  const signOut = () => {
    setToken(null);
    setMe(null);
  };

  return (
    <PermissionsProvider value={perms}>
      <div className="min-h-screen bg-background text-text">
        <header className="sticky top-0 z-sticky border-b border-border bg-surface/95 shadow-surface backdrop-blur">
          <div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-2.5">
            <button
              type="button"
              onClick={() => setView({ name: "spaces" })}
              className="flex items-center gap-2.5 rounded-md px-1 py-1 text-left transition duration-fast ease-standard hover:bg-background focus-visible:outline-2 focus-visible:outline-primary"
            >
              <span aria-hidden className="flex h-9 w-9 items-center justify-center rounded-md bg-primary font-serif text-lg font-bold text-primary-fg">V</span>
              <span>
                <span className="block font-serif text-lg font-bold leading-tight">VibeForge</span>
                <span className="hidden text-xs leading-tight text-text-muted sm:block">Milestones, not git</span>
              </span>
            </button>

            <nav aria-label="Main" className="ml-4 hidden items-center gap-1 sm:flex">
              <Button variant={view.name === "spaces" || view.name === "space" || view.name === "project" ? "secondary" : "ghost"} size="sm" onClick={() => setView({ name: "spaces" })}>
                Spaces
              </Button>
            </nav>

            <div className="ml-auto flex items-center gap-2">
              {perms.isAdmin && (
                <Button
                  size="sm"
                  aria-label="Create a new space"
                  onClick={() => {
                    setView({ name: "spaces" });
                    window.setTimeout(() => window.dispatchEvent(new Event("vf:new-space")), 50);
                  }}
                >
                  + New space
                </Button>
              )}
              {/* Single Settings entry (admins): one button, tabbed page inside. */}
              {perms.isAdmin && (
                <Button
                  variant={view.name === "admin" ? "secondary" : "ghost"}
                  size="sm"
                  aria-label="Settings and admin"
                  aria-current={view.name === "admin" || undefined}
                  onClick={() => setView({ name: "admin", tab: "vulns" })}
                >
                  <svg aria-hidden viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4 shrink-0">
                    <circle cx="12" cy="12" r="3" />
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                  </svg>
                  Settings
                </Button>
              )}

              {/* Everything account-related lives under this one menu. */}
              <Menu label="Profile menu" button={<span className="flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-3 shadow-surface transition duration-fast hover:bg-background"><Avatar name={me.user.display_name} size="sm" /><span className="max-w-36 truncate text-sm font-medium">{me.user.display_name}</span><span aria-hidden className="text-xs text-text-muted">▾</span></span>}>
                {(close) => (
                  <>
                    <div className="px-3 py-2">
                      <p className="truncate text-sm font-medium">{me.user.display_name}</p>
                      <p className="truncate text-xs text-text-muted">{me.user.email}</p>
                      {me.user.is_platform_admin && <span className="mt-1 inline-block"><Badge tone="primary">Admin</Badge></span>}
                    </div>
                    <div className="my-1 border-t border-border" />
                    <MenuItem onClick={() => { close(); setView({ name: "profile" }); }}>Profile &amp; skill install</MenuItem>
                    <MenuItem onClick={() => { close(); setView({ name: "profile" }); }}>API tokens</MenuItem>
                    {me.user.is_platform_admin && (
                      <MenuItem onClick={() => { close(); setView({ name: "admin", tab: "settings" }); }}>App settings</MenuItem>
                    )}
                    <div className="my-1 border-t border-border" />
                    <MenuItem danger onClick={() => { close(); signOut(); }}>Sign out</MenuItem>
                  </>
                )}
              </Menu>
            </div>
          </div>
        </header>

        <main className="mx-auto max-w-6xl px-4 py-6">
          <div key={view.name + ("id" in view ? view.id : "")} className="vf-page">
            {view.name === "spaces" && <Spaces me={me} go={setView} />}
            {view.name === "space" && <SpaceDetail spaceId={view.id} label={view.label} go={setView} />}
            {view.name === "project" && <ProjectDetail projectId={view.id} milestoneId={view.milestoneId} go={setView} />}
            {view.name === "profile" && <Profile />}
            {view.name === "admin" && <Admin initialTab={view.tab} />}
          </div>
        </main>
      </div>
    </PermissionsProvider>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("admin@vibeforge.local");
  const [password, setPassword] = useState("admin12345");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api.login(email.trim(), password);
      setToken(r.token);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 py-10 text-text">
      <Card className="vf-page w-full max-w-md p-6 sm:p-8">
        <span aria-hidden className="flex h-11 w-11 items-center justify-center rounded-md bg-primary font-serif text-xl font-bold text-primary-fg">V</span>
        <h1 className="mt-4 font-serif text-2xl font-bold">Welcome to VibeForge</h1>
        <p className="mt-1 text-sm text-text-muted">
          Store AI-built projects as milestones. Scan them. Share them safely.
        </p>
        <form className="mt-6 space-y-4" onSubmit={submit}>
          <label className="block">
            <Label>Email</Label>
            <span className="mt-1 block"><Input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required /></span>
          </label>
          <label className="block">
            <Label>Password</Label>
            <span className="mt-1 block"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></span>
          </label>
          {error && <Alert>{error}</Alert>}
          <Button type="submit" busy={busy} className="w-full">
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <p className="mt-5 text-xs leading-relaxed text-text-muted">
          First run seeds <code className="rounded-sm bg-background px-1">admin@vibeforge.local / admin12345</code> (change via{" "}
          <code className="rounded-sm bg-background px-1">ADMIN_PASSWORD</code>). Ask your admin if you need an account.
        </p>
      </Card>
    </div>
  );
}

// ------------------------------------------------------------------ spaces

function Spaces({ me, go }: { me: Me; go: (v: View) => void }) {
  const [spaces, setSpaces] = useState<Awaited<ReturnType<typeof api.spaces>> | null>(null);
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();
  const canCreate = usePermission("spaces:create");

  useEffect(() => {
    const open = () => setShowCreate(true);
    window.addEventListener("vf:new-space", open);
    return () => window.removeEventListener("vf:new-space", open);
  }, []);

  const load = useCallback(async () => {
    try { setSpaces(await api.spaces()); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to load spaces."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const visible = (spaces ?? []).filter((sp) => sp.name.toLowerCase().includes(query.trim().toLowerCase()));
  const totals = (spaces ?? []).reduce(
    (acc, sp) => ({
      projects: acc.projects + sp.projects,
      milestones: acc.milestones + sp.milestones,
      issues: acc.issues + sp.open_findings,
    }),
    { projects: 0, milestones: 0, issues: 0 },
  );

  return (
    <section aria-labelledby="spaces-title">
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">Workspace</p>
          <h2 id="spaces-title" className="mt-1 font-serif text-3xl font-bold">Spaces</h2>
          <p className="mt-1 max-w-xl text-sm text-text-muted">
            Every project lives in a space. Roles, health and activity at a glance.
          </p>
        </div>
        <div className="ml-auto flex w-full flex-wrap items-center gap-2 sm:w-auto">
          <span className="hidden items-center gap-4 text-sm text-text-muted lg:flex" aria-label="Totals">
            <span><strong className="font-serif text-base text-text">{totals.projects}</strong> projects</span>
            <span><strong className="font-serif text-base text-text">{totals.milestones}</strong> milestones</span>
            <span><strong className="font-serif text-base text-text">{totals.issues}</strong> open issues</span>
          </span>
          <span className="w-full sm:w-60">
            <Input type="search" placeholder="Search spaces…" aria-label="Search spaces" value={query} onChange={(e) => setQuery(e.target.value)} />
          </span>
          {canCreate && (
            <Button aria-expanded={showCreate} onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "Close" : "+ New space"}
            </Button>
          )}
        </div>
      </div>

      {error && <div className="mt-4"><Alert>{error}</Alert></div>}

      {spaces === null && !error && (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3" aria-label="Loading spaces">
          <Skeleton className="h-52" /><Skeleton className="h-52" /><Skeleton className="h-52" />
        </div>
      )}

      {spaces !== null && visible.length > 0 && (
        <div className="mt-6 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((sp) => {
            const healthy = sp.open_findings === 0;
            return (
              <article
                key={sp.id}
                className="group flex flex-col rounded-lg border border-border bg-surface shadow-surface transition duration-normal ease-standard hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-raised"
              >
                <button
                  type="button"
                  onClick={() => go({ name: "space", id: sp.id, label: sp.name })}
                  className="flex flex-1 flex-col p-5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.99]"
                  aria-label={`Open space ${sp.name}`}
                >
                  <span className="flex items-start gap-3">
                    <Avatar name={sp.name} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-serif text-lg font-bold leading-tight">{sp.name}</span>
                      <span className="text-xs text-text-muted">/{sp.slug}</span>
                    </span>
                    <Badge tone={healthy ? "success" : "danger"}>{healthy ? "✓ Healthy" : `${sp.open_findings} to fix`}</Badge>
                  </span>

                  <span className="mt-3 flex flex-wrap gap-1.5">
                    <Badge tone={sp.role === "owner" ? "primary" : "neutral"}>You: {sp.role}</Badge>
                    {sp.vulnerabilities > 0 && <Badge tone="danger">{sp.vulnerabilities} vulnerabilities</Badge>}
                  </span>

                  <span className="mt-4 grid grid-cols-4 divide-x divide-border rounded-md border border-border bg-background py-2.5 text-center">
                    <span><span className="block font-serif text-base font-bold leading-none">{sp.projects}</span><span className="mt-1 block text-[11px] text-text-muted">Projects</span></span>
                    <span><span className="block font-serif text-base font-bold leading-none">{sp.milestones}</span><span className="mt-1 block text-[11px] text-text-muted">Milestones</span></span>
                    <span><span className="block font-serif text-base font-bold leading-none">{sp.members}</span><span className="mt-1 block text-[11px] text-text-muted">Members</span></span>
                    <span><span className="block font-serif text-base font-bold leading-none">{sp.open_findings}</span><span className="mt-1 block text-[11px] text-text-muted">Issues</span></span>
                  </span>

                  <span className="mt-4 flex items-center gap-2 border-t border-border pt-3 text-xs text-text-muted">
                    <span>{sp.last_activity ? `Last activity ${new Date(sp.last_activity).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : "No activity yet"}</span>
                    <span aria-hidden className="ml-auto text-sm font-medium text-primary opacity-0 transition duration-fast group-hover:opacity-100">Open space →</span>
                  </span>
                </button>
              </article>
            );
          })}
        </div>
      )}

      {spaces !== null && visible.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title={query ? "No spaces match that search" : "No spaces yet"}
            hint={query ? "Try a different name." : me.user.is_platform_admin ? "Create your first space below." : "Ask an admin to add you to a space."}
          />
        </div>
      )}

      {canCreate && (
        <Modal
          open={showCreate}
          onClose={() => setShowCreate(false)}
          title="Create a space"
          hint="You become its Owner. Add people and groups from inside the space."
        >
          <form className="flex gap-2" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try { await api.createSpace(name); setName(""); setShowCreate(false); await load(); toast.success("Space created."); }
            catch (err) { toast.error(err instanceof Error ? err.message : "Could not create the space."); }
            finally { setBusy(false); }
          }}>
            <Input autoFocus placeholder="Space name, e.g. Client work" value={name} onChange={(e) => setName(e.target.value)} required aria-label="Space name" />
            <Button type="submit" busy={busy}>Create space</Button>
          </form>
        </Modal>
      )}
      {spaces !== null && visible.length === 0 && (
        <div className="mt-6">
          <EmptyState
            title={query ? "No spaces match that search" : "No spaces yet"}
            hint={query ? "Try a different name." : me.user.is_platform_admin ? "Create your first space below." : "Ask an admin to add you to a space."}
          />
        </div>
      )}

      {canCreate && showCreate && (
        <Card className="vf-page mt-6 p-5">
          <div className="flex items-start gap-3">
            <div>
              <h3 className="font-medium">Create a space</h3>
              <p className="mt-0.5 text-sm text-text-muted">You become its Owner. Add people and groups from inside the space.</p>
            </div>
            <span className="ml-auto">
              <Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button>
            </span>
          </div>
          <form className="mt-3 flex max-w-md gap-2" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try { await api.createSpace(name); setName(""); setShowCreate(false); await load(); toast.success("Space created."); }
            catch (err) { toast.error(err instanceof Error ? err.message : "Could not create the space."); }
            finally { setBusy(false); }
          }}>
            <Input autoFocus placeholder="Space name, e.g. Client work" value={name} onChange={(e) => setName(e.target.value)} required aria-label="Space name" />
            <Button type="submit" busy={busy}>Create space</Button>
          </form>
        </Card>
      )}
    </section>
  );
}

function SpaceDetail({ spaceId, label, go }: { spaceId: string; label: string; go: (v: View) => void }) {
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof api.spaceProjects>> | null>(null);
  const [members, setMembers] = useState<Awaited<ReturnType<typeof api.members>>>([]);
  const [users, setUsers] = useState<Awaited<ReturnType<typeof api.adminUsers>>>([]);
  const [projName, setProjName] = useState("");
  const [pickUser, setPickUser] = useState("");
  const [pickRole, setPickRole] = useState<SpaceRoleName>("coder");
  const [busy, setBusy] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  const [myRole, setMyRole] = useState<SpaceRoleName | null>(null);
  const canCreateProject = usePermission("projects:create", myRole);
  const canManageMembers = usePermission("members:manage", myRole);
  const [title, setTitle] = useState(label);

  const load = useCallback(async () => {
    try {
      const [ps, ms, me] = await Promise.all([api.spaceProjects(spaceId), api.members(spaceId), api.me()]);
      setTitle(me.spaces.find((sp) => sp.id === spaceId)?.name ?? label);
      setProjects(ps);
      setMembers(ms);
      setMyRole((me.spaces.find((sp) => sp.id === spaceId)?.role as SpaceRoleName | undefined) ?? null);
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load this space."); }
    try { setUsers(await api.adminUsers()); } catch { /* picker list is admin-only; members still load */ }
  }, [spaceId, label]);
  useEffect(() => { void load(); }, [load]);

  const issueTotal = (projects ?? []).reduce((n, pr) => n + pr.open_findings, 0);
  const milestoneTotal = (projects ?? []).reduce((n, pr) => n + pr.milestones, 0);

  return (
    <section aria-labelledby="space-title">
      <Button variant="ghost" size="sm" onClick={() => go({ name: "spaces" })}>← All spaces</Button>

      <div className="mt-3 flex flex-wrap items-start gap-4">
        <span className="flex items-center gap-3">
          <Avatar name={title || label} />
          <span>
            <span className="flex flex-wrap items-center gap-2">
              <h2 id="space-title" className="font-serif text-3xl font-bold leading-tight">{title || label}</h2>
              {myRole && <Badge tone={myRole === "owner" ? "primary" : "neutral"}>You are {myRole}</Badge>}
              <Badge tone={issueTotal === 0 ? "success" : "danger"}>{issueTotal === 0 ? "✓ Healthy" : `${issueTotal} open issues`}</Badge>
            </span>
            <span className="mt-0.5 block text-sm text-text-muted">Projects, people and health for this space.</span>
          </span>
        </span>
        <span className="ml-auto flex flex-wrap gap-2">
          {canManageMembers && (
            <Button variant="secondary" aria-expanded={showMembers} onClick={() => setShowMembers((v) => !v)}>
              {showMembers ? "Close members" : "Manage members"}
            </Button>
          )}
          {canCreateProject && (
            <Button aria-expanded={showCreate} onClick={() => setShowCreate((v) => !v)}>
              {showCreate ? "Close" : "+ New project"}
            </Button>
          )}
        </span>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Space totals">
        {[
          ["Projects", projects?.length ?? "—"],
          ["Milestones", projects ? milestoneTotal : "—"],
          ["Members", members.length || "—"],
          ["Open issues", projects ? issueTotal : "—"],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg border border-border bg-surface px-4 py-3 shadow-surface">
            <p className="font-serif text-2xl font-bold leading-none">{v}</p>
            <p className="mt-1.5 text-xs text-text-muted">{k}</p>
          </div>
        ))}
      </div>

      {error && <div className="mt-4"><Alert>{error}</Alert></div>}

      {canCreateProject && showCreate && (
        <Card className="vf-page mt-5 p-5">
          <div className="flex items-start gap-3">
            <div>
              <h3 className="font-medium">Create a project</h3>
              <p className="mt-0.5 text-sm text-text-muted">Milestones, scans and forks will live here.</p>
            </div>
            <span className="ml-auto"><Button variant="ghost" size="sm" onClick={() => setShowCreate(false)}>Cancel</Button></span>
          </div>
          <form className="mt-3 flex max-w-md gap-2" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try { const r = await api.createProject(spaceId, projName); toast.success("Project created."); go({ name: "project", id: r.id }); }
            catch (err) { toast.error(err instanceof Error ? err.message : "Could not create the project."); }
            finally { setBusy(false); }
          }}>
            <Input autoFocus placeholder="Project name, e.g. Shop app" value={projName} onChange={(e) => setProjName(e.target.value)} required aria-label="Project name" />
            <Button type="submit" busy={busy}>Create project</Button>
          </form>
        </Card>
      )}

      <div className="mt-8 grid gap-6 xl:grid-cols-[1fr_340px]">
        <div>
          <h3 className="font-serif text-xl font-bold">Projects</h3>
          {projects === null && !error && <div className="mt-3 grid gap-3 sm:grid-cols-2"><Skeleton className="h-44" /><Skeleton className="h-44" /></div>}
          {projects !== null && projects.length > 0 && (
            <div className="mt-3 grid gap-3 sm:grid-cols-2">
              {projects.map((pr) => (
                <article key={pr.id} className="group rounded-lg border border-border bg-surface shadow-surface transition duration-normal ease-standard hover:-translate-y-0.5 hover:border-primary/50 hover:shadow-raised">
                  <button
                    type="button"
                    onClick={() => go({ name: "project", id: pr.id })}
                    className="flex w-full flex-col p-5 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.99]"
                    aria-label={`Open project ${pr.name}`}
                  >
                    <span className="flex items-start gap-2">
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-serif text-lg font-bold leading-tight">{pr.name}</span>
                        <span className="text-xs text-text-muted">/{pr.slug}</span>
                      </span>
                      <Badge tone={pr.open_findings === 0 ? "success" : "danger"}>{pr.open_findings === 0 ? "✓ Healthy" : `${pr.open_findings} to fix`}</Badge>
                    </span>
                    <span className="mt-3 grid grid-cols-3 divide-x divide-border rounded-md border border-border bg-background py-2.5 text-center">
                      <span><span className="block font-serif text-base font-bold leading-none">{pr.milestones}</span><span className="mt-1 block text-[11px] text-text-muted">Milestones</span></span>
                      <span><span className="block font-serif text-base font-bold leading-none">{pr.vulnerabilities}</span><span className="mt-1 block text-[11px] text-text-muted">Vulns</span></span>
                      <span><span className="block font-serif text-base font-bold leading-none">{pr.open_findings}</span><span className="mt-1 block text-[11px] text-text-muted">Issues</span></span>
                    </span>
                    <span className="mt-3 flex flex-wrap gap-1.5">
                      {pr.languages.length > 0 ? pr.languages.map((l) => <Badge key={l} tone="primary">{l}</Badge>) : <Badge>No languages yet</Badge>}
                    </span>
                    <span className="mt-3 flex items-center border-t border-border pt-3 text-xs text-text-muted">
                      <span>{pr.last_activity ? `Last activity ${new Date(pr.last_activity).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}` : "No milestones yet"}</span>
                      <span aria-hidden className="ml-auto text-sm font-medium text-primary opacity-0 transition duration-fast group-hover:opacity-100">Open →</span>
                    </span>
                  </button>
                </article>
              ))}
            </div>
          )}
          {projects !== null && projects.length === 0 && (
            <div className="mt-3"><EmptyState title="No projects yet" hint={canCreateProject ? "Create the first one with New project." : "Owners and Coders can create projects here."} /></div>
          )}
        </div>

        <aside aria-labelledby="members-title">
          <h3 id="members-title" className="font-serif text-xl font-bold">Members &amp; roles</h3>
          <div className="mt-3 flex flex-wrap gap-1.5" aria-label="What each role can do">
            <Badge tone="primary">Owner · everything</Badge>
            <Badge>Coder · push &amp; create</Badge>
            <Badge>Reader · view only</Badge>
          </div>
          {members.length > 0 ? (
            <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface shadow-surface">
              {members.map((m, i) => (
                <li key={i} className="flex min-h-12 items-center gap-2.5 px-4 py-2.5 text-sm">
                  <Avatar name={m.label} size="sm" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium leading-tight">{m.label}</span>
                    <span className="text-xs capitalize text-text-muted">{m.principal_kind}</span>
                  </span>
                  <span className="ml-auto"><Badge tone={m.role === "owner" ? "primary" : "neutral"}>{m.role}</Badge></span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="mt-3"><EmptyState title="No members listed" hint={canManageMembers ? "Use Manage members to give the first role." : "A Space Owner manages members."} /></div>
          )}

          {canManageMembers && showMembers && (
            <Card className="vf-page mt-4 p-4">
              <p className="text-sm font-medium">Give a role</p>
              <p className="mt-0.5 text-xs text-text-muted">Applies instantly. Groups inherit the same way (API: principal_kind “group”).</p>
              <form className="mt-3 grid gap-2" onSubmit={async (e) => {
                e.preventDefault();
                try { await api.addMember(spaceId, { principal_kind: "user", principal_id: pickUser, role: pickRole }); await load(); toast.success("Role saved."); }
                catch (err) { toast.error(err instanceof Error ? err.message : "Could not save the role."); }
              }}>
                <Select value={pickUser} onChange={(e) => setPickUser(e.target.value)} required aria-label="Person" className="w-full">
                  <option value="">Choose a person…</option>
                  {users.map((u) => <option key={u.id} value={u.id}>{u.display_name} ({u.email})</option>)}
                </Select>
                <Select value={pickRole} onChange={(e) => setPickRole(e.target.value as SpaceRoleName)} aria-label="Role" className="w-full">
                  <option value="owner">Owner — everything</option>
                  <option value="coder">Coder — push &amp; create</option>
                  <option value="reader">Reader — view only</option>
                </Select>
                <Button type="submit">Give role</Button>
              </form>
            </Card>
          )}
        </aside>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- projects

function ProjectDetail({ projectId, milestoneId, go }: { projectId: string; milestoneId?: string; go: (v: View, replace?: boolean) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.project>> | null>(null);
  const [selected, setSelectedState] = useState<string | null>(milestoneId ?? null);
  const [showPush, setShowPush] = useState(false);
  const [error, setError] = useState("");

  const setSelected = useCallback((mid: string) => {
    setSelectedState(mid);
    go({ name: "project", id: projectId, milestoneId: mid }, true); // URL stays shareable without spamming Back
  }, [go, projectId]);

  const load = useCallback(async () => {
    try {
      const d = await api.project(projectId);
      setData(d);
      setSelectedState((prev) => {
        if (prev && d.milestones.some((m) => m.id === prev)) return prev;
        if (milestoneId && d.milestones.some((m) => m.id === milestoneId)) return milestoneId;
        return d.milestones[d.milestones.length - 1]?.id ?? null;
      });
    } catch (e) { setError(e instanceof Error ? e.message : "Failed to load this project."); }
  }, [projectId, milestoneId]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (milestoneId) setSelectedState(milestoneId); }, [milestoneId]);

  if (!data) {
    return error
      ? <Alert>{error}</Alert>
      : <div className="space-y-3"><Skeleton className="h-10 w-64" /><Skeleton className="h-40" /></div>;
  }

  return (
    <section aria-labelledby="project-title">
      <Button variant="ghost" size="sm" onClick={() => go({ name: "space", id: data.project.space_id, label: data.project.name })}>← Back to space</Button>
      <h2 id="project-title" className="mt-2 font-serif text-3xl font-bold">{data.project.name}</h2>
      <p className="mt-1 max-w-2xl text-sm text-text-muted">
        Each push from the skill saves a new milestone. Nothing is overwritten — fork any milestone to try a different direction.
      </p>

      <Card className="mt-4 p-4" >
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <div>
            <p className="text-xs font-medium text-text-muted">Languages</p>
            <p className="mt-1 flex flex-wrap gap-1.5">
              {data.summary.languages.length > 0
                ? data.summary.languages.map((l) => <Badge key={l} tone="primary">{l}</Badge>)
                : <span className="text-sm text-text-muted">Not detected yet</span>}
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-text-muted">Milestones</p>
            <p className="mt-0.5 font-serif text-xl font-bold">{data.summary.milestones}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-text-muted">Vulnerabilities</p>
            <p className="mt-0.5 font-serif text-xl font-bold">{data.summary.vulnerabilities}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-text-muted">Secrets found</p>
            <p className="mt-0.5 font-serif text-xl font-bold">{data.summary.secrets}</p>
          </div>
          <div>
            <p className="text-xs font-medium text-text-muted">Needs fixing</p>
            <p className="mt-1 flex flex-wrap gap-1.5">
              <Badge tone="danger">{data.summary.fix_now} fix now</Badge>
              <Badge tone="warning">{data.summary.fix_soon} fix soon</Badge>
              <Badge>{data.summary.good_to_know} good to know</Badge>
            </p>
          </div>
          <div>
            <p className="text-xs font-medium text-text-muted">Last push</p>
            <p className="mt-0.5 text-sm">{data.summary.last_push ? new Date(data.summary.last_push).toLocaleDateString() : "—"}</p>
          </div>
          <div className="ml-auto flex flex-wrap gap-2">
            <CopyButton text={`${window.location.origin}/projects/${data.project.id}`} label="Copy project link" />
            {selected && <CopyButton text={`${window.location.origin}/projects/${data.project.id}/milestones/${selected}`} label="Copy milestone link" />}
          </div>
        </div>
        <p className="mt-3 text-xs text-text-muted">
          Share these links with your team — anyone with access to this space opens the exact project or milestone. Latest milestone languages: {data.milestones[data.milestones.length - 1]?.languages.join(", ") || "—"}.
        </p>
      </Card>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button aria-expanded={showPush} onClick={() => setShowPush((v) => !v)}>
          {showPush ? "Close" : "+ Push milestone"}
        </Button>
        <span className="text-sm text-text-muted">Saves a new scanned version — History below is never overwritten.</span>
      </div>
      {showPush && (
        <UploadBox projectId={projectId} onDone={() => { setShowPush(false); void load(); }} onCancel={() => setShowPush(false)} />
      )}

      <div className="mt-8 grid gap-6 lg:grid-cols-[280px_1fr]">
        <div>
          <div className="flex items-baseline gap-2">
            <h3 className="font-serif text-lg font-bold">History</h3>
            <span className="text-xs text-text-muted">{data.milestones.length} milestone{data.milestones.length === 1 ? "" : "s"}</span>
          </div>
          {data.milestones.length > 0 ? (
            <ol className="relative mt-4">
              <span aria-hidden className="absolute bottom-3 left-[13px] top-3 w-px bg-border" />
              {[...data.milestones].reverse().map((m, idx) => {
                const active = selected === m.id;
                const latest = idx === 0;
                return (
                  <li key={m.id} className="relative pb-3 pl-9 last:pb-0">
                    <span
                      aria-hidden
                      className={`absolute left-[7px] top-[18px] h-[13px] w-[13px] rounded-full border-[2.5px] transition duration-fast ${
                        active ? "border-primary bg-primary" : m.findings > 0 ? "border-error/70 bg-surface" : "border-success/70 bg-surface"
                      }`}
                    />
                    <button
                      type="button"
                      aria-current={active || undefined}
                      onClick={() => setSelected(m.id)}
                      className={`w-full rounded-lg border p-3.5 text-left transition duration-normal ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.99] ${
                        active
                          ? "border-primary bg-primary/5 shadow-raised"
                          : "border-border bg-surface shadow-surface hover:-translate-y-px hover:border-primary/50 hover:shadow-raised"
                      }`}
                    >
                      <span className="flex items-center gap-2">
                        <span className={`rounded-sm px-1.5 py-0.5 text-[11px] font-bold ${active ? "bg-primary text-primary-fg" : "bg-background text-text-muted"}`}>
                          #{m.seq_no}
                        </span>
                        {latest && <Badge tone="primary">Latest</Badge>}
                        <span className="ml-auto text-[11px] text-text-muted">
                          {new Date(m.created_at).toLocaleDateString(undefined, { day: "numeric", month: "short" })}
                          {" · "}
                          {new Date(m.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </span>
                      <span className="mt-2 line-clamp-2 block text-sm font-medium leading-snug">{m.label}</span>
                      <span className="mt-2.5 flex flex-wrap items-center gap-1.5">
                        {m.findings > 0 ? <Badge tone="danger">{m.findings} to fix</Badge> : <Badge tone="success">✓ Clean scan</Badge>}
                        {m.languages?.length > 0 && <Badge>{m.languages.join(" · ")}</Badge>}
                        <span aria-hidden className={`ml-auto text-xs font-medium text-primary transition duration-fast ${active ? "opacity-100" : "opacity-0"}`}>
                          Viewing →
                        </span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          ) : (
            <div className="mt-3"><EmptyState title="No milestones yet" hint="Push one with the skill or the button above." /></div>
          )}
        </div>
        <div>
          {selected
            ? <MilestoneDetail milestoneId={selected} projectId={projectId} onChanged={load} />
            : <EmptyState title="Pick a milestone" hint="Its files, findings and screenshots appear here." />}
        </div>
      </div>
    </section>
  );
}

function UploadBox({ projectId, onDone, onCancel }: { projectId: string; onDone: () => void; onCancel: () => void }) {
  const [label, setLabel] = useState("");
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <form
      className="vf-page mt-4 rounded-lg border border-dashed border-border bg-surface p-5 shadow-surface"
      onSubmit={async (e) => {
        e.preventDefault();
        const file = e.currentTarget.querySelector<HTMLInputElement>("input[type=file]")?.files?.[0];
        if (!file) { toast.error("Choose a .zip of the project first."); return; }
        setBusy(true);
        try {
          const r = (await api.pushZip(projectId, file, label)) as { findings: number };
          toast.success(`Milestone saved. Scan found ${r.findings} thing(s) to look at.`);
          setLabel("");
          onDone();
        } catch (err) { toast.error(err instanceof Error ? err.message : "Upload failed."); }
        finally { setBusy(false); }
      }}
    >
      <Label>Push a milestone (.zip)</Label>
      <p className="mt-0.5 text-sm text-text-muted">
        We check the zip safely (no zip bombs), then scan for passwords in code, risky patterns, unused libraries, and known library problems.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Input type="file" accept=".zip" aria-label="Project zip" className="w-auto" />
        <span className="min-w-48 flex-1"><Input placeholder="What changed? e.g. Login page works" value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Milestone label" /></span>
        <Button type="submit" busy={busy}>{busy ? "Scanning…" : "Save milestone"}</Button>
        <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
      </div>
    </form>
  );
}

type MileData = Awaited<ReturnType<typeof api.milestone>>;

function MilestoneDetail({ milestoneId, projectId, onChanged }: { milestoneId: string; projectId: string; onChanged: () => void }) {
  const [tab, setTab] = useState("findings");
  const [data, setData] = useState<MileData | null>(null);
  const [openFile, setOpenFile] = useState<{ path: string; text: string } | null>(null);
  const [myProjects, setMyProjects] = useState<Awaited<ReturnType<typeof api.myProjects>>>([]);
  const [forkTo, setForkTo] = useState("");
  const [forking, setForking] = useState(false);
  const [shotBusy, setShotBusy] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try { setData(await api.milestone(milestoneId)); } catch { setData(null); }
  }, [milestoneId]);
  useEffect(() => { void load(); setOpenFile(null); setTab("findings"); }, [load]);
  useEffect(() => { void api.myProjects().then(setMyProjects).catch(() => {}); }, []);

  if (!data) return <div className="space-y-2"><Skeleton className="h-10" /><Skeleton className="h-32" /></div>;
  const open = data.findings.filter((f) => f.status === "open");
  const shots = data.milestone.screenshots ?? [];

  return (
    <div>
      <Tabs
        ariaLabel="Milestone"
        value={tab}
        onChange={setTab}
        items={[
          { key: "findings", label: `Findings (${open.length})` },
          { key: "fix", label: "Fix it" },
          { key: "files", label: `Files (${data.files.length})` },
          { key: "todos", label: `To-dos & gaps (${data.todos.length})` },
          { key: "sbom", label: `SBOM (${data.sbom?.total ?? 0})` },
          { key: "shots", label: `Screenshots (${shots.length})` },
        ]}
      />
      <div role="tabpanel" className="mt-4">
        {tab === "findings" && (
          open.length > 0 ? (
            <ul className="space-y-2">
              {open.map((f) => (
                <li key={f.id}>
                  <Card className="p-4">
                    <span className="flex flex-wrap items-center gap-2">
                      <Badge tone={sevTone(f.severity)}>{SEV_WORD[f.severity] ?? f.severity}</Badge>
                      <span className="font-medium">{f.plain_title}</span>
                    </span>
                    <p className="mt-1.5 text-sm text-text-muted">{f.plain_explain}</p>
                    {(f.cve_id || f.cvss_score != null || f.fixed_version) && (
                      <p className="mt-2 flex flex-wrap gap-1.5">
                        {f.cve_id && <Badge>{f.cve_id}</Badge>}
                        {cvssLabel(f.cvss_score) && <Badge tone={f.cvss_score != null && f.cvss_score >= 7 ? "danger" : "warning"}>{cvssLabel(f.cvss_score)}</Badge>}
                        {f.package && <Badge tone="primary">{f.package} {f.current_version ?? ""}{f.fixed_version ? ` → ${f.fixed_version}` : ""}</Badge>}
                      </p>
                    )}
                    {f.file_path && <p className="mt-1 text-xs text-text-muted">In {f.file_path}</p>}
                  </Card>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="Nothing needs fixing" hint="This milestone passed every check. Nice work." />
        )}

        {tab === "fix" && (
          open.length > 0 ? (
            <ul className="space-y-2">
              {open.map((f) => (
                <li key={f.id}>
                  <Card className="p-4">
                    <span className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{f.plain_title}</span>
                      {cvssLabel(f.cvss_score) && <Badge tone={f.cvss_score != null && f.cvss_score >= 7 ? "danger" : "warning"}>{cvssLabel(f.cvss_score)}</Badge>}
                    </span>
                    {f.package && (
                      <p className="mt-1 text-sm text-text-muted">
                        {f.package}: <strong>{f.current_version ?? "?"}</strong>
                        {f.fixed_version ? <> → update to <strong>{f.fixed_version}</strong> or later</> : <> — no fixed version published yet</>}
                      </p>
                    )}
                    <pre className="mt-2 overflow-x-auto whitespace-pre-wrap rounded-md bg-background p-3 text-xs">{f.fix_text}</pre>
                    <div className="mt-3 flex flex-wrap gap-2">
                      <CopyButton text={f.fix_text} label="Copy fix" />
                      <Button variant="ghost" size="sm" onClick={async () => { await api.ignoreFinding(f.id); await load(); toast.info("Marked as not a problem."); }}>
                        Not a problem
                      </Button>
                    </div>
                    <p className="mt-2 text-xs text-text-muted">Apply the fix in your AI tool, then push again — the new milestone should show this gone.</p>
                  </Card>
                </li>
              ))}
            </ul>
          ) : <EmptyState title="Nothing to fix" hint="Fixes for open findings appear here." />
        )}

        {tab === "files" && (
          <div className="grid gap-3 lg:grid-cols-[260px_1fr]">
            <ul className="max-h-96 divide-y divide-border overflow-auto rounded-lg border border-border bg-surface shadow-surface">
              {data.files.map((f) => (
                <li key={f.path}>
                  <button
                    type="button"
                    aria-current={openFile?.path === f.path || undefined}
                    className={`min-h-11 w-full px-3 py-2 text-left text-sm transition duration-fast hover:bg-background focus-visible:outline-2 focus-visible:outline-primary ${openFile?.path === f.path ? "bg-primary/5 font-medium" : ""}`}
                    onClick={async () => {
                      try { setOpenFile(await api.fileContent(milestoneId, f.path)); }
                      catch (e) { setOpenFile({ path: f.path, text: e instanceof Error ? e.message : "Cannot preview this file." }); }
                    }}
                  >
                    {f.path} <span className="text-text-muted">({f.size_bytes} B)</span>
                  </button>
                </li>
              ))}
            </ul>
            <Card className="p-4">
              {openFile ? (
                <>
                  <p className="text-sm font-medium">{openFile.path}</p>
                  <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-md bg-background p-3 text-xs">{openFile.text}</pre>
                </>
              ) : (
                <p className="text-sm text-text-muted">Pick a file to read it. README.md, TODO.md and KNOWN_GAPS.md live here too.</p>
              )}
            </Card>
          </div>
        )}

        {tab === "todos" && (
          <Card className="p-4">
            <p className="text-sm text-text-muted">From the skill survey, the scanner, and admin messages. Edit TODO.md / KNOWN_GAPS.md in the Files tab.</p>
            {data.todos.length > 0 ? (
              <ul className="mt-3 space-y-1.5">
                {data.todos.map((t) => (
                  <li key={t.id} className="flex min-h-8 items-start gap-2 text-sm">
                    <span aria-hidden className={t.done ? "text-success" : "text-text-muted"}>{t.done ? "✓" : "○"}</span>
                    <span className={t.done ? "text-text-muted line-through" : ""}>{t.body}</span>
                    <Badge>{t.source}</Badge>
                  </li>
                ))}
              </ul>
            ) : <p className="mt-3 text-sm text-text-muted">No to-dos recorded for this milestone.</p>}
          </Card>
        )}

        {tab === "sbom" && <SbomPanel milestoneId={milestoneId} sbom={data.sbom} />}

        {tab === "shots" && (
          <Card className="p-4">
            <p className="text-sm text-text-muted">Base a milestone on how it looks. Attach a screenshot — History keeps it with this milestone.</p>
            <div className="mt-3 flex flex-wrap gap-2">
              {shots.map((k) => <Badge key={k}>{k.split("/").pop()}</Badge>)}
              {shots.length === 0 && <span className="text-sm text-text-muted">No screenshots yet.</span>}
            </div>
            <form className="mt-4 flex flex-wrap gap-2" onSubmit={async (e) => {
              e.preventDefault();
              const file = e.currentTarget.querySelector<HTMLInputElement>("input[type=file]")?.files?.[0];
              if (!file) { toast.error("Choose an image first."); return; }
              setShotBusy(true);
              try { await api.addScreenshot(milestoneId, file); await load(); onChanged(); toast.success("Screenshot attached."); }
              catch (err) { toast.error(err instanceof Error ? err.message : "Upload failed."); }
              finally { setShotBusy(false); }
            }}>
              <Input type="file" accept="image/*" aria-label="Screenshot image" className="w-auto" />
              <Button type="submit" busy={shotBusy}>Attach screenshot</Button>
            </form>
          </Card>
        )}
      </div>

      <Card className="mt-6 p-4">
        <p className="font-medium">Fork this milestone</p>
        <p className="mt-0.5 text-sm text-text-muted">Copies this exact version into another project so you can try a different direction without losing this one.</p>
        <form className="mt-3 flex flex-wrap gap-2" onSubmit={async (e) => {
          e.preventDefault();
          if (!forkTo) { toast.error("Pick a project to fork into."); return; }
          setForking(true);
          try { await api.fork(milestoneId, forkTo, `Fork of ${data.milestone.label}`); toast.success("Forked — open that project to keep building from here."); }
          catch (err) { toast.error(err instanceof Error ? err.message : "Fork failed."); }
          finally { setForking(false); }
        }}>
          <Select value={forkTo} onChange={(e) => setForkTo(e.target.value)} aria-label="Fork target project">
            <option value="">Choose a project…</option>
            {myProjects.filter((p) => p.id !== projectId).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
          <Button type="submit" busy={forking}>Fork</Button>
        </form>
      </Card>
    </div>
  );
}

function SbomPanel({ milestoneId, sbom }: { milestoneId: string; sbom: MileData["sbom"] }) {
  const [query, setQuery] = useState("");
  const toast = useToast();
  const packages = sbom?.packages ?? [];
  const visible = packages.filter((pkg) =>
    `${pkg.name} ${pkg.version} ${pkg.ecosystem ?? ""}`.toLowerCase().includes(query.trim().toLowerCase()));
  if (!sbom || sbom.total === 0) {
    return <EmptyState title="No SBOM for this milestone" hint="Push again — every new milestone generates a Syft SBOM (SBOM.json) automatically." />;
  }
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div>
          <p className="font-medium">Software bill of materials (Syft)</p>
          <p className="text-sm text-text-muted">{sbom.total} packages · generated by {sbom.tool} · this list is exactly what OSV checked for vulnerabilities.</p>
        </div>
        <span className="ml-auto flex flex-wrap gap-2">
          <Input type="search" placeholder="Search packages…" aria-label="Search SBOM packages" value={query} onChange={(e) => setQuery(e.target.value)} className="w-52" />
          <Button onClick={async () => {
            try { await api.downloadSbom(milestoneId); toast.success("SBOM.json downloaded."); }
            catch (err) { toast.error(err instanceof Error ? err.message : "Download failed."); }
          }}>Download SBOM.json</Button>
        </span>
      </div>
      <div className="mt-3 max-h-96 overflow-auto rounded-md border border-border">
        <table className="w-full text-left text-sm">
          <thead className="sticky top-0 bg-background">
            <tr>
              <th className="px-3 py-2 font-medium">Package</th>
              <th className="px-3 py-2 font-medium">Version</th>
              <th className="px-3 py-2 font-medium">Ecosystem</th>
              <th className="px-3 py-2 font-medium">PURL</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {visible.map((pkg, i) => (
              <tr key={`${pkg.purl}-${i}`} className="transition duration-fast hover:bg-background">
                <td className="px-3 py-2 font-medium">{pkg.name}</td>
                <td className="px-3 py-2">{pkg.version}</td>
                <td className="px-3 py-2"><Badge>{pkg.ecosystem ?? pkg.type}</Badge></td>
                <td className="max-w-64 truncate px-3 py-2 font-mono text-xs text-text-muted" title={pkg.purl}>{pkg.purl}</td>
              </tr>
            ))}
            {visible.length === 0 && <tr><td colSpan={4} className="px-3 py-4 text-text-muted">No packages match that search.</td></tr>}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

// ----------------------------------------------------------------- profile

function Profile() {
  const [tokens, setTokens] = useState<Awaited<ReturnType<typeof api.tokens>> | null>(null);
  const [fresh, setFresh] = useState("");
  const [name, setName] = useState("My AI tool");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  const load = useCallback(async () => {
    try { setTokens(await api.tokens()); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to load tokens."); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const skillMd = `Install the VibeForge skill, then connect with your token:

1. Download SKILL.md from /skill/SKILL.md (this server also serves it).
2. Save it as SKILL.md in your AI tool's skills folder:
   - Claude Code: ~/.claude/skills/vibeforge/SKILL.md
   - Codex: ~/.codex/skills/vibeforge/SKILL.md
3. In your AI tool say: "Use the VibeForge skill. My server is ${location.origin} and my token is <paste token>."
4. The skill asks 3 short questions (or say "skip, just push"), writes TODO.md / KNOWN_GAPS.md / README.md, zips the project and pushes a milestone.`;

  return (
    <section aria-labelledby="profile-title" className="space-y-6">
      <div>
        <h2 id="profile-title" className="font-serif text-3xl font-bold">Profile</h2>
        <p className="mt-1 text-sm text-text-muted">Your skill install and API tokens. Everything here is also in the Profile menu, top right.</p>
      </div>

      <Card className="p-5">
        <h3 className="font-serif text-lg font-bold">Install the skill — connect your AI tool</h3>
        <p className="mt-1 text-sm text-text-muted">The skill teaches your AI tool how to save milestones here. It works with any tool that reads SKILL.md files.</p>
        <pre className="mt-3 overflow-x-auto whitespace-pre-wrap rounded-md bg-background p-3 text-xs">{skillMd}</pre>
        <div className="mt-3 flex flex-wrap gap-2">
          <a href="/skill/SKILL.md" download className="inline-flex min-h-11 items-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-fg shadow-surface transition duration-fast ease-standard hover:bg-primary-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.98]">
            Download SKILL.md
          </a>
          <CopyButton text={skillMd} label="Copy install steps" />
        </div>
      </Card>

      <Card className="p-5">
        <h3 className="font-serif text-lg font-bold">API tokens — how the skill signs in</h3>
        <p className="mt-1 text-sm text-text-muted">A token works like a password for one tool. You will see it once — copy it straight into your AI tool. Revoke it any time.</p>
        {error && <div className="mt-3"><Alert>{error}</Alert></div>}
        <form className="mt-4 flex max-w-md gap-2" onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          try { const r = await api.createToken(name); setFresh(r.token); await load(); toast.success("Token created — copy it now."); }
          catch (err) { toast.error(err instanceof Error ? err.message : "Could not create the token."); }
          finally { setBusy(false); }
        }}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required aria-label="Token name" />
          <Button type="submit" busy={busy}>Create token</Button>
        </form>
        {fresh && (
          <div className="mt-4 rounded-md border border-warning/40 bg-warning/10 p-4">
            <p className="text-sm font-medium">Copy this now — it will not be shown again:</p>
            <code className="mt-2 block break-all rounded-md bg-surface p-2 text-sm">{fresh}</code>
            <div className="mt-2"><CopyButton text={fresh} label="Copy token" /></div>
          </div>
        )}
        {tokens === null && !error && <div className="mt-4 space-y-2"><Skeleton className="h-11" /><Skeleton className="h-11" /></div>}
        {tokens !== null && (
          <ul className="mt-4 divide-y divide-border rounded-lg border border-border">
            {tokens.map((t) => (
              <li key={t.id} className="flex min-h-11 flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="font-medium">{t.name}</span>
                <code className="text-xs text-text-muted">{t.prefix}…</code>
                <Badge tone={t.revoked ? "danger" : "success"}>{t.revoked ? "revoked" : t.scopes.join(", ")}</Badge>
                {!t.revoked && (
                  <span className="ml-auto">
                    <Button variant="ghost" size="sm" onClick={async () => { await api.revokeToken(t.id); await load(); toast.info("Token revoked."); }}>
                      Revoke
                    </Button>
                  </span>
                )}
              </li>
            ))}
            {tokens.length === 0 && <li className="px-3 py-3 text-sm text-text-muted">No tokens yet.</li>}
          </ul>
        )}
      </Card>
    </section>
  );
}

// ------------------------------------------------------------------- admin

function Admin({ initialTab }: { initialTab: string }) {
  const [tab, setTab] = useState(initialTab || "vulns");
  const [users, setUsers] = useState<Awaited<ReturnType<typeof api.adminUsers>>>([]);
  const [vulns, setVulns] = useState<Awaited<ReturnType<typeof api.adminVulns>> | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState({ email: "", display_name: "", password: "", is_platform_admin: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [u, v, s] = await Promise.all([api.adminUsers(), api.adminVulns(), api.settings()]);
      setUsers(u); setVulns(v); setSettings(s);
    } catch { setError("Admin access required."); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);

  return (
    <section aria-labelledby="admin-title">
      <h2 id="admin-title" className="font-serif text-3xl font-bold">Settings &amp; admin</h2>
      <p className="mt-1 text-sm text-text-muted">One place for people, safety, and app settings — reached from the single Settings button.</p>
      {error && <div className="mt-4"><Alert>{error}</Alert></div>}

      <div className="mt-5">
        <Tabs
          ariaLabel="Admin"
          value={tab}
          onChange={setTab}
          items={[
            { key: "vulns", label: `Vulnerabilities${vulns ? ` (${vulns.total_open})` : ""}` },
            { key: "people", label: "People & groups" },
            { key: "settings", label: "App settings" },
          ]}
        />
      </div>

      <div role="tabpanel" className="mt-5">
        {tab === "vulns" && (
          <div>
            {vulns
              ? <p className="text-sm text-text-muted">{vulns.total_open} open ({vulns.critical} fix-now) across every project. Contact leaves a to-do on their latest milestone.</p>
              : <div className="space-y-2"><Skeleton className="h-12" /><Skeleton className="h-12" /></div>}
            {vulns && vulns.rows.length > 0 && (
              <div className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface shadow-surface">
                {vulns.rows.map((r) => (
                  <div key={r.finding_id} className="flex min-h-11 flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                    <Badge tone={sevTone(r.severity)}>{SEV_WORD[r.severity] ?? r.severity}</Badge>
                    <span className="font-medium">{r.title}</span>
                    <span className="text-text-muted">in {r.project} · {r.owner}</span>
                    <span className="ml-auto flex gap-1">
                      <Button variant="ghost" size="sm" onClick={async () => { await api.adminNudge(r.owner_id, `Please fix: ${r.title}`); toast.success("Message left on their latest milestone."); }}>
                        Contact member
                      </Button>
                      <Button variant="ghost" size="sm" onClick={async () => { await api.adminBlock(r.owner_id, "Security fix required"); await load(); toast.info("Member blocked until unblocked."); }}>
                        Block
                      </Button>
                    </span>
                  </div>
                ))}
              </div>
            )}
            {vulns && vulns.rows.length === 0 && <div className="mt-3"><EmptyState title="No open vulnerabilities" hint="Every project is currently clean." /></div>}
          </div>
        )}

        {tab === "people" && (
          <div className="space-y-6">
            <div>
              {users.length > 0 ? (
                <ul className="divide-y divide-border rounded-lg border border-border bg-surface shadow-surface">
                  {users.map((u) => (
                    <li key={u.id} className="flex min-h-11 flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                      <Avatar name={u.display_name} size="sm" />
                      <span className="font-medium">{u.display_name}</span>
                      <span className="text-text-muted">{u.email}</span>
                      {u.is_platform_admin && <Badge tone="primary">Admin</Badge>}
                      {u.is_blocked && <Badge tone="danger">Blocked</Badge>}
                      <span className="ml-auto flex gap-1">
                        {u.is_blocked
                          ? <Button variant="ghost" size="sm" onClick={async () => { await api.adminUnblock(u.id); await load(); toast.success("Member unblocked."); }}>Unblock</Button>
                          : <Button variant="ghost" size="sm" onClick={async () => { await api.adminBlock(u.id, "Blocked by admin"); await load(); toast.info("Member blocked."); }}>Block</Button>}
                        <Button variant="ghost" size="sm" onClick={async () => { await api.adminNudge(u.id, "Hello from your admin — please check your project findings."); toast.success("Message left on their latest milestone."); }}>Contact</Button>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : <EmptyState title="No people yet" hint="Create the first user below." />}
              <Card className="mt-4 p-4">
                <p className="font-medium">Create a user</p>
                <form className="mt-3 grid max-w-lg gap-3" onSubmit={async (e) => {
                  e.preventDefault();
                  setBusy(true);
                  try {
                    await api.adminCreateUser(form);
                    setForm({ email: "", display_name: "", password: "", is_platform_admin: false });
                    await load();
                    toast.success("User created. Share the password once — they create their own token under Profile.");
                  } catch (err) { toast.error(err instanceof Error ? err.message : "Could not create the user."); }
                  finally { setBusy(false); }
                }}>
                  <Input type="email" placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required aria-label="Email" />
                  <Input placeholder="Display name" value={form.display_name} onChange={(e) => setForm({ ...form, display_name: e.target.value })} required aria-label="Display name" />
                  <Input type="password" placeholder="Temporary password (8+ characters)" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required aria-label="Temporary password" />
                  <label className="flex min-h-11 items-center gap-2 text-sm">
                    <input type="checkbox" className="h-4 w-4 accent-primary" checked={form.is_platform_admin} onChange={(e) => setForm({ ...form, is_platform_admin: e.target.checked })} />
                    Platform admin
                  </label>
                  <Button type="submit" busy={busy}>Create user</Button>
                </form>
              </Card>
              <CreateGroup users={users} onDone={load} />
            </div>
          </div>
        )}

        {tab === "settings" && (
          <div>
            <p className="max-w-2xl text-sm text-text-muted">Upload limits stop zip bombs. Token and session values control sign-in. Changes save to the database and take effect on the next request — no restart.</p>
            {settings ? (
              <form className="mt-4 grid max-w-xl gap-2" onSubmit={async (e) => {
                e.preventDefault();
                await api.putSettings(settings);
                toast.success("Settings saved.");
              }}>
                {Object.entries(settings).map(([k, v]) => (
                  <label key={k} className="flex min-h-11 items-center gap-3 rounded-md border border-border bg-surface px-3 py-1.5 text-sm">
                    <span className="w-52 shrink-0 font-medium">{k}</span>
                    {typeof v === "boolean"
                      ? <input type="checkbox" className="h-4 w-4 accent-primary" checked={v} onChange={(e) => setSettings({ ...settings, [k]: e.target.checked })} />
                      : <Input value={String(v)} aria-label={k} onChange={(e) => setSettings({ ...settings, [k]: typeof v === "number" ? Number(e.target.value) : e.target.value })} />}
                  </label>
                ))}
                <div className="mt-2"><Button type="submit">Save settings</Button></div>
              </form>
            ) : <div className="mt-4 space-y-2"><Skeleton className="h-11" /><Skeleton className="h-11" /><Skeleton className="h-11" /></div>}
          </div>
        )}
      </div>
    </section>
  );
}

function CreateGroup({ users, onDone }: { users: { id: string; display_name: string }[]; onDone: () => void }) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Card className="mt-4 max-w-lg p-4">
      <p className="font-medium">Create a group</p>
      <p className="mt-0.5 text-sm text-text-muted">Give the group a role in a space and everyone in it inherits that role.</p>
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await api.adminCreateGroup({ name, description: "", member_ids: picked }); setName(""); setPicked([]); onDone(); toast.success("Group created."); }
        catch (err) { toast.error(err instanceof Error ? err.message : "Could not create the group."); }
        finally { setBusy(false); }
      }}>
        <div className="mt-3"><Input placeholder="Group name" value={name} onChange={(e) => setName(e.target.value)} required aria-label="Group name" /></div>
        <div className="mt-3 flex flex-wrap gap-2">
          {users.map((u) => {
            const on = picked.includes(u.id);
            return (
              <button
                key={u.id}
                type="button"
                aria-pressed={on}
                onClick={() => setPicked(on ? picked.filter((x) => x !== u.id) : [...picked, u.id])}
                className={`min-h-9 rounded-full border px-3 py-1 text-sm transition duration-fast ease-standard focus-visible:outline-2 focus-visible:outline-primary active:scale-[0.98] ${on ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface hover:bg-background"}`}
              >
                {u.display_name}
              </button>
            );
          })}
        </div>
        <div className="mt-3"><Button type="submit" busy={busy}>Create group</Button></div>
      </form>
    </Card>
  );
}
