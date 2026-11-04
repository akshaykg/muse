import { useCallback, useEffect, useMemo, useRef, useState, type SVGProps } from "react";
import { aiApi, type AiIssue, type AiReview, type AiStatus } from "../lib/aiApi";
import { Alert, Badge, Button, Card, CopyButton, Skeleton, useToast } from "./ui";

// ------------------------------------------------------------------ icons

export function IconSparkles(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15z" />
      <path d="M5 2.5l.6 1.4L7 4.5l-1.4.6L5 6.5l-.6-1.4L3 4.5l1.4-.6L5 2.5z" />
    </svg>
  );
}

function IconShield(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <path d="M12 3l8 3v6c0 4.5-3.4 8.3-8 9-4.6-.7-8-4.5-8-9V6l8-3z" />
      <path d="M9 12l2 2 4-4" />
    </svg>
  );
}

// ------------------------------------------------------------------ words

const CATEGORY: Record<string, { label: string; emoji: string }> = {
  secrets: { label: "Hidden secrets", emoji: "🔑" },
  security: { label: "Security", emoji: "🛡️" },
  privacy: { label: "Privacy", emoji: "👁️" },
  best_practice: { label: "Best practice", emoji: "✨" },
  reliability: { label: "Reliability", emoji: "🧯" },
  performance: { label: "Speed", emoji: "⚡" },
};

const SEV: Record<string, { word: string; tone: "danger" | "warning" | "neutral" | "primary"; bar: string }> = {
  critical: { word: "Fix now", tone: "danger", bar: "bg-error" },
  high: { word: "Fix soon", tone: "danger", bar: "bg-error/70" },
  medium: { word: "Worth fixing", tone: "warning", bar: "bg-warning" },
  low: { word: "Nice to have", tone: "neutral", bar: "bg-text-muted/50" },
};

const STEPS = [
  "Picking the files that matter",
  "Masking secrets before anything leaves VibeForge",
  "Muse is reading your code",
  "Looking for what scanners can't see",
  "Writing plain-English explanations",
];

function gradeTone(score: number): string {
  if (score >= 85) return "text-success";
  if (score >= 65) return "text-warning";
  return "text-error";
}

function fmtDuration(ms: number): string {
  if (!ms) return "—";
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

// ------------------------------------------------------------------ pieces

function ScoreRing({ score, grade }: { score: number; grade: string }) {
  const r = 42;
  const c = 2 * Math.PI * r;
  const [shown, setShown] = useState(0);
  useEffect(() => { const t = window.setTimeout(() => setShown(score), 60); return () => window.clearTimeout(t); }, [score]);
  return (
    <div className={`relative h-28 w-28 shrink-0 ${gradeTone(score)}`} aria-label={`Health score ${score} out of 100, grade ${grade}`} role="img">
      <svg viewBox="0 0 100 100" className="h-full w-full -rotate-90">
        <circle cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeOpacity={0.14} strokeWidth={9} />
        <circle
          cx="50" cy="50" r={r} fill="none" stroke="currentColor" strokeWidth={9} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c - (c * shown) / 100}
          style={{ transition: "stroke-dashoffset 900ms cubic-bezier(0.2, 0, 0, 1)" }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-serif text-3xl font-bold leading-none">{grade || "–"}</span>
        <span className="mt-1 text-xs font-medium text-text-muted">{score}/100</span>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-md border border-border/70 bg-background/60 px-3 py-2">
      <div className="text-[11px] font-medium uppercase tracking-wide text-text-muted">{label}</div>
      <div className="mt-0.5 text-sm font-semibold text-text">{value}</div>
    </div>
  );
}

function Running({ review }: { review: AiReview }) {
  const [step, setStep] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const start = Date.parse(review.started_at) || Date.now();
    const tick = () => {
      const s = Math.max(0, (Date.now() - start) / 1000);
      setElapsed(s);
      setStep(Math.min(STEPS.length - 1, Math.floor(s / 4)));
    };
    tick();
    const id = window.setInterval(tick, 500);
    return () => window.clearInterval(id);
  }, [review.started_at]);
  return (
    <Card className="relative overflow-hidden p-6">
      <style>{`@keyframes vf-ai-beam{0%{transform:translateX(-100%)}100%{transform:translateX(250%)}}.vf-ai-beam{animation:vf-ai-beam 1.6s cubic-bezier(.4,0,.2,1) infinite}@media (prefers-reduced-motion: reduce){.vf-ai-beam{animation:none}}`}</style>
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-0.5 overflow-hidden bg-primary/10">
        <div className="vf-ai-beam h-full w-2/5 bg-gradient-to-r from-transparent via-primary to-transparent" />
      </div>
      <div className="flex items-start gap-4">
        <span className="relative flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-primary/12 text-primary">
          <span aria-hidden className="vf-pulse-glow absolute inset-0 rounded-xl bg-primary/20" />
          <IconSparkles width={22} height={22} className="relative" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-serif text-lg font-bold">Muse is reviewing this milestone…</p>
          <p className="text-sm text-text-muted">Usually 20–60 seconds with {review.model}. You can leave this tab; the result is saved.</p>
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

export function PromptBox({ text, label = "Prompt for your AI tool" }: { text: string; label?: string }) {
  return (
    <div className="rounded-md border border-primary/25 bg-primary/5">
      <div className="flex items-center justify-between gap-2 border-b border-primary/15 px-3 py-1.5">
        <span className="flex items-center gap-1.5 text-xs font-semibold text-primary"><IconSparkles width={13} height={13} /> {label}</span>
        <CopyButton text={text} label="Copy prompt" />
      </div>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap px-3 py-2.5 font-mono text-xs leading-relaxed text-text">{text}</pre>
    </div>
  );
}

function IssueCard({ issue, index, canPush, onToggle }: { issue: AiIssue; index: number; canPush: boolean; onToggle: () => Promise<void> }) {
  const [open, setOpen] = useState(index < 2);
  const [busy, setBusy] = useState(false);
  const sev = SEV[issue.severity] ?? SEV.low;
  const cat = CATEGORY[issue.category] ?? { label: issue.category.replace(/_/g, " "), emoji: "•" };
  const ignored = issue.status === "ignored";
  return (
    <li className="vf-page" style={{ animationDelay: `${Math.min(index, 8) * 40}ms`, animationFillMode: "backwards" }}>
      <Card className={`relative overflow-hidden transition-all duration-normal ease-standard hover:shadow-raised ${ignored ? "opacity-55" : ""}`}>
        <span aria-hidden className={`absolute inset-y-0 left-0 w-1 ${sev.bar}`} />
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="flex w-full cursor-pointer items-start gap-3 p-4 pl-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
        >
          <span className="mt-0.5 text-lg leading-none" aria-hidden>{cat.emoji}</span>
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-1.5">
              <Badge tone={sev.tone}>{sev.word}</Badge>
              <Badge>{cat.label}</Badge>
              {issue.file && (
                <span className="truncate rounded bg-background px-1.5 py-0.5 font-mono text-[11px] text-text-muted">
                  {issue.file}{issue.line ? `:${issue.line}` : ""}
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
            {issue.why_it_matters && (
              <p className="rounded-md bg-warning/8 px-3 py-2 text-sm text-text">
                <span className="font-semibold">Why it matters: </span>{issue.why_it_matters}
              </p>
            )}
            {issue.fix_steps.length > 0 && (
              <div>
                <p className="text-xs font-semibold uppercase tracking-wide text-text-muted">How to fix it</p>
                <ol className="mt-1.5 list-decimal space-y-1 pl-5 text-sm text-text">
                  {issue.fix_steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
              </div>
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

// ------------------------------------------------------------------ panel

export function AiReviewPanel({ milestoneId, canPush, isAdmin, onOpenSettings }: {
  milestoneId: string;
  canPush: boolean;
  isAdmin?: boolean;
  onOpenSettings?: () => void;
}) {
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [review, setReview] = useState<AiReview | null | undefined>(undefined);
  const [error, setError] = useState("");
  const [starting, setStarting] = useState(false);
  const [filter, setFilter] = useState<string>("all");
  const [showIgnored, setShowIgnored] = useState(false);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;
  const poll = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await aiApi.review(milestoneId);
      setReview(r.review);
      return r.review;
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load the AI review.");
      setReview(null);
      return null;
    }
  }, [milestoneId]);

  useEffect(() => {
    setReview(undefined); setError(""); setFilter("all");
    void load();
    void aiApi.status().then(setStatus).catch(() => setStatus(null));
  }, [load]);

  // Poll while a review runs; stop as soon as it settles.
  useEffect(() => {
    if (review?.status !== "running") return;
    poll.current = window.setInterval(async () => {
      const r = await load();
      if (r && r.status !== "running") {
        if (r.status === "done") toastRef.current.success(`AI review ready: ${r.issues.length} thing${r.issues.length === 1 ? "" : "s"} to look at.`);
        else toastRef.current.error(r.error ?? "The AI review failed.");
      }
    }, 1500);
    return () => { if (poll.current) window.clearInterval(poll.current); };
  }, [review?.status, load]);

  const start = async () => {
    setStarting(true); setError("");
    try { const r = await aiApi.start(milestoneId); setReview(r.review); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not start the AI review."); }
    finally { setStarting(false); }
  };

  const issues = review?.issues ?? [];
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const i of issues) if (i.status !== "ignored") c[i.category] = (c[i.category] ?? 0) + 1;
    return c;
  }, [issues]);
  const visible = issues.filter((i) => (filter === "all" || i.category === filter) && (showIgnored || i.status !== "ignored"));
  const ignoredCount = issues.filter((i) => i.status === "ignored").length;
  const openCount = issues.length - ignoredCount;
  const urgent = issues.filter((i) => i.status !== "ignored" && (i.severity === "critical" || i.severity === "high")).length;

  if (review === undefined) return <div className="space-y-2"><Skeleton className="h-36" /><Skeleton className="h-20" /><Skeleton className="h-20" /></div>;

  const runButton = canPush && status?.configured && (
    <Button onClick={start} busy={starting} disabled={review?.status === "running"}>
      <IconSparkles width={16} height={16} /> {review ? "Run again" : "Run AI review"}
    </Button>
  );

  const hero = (
    <Card className="relative overflow-hidden p-5 sm:p-6">
      <div aria-hidden className="pointer-events-none absolute -right-16 -top-20 h-56 w-56 rounded-full bg-primary/10 blur-3xl" />
      <div className="relative flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-3.5">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-info text-primary-fg shadow-raised">
            <IconSparkles width={22} height={22} />
          </span>
          <div>
            <h3 className="font-serif text-xl font-bold"><span className="vf-gradient-text">Meta Muse</span> AI review</h3>
            <p className="mt-0.5 max-w-xl text-sm text-text-muted">
              Finds what pattern scanners and the CVE database can't: secrets hiding in plain sight, missing security checks and habits that will bite later. Explained in plain words, with a prompt to fix each one.
            </p>
            <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-text-muted">
              <span className="inline-flex items-center gap-1 text-success"><IconShield /> Secrets are masked before code leaves VibeForge</span>
              {status?.model_label && <span>Model: <span className="font-medium text-text">{status.model_label}</span></span>}
            </p>
          </div>
        </div>
        {runButton}
      </div>
    </Card>
  );

  return (
    <div className="space-y-4">
      {hero}
      {error && <Alert>{error}</Alert>}

      {status && !status.configured && (
        <Alert variant="info">
          {status.enabled ? "AI review needs an API key." : "AI review is turned off."}{" "}
          {isAdmin && onOpenSettings
            ? <button type="button" className="cursor-pointer font-semibold underline underline-offset-2" onClick={onOpenSettings}>Set it up in Admin → AI review</button>
            : "Ask an admin to set it up in Admin → AI review."}
        </Alert>
      )}

      {!review && status?.configured && (
        <Card className="flex flex-col items-center px-6 py-10 text-center">
          <span className="text-3xl" aria-hidden>🔍</span>
          <p className="mt-2 font-semibold">No AI review for this milestone yet</p>
          <p className="mt-1 max-w-md text-sm text-text-muted">
            {canPush ? "Run one to get a health score and a short, plain-English list of what to fix, each with a ready-to-paste prompt." : "Owners and Coders of this space can run one."}
          </p>
        </Card>
      )}

      {review?.status === "running" && <Running review={review} />}

      {review?.status === "failed" && (
        <Alert>
          <span className="font-semibold">The AI review didn't finish.</span> {review.error}
        </Alert>
      )}

      {review?.status === "done" && (
        <>
          <Card className="vf-page p-5 sm:p-6">
            <div className="flex flex-col gap-5 sm:flex-row sm:items-center">
              <ScoreRing score={review.score} grade={review.grade} />
              <div className="min-w-0 flex-1">
                <p className="font-serif text-lg font-bold leading-snug">{review.headline}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-text-muted">{review.summary}</p>
                {review.strengths.length > 0 && (
                  <ul className="mt-3 flex flex-wrap gap-1.5">
                    {review.strengths.map((s, i) => (
                      <li key={i} className="rounded-full bg-success/12 px-2.5 py-1 text-xs font-medium text-success">✓ {s}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Stat label="To fix" value={urgent > 0 ? `${openCount} (${urgent} urgent)` : openCount} />
              <Stat label="Files read" value={review.files_reviewed} />
              <Stat label="Secrets masked" value={review.secrets_masked} />
              <Stat label="Took" value={fmtDuration(review.duration_ms)} />
            </div>
          </Card>

          {issues.length === 0 ? (
            <Card className="flex flex-col items-center px-6 py-10 text-center">
              <span className="text-3xl" aria-hidden>🎉</span>
              <p className="mt-2 font-semibold">Muse found nothing to fix</p>
              <p className="mt-1 text-sm text-text-muted">Clean work. Run it again after your next big change.</p>
            </Card>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Filter by kind">
                {[["all", "All", openCount] as const, ...Object.entries(counts).map(([k, n]) => [k, CATEGORY[k]?.label ?? k, n] as const)].map(([key, label, n]) => (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setFilter(key)}
                    aria-pressed={filter === key}
                    className={`min-h-9 cursor-pointer rounded-full border px-3 text-sm font-medium transition-all duration-fast ease-standard active:scale-[0.96] ${filter === key ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface text-text-muted hover:border-text-muted/60 hover:text-text"}`}
                  >
                    {CATEGORY[key]?.emoji ? `${CATEGORY[key].emoji} ` : ""}{label} <span className="opacity-70">{n}</span>
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
                  <IssueCard
                    key={issue.id}
                    issue={issue}
                    index={i}
                    canPush={canPush}
                    onToggle={async () => {
                      try { await aiApi.toggleIgnore(milestoneId, issue.id); await load(); }
                      catch (e) { toast.error(e instanceof Error ? e.message : "That did not work."); }
                    }}
                  />
                ))}
              </ul>

              {review.fix_all_prompt && openCount > 1 && (
                <Card className="p-4">
                  <p className="mb-2 text-sm font-semibold">Fix everything in one go</p>
                  <PromptBox text={review.fix_all_prompt} label="One prompt for all of the above" />
                  <p className="mt-2 text-xs text-text-muted">Paste it into Cursor, Claude Code or Copilot, then push a new milestone and run the review again.</p>
                </Card>
              )}
            </>
          )}

          <p className="text-center text-xs text-text-muted">
            Reviewed by {review.model} · {review.files_reviewed} files{review.files_skipped ? `, ${review.files_skipped} skipped (lockfiles, builds, binaries)` : ""} · AI can be wrong, so check before you change anything important.
          </p>
        </>
      )}
    </div>
  );
}
