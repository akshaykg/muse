import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { aiApi, type AiStatus } from "../lib/aiApi";
import {
  assessApi, assessmentMarkdown, ASSET_STATUS, AUDIENCE, DEPLOY, ISSUE_CATEGORY, LICENSE_STATUS, MOBILE, PLATFORM, RISK,
  type AiAssessment, type AssessIssue, type Verdict,
} from "../lib/assessApi";
import { IconSparkles, PromptBox } from "./AiReview";
import { Alert, Badge, Button, Card, Skeleton, useToast } from "./ui";

const STEPS = [
  "Checking licences, credits and store manifests",
  "Listing images, fonts, sounds and other assets",
  "Muse is reading the project",
  "Deciding who it is for and how it ships",
  "Writing the report",
];

const SEV: Record<string, { word: string; tone: "danger" | "warning" | "neutral"; bar: string }> = {
  critical: { word: "Fix before launch", tone: "danger", bar: "bg-error" },
  high: { word: "Fix soon", tone: "danger", bar: "bg-error/70" },
  medium: { word: "Worth sorting", tone: "warning", bar: "bg-warning" },
  low: { word: "Good to know", tone: "neutral", bar: "bg-text-muted/50" },
};

function readinessTone(n: number): string {
  if (n >= 80) return "text-success";
  if (n >= 55) return "text-warning";
  return "text-error";
}

function fmtDuration(ms: number): string {
  if (!ms) return "—";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

// ------------------------------------------------------------------ pieces

function ReadinessRing({ value }: { value: number }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const [shown, setShown] = useState(0);
  useEffect(() => { const t = window.setTimeout(() => setShown(value), 60); return () => window.clearTimeout(t); }, [value]);
  return (
    <div className={`relative h-28 w-28 shrink-0 ${readinessTone(value)}`} role="img" aria-label={`Release readiness ${value} out of 100`}>
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={9} />
        <circle cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeWidth={9} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c - (c * shown) / 100}
          style={{ transition: "stroke-dashoffset 900ms cubic-bezier(0.2, 0, 0, 1)" }} />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-serif text-3xl font-bold leading-none tabular-nums">{value}</span>
        <span className="mt-1 text-[10px] font-semibold uppercase tracking-wider text-text-muted">ready</span>
      </div>
    </div>
  );
}

function ConfidenceDot({ level }: { level: string }) {
  const n = level === "high" ? 3 : level === "medium" ? 2 : 1;
  return (
    <span className="inline-flex items-center gap-0.5" title={`${level} confidence`} aria-label={`${level} confidence`}>
      {[1, 2, 3].map((i) => <span key={i} className={`h-1.5 w-1.5 rounded-full ${i <= n ? "bg-primary" : "bg-border"}`} />)}
    </span>
  );
}

function ProfileTile({ emoji, label, value, detail, confidence, tone, children }: {
  emoji: string; label: string; value: string; detail?: string; confidence?: string;
  tone?: "success" | "warning" | "danger" | "neutral"; children?: ReactNode;
}) {
  const ring = tone === "danger" ? "border-error/35 bg-error/[0.04]" : tone === "warning" ? "border-warning/40 bg-warning/[0.05]" : tone === "success" ? "border-success/30 bg-success/[0.04]" : "border-border/80 bg-background/50";
  return (
    <div className={`rounded-lg border p-3.5 transition-shadow duration-normal hover:shadow-raised ${ring}`}>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</span>
        {confidence && <ConfidenceDot level={confidence} />}
      </div>
      <p className="mt-1.5 flex items-center gap-2 font-semibold text-text"><span aria-hidden className="text-lg leading-none">{emoji}</span>{value}</p>
      {children}
      {detail && <p className="mt-1.5 text-xs leading-relaxed text-text-muted">{detail}</p>}
    </div>
  );
}

function Running({ a }: { a: AiAssessment }) {
  const [step, setStep] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.parse(a.started_at) || Date.now();
    const tick = () => { const s = Math.max(0, (Date.now() - start) / 1000); setElapsed(s); setStep(Math.min(STEPS.length - 1, Math.floor(s / 4))); };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [a.started_at]);
  return (
    <Card className="relative overflow-hidden p-6">
      <style>{`@keyframes vf-as-beam{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}.vf-as-beam{animation:vf-as-beam 1.6s cubic-bezier(.4,0,.2,1) infinite}@media (prefers-reduced-motion: reduce){.vf-as-beam{animation:none}}`}</style>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-primary/10">
        <div className="vf-as-beam h-full w-2/5 bg-gradient-to-r from-transparent via-primary to-transparent" />
      </div>
      <div className="flex items-start gap-4">
        <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <span aria-hidden className="vf-pulse-glow absolute inset-0 rounded-xl bg-primary/20" />
          <IconSparkles width={22} height={22} className="relative" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-serif text-lg font-bold">Muse is assessing this project…</p>
          <p className="text-sm text-text-muted">Usually 20–60 seconds with {a.model}. You can leave this tab; the report is saved.</p>
          <ol className="mt-4 space-y-2" aria-live="polite">
            {STEPS.map((s, i) => (
              <li key={s} className={`flex items-center gap-2.5 text-sm transition-opacity duration-normal ${i > step ? "opacity-40" : ""}`}>
                <span className={`flex h-5 w-5 items-center justify-center rounded-full text-[11px] font-bold ${i < step ? "bg-success/15 text-success" : i === step ? "bg-primary text-primary-fg" : "bg-border text-text-muted"}`}>
                  {i < step ? "✓" : i + 1}
                </span>
                <span className={i === step ? "font-medium text-text" : "text-text-muted"}>{s}</span>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs tabular-nums text-text-muted">{elapsed.toFixed(0)}s elapsed</p>
        </div>
      </div>
    </Card>
  );
}

function IssueCard({ issue, index, canPush, onToggle }: { issue: AssessIssue; index: number; canPush: boolean; onToggle: () => Promise<void> }) {
  const [open, setOpen] = useState(index < 2);
  const [busy, setBusy] = useState(false);
  const sev = SEV[issue.severity] ?? SEV.low;
  const cat = ISSUE_CATEGORY[issue.category] ?? { label: issue.category.replace(/_/g, " "), emoji: "•" };
  const ignored = issue.status === "ignored";
  return (
    <li className="vf-page" style={{ animationDelay: `${Math.min(index, 8) * 40}ms`, animationFillMode: "backwards" }}>
      <Card className={`relative overflow-hidden transition-all duration-normal ease-standard hover:shadow-raised ${ignored ? "opacity-55" : ""}`}>
        <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${sev.bar}`} />
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className="flex w-full cursor-pointer items-start gap-3 p-4 pl-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40">
          <span className="mt-0.5 text-lg leading-none" aria-hidden>{cat.emoji}</span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={sev.tone}>{sev.word}</Badge>
              <Badge>{cat.label}</Badge>
              {issue.source === "check" ? <Badge tone="primary">VibeForge check</Badge> : <Badge tone="primary">✦ Muse</Badge>}
              {issue.evidence && (
                <span className="max-w-full truncate rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-text-muted">
                  {issue.evidence}{issue.line ? `:${issue.line}` : ""}
                </span>
              )}
              {ignored && <Badge>Not a problem</Badge>}
            </span>
            <span className="mt-1.5 block font-semibold text-text">{issue.title}</span>
            <span className="mt-1 block text-sm leading-relaxed text-text-muted">{issue.explain}</span>
          </span>
          <span aria-hidden className={`mt-1 text-text-muted transition-transform duration-normal ${open ? "rotate-180" : ""}`}>▾</span>
        </button>
        {open && (
          <div className="space-y-3 px-4 pb-4 pl-5 sm:pl-12">
            {issue.recommendation && (
              <p className="rounded-md bg-primary/[0.06] px-3 py-2 text-sm text-text"><span className="font-semibold">What to do: </span>{issue.recommendation}</p>
            )}
            {issue.ai_prompt && <PromptBox text={issue.ai_prompt} />}
            {canPush && (
              <div className="flex justify-end">
                <Button variant="ghost" size="sm" busy={busy} onClick={async () => { setBusy(true); try { await onToggle(); } finally { setBusy(false); } }}>
                  {ignored ? "Show as a problem again" : "Not a problem"}
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </li>
  );
}

function EvidenceList({ title, items, empty }: { title: string; items: string[]; empty: string }) {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">{title}</p>
      {items.length ? (
        <ul className="mt-1 space-y-0.5">
          {items.slice(0, 12).map((x) => <li key={x} className="truncate font-mono text-[11.5px] text-text" title={x}>{x}</li>)}
          {items.length > 12 && <li className="text-xs text-text-muted">+{items.length - 12} more</li>}
        </ul>
      ) : <p className="mt-1 text-xs text-text-muted">{empty}</p>}
    </div>
  );
}

function verdictTone(kind: "audience" | "deploy" | "license", v: Verdict): "success" | "warning" | "danger" | "neutral" {
  if (kind === "license") return LICENSE_STATUS[v.value]?.tone ?? "neutral";
  if (kind === "deploy") return v.value === "configured" ? "success" : v.value === "planned" ? "neutral" : "warning";
  return v.value === "unknown" ? "warning" : "neutral";
}

// ------------------------------------------------------------------ panel

export function AiAssessmentPanel({ milestoneId, projectName, milestoneLabel, canPush, isAdmin, onOpenSettings }: {
  milestoneId: string;
  projectName: string;
  milestoneLabel: string;
  canPush: boolean;
  isAdmin?: boolean;
  onOpenSettings?: () => void;
}) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [a, setA] = useState<AiAssessment | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [filter, setFilter] = useState("all");
  const [showIgnored, setShowIgnored] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const load = useCallback(async () => {
    try { const r = await assessApi.get(milestoneId); setA(r.assessment); return r.assessment; }
    catch (e) { setError(e instanceof Error ? e.message : "Could not load the assessment."); setA(null); return null; }
  }, [milestoneId]);

  useEffect(() => {
    setA(undefined); setError(""); setFilter("all");
    void load();
    void aiApi.status().then(setStatus).catch(() => setStatus(null));
  }, [load]);

  useEffect(() => {
    if (a?.status !== "running") return;
    const id = window.setInterval(async () => {
      const r = await load();
      if (r && r.status !== "running") {
        if (r.status === "done") toastRef.current.success(`Assessment ready: ${r.issues.filter((i) => i.status !== "ignored").length} possible issue(s).`);
        else toastRef.current.error(r.error ?? "The assessment failed.");
      }
    }, 1500);
    return () => window.clearInterval(id);
  }, [a?.status, load]);

  const start = async () => {
    setStarting(true); setError("");
    try { const r = await assessApi.start(milestoneId); setA(r.assessment); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not start the assessment."); }
    finally { setStarting(false); }
  };

  const download = () => {
    if (!a) return;
    const blob = new Blob([assessmentMarkdown(a, projectName, milestoneLabel)], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${(projectName || "project").toLowerCase().replace(/[^a-z0-9]+/g, "-")}-assessment.md`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const issues = a?.issues ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of issues) if (i.status !== "ignored") c[i.category] = (c[i.category] ?? 0) + 1;
    return c;
  }, [issues]);
  const ignoredCount = issues.filter((i) => i.status === "ignored").length;
  const openCount = issues.length - ignoredCount;
  const visible = issues.filter((i) => (filter === "all" || i.category === filter) && (showIgnored || i.status !== "ignored"));

  if (a === undefined) return <div className="space-y-2"><Skeleton className="h-36" /><Skeleton className="h-28" /><Skeleton className="h-20" /></div>;

  const hero = (
    <Card className="relative overflow-hidden p-5 sm:p-6">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-info/10 blur-3xl" />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-info text-primary-fg shadow-raised">
            <IconSparkles width={22} height={22} />
          </span>
          <div>
            <h3 className="font-serif text-xl font-bold"><span className="vf-gradient-text">Meta Muse</span> AI assessment</h3>
            <p className="mt-0.5 max-w-xl text-sm text-text-muted">
              A custom release check for this project: who it is for, web or mobile, how it ships, whether it is licensed, and any paid or third-party media used without clear permission.
            </p>
            {status?.model_label && <p className="mt-2 text-xs text-text-muted">Model: <span className="font-medium text-text">{status.model_label}</span> · indexed for admins</p>}
          </div>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          {a?.status === "done" && <Button variant="secondary" onClick={download}>Download report</Button>}
          {canPush && status?.configured && (
            <Button onClick={start} busy={starting} disabled={a?.status === "running"}>
              <IconSparkles width={16} height={16} /> {a ? "Assess again" : "Run assessment"}
            </Button>
          )}
        </div>
      </div>
    </Card>
  );

  return (
    <div className="space-y-4">
      {hero}
      {error && <Alert>{error}</Alert>}
      {status && !status.configured && (
        <Alert variant="info">
          {status.enabled ? "AI assessments need an API key." : "AI is turned off."}{" "}
          {isAdmin && onOpenSettings
            ? <button type="button" className="cursor-pointer font-semibold underline underline-offset-2" onClick={onOpenSettings}>Set it up in Admin → AI review</button>
            : "Ask an admin to set it up in Admin → AI review."}
        </Alert>
      )}
      {!a && status?.configured && (
        <Card className="flex flex-col items-center px-6 py-10 text-center">
          <span className="text-3xl" aria-hidden>🧭</span>
          <p className="mt-2 font-semibold">No assessment for this milestone yet</p>
          <p className="mt-1 max-w-md text-sm text-text-muted">
            {canPush ? "Run one to see who this project is for, how it ships, and what to sort out before launch." : "Owners and Coders of this space can run one."}
          </p>
        </Card>
      )}
      {a?.status === "running" && <Running a={a} />}
      {a?.status === "failed" && <Alert><span className="font-semibold">The assessment didn't finish.</span> {a.error}</Alert>}

      {a?.status === "done" && (
        <>
          <Card className="vf-page p-5 sm:p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
              <ReadinessRing value={a.readiness} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={RISK[a.risk]?.tone ?? "neutral"}>{RISK[a.risk]?.label ?? a.risk}</Badge>
                  {a.tags.slice(0, 6).map((t) => <span key={t} className="rounded-full bg-text/[0.05] px-2 py-0.5 text-[11px] font-medium text-text-muted">#{t}</span>)}
                </div>
                <p className="mt-2 font-serif text-lg font-bold leading-snug">{a.headline}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-text-muted">{a.summary}</p>
                {a.strengths.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-1.5">
                    {a.strengths.map((s, i) => <li key={i} className="rounded-full bg-success/12 px-2.5 py-1 text-xs font-medium text-success">✓ {s}</li>)}
                  </ul>
                )}
              </div>
            </div>
          </Card>

          <section aria-label="Project profile" className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
            <ProfileTile emoji={AUDIENCE[a.audience.value]?.emoji ?? "❔"} label="Who it's for" value={AUDIENCE[a.audience.value]?.label ?? a.audience.value}
              detail={a.audience.detail} confidence={a.audience.confidence} tone={verdictTone("audience", a.audience)} />
            <ProfileTile emoji={a.mobile.value === "none" ? "🖥️" : "📱"} label="Platforms" value={MOBILE[a.mobile.value] ?? a.mobile.value} detail={a.mobile.detail} confidence={a.mobile.confidence}>
              {a.platforms.length > 0 && (
                <span className="mt-1.5 flex flex-wrap gap-1">{a.platforms.map((p) => <Badge key={p} tone="primary">{PLATFORM[p] ?? p}</Badge>)}</span>
              )}
            </ProfileTile>
            <ProfileTile emoji="🚀" label="Deployment" value={DEPLOY[a.deployment.value] ?? a.deployment.value} detail={a.deployment.detail}
              confidence={a.deployment.confidence} tone={verdictTone("deploy", a.deployment)}>
              {a.deploy_targets.length > 0 && (
                <span className="mt-1.5 flex flex-wrap gap-1">{a.deploy_targets.map((t) => <Badge key={t}>{t}</Badge>)}</span>
              )}
            </ProfileTile>
            <ProfileTile emoji="📜" label="Licence" value={`${a.project_license} · ${LICENSE_STATUS[a.license.value]?.label ?? a.license.value}`}
              detail={a.license.detail} confidence={a.license.confidence} tone={verdictTone("license", a.license)} />
            <ProfileTile emoji="🔐" label="Data & payments"
              value={[a.personal_data ? "Personal data" : "No personal data", a.payments ? "payments" : "no payments"].join(" · ")}
              detail={a.data_detail} tone={a.personal_data && !a.signals.policy_files.length ? "warning" : "neutral"} />
            <ProfileTile emoji="🧩" label="Third-party assets"
              value={`${a.assets.length} found · ${a.assets.filter((x) => x.status === "paid" || x.status === "unlicensed").length} need a licence`}
              detail={`${a.signals.media_total} media file(s) in the project${a.signals.attribution_files.length ? `, credits in ${a.signals.attribution_files[0]}` : ", no credits file"}.`}
              tone={a.assets.some((x) => x.status === "unlicensed" || x.status === "paid") ? "danger" : a.assets.some((x) => x.status === "needs_check") ? "warning" : "success"} />
          </section>

          <div className="flex items-end justify-between gap-2 pt-2">
            <h4 className="font-serif text-lg font-bold">Possible issues <span className="text-text-muted">({openCount})</span></h4>
          </div>
          {issues.length === 0 ? (
            <Card className="flex flex-col items-center px-6 py-8 text-center">
              <span className="text-3xl" aria-hidden>🎉</span>
              <p className="mt-2 font-semibold">Nothing to sort out before launch</p>
              <p className="mt-1 text-sm text-text-muted">Licences, assets and deployment all look in order.</p>
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by kind">
                {[["all", "All", openCount] as const, ...Object.entries(counts).map(([k, n]) => [k, ISSUE_CATEGORY[k]?.label ?? k, n] as const)].map(([key, label, n]) => (
                  <button key={key} type="button" onClick={() => setFilter(key)} aria-pressed={filter === key}
                    className={`min-h-9 cursor-pointer rounded-full border px-3 text-sm font-medium transition-all duration-fast ease-standard active:scale-[0.96] ${filter === key ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface text-text-muted hover:border-text-muted/60 hover:text-text"}`}>
                    {ISSUE_CATEGORY[key]?.emoji ? `${ISSUE_CATEGORY[key].emoji} ` : ""}{label} <span className="opacity-70">{n}</span>
                  </button>
                ))}
                {ignoredCount > 0 && (
                  <button type="button" onClick={() => setShowIgnored((v) => !v)} className="ml-auto cursor-pointer text-xs font-medium text-text-muted underline-offset-2 hover:underline">
                    {showIgnored ? "Hide" : "Show"} {ignoredCount} marked not a problem
                  </button>
                )}
              </div>
              <ul className="space-y-2.5">
                {visible.map((issue, i) => (
                  <IssueCard key={issue.id} issue={issue} index={i} canPush={canPush}
                    onToggle={async () => {
                      try { await assessApi.toggleIgnore(milestoneId, issue.id); await load(); }
                      catch (e) { toast.error(e instanceof Error ? e.message : "That did not work."); }
                    }} />
                ))}
              </ul>
            </>
          )}

          {a.assets.length > 0 && (
            <Card className="overflow-hidden">
              <div className="border-b border-border px-4 py-3">
                <p className="font-semibold">Third-party assets</p>
                <p className="text-xs text-text-muted">Images, fonts, sounds, code and services that come from someone else, and whether you have permission to use them.</p>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full min-w-[620px] text-sm">
                  <thead className="bg-background/60 text-left text-[11px] uppercase tracking-wide text-text-muted">
                    <tr><th className="px-4 py-2 font-semibold">Asset</th><th className="px-3 py-2 font-semibold">Source</th><th className="px-3 py-2 font-semibold">Licence</th><th className="px-3 py-2 font-semibold">Status</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {a.assets.map((x, i) => (
                      <tr key={i} className="align-top">
                        <td className="px-4 py-2.5">
                          <span className="font-medium">{x.name}</span> <span className="text-xs text-text-muted">· {x.kind}</span>
                          {x.file && <span className="block truncate font-mono text-[11px] text-text-muted">{x.file}</span>}
                          {x.note && <span className="mt-0.5 block text-xs text-text-muted">{x.note}</span>}
                        </td>
                        <td className="px-3 py-2.5 text-text-muted">{x.source || "—"}</td>
                        <td className="px-3 py-2.5 text-text-muted">{x.license}</td>
                        <td className="px-3 py-2.5"><Badge tone={ASSET_STATUS[x.status]?.tone ?? "neutral"}>{ASSET_STATUS[x.status]?.label ?? x.status}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}

          <Card className="p-4">
            <button type="button" onClick={() => setShowEvidence((v) => !v)} aria-expanded={showEvidence} className="flex w-full cursor-pointer items-center justify-between text-left">
              <span>
                <span className="font-semibold">What VibeForge checked</span>
                <span className="block text-xs text-text-muted">Facts found without AI, given to Muse as evidence.</span>
              </span>
              <span aria-hidden className={`text-text-muted transition-transform duration-normal ${showEvidence ? "rotate-180" : ""}`}>▾</span>
            </button>
            {showEvidence && (
              <div className="mt-4 grid gap-4 sm:grid-cols-2">
                <EvidenceList title="Licence files" items={[...a.signals.license_files.map((f) => `${f}${a.signals.license_text_id ? ` (${a.signals.license_text_id})` : ""}`), ...a.signals.declared_licenses]} empty="No LICENSE file and no declared licence." />
                <EvidenceList title="Credits & policies" items={[...a.signals.attribution_files, ...a.signals.policy_files]} empty="No credits, privacy or terms files." />
                <EvidenceList title="Mobile & desktop" items={a.signals.mobile} empty="No app-store or mobile build files." />
                <EvidenceList title="Deployment & CI" items={[...a.signals.deployment, ...a.signals.ci]} empty="No deploy configs or CI pipelines." />
                <EvidenceList title="Stock-looking media" items={a.signals.stock_hints} empty="No stock-library file names." />
                <EvidenceList title="Asset services in code" items={a.signals.asset_hosts} empty="No font, image or icon CDNs." />
              </div>
            )}
          </Card>

          <p className="text-center text-xs text-text-muted">
            Assessed by {a.model} · {a.files_read} files read · {a.secrets_masked} secrets masked · took {fmtDuration(a.duration_ms)} · AI can be wrong and this is not legal advice.
          </p>
        </>
      )}
    </div>
  );
}
