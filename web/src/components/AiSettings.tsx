import { useEffect, useState } from "react";
import { aiApi, type AiConfig, type AiModel } from "../lib/aiApi";
import { Alert, Badge, Button, Card, Input, Label, Select, Skeleton, Toggle, useToast } from "./ui";
import { IconSparkles } from "./AiReview";

const SIZES = [
  { value: 100_000, label: "Small: about 100k characters (fastest, cheapest)" },
  { value: 200_000, label: "Standard: about 200k characters (recommended)" },
  { value: 500_000, label: "Large: about 500k characters (big projects)" },
  { value: 900_000, label: "Maximum: about 900k characters" },
];

const EFFORTS = [
  { value: "", label: "Model default" },
  { value: "minimal", label: "Minimal (fastest)" },
  { value: "low", label: "Low (recommended)" },
  { value: "medium", label: "Medium" },
  { value: "high", label: "High (slower, deeper)" },
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

export function AiSettings() {
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [models, setModels] = useState<AiModel[]>([]);
  const [live, setLive] = useState(false);
  const [newKey, setNewKey] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [custom, setCustom] = useState("");
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);
  const [error, setError] = useState("");
  const toast = useToast();

  const loadModels = async () => {
    try { const m = await aiApi.models(); setModels(m.models); setLive(m.live); } catch { /* catalog stays */ }
  };

  useEffect(() => {
    aiApi.config().then((c) => {
      setCfg(c);
      void loadModels();
    }).catch((e) => setError(e instanceof Error ? e.message : "Could not load AI settings."));
  }, []);

  if (error && !cfg) return <Alert>{error}</Alert>;
  if (!cfg) return <div className="space-y-3"><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;

  const set = <K extends keyof AiConfig>(k: K, v: AiConfig[K]) => setCfg({ ...cfg, [k]: v });
  const inCatalog = models.some((m) => m.id === cfg.model);
  const selected = models.find((m) => m.id === cfg.model);

  const save = async (extra: { clear_api_key?: boolean } = {}) => {
    setSaving(true); setError("");
    try {
      const next = await aiApi.saveConfig({
        enabled: cfg.enabled, base_url: cfg.base_url, model: cfg.model, redact_secrets: cfg.redact_secrets,
        max_chars: cfg.max_chars, reasoning_effort: cfg.reasoning_effort,
        api_key: newKey.trim() || undefined, ...extra,
      });
      setCfg(next); setNewKey(""); setShowKey(false);
      toast.success(extra.clear_api_key ? "API key removed." : "AI review settings saved.");
      void loadModels();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save."); }
    finally { setSaving(false); }
  };

  const runTest = async () => {
    setTesting(true); setTest(null);
    try {
      const r = await aiApi.test({ model: cfg.model, base_url: cfg.base_url, api_key: newKey.trim() || undefined });
      setTest({ ok: true, text: `Connected to ${r.model} in ${(r.latency_ms / 1000).toFixed(1)}s.` });
    } catch (e) { setTest({ ok: false, text: e instanceof Error ? e.message : "Connection failed." }); }
    finally { setTesting(false); }
  };

  return (
    <div className="space-y-5">
      <Card className="relative overflow-hidden p-5">
        <div aria-hidden className="pointer-events-none absolute -right-12 -top-16 h-48 w-48 rounded-full bg-primary/10 blur-3xl" />
        <div className="relative flex items-start gap-3.5">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-primary to-info text-primary-fg shadow-raised">
            <IconSparkles width={20} height={20} />
          </span>
          <div className="min-w-0 flex-1">
            <Toggle
              checked={cfg.enabled}
              onChange={(v) => set("enabled", v)}
              label="AI review with Meta Muse"
              description="Adds an AI review tab to every milestone. Owners and Coders run it on demand; code is sent to the provider below only when they do."
            />
          </div>
        </div>
      </Card>

      <Section
        title="API key"
        description="Your Meta Model API key from dev.meta.ai. Stored encrypted on this server, never shown again and never sent to browsers."
        aside={cfg.api_key_set
          ? <Badge tone="success">{cfg.api_key_source === "env" ? "From MODEL_API_KEY" : "Saved"} {cfg.api_key_hint}</Badge>
          : <Badge tone="warning">Not set</Badge>}
      >
        <label className="block space-y-1.5">
          <Label>{cfg.api_key_set ? "Replace key" : "Paste key"}</Label>
          <div className="flex gap-2">
            <Input
              type={showKey ? "text" : "password"}
              autoComplete="off"
              spellCheck={false}
              placeholder={cfg.api_key_set ? "Leave empty to keep the current key" : "LLM_…"}
              value={newKey}
              onChange={(e) => setNewKey(e.target.value)}
              className="font-mono"
            />
            <Button variant="secondary" onClick={() => setShowKey((s) => !s)} aria-label={showKey ? "Hide key" : "Show key"}>{showKey ? "Hide" : "Show"}</Button>
          </div>
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="secondary" busy={testing} onClick={runTest} disabled={!cfg.api_key_set && !newKey.trim()}>Test connection</Button>
          {cfg.api_key_source === "settings" && (
            <Button variant="ghost" onClick={() => void save({ clear_api_key: true })}>Remove saved key</Button>
          )}
          {test && <span className={`text-sm font-medium ${test.ok ? "text-success" : "text-error"}`} role="status">{test.ok ? "✓ " : ""}{test.text}</span>}
        </div>
      </Section>

      <Section
        title="Model"
        description="Pick the Muse model that reads your code. Change it any time; the next review uses it."
        aside={<Button variant="ghost" size="sm" onClick={() => void loadModels()}>{live ? "Refresh list" : "Load from provider"}</Button>}
      >
        <div role="radiogroup" aria-label="Model" className="grid gap-2 sm:grid-cols-2">
          {models.map((m) => {
            const active = m.id === cfg.model;
            return (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={active}
                onClick={() => { set("model", m.id); setCustom(""); }}
                className={`cursor-pointer rounded-lg border p-3.5 text-left transition-all duration-fast ease-standard active:scale-[0.99] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40 ${active ? "border-primary bg-primary/6 shadow-raised ring-1 ring-primary/40" : "border-border bg-surface hover:border-text-muted/50 hover:-translate-y-px"}`}
              >
                <span className="flex items-center justify-between gap-2">
                  <span className="font-semibold text-text">{m.label}</span>
                  <span className={`flex h-4 w-4 items-center justify-center rounded-full border-2 ${active ? "border-primary" : "border-border"}`}>
                    {active && <span className="h-2 w-2 rounded-full bg-primary" />}
                  </span>
                </span>
                <span className="mt-0.5 block font-mono text-[11px] text-text-muted">{m.id}</span>
                {m.note && <span className="mt-1.5 block text-xs leading-relaxed text-text-muted">{m.note}</span>}
                <span className="mt-2 flex flex-wrap gap-1">
                  {m.recommended && <Badge tone="primary">Recommended</Badge>}
                  {m.trains_on_data && <Badge tone="warning">Meta may train on your code</Badge>}
                  {m.price && <Badge>{m.price}</Badge>}
                </span>
              </button>
            );
          })}
        </div>
        <label className="block space-y-1.5">
          <Label>Or type another model id</Label>
          <Input
            placeholder="e.g. muse-spark-1.3"
            value={custom || (!inCatalog ? cfg.model : "")}
            onChange={(e) => { setCustom(e.target.value); if (e.target.value.trim()) set("model", e.target.value.trim()); }}
            className="font-mono"
          />
        </label>
        {selected?.trains_on_data && (
          <Alert variant="warning">Contributor models are cheaper because Meta may use what you send to train its models. Use them only for code you are happy to share.</Alert>
        )}
      </Section>

      <Section title="Safety and cost" description="What leaves this server, and how much of it.">
        <Toggle
          checked={cfg.redact_secrets}
          onChange={(v) => set("redact_secrets", v)}
          label="Mask secrets before sending code"
          description="Keys, tokens, passwords and other secret-looking values are replaced with a placeholder like [MASKED:stripe-key:32chars]. Muse still sees where each one sits, so it can tell you it is exposed, without ever receiving it."
        />
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="block space-y-1.5">
            <Label>Code sent per review</Label>
            <Select className="w-full" value={cfg.max_chars} onChange={(e) => set("max_chars", Number(e.target.value))}>
              {SIZES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
              {!SIZES.some((s) => s.value === cfg.max_chars) && <option value={cfg.max_chars}>{cfg.max_chars.toLocaleString()} characters</option>}
            </Select>
            <span className="block text-xs text-text-muted">Config and server files go first; lockfiles, builds and binaries are never sent.</span>
          </label>
          <label className="block space-y-1.5">
            <Label>Thinking effort</Label>
            <Select className="w-full" value={cfg.reasoning_effort} onChange={(e) => set("reasoning_effort", e.target.value)}>
              {EFFORTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
            </Select>
            <span className="block text-xs text-text-muted">More effort finds subtler problems but takes longer.</span>
          </label>
        </div>
        <details className="group rounded-md border border-border/70 px-3 py-2">
          <summary className="cursor-pointer select-none text-sm font-medium text-text-muted group-open:text-text">Advanced: provider URL</summary>
          <label className="mt-3 block space-y-1.5">
            <Label>OpenAI-compatible base URL</Label>
            <Input value={cfg.base_url} onChange={(e) => set("base_url", e.target.value)} className="font-mono" spellCheck={false} />
            <span className="block text-xs text-text-muted">Default https://api.meta.ai/v1. Any provider with a /chat/completions endpoint works.</span>
          </label>
        </details>
      </Section>

      {error && <Alert>{error}</Alert>}
      <div className="sticky bottom-3 z-sticky flex justify-end">
        <Button busy={saving} onClick={() => void save()} className="shadow-raised">Save AI settings</Button>
      </div>
    </div>
  );
}
