import { useEffect, useRef, useState, type SVGProps } from "react";
import {
  assessApi, AUDIENCE, DEPLOY, FLAG, ISSUE_CATEGORY, LICENSE_STATUS, PLATFORM, RISK,
  type AssessFilters, type AssessRow, type AssessSearch,
} from "../lib/assessApi";
import { IconSparkles } from "./AiReview";
import { Alert, Badge, Card, EmptyState, Input, Select, Skeleton } from "./ui";

export function IconAssessment(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden {...props}>
      <rect x="5" y="4" width="14" height="17" rx="2" />
      <path d="M9 4.5V3h6v1.5" />
      <path d="M8.5 11.5l2 2 4-4" />
      <path d="M8.5 17h7" />
    </svg>
  );
}

const SEV_DOT: Record<string, string> = { critical: "bg-error", high: "bg-error/70", medium: "bg-warning", low: "bg-text-muted/50" };

function readinessTone(n: number): string {
  if (n >= 80) return "text-success";
  if (n >= 55) return "text-warning";
  return "text-error";
}

const FACETS: { key: keyof AssessFilters; facet: keyof AssessSearch["facets"]; label: string; words: Record<string, string> }[] = [
  { key: "audience", facet: "audience", label: "Audience", words: Object.fromEntries(Object.entries(AUDIENCE).map(([k, v]) => [k, v.label])) },
  { key: "platform", facet: "platform", label: "Platform", words: PLATFORM },
  { key: "risk", facet: "risk", label: "Risk", words: Object.fromEntries(Object.entries(RISK).map(([k, v]) => [k, v.label])) },
  { key: "license", facet: "license", label: "Licence", words: Object.fromEntries(Object.entries(LICENSE_STATUS).map(([k, v]) => [k, v.label])) },
  { key: "deployment", facet: "deployment", label: "Deployment", words: DEPLOY },
  { key: "category", facet: "category", label: "Issue type", words: Object.fromEntries(Object.entries(ISSUE_CATEGORY).map(([k, v]) => [k, v.label])) },
];

const QUICK: { label: string; f: AssessFilters }[] = [
  { label: "🔴 High or critical risk", f: { risk: "high_plus" } },
  { label: "💳 Paid media", f: { flag: "paid_media" } },
  { label: "🚫 Unlicensed assets", f: { flag: "unlicensed" } },
  { label: "📜 No licence", f: { license: "missing" } },
  { label: "🌍 External apps", f: { audience: "external" } },
  { label: "📱 Mobile apps", f: { flag: "mobile" } },
  { label: "🔐 Personal data", f: { flag: "personal_data" } },
];

function StatTile({ label, value, tone }: { label: string; value: number | string; tone?: string }) {
  return (
    <div className="rounded-lg border border-border bg-surface px-4 py-3 shadow-surface">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-text-muted">{label}</div>
      <div className={`mt-0.5 font-serif text-2xl font-bold tabular-nums ${tone ?? "text-text"}`}>{value}</div>
    </div>
  );
}

function Row({ r, onOpen }: { r: AssessRow; onOpen: (r: AssessRow) => void }) {
  const lic = LICENSE_STATUS[r.license_status];
  return (
    <li>
      <button type="button" onClick={() => onOpen(r)}
        className="group flex w-full cursor-pointer flex-col gap-3 p-4 text-left transition-colors duration-fast hover:bg-background/70 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary/40 sm:flex-row sm:items-start">
        <div className={`flex w-14 shrink-0 flex-col items-center ${readinessTone(r.readiness)}`}>
          <span className="font-serif text-2xl font-bold leading-none tabular-nums">{r.readiness}</span>
          <span className="mt-0.5 text-[10px] font-semibold uppercase tracking-wider text-text-muted">ready</span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className="font-semibold text-text group-hover:text-primary">{r.project ?? "Deleted project"}</span>
            <Badge tone={RISK[r.risk]?.tone ?? "neutral"}>{RISK[r.risk]?.label ?? r.risk}</Badge>
            <span className="text-xs text-text-muted">
              {r.space ?? "—"} · {r.owner ?? "unknown"} · #{r.seq_no ?? "?"}{r.is_latest ? "" : " (older milestone)"}
            </span>
          </div>
          <p className="mt-1 line-clamp-2 text-sm text-text-muted">{r.headline}</p>
          <div className="mt-2 flex flex-wrap gap-1">
            <Badge>{AUDIENCE[r.audience]?.emoji} {AUDIENCE[r.audience]?.label ?? r.audience}</Badge>
            {r.platforms.map((p) => <Badge key={p} tone="primary">{PLATFORM[p] ?? p}</Badge>)}
            <Badge tone={lic?.tone ?? "neutral"}>{r.license} · {lic?.label ?? r.license_status}</Badge>
            <Badge>{DEPLOY[r.deployment] ?? r.deployment}{r.deploy_targets.length ? `: ${r.deploy_targets.slice(0, 2).join(", ")}` : ""}</Badge>
            {r.paid_media && <Badge tone="danger">Paid media</Badge>}
            {r.unlicensed_assets > 0 && <Badge tone="danger">{r.unlicensed_assets} unlicensed asset{r.unlicensed_assets === 1 ? "" : "s"}</Badge>}
            {r.personal_data && <Badge tone="warning">Personal data</Badge>}
            {r.payments && <Badge tone="warning">Payments</Badge>}
          </div>
          {r.top_issues.length > 0 && (
            <ul className="mt-2.5 space-y-1">
              {r.top_issues.map((i, n) => (
                <li key={n} className="flex items-center gap-2 text-xs text-text">
                  <span aria-hidden className={`h-1.5 w-1.5 shrink-0 rounded-full ${SEV_DOT[i.severity] ?? SEV_DOT.low}`} />
                  <span className="truncate">{i.title}</span>
                  <span className="shrink-0 text-text-muted">· {ISSUE_CATEGORY[i.category]?.label ?? i.category}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-3 sm:flex-col sm:items-end">
          <span className="text-sm font-semibold text-text">{r.issues_open} issue{r.issues_open === 1 ? "" : "s"}</span>
          {r.urgent > 0 && <span className="text-xs font-semibold text-error">{r.urgent} urgent</span>}
          <span className="text-xs text-text-muted">{r.finished_at?.slice(0, 10)}</span>
        </div>
      </button>
    </li>
  );
}

/** Admin → AI assessments: search and filter every project's assessment. */
export function AdminAssessments({ onOpen }: { onOpen: (projectId: string, milestoneId: string) => void }) {
  const [filters, setFilters] = useState<AssessFilters>({ sort: "relevance" });
  const [text, setText] = useState("");
  const [data, setData] = useState<AssessSearch | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const seq = useRef(0);

  // Debounce typing; filters apply at once.
  useEffect(() => {
    const t = window.setTimeout(() => setFilters((f) => (f.q === text ? f : { ...f, q: text })), 250);
    return () => window.clearTimeout(t);
  }, [text]);

  useEffect(() => {
    const n = ++seq.current;
    setLoading(true);
    assessApi.search(filters)
      .then((d) => { if (n === seq.current) { setData(d); setError(""); } })
      .catch((e) => { if (n === seq.current) setError(e instanceof Error ? e.message : "Search failed."); })
      .finally(() => { if (n === seq.current) setLoading(false); });
  }, [filters]);

  const set = (k: keyof AssessFilters, v: string) => setFilters((f) => ({ ...f, [k]: v }));
  const active = (Object.keys(filters) as (keyof AssessFilters)[]).filter((k) => k !== "sort" && k !== "q" && k !== "scope" && filters[k]);
  const facet = (name: keyof AssessSearch["facets"], key: string) => data?.facets[name]?.[key] ?? 0;
  const highRisk = facet("risk", "high") + facet("risk", "critical");

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2.5 lg:grid-cols-4">
        <StatTile label="Projects assessed" value={data ? `${data.indexed}/${data.projects}` : "—"} />
        <StatTile label="High or critical risk" value={data ? highRisk : "—"} tone={highRisk > 0 ? "text-error" : undefined} />
        <StatTile label="Paid or unlicensed media" value={data ? Math.max(facet("flag", "paid_media"), facet("flag", "unlicensed")) : "—"} tone={facet("flag", "paid_media") + facet("flag", "unlicensed") > 0 ? "text-error" : undefined} />
        <StatTile label="Missing a licence" value={data ? facet("license", "missing") : "—"} tone={facet("license", "missing") > 0 ? "text-warning" : undefined} />
      </div>

      <Card className="p-4">
        <div className="relative">
          <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-primary"><IconSparkles width={16} height={16} /></span>
          <Input
            type="search" value={text} onChange={(e) => setText(e.target.value)} aria-label="Search assessments"
            placeholder="Search projects, owners, licences, assets, issues… e.g. gpl, shutterstock, expo, stripe"
            className="pl-9"
          />
        </div>
        <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Quick filters">
          {QUICK.map((q) => {
            const on = Object.entries(q.f).every(([k, v]) => filters[k as keyof AssessFilters] === v);
            return (
              <button key={q.label} type="button" aria-pressed={on}
                onClick={() => setFilters((f) => { const next = { ...f }; for (const [k, v] of Object.entries(q.f)) next[k as keyof AssessFilters] = on ? "" : v; return next; })}
                className={`min-h-8 cursor-pointer rounded-full border px-3 text-xs font-medium transition-all duration-fast ease-standard active:scale-[0.96] ${on ? "border-primary bg-primary text-primary-fg" : "border-border bg-surface text-text-muted hover:border-text-muted/60 hover:text-text"}`}>
                {q.label}
              </button>
            );
          })}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-3 2xl:grid-cols-6">
          {FACETS.map((f) => (
            <Select key={f.key} value={filters[f.key] ?? ""} onChange={(e) => set(f.key, e.target.value)} aria-label={f.label}>
              <option value="">{f.label}: any</option>
              {Object.entries(f.words).map(([k, label]) => (
                <option key={k} value={k}>{label} ({facet(f.facet, k)})</option>
              ))}
            </Select>
          ))}
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2 text-sm">
          <Select value={filters.flag ?? ""} onChange={(e) => set("flag", e.target.value)} aria-label="Flag" className="w-auto">
            <option value="">Any flag</option>
            {Object.entries(FLAG).map(([k, label]) => <option key={k} value={k}>{label} ({facet("flag", k)})</option>)}
          </Select>
          <Select value={filters.scope ?? ""} onChange={(e) => set("scope", e.target.value)} aria-label="Milestones" className="w-auto">
            <option value="">Latest milestone of each project</option>
            <option value="all">Every assessed milestone</option>
          </Select>
          <Select value={filters.sort ?? "relevance"} onChange={(e) => set("sort", e.target.value)} aria-label="Sort" className="w-auto">
            <option value="relevance">Best match</option>
            <option value="risk">Highest risk first</option>
            <option value="readiness">Least ready first</option>
            <option value="recent">Newest first</option>
          </Select>
          {(active.length > 0 || text) && (
            <button type="button" className="ml-auto cursor-pointer text-xs font-semibold text-primary hover:underline"
              onClick={() => { setText(""); setFilters({ sort: filters.sort, scope: filters.scope }); }}>
              Clear all
            </button>
          )}
        </div>
      </Card>

      {error && <Alert>{error}</Alert>}

      <div className="flex items-center justify-between text-sm text-text-muted" aria-live="polite">
        <span>{data ? `${data.total} result${data.total === 1 ? "" : "s"}` : "Searching…"}</span>
        {loading && data && <span className="text-xs">Updating…</span>}
      </div>

      {!data && loading && <div className="space-y-2"><Skeleton className="h-28" /><Skeleton className="h-28" /></div>}
      {data && data.indexed === 0 && (
        <EmptyState title="No assessments yet" hint="Turn on automatic assessments in AI review, or open a milestone and run one from its ✦ Assessment tab." />
      )}
      {data && data.indexed > 0 && data.rows.length === 0 && (
        <EmptyState title="Nothing matches" hint="Try fewer words or clear a filter." />
      )}
      {data && data.rows.length > 0 && (
        <ul className={`divide-y divide-border overflow-hidden rounded-lg border border-border bg-surface shadow-surface transition-opacity duration-fast ${loading ? "opacity-70" : ""}`}>
          {data.rows.map((r) => (
            <Row key={r.milestone_id} r={r} onOpen={(row) => row.project_id && onOpen(row.project_id, row.milestone_id)} />
          ))}
        </ul>
      )}
    </div>
  );
}
