import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { aiApi, type AiPreview } from "../lib/aiApi";
import { Badge, Button, Card, useToast } from "./ui";
import { IconSparkles } from "./AiReview";

const FRAME_W = 1280;
const FRAME_H = 800;

/** Blob → object URL, fetched with the session token (an <img src> can't send it). */
function useBlobUrl(key: string | undefined) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!key) { setUrl(null); return; }
    let live = true;
    let made: string | null = null;
    setUrl(null);
    void api.blobUrl(key).then((u) => { made = u; if (live) setUrl(u); });
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [key]);
  return url;
}

/** The AI sketch at its design size (1280×800), scaled to the card's width. */
function ScaledFrame({ html, title }: { html: string; title: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0.5);
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setScale(el.clientWidth / FRAME_W);
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return (
    <div ref={box} className="relative w-full overflow-hidden bg-white" style={{ height: FRAME_H * scale }}>
      <iframe
        title={title}
        srcDoc={html}
        // No scripts, forms, popups or same-origin access: the sketch is a picture, nothing more.
        sandbox=""
        referrerPolicy="no-referrer"
        loading="lazy"
        tabIndex={-1}
        className="pointer-events-none absolute left-0 top-0 origin-top-left border-0"
        style={{ width: FRAME_W, height: FRAME_H, transform: `scale(${scale})` }}
      />
    </div>
  );
}

function BrowserChrome({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-raised">
      <div className="flex items-center gap-3 border-b border-border bg-background/80 px-3 py-2">
        <span className="flex gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-error/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-warning/60" />
          <span className="h-2.5 w-2.5 rounded-full bg-success/60" />
        </span>
        <span className="mx-auto flex min-w-0 max-w-sm flex-1 items-center justify-center truncate rounded-md bg-surface px-3 py-1 text-[11px] text-text-muted">
          {label}
        </span>
        <span className="w-10" aria-hidden />
      </div>
      {children}
    </div>
  );
}

export function MilestoneShowcase({ milestoneId, projectName, shots, canPush, onShotsChanged }: {
  milestoneId: string;
  projectName: string;
  shots: string[];
  canPush: boolean;
  onShotsChanged: () => Promise<void> | void;
}) {
  const [preview, setPreview] = useState<AiPreview | null | undefined>(undefined);
  const [aiReady, setAiReady] = useState(false);
  const [view, setView] = useState<"shots" | "ai">(shots.length ? "shots" : "ai");
  const [index, setIndex] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [starting, setStarting] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  const toast = useToast();
  const toastRef = useRef(toast);
  toastRef.current = toast;

  const load = useCallback(async () => {
    try { const r = await aiApi.preview(milestoneId); setPreview(r.preview); return r.preview; }
    catch { setPreview(null); return null; }
  }, [milestoneId]);

  useEffect(() => {
    setPreview(undefined); setIndex(0);
    void load();
    void aiApi.status().then((s) => setAiReady(s.configured)).catch(() => setAiReady(false));
  }, [load]);
  useEffect(() => { setView(shots.length ? "shots" : "ai"); setIndex((i) => Math.min(i, Math.max(0, shots.length - 1))); }, [shots.length, milestoneId]);

  // Poll while Muse sketches; on a fresh push with no picture yet, watch briefly for the auto-sketch.
  useEffect(() => {
    const running = preview?.status === "running";
    const waitingForAuto = preview === null && shots.length === 0 && aiReady;
    if (!running && !waitingForAuto) return;
    let ticks = 0;
    const id = window.setInterval(async () => {
      ticks += 1;
      const p = await load();
      if (running && p && p.status === "done") toastRef.current.success("Muse sketched a preview of this milestone.");
      if (running && p && p.status === "failed") toastRef.current.error(p.error ?? "The preview failed.");
      if (!running && ticks > 10) window.clearInterval(id);
    }, running ? 2000 : 5000);
    return () => window.clearInterval(id);
  }, [preview?.status, preview === null, shots.length, aiReady, load]);

  const shotUrl = useBlobUrl(view === "shots" ? shots[index] : undefined);

  const upload = async (f: File) => {
    setUploading(true);
    try { await api.addScreenshot(milestoneId, f); await onShotsChanged(); setIndex(shots.length); setView("shots"); toast.success("Screenshot added."); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Upload failed."); }
    finally { setUploading(false); if (file.current) file.current.value = ""; }
  };

  const sketch = async () => {
    setStarting(true);
    try { const r = await aiApi.startPreview(milestoneId); setPreview(r.preview); setView("ai"); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not start the preview."); }
    finally { setStarting(false); }
  };

  const hasAi = preview?.status === "done";
  const running = preview?.status === "running";
  const showingAi = view === "ai" || shots.length === 0;
  const name = shots[index]?.split("/").pop()?.replace(/^[0-9a-f]{64}-/, "") ?? "";

  return (
    <Card className="mb-5 overflow-hidden p-4 sm:p-5">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="mr-1 text-sm font-semibold text-text">How it looks</h3>
        {shots.length > 0 && (hasAi || running) ? (
          <div className="flex rounded-full border border-border bg-background p-0.5" role="group" aria-label="Preview source">
            {(["shots", "ai"] as const).map((v) => (
              <button
                key={v}
                type="button"
                aria-pressed={view === v}
                onClick={() => setView(v)}
                className={`cursor-pointer rounded-full px-2.5 py-1 text-xs font-medium transition duration-fast ${view === v ? "bg-surface text-text shadow-surface" : "text-text-muted hover:text-text"}`}
              >
                {v === "shots" ? `Screenshots (${shots.length})` : "✦ AI preview"}
              </button>
            ))}
          </div>
        ) : showingAi && (hasAi || running) ? (
          <Badge tone="primary">✦ AI preview</Badge>
        ) : shots.length > 0 ? (
          <Badge>Screenshot {index + 1} of {shots.length}</Badge>
        ) : null}
        <div className="ml-auto flex flex-wrap gap-2">
          {canPush && aiReady && showingAi && (hasAi || preview?.status === "failed") && (
            <Button variant="ghost" size="sm" busy={starting} onClick={sketch}><IconSparkles width={14} height={14} /> Redraw</Button>
          )}
          {canPush && (
            <>
              <input ref={file} type="file" accept="image/*" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); }} />
              <Button variant="secondary" size="sm" busy={uploading} onClick={() => file.current?.click()}>Add screenshot</Button>
            </>
          )}
        </div>
      </div>

      {!showingAi && shots.length > 0 && (
        <>
          <BrowserChrome label={name || projectName}>
            <div className="group relative flex max-h-[560px] min-h-48 items-center justify-center bg-background">
              {shotUrl
                ? <a href={shotUrl} target="_blank" rel="noreferrer" className="block w-full"><img src={shotUrl} alt={name || "Screenshot"} className="mx-auto max-h-[560px] w-full object-contain" /></a>
                : <div className="aspect-video w-full animate-pulse bg-border/50" />}
              {shots.length > 1 && (
                <>
                  <button type="button" aria-label="Previous screenshot" onClick={() => setIndex((i) => (i - 1 + shots.length) % shots.length)}
                    className="absolute left-3 top-1/2 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-surface/90 text-text shadow-raised opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100">‹</button>
                  <button type="button" aria-label="Next screenshot" onClick={() => setIndex((i) => (i + 1) % shots.length)}
                    className="absolute right-3 top-1/2 flex h-9 w-9 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full border border-border bg-surface/90 text-text shadow-raised opacity-0 transition group-hover:opacity-100 focus-visible:opacity-100">›</button>
                </>
              )}
            </div>
          </BrowserChrome>
          {shots.length > 1 && (
            <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
              {shots.map((k, i) => <Thumb key={k} blobKey={k} active={i === index} onClick={() => setIndex(i)} />)}
            </div>
          )}
        </>
      )}

      {showingAi && hasAi && preview && (
        <>
          <BrowserChrome label={preview.title || projectName}>
            <ScaledFrame html={preview.html} title={`AI preview of ${preview.title || projectName}`} />
          </BrowserChrome>
          <p className="mt-2.5 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-text-muted">
            <span className="inline-flex items-center gap-1 font-medium text-primary"><IconSparkles width={13} height={13} /> Reconstructed by Muse from this milestone's code</span>
            {preview.caption && <span>· {preview.caption}</span>}
            <span>· Not a real screenshot; add one to replace it.</span>
          </p>
        </>
      )}

      {showingAi && running && (
        <BrowserChrome label={projectName}>
          <div className="relative overflow-hidden bg-background" style={{ aspectRatio: `${FRAME_W} / ${FRAME_H}` }}>
            <div className="absolute inset-0 grid grid-cols-[18%_1fr] gap-4 p-6 opacity-70">
              <div className="space-y-3"><div className="h-6 animate-pulse rounded bg-border/70" />{[0, 1, 2, 3].map((i) => <div key={i} className="h-3 animate-pulse rounded bg-border/50" />)}</div>
              <div className="space-y-4"><div className="h-10 w-2/3 animate-pulse rounded bg-border/70" /><div className="grid grid-cols-3 gap-4">{[0, 1, 2, 3, 4, 5].map((i) => <div key={i} className="h-24 animate-pulse rounded-lg bg-border/50" style={{ animationDelay: `${i * 120}ms` }} />)}</div></div>
            </div>
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="flex items-center gap-2 rounded-full border border-primary/30 bg-surface/95 px-4 py-2 text-sm font-medium text-primary shadow-raised">
                <IconSparkles width={16} height={16} className="vf-pulse-glow" /> Muse is sketching your app from its code…
              </span>
            </div>
          </div>
        </BrowserChrome>
      )}

      {showingAi && !hasAi && !running && shots.length === 0 && preview !== undefined && (
        <div className="relative flex flex-col items-center overflow-hidden rounded-lg border border-dashed border-border bg-background/60 px-6 py-10 text-center">
          <div aria-hidden className="vf-grid pointer-events-none absolute inset-0 opacity-60" />
          <span className="relative text-4xl" aria-hidden>🖼️</span>
          <p className="relative mt-3 font-semibold">No screenshot for this milestone yet</p>
          <p className="relative mt-1 max-w-md text-sm text-text-muted">
            {preview?.status === "failed"
              ? preview.error
              : aiReady ? "Muse can read the code and sketch what the app looks like, so you can spot this version at a glance." : "Add a screenshot so you can recognise this version at a glance."}
          </p>
          {canPush && (
            <div className="relative mt-4 flex flex-wrap justify-center gap-2">
              {aiReady && <Button busy={starting} onClick={sketch}><IconSparkles width={16} height={16} /> {preview?.status === "failed" ? "Try again" : "Sketch it with Muse"}</Button>}
              <Button variant="secondary" busy={uploading} onClick={() => file.current?.click()}>Upload screenshot</Button>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Thumb({ blobKey, active, onClick }: { blobKey: string; active: boolean; onClick: () => void }) {
  const url = useBlobUrl(blobKey);
  return (
    <button type="button" onClick={onClick} aria-pressed={active} aria-label="Show screenshot"
      className={`h-16 w-28 shrink-0 cursor-pointer overflow-hidden rounded-md border-2 bg-background transition duration-fast ${active ? "border-primary" : "border-transparent opacity-70 hover:opacity-100"}`}>
      {url ? <img src={url} alt="" className="h-full w-full object-cover" /> : <span className="block h-full w-full animate-pulse bg-border/50" />}
    </button>
  );
}
