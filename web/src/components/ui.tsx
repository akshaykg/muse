"use client";

// Shared UI kit — the local @depotex/ui-components equivalent
// (shared-ui-components.md). Every interactive element in the app comes
// from here: no raw <button>/<input> styling in pages, theme tokens only.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";

// ------------------------------------------------------------ permissions
// Single permission utility (ui-permissions.md). Elements that fail the
// check are not rendered at all — never hidden with CSS.

export type SpaceRoleName = "owner" | "coder" | "reader";

const ROLE_RANK: Record<SpaceRoleName, number> = { reader: 1, coder: 2, owner: 3 };

export interface PermContextValue {
  isAdmin: boolean;
  roleIn: (spaceId: string) => SpaceRoleName | null;
}

const PermContext = createContext<PermContextValue>({ isAdmin: false, roleIn: () => null });

export function PermissionsProvider({
  value,
  children,
}: {
  value: PermContextValue;
  children: ReactNode;
}) {
  return <PermContext.Provider value={value}>{children}</PermContext.Provider>;
}

/** e.g. usePermission("projects:create", role) — true when role may do it. */
export function usePermission(permission: string, spaceRole?: SpaceRoleName | null): boolean {
  const ctx = useContext(PermContext);
  if (ctx.isAdmin) return true;
  switch (permission) {
    case "spaces:create":
    case "admin:access":
      return false; // platform-admin only; non-admins never see the entry
    case "projects:create":
    case "milestones:push":
    case "findings:dismiss":
      return spaceRole != null && ROLE_RANK[spaceRole] >= ROLE_RANK.coder;
    case "members:manage":
      return spaceRole === "owner";
    case "projects:read":
      return spaceRole != null;
    default:
      return false;
  }
}

// ----------------------------------------------------------------- toasts
// One toast region (toasts.md): bottom-end, max 3, role="status".
// Successes are toasts; field/page errors stay inline as <Alert>.

interface ToastItem {
  id: number;
  kind: "success" | "error" | "info";
  text: string;
}

const ToastContext = createContext<{ push: (kind: ToastItem["kind"], text: string) => void }>({
  push: () => {},
});

export function useToast() {
  const { push } = useContext(ToastContext);
  return {
    success: (text: string) => push("success", text),
    error: (text: string) => push("error", text),
    info: (text: string) => push("info", text),
  };
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const idRef = useRef(0);

  const push = useCallback((kind: ToastItem["kind"], text: string) => {
    const id = ++idRef.current;
    setToasts((prev) => [...prev.slice(-2), { id, kind, text }]);
    const ttl = kind === "error" ? 8000 : 4000;
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), ttl);
  }, []);

  return (
    <ToastContext.Provider value={{ push }}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-toast flex w-[min(384px,calc(100vw-2rem))] flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : undefined}
            className="vf-toast pointer-events-auto flex items-start gap-2 rounded-md border border-border bg-surface-elevated px-3 py-2 shadow-overlay"
          >
            <span aria-hidden className={t.kind === "success" ? "text-success" : t.kind === "error" ? "text-error" : "text-info"}>
              {t.kind === "success" ? "✓" : t.kind === "error" ? "!" : "i"}
            </span>
            <span className="text-sm text-text">{t.text}</span>
            <button
              type="button"
              aria-label="Dismiss"
              className="ml-auto min-h-6 min-w-6 text-text-muted transition-colors duration-fast hover:text-text"
              onClick={() => setToasts((prev) => prev.filter((x) => x.id !== t.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ------------------------------------------------------------------ hooks

/** Close on outside click / Escape; returns focus signal via callback. */
export function useDismiss<T extends HTMLElement>(open: boolean, onClose: () => void) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return ref;
}

export function useCopy(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const copy = useCallback(
    async (text: string) => {
      try {
        await navigator.clipboard.writeText(text);
        setCopied(true);
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), resetMs);
      } catch {
        setCopied(false);
      }
    },
    [resetMs],
  );
  return { copied, copy };
}

// --------------------------------------------------------------- controls

function cx(...parts: (string | false | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "primary" | "secondary" | "ghost" | "danger";
  size?: "sm" | "md";
  busy?: boolean;
}

const BUTTON_VARIANTS: Record<NonNullable<ButtonProps["variant"]>, string> = {
  primary: "bg-primary text-primary-fg shadow-surface hover:bg-primary-hover hover:shadow-raised hover:-translate-y-px active:translate-y-0 active:scale-[0.96] active:brightness-95 active:shadow-surface",
  secondary: "border border-border bg-surface text-text shadow-surface hover:bg-background hover:border-text-muted/60 hover:-translate-y-px active:translate-y-0 active:scale-[0.96] active:bg-background/90 active:shadow-inner",
  ghost: "text-text-muted hover:bg-background hover:text-text active:scale-[0.95] active:bg-text/10",
  danger: "bg-error text-error-fg shadow-surface hover:brightness-105 hover:-translate-y-px active:translate-y-0 active:scale-[0.96] active:brightness-90",
};

export function Button({ variant = "primary", size = "md", busy, disabled, className, children, ...rest }: ButtonProps) {
  return (
    <button
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md font-medium cursor-pointer select-none transition-all duration-fast ease-standard",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 focus-visible:ring-offset-2",
        "active:scale-[0.96] disabled:pointer-events-none disabled:opacity-50",
        size === "sm" ? "min-h-9 px-3 py-1.5 text-sm" : "min-h-11 px-4 py-2 text-sm",
        BUTTON_VARIANTS[variant],
        className,
      )}
      disabled={disabled || busy}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy && <Spinner size="sm" />}
      {children}
    </button>
  );
}

export function Input({ className, ...rest }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={cx(
        "min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-text",
        "transition duration-fast ease-standard placeholder:text-text-muted",
        "hover:border-text-muted focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30",
        "disabled:opacity-50",
        className,
      )}
      {...rest}
    />
  );
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={cx(
        "min-h-11 rounded-md border border-border bg-surface px-2 py-2 text-sm text-text",
        "transition duration-fast ease-standard hover:border-text-muted",
        "focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/30",
        className,
      )}
      {...rest}
    >
      {children}
    </select>
  );
}

export function Label({ children }: { children: ReactNode }) {
  return <span className="text-sm font-medium text-text">{children}</span>;
}

// ---------------------------------------------------------------- display

export function Alert({ variant = "error", children }: { variant?: "error" | "warning" | "success" | "info"; children: ReactNode }) {
  const styles: Record<string, string> = {
    error: "border-error/40 bg-error/10 text-error",
    warning: "border-warning/40 bg-warning/10 text-warning",
    success: "border-success/40 bg-success/10 text-success",
    info: "border-info/40 bg-info/10 text-info",
  };
  return (
    <div role={variant === "error" ? "alert" : "status"} className={cx("rounded-md border px-3 py-2 text-sm", styles[variant])}>
      {children}
    </div>
  );
}

export function Spinner({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const px = size === "sm" ? "h-4 w-4" : size === "lg" ? "h-8 w-8" : "h-5 w-5";
  return (
    <span
      role="status"
      aria-label="Loading"
      className={cx("inline-block animate-spin rounded-full border-2 border-current border-t-transparent", px)}
    />
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden className={cx("animate-pulse rounded-md bg-border/60", className)} />;
}

export function Card({ className, children }: { className?: string; children: ReactNode }) {
  return (
    <div className={cx("rounded-lg border border-border bg-surface shadow-surface", className)}>{children}</div>
  );
}

export function Badge({
  tone = "neutral",
  children,
}: {
  tone?: "neutral" | "success" | "warning" | "danger" | "primary";
  children: ReactNode;
}) {
  const styles: Record<string, string> = {
    neutral: "bg-background text-text-muted",
    success: "bg-success/15 text-success",
    warning: "bg-warning/15 text-warning",
    danger: "bg-error/15 text-error",
    primary: "bg-primary/15 text-primary",
  };
  return <span className={cx("inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium", styles[tone])}>{children}</span>;
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border bg-surface px-4 py-8 text-center">
      <p className="font-medium text-text">{title}</p>
      {hint && <p className="mt-1 text-sm text-text-muted">{hint}</p>}
    </div>
  );
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const { copied, copy } = useCopy();
  return (
    <Button variant="secondary" size="sm" onClick={() => void copy(text)}>
      {copied ? "Copied ✓" : label}
    </Button>
  );
}

export function Tabs({
  items,
  value,
  onChange,
  ariaLabel,
}: {
  items: { key: string; label: string }[];
  value: string;
  onChange: (key: string) => void;
  ariaLabel: string;
}) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="flex flex-wrap gap-1 border-b border-border">
      {items.map((item, i) => {
        const active = item.key === value;
        return (
          <button
            key={item.key}
            role="tab"
            id={`${ariaLabel}-tab-${item.key}`}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(item.key)}
            onKeyDown={(e) => {
              if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
              const next = items[(i + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length];
              onChange(next.key);
              document.getElementById(`${ariaLabel}-tab-${next.key}`)?.focus();
            }}
            className={cx(
              "relative min-h-11 cursor-pointer select-none rounded-md px-3 py-2 text-sm font-medium transition-all duration-fast ease-standard active:scale-[0.96]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40",
              active ? "text-primary" : "text-text-muted hover:bg-background/60 hover:text-text",
            )}
          >
            {item.label}
            <span
              aria-hidden
              className={cx(
                "absolute inset-x-2 -bottom-px h-0.5 bg-primary transition duration-normal ease-standard",
                active ? "opacity-100" : "opacity-0",
              )}
            />
          </button>
        );
      })}
    </div>
  );
}

/** Avatar button + dropdown panel (profile menu, settings menu). */
export function Menu({
  label,
  button,
  children,
  align = "end",
}: {
  label: string;
  button: ReactNode;
  children: ReactNode | ((close: () => void) => ReactNode);
  align?: "start" | "end";
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useDismiss<HTMLDivElement>(open, close);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={label}
        onClick={() => setOpen((v) => !v)}
        className="rounded-full transition duration-fast ease-standard focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary active:scale-[0.97]"
      >
        {button}
      </button>
      {open && (
        <div
          role="menu"
          aria-label={label}
          className={cx(
            "vf-pop absolute top-[calc(100%+8px)] z-dropdown min-w-56 rounded-lg border border-border bg-surface-elevated p-1.5 shadow-overlay",
            align === "end" ? "right-0" : "left-0",
          )}
        >
          {typeof children === "function" ? (children as (c: () => void) => ReactNode)(close) : children}
        </div>
      )}
    </div>
  );
}

export function MenuItem({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      className={cx(
        "flex min-h-11 w-full items-center gap-2 rounded-md px-3 py-2 text-left text-sm transition duration-fast ease-standard",
        "focus-visible:outline-2 focus-visible:outline-primary",
        danger ? "text-error hover:bg-error/10" : "text-text hover:bg-background",
      )}
    >
      {children}
    </button>
  );
}

export function Avatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }) {
  const initials = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? "")
    .join("");
  return (
    <span
      aria-hidden
      className={cx(
        "inline-flex items-center justify-center rounded-full bg-primary font-semibold text-primary-fg",
        size === "sm" ? "h-8 w-8 text-xs" : "h-10 w-10 text-sm",
      )}
    >
      {initials || "?"}
    </span>
  );
}

/** Centered dialog over a translucent backdrop. Escape / backdrop click closes. */
export function Modal({
  open,
  onClose,
  title,
  hint,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  hint?: string;
  children: ReactNode;
}) {
  const ref = useDismiss<HTMLDivElement>(open, onClose);
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-overlay flex items-end justify-center p-0 sm:items-center sm:p-6" role="presentation">
      {/* Translucent scrim — click anywhere outside the card to dismiss */}
      <button type="button" aria-label="Close dialog" onClick={onClose} className="absolute inset-0 bg-text/45 backdrop-blur-[2px]" />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="vf-pop relative max-h-[90vh] w-full max-w-md overflow-auto rounded-t-lg border border-border bg-surface-elevated p-5 shadow-overlay sm:rounded-lg"
      >
        <div className="flex items-start gap-3">
          <div>
            <h3 className="font-serif text-lg font-bold">{title}</h3>
            {hint && <p className="mt-0.5 text-sm text-text-muted">{hint}</p>}
          </div>
          <span className="ml-auto">
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">✕</Button>
          </span>
        </div>
        <div className="mt-4">{children}</div>
      </div>
    </div>
  );
}
