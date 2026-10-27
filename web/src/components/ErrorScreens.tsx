import React, { Component, useState, type ReactNode } from "react";
import { Button, Badge, Card, useToast } from "./ui";
import { IconSpaces, IconChevronLeft, IconSearch, IconMarketplace } from "./icons";

// ------------------------------------------------------------------- 404 Screen

export function NotFoundScreen({
  onHome,
  onBack,
  onMarketplace,
}: {
  onHome?: () => void;
  onBack?: () => void;
  onMarketplace?: () => void;
}) {
  return (
    <div className="flex min-h-[calc(100vh-160px)] w-full flex-col items-center justify-center px-4 py-12 text-center">
      {/* Animated 404 Cosmic Beacon Illustration */}
      <div className="relative mb-8 flex items-center justify-center">
        {/* Ambient atmospheric glow */}
        <div
          aria-hidden="true"
          className="vf-pulse-glow absolute -inset-8 rounded-full bg-gradient-to-tr from-primary/30 via-emerald-500/20 to-amber-500/15 blur-2xl"
        />

        <svg
          width="280"
          height="220"
          viewBox="0 0 280 220"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="relative z-base overflow-visible select-none"
          aria-label="Lost in the void illustration"
        >
          <defs>
            {/* Hologram crystal gradients */}
            <linearGradient id="nf-crystal-top" x1="140" y1="45" x2="140" y2="75" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#8affea" />
              <stop offset="100%" stopColor="#2ea88f" />
            </linearGradient>
            <linearGradient id="nf-crystal-left" x1="110" y1="60" x2="140" y2="120" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#2ea88f" />
              <stop offset="100%" stopColor="#0a3a33" />
            </linearGradient>
            <linearGradient id="nf-crystal-right" x1="170" y1="60" x2="140" y2="120" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#5be3c7" />
              <stop offset="100%" stopColor="#104e44" />
            </linearGradient>
            <linearGradient id="nf-orbit" x1="50" y1="50" x2="230" y2="170" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#3dbfa4" stopOpacity="0.85" />
              <stop offset="50%" stopColor="#2ea88f" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#ffd166" stopOpacity="0.75" />
            </linearGradient>
            <linearGradient id="nf-amber" x1="140" y1="80" x2="140" y2="105" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#ffd166" />
              <stop offset="100%" stopColor="#f77f00" />
            </linearGradient>
            <radialGradient id="nf-glow" cx="140" cy="95" r="50" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#3dbfa4" stopOpacity="0.45" />
              <stop offset="100%" stopColor="#3dbfa4" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Radar sonar waves pulsing outward */}
          <circle cx="140" cy="95" r="45" fill="url(#nf-glow)" />
          <circle cx="140" cy="95" r="65" stroke="#3dbfa4" strokeWidth="1" strokeOpacity="0.3" strokeDasharray="4 6" className="vf-spin-slow" />
          <circle cx="140" cy="95" r="90" stroke="#ffd166" strokeWidth="1" strokeOpacity="0.25" strokeDasharray="3 9" className="vf-spin-reverse" />

          {/* Twinkling coordinate stars in background */}
          <circle cx="48" cy="42" r="1.5" fill="#8affea" className="vf-flicker" />
          <circle cx="232" cy="52" r="2" fill="#ffd166" className="vf-flicker" />
          <circle cx="72" cy="165" r="1.5" fill="#3dbfa4" opacity="0.6" />
          <circle cx="218" cy="148" r="1.5" fill="#8affea" className="vf-flicker" />
          <circle cx="180" cy="30" r="1" fill="#ffffff" opacity="0.5" />

          {/* Orbital rings */}
          <ellipse cx="140" cy="95" rx="84" ry="32" stroke="url(#nf-orbit)" strokeWidth="1.5" fill="none" strokeDasharray="12 8 4 8" className="vf-spin-slow" />
          <ellipse cx="140" cy="95" rx="72" ry="46" stroke="#2ea88f" strokeWidth="1.25" fill="none" strokeOpacity="0.4" strokeDasharray="6 6" className="vf-spin-reverse" />

          {/* Floating fractured crystal shards */}
          <g className="vf-float">
            {/* Shard 1 floating away */}
            <polygon points="98,58 108,52 105,68" fill="url(#nf-crystal-top)" opacity="0.75" />
            {/* Shard 2 floating away */}
            <polygon points="175,130 186,124 179,138" fill="url(#nf-crystal-right)" opacity="0.65" />
            {/* Shard 3 */}
            <polygon points="178,54 185,48 184,60" fill="url(#nf-amber)" opacity="0.8" />

            {/* Main faceted milestone crystal */}
            <g transform="translate(0, 0)">
              {/* Top facets */}
              <polygon points="140,55 166,70 140,84 114,70" fill="url(#nf-crystal-top)" />
              {/* Left facet */}
              <polygon points="114,70 140,84 140,126 114,108" fill="url(#nf-crystal-left)" />
              {/* Right facet */}
              <polygon points="166,70 140,84 140,126 166,108" fill="url(#nf-crystal-right)" />

              {/* Inner glowing ember void */}
              <polygon points="140,78 149,90 140,102 131,90" fill="url(#nf-amber)" />
              <circle cx="140" cy="90" r="2.5" fill="#ffffff" className="vf-pulse-glow" />

              {/* Holographic scanner line across crystal */}
              <line x1="110" y1="84" x2="170" y2="84" stroke="#8affea" strokeWidth="1.5" strokeDasharray="4 2" opacity="0.85" className="vf-flicker" />
            </g>
          </g>

          {/* Projected 404 hologram pedestal reflection */}
          <ellipse cx="140" cy="180" rx="55" ry="8" fill="#3dbfa4" opacity="0.15" className="vf-pulse-glow" />
          <ellipse cx="140" cy="180" rx="30" ry="4" fill="#ffd166" opacity="0.2" />
        </svg>
      </div>

      {/* Status Pill */}
      <div className="mb-3">
        <Badge tone="warning">SECTOR 404 // TRAJECTORY UNRESOLVED</Badge>
      </div>

      {/* Main Copy */}
      <h1 className="font-serif text-3xl font-bold tracking-tight sm:text-4xl text-text">
        Milestone Lost in the Void
      </h1>
      <p className="mt-2 max-w-md text-sm sm:text-base text-text-muted leading-relaxed">
        The coordinates you navigated to do not correspond to any known space, project, or milestone artifact. It may have drifted into the cosmos or been decommissioned.
      </p>

      {/* Action Buttons */}
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        {onHome && (
          <Button variant="primary" onClick={onHome} className="shadow-raised">
            <span className="flex items-center gap-2">
              <IconSpaces className="h-4 w-4" />
              Return to All Spaces
            </span>
          </Button>
        )}
        {onBack && (
          <Button variant="secondary" onClick={onBack}>
            <span className="flex items-center gap-1.5">
              <IconChevronLeft className="h-4 w-4" />
              Retrace Steps
            </span>
          </Button>
        )}
        {onMarketplace && (
          <Button variant="ghost" onClick={onMarketplace}>
            <span className="flex items-center gap-2">
              <IconMarketplace className="h-4 w-4" />
              Explore Marketplace
            </span>
          </Button>
        )}
      </div>

      {/* Quick Navigation Chips */}
      <div className="mt-10 border-t border-border pt-6 text-center">
        <p className="text-xs font-semibold uppercase tracking-wider text-text-muted mb-2.5">
          Or jump directly to
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {onHome && (
            <button
              type="button"
              onClick={onHome}
              className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-text-muted transition-all duration-fast hover:border-primary hover:text-primary active:scale-95 cursor-pointer"
            >
              /spaces
            </button>
          )}
          {onMarketplace && (
            <button
              type="button"
              onClick={onMarketplace}
              className="rounded-full border border-border bg-surface px-3 py-1 text-xs font-medium text-text-muted transition-all duration-fast hover:border-primary hover:text-primary active:scale-95 cursor-pointer"
            >
              /marketplace
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------- 500 Screen

export function ServerErrorScreen({
  error,
  resetError,
  onHome,
}: {
  error?: Error | string | null;
  resetError?: () => void;
  onHome?: () => void;
}) {
  const [showLogs, setShowLogs] = useState(false);
  const toast = useToast();

  const errorMessage = error instanceof Error ? error.message : typeof error === "string" ? error : "An unexpected server error occurred.";
  const errorStack = error instanceof Error ? error.stack : null;

  const copyReport = () => {
    const report = `VibeForge Incident Report\nError: ${errorMessage}\nTimestamp: ${new Date().toISOString()}\nPath: ${window.location.pathname}\nStack:\n${errorStack ?? "No stack trace available."}`;
    navigator.clipboard.writeText(report).then(() => {
      toast.success("Incident diagnostics copied to clipboard.");
    }).catch(() => {
      toast.info("Could not auto-copy diagnostics.");
    });
  };

  return (
    <div className="flex min-h-[calc(100vh-160px)] w-full flex-col items-center justify-center px-4 py-12 text-center">
      {/* Animated 500 Reactor Anomaly Illustration */}
      <div className="relative mb-8 flex items-center justify-center">
        {/* Core overload pulsing halo */}
        <div
          aria-hidden="true"
          className="vf-pulse-glow absolute -inset-8 rounded-full bg-gradient-to-tr from-error/35 via-amber-600/25 to-red-600/20 blur-2xl"
        />

        <svg
          width="280"
          height="220"
          viewBox="0 0 280 220"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
          className="relative z-base overflow-visible select-none"
          aria-label="Forge reactor anomaly illustration"
        >
          <defs>
            <linearGradient id="se-flame" x1="140" y1="40" x2="140" y2="150" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#ffd166" />
              <stop offset="50%" stopColor="#f77f00" />
              <stop offset="100%" stopColor="#e0655f" />
            </linearGradient>
            <linearGradient id="se-core" x1="140" y1="70" x2="140" y2="120" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#ffffff" />
              <stop offset="40%" stopColor="#ffd166" />
              <stop offset="100%" stopColor="#ff5436" />
            </linearGradient>
            <linearGradient id="se-hazard" x1="60" y1="95" x2="220" y2="95" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#ff5436" />
              <stop offset="50%" stopColor="#ffd166" />
              <stop offset="100%" stopColor="#ff5436" />
            </linearGradient>
            <radialGradient id="se-glow" cx="140" cy="95" r="60" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stopColor="#ff5436" stopOpacity="0.5" />
              <stop offset="60%" stopColor="#f77f00" stopOpacity="0.2" />
              <stop offset="100%" stopColor="#ff5436" stopOpacity="0" />
            </radialGradient>
          </defs>

          {/* Expanding thermal radiation ripples */}
          <circle cx="140" cy="95" r="50" fill="url(#se-glow)" className="vf-pulse-glow" />
          <circle cx="140" cy="95" r="75" stroke="#f77f00" strokeWidth="1.5" strokeDasharray="6 8" strokeOpacity="0.4" className="vf-spin-slow" />
          <circle cx="140" cy="95" r="95" stroke="#e0655f" strokeWidth="1.25" strokeDasharray="12 6 3 6" strokeOpacity="0.3" className="vf-spin-reverse" />

          {/* Electric energy arcs & sparks */}
          <path d="M78,60 L92,72 L86,88 L104,95" stroke="#ffd166" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" fill="none" className="vf-flicker" />
          <path d="M202,58 L188,74 L196,86 L178,98" stroke="#ff5436" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" fill="none" className="vf-flicker" />
          <circle cx="88" cy="80" r="2.5" fill="#ffd166" className="vf-pulse-glow" />
          <circle cx="192" cy="80" r="2.5" fill="#ff5436" className="vf-pulse-glow" />

          {/* Outer containment gear ring */}
          <g className="vf-spin-slow">
            <circle cx="140" cy="95" r="62" stroke="url(#se-hazard)" strokeWidth="2.5" strokeDasharray="14 10" fill="none" />
            {/* Gear teeth */}
            <rect x="137" y="27" width="6" height="8" rx="1" fill="#f77f00" />
            <rect x="137" y="155" width="6" height="8" rx="1" fill="#f77f00" />
            <rect x="72" y="92" width="8" height="6" rx="1" fill="#f77f00" />
            <rect x="200" y="92" width="8" height="6" rx="1" fill="#f77f00" />
          </g>

          {/* Counter-rotating inner magnetic field */}
          <g className="vf-spin-reverse">
            <ellipse cx="140" cy="95" rx="46" ry="24" stroke="#ffd166" strokeWidth="1.5" fill="none" strokeOpacity="0.75" />
            <ellipse cx="140" cy="95" rx="24" ry="46" stroke="#ff5436" strokeWidth="1.5" fill="none" strokeOpacity="0.75" />
          </g>

          {/* Central Reactor Core — melting milestone crystal */}
          <g className="vf-float">
            {/* Upper core shell */}
            <polygon points="140,60 162,74 140,88 118,74" fill="url(#se-flame)" />
            {/* Lower core facets */}
            <polygon points="118,74 140,88 140,125 118,108" fill="#8c1c13" opacity="0.9" />
            <polygon points="162,74 140,88 140,125 162,108" fill="#b3261e" opacity="0.95" />

            {/* Glowing critical plasma heart */}
            <circle cx="140" cy="92" r="14" fill="url(#se-core)" className="vf-pulse-glow" />
            <circle cx="140" cy="92" r="6" fill="#ffffff" />

            {/* Crackling fissure across core */}
            <path d="M128,80 L136,88 L133,96 L144,102 L141,114" stroke="#ffffff" strokeWidth="1.75" strokeLinecap="round" fill="none" className="vf-flicker" />
          </g>

          {/* Baseline thermal puddle */}
          <ellipse cx="140" cy="182" rx="55" ry="7" fill="#e0655f" opacity="0.2" className="vf-pulse-glow" />
        </svg>
      </div>

      {/* Incident Status Pill */}
      <div className="mb-3">
        <Badge tone="danger">SYSTEM 500 // FORGE CORE ANOMALY</Badge>
      </div>

      {/* Main Copy */}
      <h1 className="font-serif text-3xl font-bold tracking-tight sm:text-4xl text-text">
        Forge Reactor Anomaly
      </h1>
      <p className="mt-2 max-w-md text-sm sm:text-base text-text-muted leading-relaxed">
        An unhandled disruption caused the milestone forge reactor to halt. Automated containment protocols have safely isolated the incident.
      </p>

      {/* Action Buttons */}
      <div className="mt-7 flex flex-wrap items-center justify-center gap-3">
        <Button
          variant="primary"
          onClick={() => {
            if (resetError) resetError();
            else window.location.reload();
          }}
          className="shadow-raised"
        >
          <span className="flex items-center gap-2">
            Reboot Forge Core
          </span>
        </Button>
        {onHome && (
          <Button variant="secondary" onClick={onHome}>
            <span className="flex items-center gap-2">
              <IconSpaces className="h-4 w-4" />
              Evacuate to Spaces
            </span>
          </Button>
        )}
        <Button variant="ghost" onClick={() => setShowLogs((v) => !v)}>
          {showLogs ? "Hide Diagnostics ▴" : "Show Diagnostics ▾"}
        </Button>
      </div>

      {/* Collapsible Diagnostics Terminal */}
      {showLogs && (
        <Card className="mt-6 w-full max-w-xl p-4 text-left shadow-overlay animate-in fade-in zoom-in-95 duration-fast">
          <div className="flex items-center justify-between border-b border-border pb-2.5">
            <div className="flex items-center gap-2">
              <span className="h-2.5 w-2.5 rounded-full bg-error" />
              <span className="font-mono text-xs font-semibold text-text">CORE_DIAGNOSTICS_DUMP</span>
            </div>
            <Button variant="ghost" size="sm" onClick={copyReport}>
              Copy Report
            </Button>
          </div>
          <pre className="mt-3 max-h-48 overflow-x-auto overflow-y-auto rounded-md bg-background/90 p-3 font-mono text-xs text-text-muted leading-relaxed">
            <code>
              {`[TIMESTAMP] ${new Date().toISOString()}\n`}
              {`[ROUTE]     ${window.location.pathname}\n`}
              {`[ERROR]     ${errorMessage}\n`}
              {errorStack ? `\n[STACK TRACE]\n${errorStack}` : ""}
            </code>
          </pre>
        </Card>
      )}
    </div>
  );
}

// ------------------------------------------------------------------- React ErrorBoundary

interface ErrorBoundaryProps {
  children: ReactNode;
  onHome?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    console.error("ErrorBoundary caught an unhandled exception:", error, errorInfo);
  }

  render() {
    if (this.state.hasError) {
      return (
        <ServerErrorScreen
          error={this.state.error}
          resetError={() => this.setState({ hasError: false, error: null })}
          onHome={this.props.onHome}
        />
      );
    }
    return this.props.children;
  }
}
