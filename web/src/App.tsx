import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
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
import {
  VibeForgeLogo,
  DefaultProjectIcon,
  IconSpaces,
  IconPlus,
  IconMarketplace,
  IconShieldAlert,
  IconPeople,
  IconUser,
  IconGroup,
  IconSettings,
  IconChevronLeft,
  IconChevronRight,
  IconSearch,
  IconMenu,
  IconClose,
} from "./components/icons";
import { NotFoundScreen, ServerErrorScreen, ErrorBoundary } from "./components/ErrorScreens";

type Me = Awaited<ReturnType<typeof api.me>>;
type View =
  | { name: "spaces" }
  | { name: "space"; id: string; label: string }
  | { name: "project"; id: string; milestoneId?: string }
  | { name: "profile" }
  | { name: "admin"; tab: string }
  | { name: "marketplace" }
  | { name: "404" }
  | { name: "500"; error?: string };

/** Shareable URLs: /spaces/:id  /projects/:id  /projects/:id/milestones/:mid  /profile  /admin/:tab  /404  /500 */
function parsePath(path: string): View {
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return { name: "spaces" };
  if (parts[0] === "spaces") {
    if (parts[1]) return { name: "space", id: parts[1], label: "" };
    return { name: "spaces" };
  }
  if (parts[0] === "projects" && parts[1]) {
    return parts[2] === "milestones" && parts[3]
      ? { name: "project", id: parts[1], milestoneId: parts[3] }
      : { name: "project", id: parts[1] };
  }
  if (parts[0] === "profile") return { name: "profile" };
  if (parts[0] === "marketplace") return { name: "marketplace" };
  if (parts[0] === "admin") return { name: "admin", tab: parts[1] ?? "vulns" };
  if (parts[0] === "404") return { name: "404" };
  if (parts[0] === "500") return { name: "500" };
  return { name: "404" };
}

function toPath(v: View): string {
  switch (v.name) {
    case "space": return `/spaces/${v.id}`;
    case "project": return v.milestoneId ? `/projects/${v.id}/milestones/${v.milestoneId}` : `/projects/${v.id}`;
    case "profile": return "/profile";
    case "marketplace": return "/marketplace";
    case "admin": return `/admin/${v.tab}`;
    case "404": return "/404";
    case "500": return "/500";
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
      <ErrorBoundary>
        <Shell />
      </ErrorBoundary>
    </ToastProvider>
  );
}

function Shell() {
  const [me, setMe] = useState<Me | null>(null);
  const [view, setViewState] = useState<View>(() => parsePath(window.location.pathname));
  const toast = useToast();
  const [collapsed, setCollapsed] = useState(() => localStorage.getItem("vf_side_collapsed") === "1");
  const [sideW, setSideW] = useState(() => {
    const v = Number(localStorage.getItem("vf_side_w"));
    return v >= 200 && v <= 420 ? v : 264;
  });
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [settingsCollapsed, setSettingsCollapsed] = useState(() => localStorage.getItem("vf_settings_collapsed") === "1");
  const [adminCounts, setAdminCounts] = useState<{ vulns?: number; users?: number; groups?: number }>({});

  const toggleSettingsCollapsed = useCallback(() => {
    setSettingsCollapsed((v) => {
      localStorage.setItem("vf_settings_collapsed", v ? "0" : "1");
      return !v;
    });
  }, []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [view]);

  useEffect(() => {
    if (view.name === "admin" && me?.user.is_platform_admin) {
      Promise.all([
        api.adminVulns().catch(() => null),
        api.adminUsers().catch(() => null),
        api.adminGroups().catch(() => null),
      ]).then(([v, u, g]) => {
        setAdminCounts({
          vulns: v?.total_open,
          users: u?.length,
          groups: g?.length,
        });
      });
    }
  }, [view.name, me]);

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

  const toggleCollapsed = () => {
    setCollapsed((v) => {
      localStorage.setItem("vf_side_collapsed", v ? "0" : "1");
      return !v;
    });
  };

  const startResize = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = sideW;
    const onMove = (ev: MouseEvent) => {
      const next = Math.min(420, Math.max(200, startW + ev.clientX - startX));
      setSideW(next);
      localStorage.setItem("vf_side_w", String(next));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };



  return (
    <PermissionsProvider value={perms}>
      <div className="flex h-screen overflow-hidden bg-background text-text">
        {/* Left navigation — desktop: collapsible + drag-resizable (persisted) */}
        <aside
          aria-label="Left navigation"
          style={collapsed ? undefined : { width: sideW }}
          className={`hidden h-full shrink-0 flex-col overflow-hidden border-r border-border bg-surface lg:relative lg:flex ${collapsed ? "w-16" : ""}`}
        >
          {/* Nav collapse at top: icon button to toggle — fixed h-16 aligned with top nav header */}
          <div className={`flex h-16 shrink-0 items-center border-b border-border px-3 ${collapsed ? "justify-center" : "justify-between"}`}>
            {!collapsed ? (
              <>
                <button
                  type="button"
                  onClick={() => setView({ name: "spaces" })}
                  className="flex items-center gap-2.5 text-left transition-all duration-fast hover:opacity-85 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer select-none"
                >
                  <VibeForgeLogo size={28} />
                  <span className="min-w-0">
                    <span className="block truncate font-serif text-base font-bold leading-tight">VibeForge</span>
                    <span className="block text-[10px] leading-tight text-text-muted">Milestones, not git</span>
                  </span>
                </button>
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  aria-label="Collapse sidebar"
                  title="Collapse sidebar"
                  className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/50 text-text-muted transition-all duration-fast hover:border-border hover:bg-background hover:text-text active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer"
                >
                  <IconChevronLeft />
                </button>
              </>
            ) : (
              <div className="flex flex-col items-center justify-center gap-1">
                <button
                  type="button"
                  onClick={() => setView({ name: "spaces" })}
                  aria-label="VibeForge home"
                  title="VibeForge"
                  className="flex items-center justify-center rounded-md p-0.5 transition-all duration-fast hover:bg-background active:scale-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer"
                >
                  <VibeForgeLogo size={20} />
                </button>
                <button
                  type="button"
                  onClick={toggleCollapsed}
                  aria-label="Expand sidebar"
                  title="Expand sidebar"
                  className="flex h-6 w-6 items-center justify-center rounded-md border border-border/70 bg-background/50 text-text-muted transition-all duration-fast hover:border-border hover:bg-background hover:text-text active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer"
                >
                  <IconChevronRight />
                </button>
              </div>
            )}
          </div>

          <nav aria-label="Spaces" className="flex-1 overflow-y-auto p-2">
            <SideItem collapsed={collapsed} active={view.name === "spaces"} label="All spaces" icon={<IconSpaces />} onClick={() => setView({ name: "spaces" })} />
            {!collapsed && <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Your spaces</p>}
            <div className="space-y-0.5">
              {me.spaces.map((sp) => (
                <SideItem
                  key={sp.id}
                  collapsed={collapsed}
                  active={view.name === "space" && view.id === sp.id}
                  label={sp.name}
                  icon={<span className="text-xs font-bold">{sp.name.slice(0, 1).toUpperCase()}</span>}
                  hint={collapsed ? sp.name : `${sp.role}`}
                  onClick={() => setView({ name: "space", id: sp.id, label: sp.name })}
                />
              ))}
            </div>
            {perms.isAdmin && (
              <SideItem
                collapsed={collapsed}
                active={false}
                label="New space"
                icon={<IconPlus />}
                onClick={() => {
                  setView({ name: "spaces" });
                  window.setTimeout(() => window.dispatchEvent(new Event("vf:new-space")), 50);
                }}
              />
            )}

            <div className="my-2 border-t border-border" />
            <SideItem collapsed={collapsed} active={view.name === "marketplace"} label="Marketplace" icon={<IconMarketplace />} onClick={() => setView({ name: "marketplace" })} />
          </nav>

          {/* App settings moved to bottom of left nav — single button */}
          {perms.isAdmin && (
            <div className="border-t border-border p-2">
              <SideItem
                collapsed={collapsed}
                active={view.name === "admin"}
                label="App settings"
                icon={<IconSettings />}
                hint={collapsed ? "App settings" : undefined}
                onClick={() => setView({ name: "admin", tab: "vulns" })}
              />
            </div>
          )}

          {!collapsed && (
            <div
              role="separator"
              aria-label="Resize sidebar"
              aria-orientation="vertical"
              onMouseDown={startResize}
              className="absolute right-0 top-0 h-full w-1.5 cursor-col-resize transition duration-fast hover:bg-primary/40"
            />
          )}
        </aside>

        {/* Settings left nav — full height like main nav, collapsable, attached next to main nav, no gap */}
        {view.name === "admin" && (
          <aside
            aria-label="Settings navigation"
            style={settingsCollapsed ? undefined : { width: 230 }}
            className={`hidden h-full shrink-0 flex-col overflow-hidden border-r border-border bg-surface lg:relative lg:flex transition-[width] duration-fast ${
              settingsCollapsed ? "w-16" : ""
            }`}
          >
            {/* Header: title + collapse button at top — fixed h-16 aligned with top nav header */}
            <div className={`flex h-16 shrink-0 items-center border-b border-border px-3 ${settingsCollapsed ? "justify-center" : "justify-between"}`}>
              {!settingsCollapsed ? (
                <>
                  <div className="min-w-0">
                    <span className="block truncate font-serif text-sm font-bold uppercase tracking-wider text-text">Settings</span>
                    <span className="block truncate text-[10px] text-text-muted">Platform admin</span>
                  </div>
                  <button
                    type="button"
                    onClick={toggleSettingsCollapsed}
                    aria-label="Collapse settings sidebar"
                    title="Collapse settings sidebar"
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/50 text-text-muted transition-all duration-fast hover:border-border hover:bg-background hover:text-text active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer"
                  >
                    <IconChevronLeft />
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  onClick={toggleSettingsCollapsed}
                  aria-label="Expand settings sidebar"
                  title="Expand settings sidebar"
                  className="flex h-7 w-7 items-center justify-center rounded-md border border-border/70 bg-background/50 text-text-muted transition-all duration-fast hover:border-border hover:bg-background hover:text-text active:scale-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer"
                >
                  <IconChevronRight />
                </button>
              )}
            </div>

            <nav aria-label="Settings navigation" className="flex-1 overflow-y-auto p-2 space-y-1">
              <SideItem
                collapsed={settingsCollapsed}
                active={view.tab === "vulns"}
                label="Vulnerabilities"
                icon={<IconShieldAlert />}
                badge={
                  adminCounts.vulns != null ? (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      view.tab === "vulns" ? "bg-primary/25 text-primary" : adminCounts.vulns > 0 ? "bg-danger/15 text-danger font-bold" : "bg-background text-text-muted"
                    }`}>
                      {adminCounts.vulns}
                    </span>
                  ) : undefined
                }
                onClick={() => setView({ name: "admin", tab: "vulns" })}
              />
              <SideItem
                collapsed={settingsCollapsed}
                active={view.tab === "people"}
                label="People"
                icon={<IconUser />}
                badge={
                  adminCounts.users != null ? (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      view.tab === "people" ? "bg-primary/25 text-primary" : "bg-background text-text-muted"
                    }`}>
                      {adminCounts.users}
                    </span>
                  ) : undefined
                }
                onClick={() => setView({ name: "admin", tab: "people" })}
              />
              <SideItem
                collapsed={settingsCollapsed}
                active={view.tab === "groups"}
                label="Groups"
                icon={<IconGroup />}
                badge={
                  adminCounts.groups != null ? (
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                      view.tab === "groups" ? "bg-primary/25 text-primary" : "bg-background text-text-muted"
                    }`}>
                      {adminCounts.groups}
                    </span>
                  ) : undefined
                }
                onClick={() => setView({ name: "admin", tab: "groups" })}
              />
              <SideItem
                collapsed={settingsCollapsed}
                active={view.tab === "settings"}
                label="App settings"
                icon={<IconSettings />}
                onClick={() => setView({ name: "admin", tab: "settings" })}
              />
            </nav>
          </aside>
        )}

        {/* Mobile Navigation Drawer Overlay */}
        {mobileNavOpen && (
          <div className="fixed inset-0 z-overlay lg:hidden" role="dialog" aria-modal="true" aria-label="Mobile Navigation">
            <div
              className="absolute inset-0 bg-text/40 backdrop-blur-xs transition-opacity duration-fast"
              onClick={() => setMobileNavOpen(false)}
              aria-hidden="true"
            />
            <div className="relative flex h-full w-[min(300px,85vw)] flex-col border-r border-border bg-surface p-3 shadow-overlay">
              <div className="flex items-center justify-between border-b border-border pb-3 px-1">
                <button
                  type="button"
                  onClick={() => { setView({ name: "spaces" }); setMobileNavOpen(false); }}
                  className="flex items-center gap-2.5 text-left active:scale-[0.98] cursor-pointer"
                >
                  <VibeForgeLogo size={30} />
                  <div>
                    <span className="block font-serif text-base font-bold leading-tight">VibeForge</span>
                    <span className="block text-[11px] text-text-muted">Milestones, not git</span>
                  </div>
                </button>
                <button
                  type="button"
                  onClick={() => setMobileNavOpen(false)}
                  aria-label="Close navigation"
                  className="flex h-8 w-8 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-background hover:text-text active:scale-90 cursor-pointer"
                >
                  <IconClose />
                </button>
              </div>

              <nav aria-label="Mobile spaces" className="flex-1 overflow-y-auto py-3 space-y-1">
                <SideItem collapsed={false} active={view.name === "spaces"} label="All spaces" icon={<IconSpaces />} onClick={() => { setView({ name: "spaces" }); setMobileNavOpen(false); }} />
                <p className="px-3 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wide text-text-muted">Your spaces</p>
                <div className="space-y-0.5">
                  {me.spaces.map((sp) => (
                    <SideItem
                      key={sp.id}
                      collapsed={false}
                      active={view.name === "space" && view.id === sp.id}
                      label={sp.name}
                      icon={<span className="text-xs font-bold">{sp.name.slice(0, 1).toUpperCase()}</span>}
                      hint={sp.role}
                      onClick={() => { setView({ name: "space", id: sp.id, label: sp.name }); setMobileNavOpen(false); }}
                    />
                  ))}
                </div>
                {perms.isAdmin && (
                  <SideItem
                    collapsed={false}
                    active={false}
                    label="New space"
                    icon={<IconPlus />}
                    onClick={() => {
                      setView({ name: "spaces" });
                      setMobileNavOpen(false);
                      window.setTimeout(() => window.dispatchEvent(new Event("vf:new-space")), 50);
                    }}
                  />
                )}
                <div className="my-2 border-t border-border" />
                <SideItem collapsed={false} active={view.name === "marketplace"} label="Marketplace" icon={<IconMarketplace />} onClick={() => { setView({ name: "marketplace" }); setMobileNavOpen(false); }} />
              </nav>

              {/* Mobile App settings at bottom of left nav */}
              {perms.isAdmin && (
                <div className="border-t border-border pt-2">
                  <SideItem
                    collapsed={false}
                    active={view.name === "admin"}
                    label="App settings"
                    icon={<IconSettings />}
                    onClick={() => {
                      setView({ name: "admin", tab: "vulns" });
                      setMobileNavOpen(false);
                    }}
                  />
                </div>
              )}
            </div>
          </div>
        )}

        <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
          {/* Top nav: search + profile only (fixed, never scrolls) — fixed h-16 aligned with sidebars */}
          <header className="z-sticky h-16 shrink-0 border-b border-border bg-surface/95 shadow-surface backdrop-blur">
            <div className="flex h-full items-center gap-2.5 px-3 sm:px-4">
              <div className="flex items-center gap-2 lg:hidden">
                <button
                  type="button"
                  onClick={() => setMobileNavOpen((v) => !v)}
                  aria-label={mobileNavOpen ? "Close navigation menu" : "Open navigation menu"}
                  className="flex h-9 w-9 items-center justify-center rounded-md border border-border bg-surface text-text shadow-surface transition-all duration-fast hover:bg-background active:scale-[0.92] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary cursor-pointer"
                >
                  {mobileNavOpen ? <IconClose /> : <IconMenu />}
                </button>
                <button
                  type="button"
                  onClick={() => setView({ name: "spaces" })}
                  aria-label="VibeForge home"
                  className="flex items-center gap-2 active:scale-[0.96] cursor-pointer"
                >
                  <VibeForgeLogo size={28} />
                  <span className="hidden font-serif text-base font-bold sm:inline">VibeForge</span>
                </button>
              </div>
              <GlobalSearch go={setView} spaces={me.spaces} />
              <div className="ml-auto">
                <Menu label="Profile menu" button={<span className="flex items-center gap-2 rounded-full border border-border bg-surface py-1 pl-1 pr-3 shadow-surface transition-all duration-fast hover:bg-background active:scale-[0.96] cursor-pointer"><Avatar name={me.user.display_name} size="sm" /><span className="hidden max-w-36 truncate text-sm font-medium sm:inline">{me.user.display_name}</span><span aria-hidden className="text-xs text-text-muted">▾</span></span>}>
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

          <main className="mx-auto w-full max-w-6xl flex-1 overflow-y-auto px-3 py-4 sm:px-6 sm:py-6">
            <ErrorBoundary onHome={() => setView({ name: "spaces" })}>
              <div key={view.name + ("id" in view ? view.id : "")} className="vf-page">
                {view.name === "spaces" && <Spaces me={me} go={setView} />}
                {view.name === "space" && <SpaceDetail spaceId={view.id} label={view.label} go={setView} />}
                {view.name === "project" && <ProjectDetail projectId={view.id} milestoneId={view.milestoneId} go={setView} />}
                {view.name === "profile" && <Profile />}
                {view.name === "admin" && <Admin initialTab={view.tab} go={setView} onCountsUpdate={setAdminCounts} />}
                {view.name === "marketplace" && <Marketplace go={setView} />}
                {view.name === "404" && (
                  <NotFoundScreen
                    onHome={() => setView({ name: "spaces" })}
                    onBack={() => window.history.back()}
                    onMarketplace={() => setView({ name: "marketplace" })}
                  />
                )}
                {view.name === "500" && (
                  <ServerErrorScreen
                    error={view.error ?? "An unexpected server error occurred."}
                    resetError={() => setView({ name: "spaces" })}
                    onHome={() => setView({ name: "spaces" })}
                  />
                )}
              </div>
            </ErrorBoundary>
          </main>
        </div>
      </div>
    </PermissionsProvider>
  );
}

function SideItem({
  collapsed, active, label, icon, hint, badge, onClick,
}: {
  collapsed: boolean; active: boolean; label: string; icon: ReactNode; hint?: string; badge?: ReactNode; onClick: () => void;
}) {
  return (
    <button
      type="button"
      title={collapsed ? label : undefined}
      aria-current={active || undefined}
      onClick={onClick}
      className={`group relative flex min-h-10 w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-sm font-medium transition-all duration-fast ease-standard cursor-pointer select-none focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary active:scale-[0.96] ${
        active
          ? "bg-primary/15 font-semibold text-primary shadow-xs"
          : "text-text-muted hover:bg-background hover:text-text active:bg-background/80"
      } ${collapsed ? "justify-center px-0" : ""}`}
    >
      <span
        aria-hidden
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-md transition-colors duration-fast ${
          active ? "bg-primary text-primary-fg shadow-xs" : "bg-background/80 text-text-muted group-hover:bg-background group-hover:text-text"
        }`}
      >
        {icon}
      </span>
      {!collapsed && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
      {!collapsed && hint && (
        <span className="rounded bg-background/60 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">
          {hint}
        </span>
      )}
      {!collapsed && badge && (
        <span className="shrink-0">{badge}</span>
      )}
      {collapsed && badge && (
        <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-primary" />
      )}
    </button>
  );
}

function GlobalSearch({ go, spaces }: { go: (v: View) => void; spaces: Me["spaces"] }) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<Awaited<ReturnType<typeof api.myProjects>>>([]);
  useEffect(() => { void api.myProjects().then(setProjects).catch(() => {}); }, []);

  const q = query.trim().toLowerCase();
  const spaceHits = q ? spaces.filter((sp) => sp.name.toLowerCase().includes(q)).slice(0, 5) : [];
  const projectHits = q ? projects.filter((pr) => pr.name.toLowerCase().includes(q)).slice(0, 6) : [];
  const hasHits = spaceHits.length + projectHits.length > 0;

  return (
    <div className="relative w-full max-w-xl">
      <IconSearch className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-muted" />
      <Input
        type="search"
        value={query}
        placeholder="Search spaces and projects…"
        aria-label="Search spaces and projects"
        className="pl-9"
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
          if (e.key === "Enter" && projectHits[0]) { go({ name: "project", id: projectHits[0].id }); setOpen(false); }
          else if (e.key === "Enter" && spaceHits[0]) { go({ name: "space", id: spaceHits[0].id, label: spaceHits[0].name }); setOpen(false); }
        }}
      />
      {open && q && (
        <div role="listbox" aria-label="Search results" className="vf-pop absolute left-0 right-0 top-[calc(100%+6px)] z-dropdown overflow-hidden rounded-lg border border-border bg-surface-elevated shadow-overlay">
          {!hasHits && <p className="px-3 py-3 text-sm text-text-muted">No spaces or projects match “{query}”.</p>}
          {spaceHits.map((sp) => (
            <button key={sp.id} type="button" role="option" aria-selected="false"
              className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm transition duration-fast hover:bg-background focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => { go({ name: "space", id: sp.id, label: sp.name }); setOpen(false); setQuery(""); }}>
              <Avatar name={sp.name} size="sm" /><span className="font-medium">{sp.name}</span><Badge>Space</Badge>
            </button>
          ))}
          {projectHits.map((pr) => (
            <button key={pr.id} type="button" role="option" aria-selected="false"
              className="flex min-h-11 w-full items-center gap-2 px-3 py-2 text-left text-sm transition duration-fast hover:bg-background focus-visible:outline-2 focus-visible:outline-primary"
              onClick={() => { go({ name: "project", id: pr.id }); setOpen(false); setQuery(""); }}>
              <ProjectFavicon projectId={pr.id} name={pr.name} /><span className="font-medium">{pr.name}</span><Badge tone="primary">Project</Badge>
              <span className="ml-auto text-xs text-text-muted">{pr.milestones} milestones</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function Login({ onDone }: { onDone: () => void }) {
  const [email, setEmail] = useState("admin@vibeforge.local");
  const [password, setPassword] = useState("admin12345");
  const [totp, setTotp] = useState("");
  const [mfaNeeded, setMfaNeeded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api.login(email.trim(), password, totp || undefined);
      setToken(r.token);
      localStorage.setItem("vf_refresh", r.refresh_token);
      onDone();
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sign-in failed.";
      if (msg.toLowerCase().includes("authenticator")) setMfaNeeded(true);
      setError(msg);
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
          {mfaNeeded && (
            <label className="block">
              <Label>Authenticator code</Label>
              <span className="mt-1 block"><Input inputMode="numeric" autoComplete="one-time-code" placeholder="6-digit code" value={totp} onChange={(e) => setTotp(e.target.value)} /></span>
            </label>
          )}
          {error && <Alert>{error}</Alert>}
          {notice && <Alert variant="info">{notice}</Alert>}
          <Button type="submit" busy={busy} className="w-full">
            {busy ? "Signing in…" : "Sign in"}
          </Button>
        </form>
        <div className="mt-3 text-right">
          <Button variant="ghost" size="sm" onClick={async () => {
            try {
              const r = await api.forgot(email.trim());
              setNotice(r.reset_token ? `${r.message} Token: ${r.reset_token}` : r.message);
            } catch { setNotice("If that email has an account, a reset link is on its way."); }
          }}>Forgot password?</Button>
        </div>
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
            <Button onClick={() => setShowCreate(true)}>
              + New space
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
            hint={query ? "Try a different name." : me.user.is_platform_admin ? "Create your first space using the button above." : "Ask an admin to add you to a space."}
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
          <form className="grid gap-4" onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            try { await api.createSpace(name); setName(""); setShowCreate(false); await load(); toast.success("Space created."); }
            catch (err) { toast.error(err instanceof Error ? err.message : "Could not create the space."); }
            finally { setBusy(false); }
          }}>
            <Input autoFocus placeholder="Space name, e.g. Client work" value={name} onChange={(e) => setName(e.target.value)} required aria-label="Space name" />
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
              <Button type="submit" busy={busy}>Create space</Button>
            </div>
          </form>
        </Modal>
      )}

    </section>
  );
}

function ProjectFavicon({ projectId, name }: { projectId: string; name: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let objectUrl: string | null = null;
    void api.faviconUrl(projectId).then((u) => {
      objectUrl = u;
      if (live) setUrl(u);
    });
    return () => { live = false; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [projectId]);
  if (!url) return <DefaultProjectIcon name={name} size={40} />;
  return (
    <span className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-surface">
      <img src={url} alt={`${name} icon`} className="h-full w-full object-contain" />
    </span>
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

  if (error) {
    if (error.includes("404") || error.toLowerCase().includes("not found")) {
      return <NotFoundScreen onHome={() => go({ name: "spaces" })} onBack={() => window.history.back()} />;
    }
    return <ServerErrorScreen error={error} resetError={() => void load()} onHome={() => go({ name: "spaces" })} />;
  }

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
                      <span className="flex shrink-0 flex-col items-end gap-1.5">
                        <ProjectFavicon projectId={pr.id} name={pr.name} />
                        <Badge tone={pr.open_findings === 0 ? "success" : "danger"}>{pr.open_findings === 0 ? "✓ Healthy" : `${pr.open_findings} to fix`}</Badge>
                      </span>
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
    if (error) {
      if (error.includes("404") || error.toLowerCase().includes("not found")) {
        return <NotFoundScreen onHome={() => go({ name: "spaces" })} onBack={() => window.history.back()} />;
      }
      return <ServerErrorScreen error={error} resetError={() => void load()} onHome={() => go({ name: "spaces" })} />;
    }
    return <div className="space-y-3"><Skeleton className="h-10 w-64" /><Skeleton className="h-40" /></div>;
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
            <PublishToggle projectId={data.project.id} />
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

function PublishToggle({ projectId }: { projectId: string }) {
  const [isPublic, setIsPublic] = useState(false);
  const toast = useToast();
  return (
    <Button
      variant="secondary"
      size="sm"
      aria-pressed={isPublic}
      onClick={async () => {
        const next = isPublic ? "space" : "public";
        try {
          await api.setVisibility(projectId, next);
          setIsPublic(!isPublic);
          toast.success(next === "public" ? "Published to the Marketplace." : "Made private to the space.");
        } catch (err) { toast.error(err instanceof Error ? err.message : "Only a Space Owner can publish."); }
      }}
    >
      {isPublic ? "Make private" : "Publish to Marketplace"}
    </Button>
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
                      {f.kind === "cve" && f.fixed_version && (
                        <Button size="sm" onClick={async () => {
                          try {
                            const r = await api.applyFix(f.id);
                            toast.success(`Auto-fix pushed as a new milestone (${r.milestone_id.slice(0, 12)}…). Re-check its findings.`);
                            onChanged();
                          } catch (err) { toast.error(err instanceof Error ? err.message : "Auto-fix failed."); }
                        }}>Apply fix automatically</Button>
                      )}
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
            try { await api.downloadSbom(milestoneId); toast.success("SBOM.json (Syft) downloaded."); }
            catch (err) { toast.error(err instanceof Error ? err.message : "Download failed."); }
          }}>Syft JSON</Button>
          <Button variant="secondary" onClick={async () => {
            try { await api.downloadExport(milestoneId, "cyclonedx"); toast.success("CycloneDX SBOM downloaded."); }
            catch (err) { toast.error(err instanceof Error ? err.message : "Download failed."); }
          }}>CycloneDX</Button>
          <Button variant="secondary" onClick={async () => {
            try { await api.downloadExport(milestoneId, "spdx"); toast.success("SPDX SBOM downloaded."); }
            catch (err) { toast.error(err instanceof Error ? err.message : "Download failed."); }
          }}>SPDX</Button>
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

      <MfaCard />
      <AccountDataCard />

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

function MfaCard() {
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [enabled, setEnabled] = useState(false);
  const toast = useToast();
  return (
    <Card className="p-5">
      <h3 className="font-serif text-lg font-bold">Two-factor authentication (MFA)</h3>
      <p className="mt-1 text-sm text-text-muted">Add an authenticator app (TOTP). After enabling, sign-in asks for the 6-digit code.</p>
      {!secret && !enabled && (
        <div className="mt-3">
          <Button onClick={async () => {
            try { const r = await api.mfaSetup(); setSecret(r.secret); }
            catch (err) { toast.error(err instanceof Error ? err.message : "Setup failed."); }
          }}>Set up authenticator</Button>
        </div>
      )}
      {secret && !enabled && (
        <div className="mt-3 space-y-3">
          <p className="text-sm">Add this secret to your authenticator app, then enter a code:</p>
          <code className="block break-all rounded-md bg-background p-2 text-sm">{secret}</code>
          <form className="flex max-w-sm gap-2" onSubmit={async (e) => {
            e.preventDefault();
            try { await api.mfaEnable(code); setEnabled(true); toast.success("MFA is on."); }
            catch (err) { toast.error(err instanceof Error ? err.message : "That code did not match."); }
          }}>
            <Input inputMode="numeric" placeholder="6-digit code" value={code} onChange={(e) => setCode(e.target.value)} required aria-label="Authenticator code" />
            <Button type="submit">Enable MFA</Button>
          </form>
        </div>
      )}
      {enabled && (
        <div className="mt-3 flex items-center gap-2">
          <Badge tone="success">MFA on</Badge>
          <Button variant="ghost" size="sm" onClick={async () => { await api.mfaDisable(); setEnabled(false); setSecret(""); toast.info("MFA turned off."); }}>Turn off</Button>
        </div>
      )}
    </Card>
  );
}

function AccountDataCard() {
  const [password, setPassword] = useState("");
  const toast = useToast();
  return (
    <Card className="p-5">
      <h3 className="font-serif text-lg font-bold">Your data</h3>
      <p className="mt-1 text-sm text-text-muted">Export everything tied to your account, or delete the account (milestones stay, marked as deleted-user).</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" onClick={async () => {
          try { await api.myExport(); toast.success("Export downloaded."); }
          catch (err) { toast.error(err instanceof Error ? err.message : "Export failed."); }
        }}>Export my data</Button>
      </div>
      <form className="mt-4 flex max-w-md gap-2" onSubmit={async (e) => {
        e.preventDefault();
        try { await api.deleteMe(password); setToken(null); location.href = "/"; }
        catch (err) { toast.error(err instanceof Error ? err.message : "Delete failed — check your password."); }
      }}>
        <Input type="password" placeholder="Password to confirm delete" value={password} onChange={(e) => setPassword(e.target.value)} required aria-label="Password" />
        <Button type="submit" variant="danger">Delete account</Button>
      </form>
    </Card>
  );
}

function Marketplace({ go }: { go: (v: View) => void }) {
  const [items, setItems] = useState<Awaited<ReturnType<typeof api.registry>> | null>(null);
  const [query, setQuery] = useState("");
  const [error, setError] = useState("");
  const load = useCallback(async (q: string) => {
    try { setItems(await api.registry(q)); }
    catch (e) { setError(e instanceof Error ? e.message : "Failed to load the marketplace."); }
  }, []);
  useEffect(() => { void load(""); }, [load]);
  return (
    <section aria-labelledby="market-title">
      <h2 id="market-title" className="font-serif text-3xl font-bold">Marketplace</h2>
      <p className="mt-1 max-w-2xl text-sm text-text-muted">Public projects anyone in this workspace can discover and fork. Owners publish from a project (visibility: public).</p>
      <div className="mt-4 max-w-md">
        <Input type="search" placeholder="Search public projects…" aria-label="Search marketplace" value={query}
          onChange={(e) => { setQuery(e.target.value); void load(e.target.value); }} />
      </div>
      {error && <div className="mt-4"><Alert>{error}</Alert></div>}
      {items === null && !error && <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3"><Skeleton className="h-44" /><Skeleton className="h-44" /><Skeleton className="h-44" /></div>}
      {items !== null && items.length > 0 && (
        <div className="mt-5 grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {items.map((pr) => (
            <article key={pr.id} className="rounded-lg border border-border bg-surface p-5 shadow-surface transition duration-normal hover:-translate-y-0.5 hover:shadow-raised">
              <span className="flex items-start gap-2">
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-serif text-lg font-bold">{pr.name}</span>
                  <span className="text-xs text-text-muted">/{pr.slug} · {pr.milestones} milestones</span>
                </span>
                <ProjectFavicon projectId={pr.id} name={pr.name} />
              </span>
              <p className="mt-3 flex flex-wrap gap-1.5">
                {pr.languages.map((l) => <Badge key={l} tone="primary">{l}</Badge>)}
                <Badge tone={pr.open_findings === 0 ? "success" : "danger"}>{pr.open_findings === 0 ? "✓ Healthy" : `${pr.open_findings} to fix`}</Badge>
              </p>
              <div className="mt-4 border-t border-border pt-3">
                <Button size="sm" onClick={() => go({ name: "project", id: pr.id })}>View project</Button>
              </div>
            </article>
          ))}
        </div>
      )}
      {items !== null && items.length === 0 && <div className="mt-5"><EmptyState title="Nothing public yet" hint="A Space Owner can publish a project from its page (API: visibility public)." /></div>}
    </section>
  );
}

// ------------------------------------------------------------------- admin

function Admin({ initialTab, go, onCountsUpdate }: {
  initialTab: string;
  go?: (v: View) => void;
  onCountsUpdate?: (counts: { vulns?: number; users?: number; groups?: number }) => void;
}) {
  const [tab, setTab] = useState(initialTab || "vulns");
  const [users, setUsers] = useState<Awaited<ReturnType<typeof api.adminUsers>>>([]);
  const [groups, setGroups] = useState<Awaited<ReturnType<typeof api.adminGroups>>>([]);
  const [vulns, setVulns] = useState<Awaited<ReturnType<typeof api.adminVulns>> | null>(null);
  const [settings, setSettings] = useState<Record<string, unknown> | null>(null);
  const [form, setForm] = useState({ email: "", display_name: "", password: "", is_platform_admin: false });
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [showCreateGroup, setShowCreateGroup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const [u, g, v, st] = await Promise.all([api.adminUsers(), api.adminGroups(), api.adminVulns(), api.settings()]);
      setUsers(u); setGroups(g); setVulns(v); setSettings(st);
      onCountsUpdate?.({ vulns: v?.total_open, users: u.length, groups: g.length });
    } catch { setError("Admin access required."); }
  }, [onCountsUpdate]);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (initialTab) setTab(initialTab); }, [initialTab]);

  const selectTab = (nextTab: string) => {
    setTab(nextTab);
    go?.({ name: "admin", tab: nextTab });
  };

  const SETTING_SECTIONS: { title: string; hint: string; fields: string[] }[] = [
    { title: "Upload & scanning", hint: "Zip-bomb limits, antivirus and CVE lookups for every push.", fields: ["max_compressed_mb", "max_uncompressed_mb", "max_entries", "max_file_mb", "max_ratio", "block_push_on_critical", "scan_timeout_s", "clamd_host", "osv_timeout_s", "osv_cache_hours", "unused_dep_check"] },
    { title: "Access & tokens", hint: "Sessions, API tokens and self-registration.", fields: ["session_hours", "token_default_ttl_days", "max_active_tokens_per_user", "allow_registration"] },
    { title: "Policy & quotas", hint: "What gets blocked, license rules and per-space limits (0 = unlimited).", fields: ["block_severity", "license_blocklist", "fix_sla_days", "space_quota_mb", "space_member_quota"] },
    { title: "Notifications", hint: "Webhook for high/critical pushes and outgoing email.", fields: ["webhook_url", "smtp_host", "smtp_port", "smtp_from", "smtp_user", "smtp_password"] },
    { title: "SSO & provisioning", hint: "OIDC sign-in and SCIM user provisioning. Secrets are encrypted at rest.", fields: ["oidc_issuer", "oidc_client_id", "oidc_client_secret", "scim_token", "public_base_url"] },
  ];
  const sectionedFields = new Set(SETTING_SECTIONS.flatMap((sec) => sec.fields));

  return (
    <section aria-labelledby="admin-title">
      <div className="border-b border-border pb-4">
        <h2 id="admin-title" className="font-serif text-2xl sm:text-3xl font-bold">
          {tab === "vulns" && "Vulnerabilities"}
          {tab === "people" && "People & access"}
          {tab === "groups" && "Groups & teams"}
          {tab === "settings" && "App settings"}
        </h2>
        <p className="mt-1 text-sm text-text-muted">
          {tab === "vulns" && `${vulns?.total_open ?? 0} open (${vulns?.critical ?? 0} fix-now) across every project. Contact leaves a to-do on their latest milestone.`}
          {tab === "people" && `${users.length} people. Block stops all sign-ins and pushes instantly.`}
          {tab === "groups" && `${groups.length} groups. Give a group a role in a space and every member inherits it.`}
          {tab === "settings" && "Platform configurations: upload limits, policies, quotas, notifications and SSO."}
        </p>
        {error && <div className="mt-3"><Alert variant="error">{error}</Alert></div>}
      </div>

      {/* Mobile Tab switcher — visible only on screens where desktop sidebar is hidden */}
      <div className="lg:hidden mt-4">
        <Tabs
          ariaLabel="Settings sections"
          value={tab}
          onChange={selectTab}
          items={[
            { key: "vulns", label: `Vulns${vulns ? ` (${vulns.total_open})` : ""}` },
            { key: "people", label: `People (${users.length})` },
            { key: "groups", label: `Groups (${groups.length})` },
            { key: "settings", label: "Settings" },
          ]}
        />
      </div>

      <div role="region" aria-label="Settings panel content" className="mt-6">
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
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm text-text-muted">{users.length} people. Block stops all sign-ins and pushes instantly.</p>
              <span className="ml-auto"><Button onClick={() => setShowCreateUser(true)}>+ Create user</Button></span>
            </div>
            {users.length > 0 ? (
              <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface shadow-surface">
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
            ) : <div className="mt-3"><EmptyState title="No people yet" hint="Create the first user with the button above." /></div>}

            <Modal open={showCreateUser} onClose={() => setShowCreateUser(false)} title="Create a user" hint="Share the temporary password once — they sign in and create their own API token under Profile.">
              <form className="grid gap-3" onSubmit={async (e) => {
                e.preventDefault();
                setBusy(true);
                try {
                  await api.adminCreateUser(form);
                  setForm({ email: "", display_name: "", password: "", is_platform_admin: false });
                  setShowCreateUser(false);
                  await load();
                  toast.success("User created.");
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
                <div className="flex gap-2">
                  <Button type="submit" busy={busy}>Create user</Button>
                  <Button type="button" variant="ghost" onClick={() => setShowCreateUser(false)}>Cancel</Button>
                </div>
              </form>
            </Modal>
          </div>
        )}

        {tab === "groups" && (
          <div>
            <div className="flex items-center gap-2">
              <p className="text-sm text-text-muted">{groups.length} groups. Give a group a role in a space and every member inherits it.</p>
              <span className="ml-auto"><Button onClick={() => setShowCreateGroup(true)}>+ Create group</Button></span>
            </div>
            {groups.length > 0 ? (
              <ul className="mt-3 divide-y divide-border rounded-lg border border-border bg-surface shadow-surface">
                {groups.map((g) => (
                  <li key={g.id} className="flex min-h-11 flex-wrap items-center gap-2 px-4 py-2.5 text-sm">
                    <Avatar name={g.name} size="sm" />
                    <span className="font-medium">{g.name}</span>
                    {g.description && <span className="text-text-muted">{g.description}</span>}
                    <span className="ml-auto"><Badge>{g.member_ids.length} members</Badge></span>
                  </li>
                ))}
              </ul>
            ) : <div className="mt-3"><EmptyState title="No groups yet" hint="Create the first group with the button above." /></div>}
            <CreateGroup users={users} open={showCreateGroup} onClose={() => setShowCreateGroup(false)} onDone={load} />
          </div>
        )}

        {tab === "settings" && (
          <form onSubmit={async (e) => {
            e.preventDefault();
            if (!settings) return;
            await api.putSettings(settings);
            toast.success("Settings saved.");
          }}>
            <div className="space-y-4">
              {SETTING_SECTIONS.map((sec) => {
                const fields = sec.fields.filter((f) => settings && f in settings);
                if (!settings || fields.length === 0) return null;
                return (
                  <Card key={sec.title} className="p-5">
                    <h3 className="font-serif text-lg font-bold">{sec.title}</h3>
                    <p className="mt-0.5 text-sm text-text-muted">{sec.hint}</p>
                    <div className="mt-4 grid gap-2">
                      {fields.map((k) => {
                        const v = settings[k];
                        return (
                          <label key={k} className="flex min-h-11 items-center gap-3 rounded-md border border-border bg-background px-3 py-1.5 text-sm">
                            <span className="w-52 shrink-0 font-medium">{k}</span>
                            {typeof v === "boolean"
                              ? <input type="checkbox" className="h-4 w-4 accent-primary" checked={v} onChange={(e) => setSettings({ ...settings, [k]: e.target.checked })} />
                              : <Input type={k.includes("password") || k.includes("secret") || k.includes("token") ? "password" : "text"} value={String(v)} aria-label={k} onChange={(e) => setSettings({ ...settings, [k]: typeof v === "number" ? Number(e.target.value) : e.target.value })} />}
                          </label>
                        );
                      })}
                    </div>
                  </Card>
                );
              })}
              {settings && Object.keys(settings).filter((k) => !sectionedFields.has(k)).length > 0 && (
                <Card className="p-5">
                  <h3 className="font-serif text-lg font-bold">Other</h3>
                  <div className="mt-4 grid gap-2">
                    {Object.entries(settings).filter(([k]) => !sectionedFields.has(k)).map(([k, v]) => (
                      <label key={k} className="flex min-h-11 items-center gap-3 rounded-md border border-border bg-background px-3 py-1.5 text-sm">
                        <span className="w-52 shrink-0 font-medium">{k}</span>
                        {typeof v === "boolean"
                          ? <input type="checkbox" className="h-4 w-4 accent-primary" checked={v} onChange={(e) => setSettings({ ...settings, [k]: e.target.checked })} />
                          : <Input value={String(v)} aria-label={k} onChange={(e) => setSettings({ ...settings, [k]: typeof v === "number" ? Number(e.target.value) : e.target.value })} />}
                      </label>
                    ))}
                  </div>
                </Card>
              )}
              {!settings && <div className="space-y-2"><Skeleton className="h-11" /><Skeleton className="h-11" /><Skeleton className="h-11" /></div>}
            </div>
            <div className="sticky bottom-4 mt-4 flex justify-end">
              <Button type="submit" className="shadow-raised">Save all settings</Button>
            </div>
            <p className="mt-2 text-right text-xs text-text-muted">Saves to the database and takes effect on the next request — no restart.</p>
          </form>
        )}
        </div>
    </section>
  );
}

function CreateGroup({ users, open, onClose, onDone }: { users: { id: string; display_name: string }[]; open: boolean; onClose: () => void; onDone: () => void }) {
  const [name, setName] = useState("");
  const [picked, setPicked] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Modal open={open} onClose={onClose} title="Create a group" hint="Give the group a role in a space and everyone in it inherits that role.">
      <form onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        try { await api.adminCreateGroup({ name, description: "", member_ids: picked }); setName(""); setPicked([]); onClose(); onDone(); toast.success("Group created."); }
        catch (err) { toast.error(err instanceof Error ? err.message : "Could not create the group."); }
        finally { setBusy(false); }
      }}>
        <Input autoFocus placeholder="Group name" value={name} onChange={(e) => setName(e.target.value)} required aria-label="Group name" />
        <p className="mt-3 text-sm font-medium">Members</p>
        <div className="mt-2 flex flex-wrap gap-2">
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
          {users.length === 0 && <span className="text-sm text-text-muted">Create people first — they will appear here.</span>}
        </div>
        <div className="mt-4 flex gap-2">
          <Button type="submit" busy={busy}>Create group</Button>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
        </div>
      </form>
    </Modal>
  );
}