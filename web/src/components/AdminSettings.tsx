import { useState, useEffect, type ReactNode } from "react";
import { api } from "../lib/api";
import {
  Button,
  Input,
  Select,
  Toggle,
  Card,
  Badge,
  Skeleton,
  useToast,
} from "./ui";
import {
  IconUploadCloud,
  IconKey,
  IconSliders,
  IconBell,
  IconLock,
} from "./icons";

export type AdminSettingsTab =
  | "upload"
  | "access"
  | "policy"
  | "notifications"
  | "sso";

interface AdminSettingsProps {
  tab: AdminSettingsTab;
  settings: Record<string, unknown> | null;
  onUpdate: () => Promise<void>;
}

// ----------------------------------------------------------------- UI Helpers

function SettingSectionCard({
  title,
  description,
  icon,
  badge,
  children,
}: {
  title: string;
  description?: string;
  icon?: ReactNode;
  badge?: string;
  children: ReactNode;
}) {
  return (
    <Card className="p-5 shadow-surface border-border/80 bg-surface">
      <div className="flex items-start justify-between gap-3 border-b border-border/60 pb-3.5">
        <div className="flex items-center gap-2.5">
          {icon && (
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/15 text-primary">
              {icon}
            </span>
          )}
          <div>
            <div className="flex items-center gap-2">
              <h3 className="font-serif text-base font-bold text-text">{title}</h3>
              {badge && <Badge tone="primary">{badge}</Badge>}
            </div>
            {description && <p className="mt-0.5 text-xs text-text-muted">{description}</p>}
          </div>
        </div>
      </div>
      <div className="mt-4 space-y-3">{children}</div>
    </Card>
  );
}

function SettingRow({
  label,
  description,
  configKey,
  children,
}: {
  label: string;
  description?: string;
  configKey: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/60 bg-background/50 p-3 transition-colors hover:border-border sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-text">{label}</span>
          <span className="rounded bg-surface px-1.5 py-0.5 font-mono text-[10px] text-text-muted border border-border/60">
            {configKey}
          </span>
        </div>
        {description && <p className="mt-1 text-xs text-text-muted leading-relaxed">{description}</p>}
      </div>
      <div className="shrink-0 sm:w-64">{children}</div>
    </div>
  );
}

function UnitInput({
  value,
  onChange,
  unit,
  min = 0,
  max,
  step = 1,
  ariaLabel,
}: {
  value: number;
  onChange: (val: number) => void;
  unit: string;
  min?: number;
  max?: number;
  step?: number;
  ariaLabel?: string;
}) {
  return (
    <div className="relative flex items-center">
      <Input
        type="number"
        value={Number.isFinite(value) ? value : ""}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = parseFloat(e.target.value);
          onChange(isNaN(v) ? 0 : v);
        }}
        aria-label={ariaLabel}
        className="pr-14 text-right font-mono"
      />
      <span className="pointer-events-none absolute right-3 select-none text-xs font-semibold text-text-muted">
        {unit}
      </span>
    </div>
  );
}

function SecretInput({
  value,
  onChange,
  placeholder,
  ariaLabel,
}: {
  value: string;
  onChange: (val: string) => void;
  placeholder?: string;
  ariaLabel?: string;
}) {
  const [show, setShow] = useState(false);
  const isSealed = value === "********";
  return (
    <div className="relative flex items-center">
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className="pr-20 font-mono text-xs"
      />
      <div className="absolute right-1.5 flex items-center gap-1.5">
        {isSealed && (
          <span
            title="Encrypted with platform master key"
            className="rounded bg-primary/20 px-1.5 py-0.5 text-[9px] font-bold text-primary tracking-wide"
          >
            SEALED
          </span>
        )}
        <button
          type="button"
          onClick={() => setShow((v) => !v)}
          className="rounded px-1.5 py-0.5 text-[11px] font-medium text-text-muted hover:bg-background hover:text-text cursor-pointer transition-colors"
        >
          {show ? "Hide" : "Show"}
        </button>
      </div>
    </div>
  );
}

function SettingsActionBar({
  title,
  dirty,
  busy,
  onSave,
  onDiscard,
}: {
  title: string;
  dirty: boolean;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
}) {
  return (
    <div className="sticky bottom-4 z-sticky mt-6 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-surface-elevated/95 p-3.5 shadow-raised backdrop-blur">
      <div className="flex items-center gap-2">
        <span
          className={`h-2.5 w-2.5 rounded-full transition-colors ${
            dirty ? "bg-amber-400 animate-pulse" : "bg-primary"
          }`}
        />
        <span className="text-xs text-text-muted">
          {dirty ? (
            <span className="font-medium text-text">Unsaved modifications in {title}</span>
          ) : (
            "All settings synchronized & sealed"
          )}
        </span>
      </div>
      <div className="flex items-center gap-2">
        {dirty && (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={onDiscard}
            disabled={busy}
          >
            Discard
          </Button>
        )}
        <Button
          type="button"
          size="sm"
          busy={busy}
          onClick={onSave}
          className="shadow-raised font-semibold"
        >
          Save {title}
        </Button>
      </div>
    </div>
  );
}

// ----------------------------------------------------------- Main Component

export function AdminSettings({ tab, settings, onUpdate }: AdminSettingsProps) {
  const [draft, setDraft] = useState<Record<string, unknown> | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  useEffect(() => {
    if (settings) {
      setDraft({ ...settings });
    }
  }, [settings]);

  if (!draft) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-44 w-full" />
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  const setField = (key: string, val: unknown) => {
    setDraft((prev) => (prev ? { ...prev, [key]: val } : prev));
  };

  const isDirty = () => {
    if (!settings || !draft) return false;
    return Object.keys(draft).some((k) => draft[k] !== settings[k]);
  };

  const handleSave = async (tabName: string) => {
    if (!draft) return;
    setBusy(true);
    try {
      await api.putSettings(draft);
      await onUpdate();
      toast.success(`${tabName} saved successfully.`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to update settings.");
    } finally {
      setBusy(false);
    }
  };

  const handleDiscard = () => {
    if (settings) {
      setDraft({ ...settings });
      toast.info("Changes discarded.");
    }
  };

  return (
    <div className="space-y-6">
      {/* -------------------- 1. UPLOAD & SCANNING -------------------- */}
      {tab === "upload" && (
        <>
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-fg shadow-xs">
                <IconUploadCloud />
              </span>
              <div>
                <h3 className="font-serif text-lg font-bold text-text">Upload & Security Scanning</h3>
                <p className="text-xs text-text-muted mt-0.5">
                  Decompression safeguards, zip-bomb defense ratios, ClamAV antivirus daemon, and OSV vulnerability lookups.
                </p>
              </div>
            </div>
          </div>

          <SettingSectionCard
            title="Archive Limits & Zip-Bomb Mitigation"
            description="Protect the engine from memory exhaustion, disk fill attacks, and recursive archive bombs."
          >
            <SettingRow
              label="Max Compressed Archive"
              configKey="max_compressed_mb"
              description="Maximum payload size accepted on project push via HTTP."
            >
              <UnitInput
                value={Number(draft.max_compressed_mb) || 0}
                onChange={(v) => setField("max_compressed_mb", v)}
                unit="MB"
                min={1}
                max={5000}
                ariaLabel="Max compressed archive size in megabytes"
              />
            </SettingRow>

            <SettingRow
              label="Max Extracted Volume"
              configKey="max_uncompressed_mb"
              description="Maximum cumulative uncompressed file content permitted during zip extraction."
            >
              <UnitInput
                value={Number(draft.max_uncompressed_mb) || 0}
                onChange={(v) => setField("max_uncompressed_mb", v)}
                unit="MB"
                min={1}
                max={20000}
                ariaLabel="Max uncompressed volume in megabytes"
              />
            </SettingRow>

            <SettingRow
              label="Max Individual File"
              configKey="max_file_mb"
              description="Maximum allowed size of any single extracted source or binary file."
            >
              <UnitInput
                value={Number(draft.max_file_mb) || 0}
                onChange={(v) => setField("max_file_mb", v)}
                unit="MB"
                min={1}
                max={2000}
                ariaLabel="Max single file size in megabytes"
              />
            </SettingRow>

            <SettingRow
              label="Max Archive Entries"
              configKey="max_entries"
              description="Maximum number of file entries permitted inside a milestone zip."
            >
              <UnitInput
                value={Number(draft.max_entries) || 0}
                onChange={(v) => setField("max_entries", v)}
                unit="files"
                min={100}
                max={500000}
                step={500}
                ariaLabel="Max archive entries count"
              />
            </SettingRow>

            <SettingRow
              label="Max Compression Ratio"
              configKey="max_ratio"
              description="Abort extraction if uncompressed / compressed ratio exceeds this factor (zip-bomb defense)."
            >
              <UnitInput
                value={Number(draft.max_ratio) || 0}
                onChange={(v) => setField("max_ratio", v)}
                unit=": 1"
                min={2}
                max={1000}
                step={5}
                ariaLabel="Max compression ratio factor"
              />
            </SettingRow>
          </SettingSectionCard>

          <SettingSectionCard
            title="Vulnerability Scanner & OSV Integration"
            description="Open Source Vulnerabilities (OSV) query thresholds and push gating."
          >
            <div className="rounded-lg border border-border/60 bg-background/50 p-3.5">
              <Toggle
                id="block-push-critical"
                label="Block Pushes on Critical CVEs"
                description="Immediately reject git/zip pushes if critical severity (CVSS 9.0+) CVE findings are identified."
                checked={Boolean(draft.block_push_on_critical)}
                onChange={(val) => setField("block_push_on_critical", val)}
              />
            </div>

            <div className="rounded-lg border border-border/60 bg-background/50 p-3.5">
              <Toggle
                id="unused-dep-check"
                label="Flag Unused Dependencies"
                description="Inspect package manifests for declared dependencies that are never referenced in source code."
                checked={Boolean(draft.unused_dep_check)}
                onChange={(val) => setField("unused_dep_check", val)}
              />
            </div>

            <SettingRow
              label="OSV Query Timeout"
              configKey="osv_timeout_s"
              description="Max seconds to wait for responses from the OSV advisory database."
            >
              <UnitInput
                value={Number(draft.osv_timeout_s) || 0}
                onChange={(v) => setField("osv_timeout_s", v)}
                unit="sec"
                min={5}
                max={120}
                ariaLabel="OSV query timeout in seconds"
              />
            </SettingRow>

            <SettingRow
              label="Advisory Cache TTL"
              configKey="osv_cache_hours"
              description="How many hours to retain cached vulnerability definitions before refreshing."
            >
              <UnitInput
                value={Number(draft.osv_cache_hours) || 0}
                onChange={(v) => setField("osv_cache_hours", v)}
                unit="hours"
                min={1}
                max={168}
                ariaLabel="OSV cache hours"
              />
            </SettingRow>
          </SettingSectionCard>

          <SettingSectionCard
            title="Antivirus Daemon (ClamAV)"
            description="Inspect uploaded blobs and assets for viruses and malicious payloads."
          >
            <SettingRow
              label="ClamAV Host"
              configKey="clamd_host"
              description="TCP endpoint (host:port) of the clamd scanning daemon service."
            >
              <Input
                value={String(draft.clamd_host || "")}
                onChange={(e) => setField("clamd_host", e.target.value)}
                placeholder="clamav:3310"
                aria-label="ClamAV daemon host"
                className="font-mono text-xs"
              />
            </SettingRow>

            <SettingRow
              label="Scan Timeout"
              configKey="scan_timeout_s"
              description="Maximum execution time allowed for virus scan before timing out."
            >
              <UnitInput
                value={Number(draft.scan_timeout_s) || 0}
                onChange={(v) => setField("scan_timeout_s", v)}
                unit="sec"
                min={5}
                max={300}
                ariaLabel="Scan timeout in seconds"
              />
            </SettingRow>
          </SettingSectionCard>

          <SettingsActionBar
            title="Upload & Scanning"
            dirty={isDirty()}
            busy={busy}
            onSave={() => handleSave("Upload & Scanning Settings")}
            onDiscard={handleDiscard}
          />
        </>
      )}

      {/* -------------------- 2. ACCESS & TOKENS -------------------- */}
      {tab === "access" && (
        <>
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-fg shadow-xs">
                <IconKey />
              </span>
              <div>
                <h3 className="font-serif text-lg font-bold text-text">Access Control & API Tokens</h3>
                <p className="text-xs text-text-muted mt-0.5">
                  Configure browser session expiration, personal access token quotas, and open user registration.
                </p>
              </div>
            </div>
          </div>

          <SettingSectionCard
            title="Registration & Authentication"
            description="User onboarding rules and interactive session lifetime."
          >
            <div className="rounded-lg border border-border/60 bg-background/50 p-3.5">
              <Toggle
                id="allow-registration"
                label="Open Self-Registration"
                description="Allow new users to sign up without requiring an administrator invitation."
                checked={Boolean(draft.allow_registration)}
                onChange={(val) => setField("allow_registration", val)}
              />
            </div>

            <SettingRow
              label="Web Session Duration"
              configKey="session_hours"
              description="Hours before browser session credentials expire and re-login is required."
            >
              <UnitInput
                value={Number(draft.session_hours) || 0}
                onChange={(v) => setField("session_hours", v)}
                unit="hours"
                min={1}
                max={720}
                ariaLabel="Session duration in hours"
              />
            </SettingRow>
          </SettingSectionCard>

          <SettingSectionCard
            title="Personal Access Tokens (PATs)"
            description="Governance rules for automated API, CI/CD, and CLI access tokens."
          >
            <SettingRow
              label="Default Token TTL"
              configKey="token_default_ttl_days"
              description="Default validity period assigned when users generate new personal access tokens."
            >
              <UnitInput
                value={Number(draft.token_default_ttl_days) || 0}
                onChange={(v) => setField("token_default_ttl_days", v)}
                unit="days"
                min={1}
                max={365}
                ariaLabel="Default token TTL in days"
              />
            </SettingRow>

            <SettingRow
              label="Max Active Tokens"
              configKey="max_active_tokens_per_user"
              description="Upper bound of active, non-expired personal API tokens per user account."
            >
              <UnitInput
                value={Number(draft.max_active_tokens_per_user) || 0}
                onChange={(v) => setField("max_active_tokens_per_user", v)}
                unit="tokens"
                min={1}
                max={100}
                ariaLabel="Max active tokens per user"
              />
            </SettingRow>
          </SettingSectionCard>

          <SettingsActionBar
            title="Access & Tokens"
            dirty={isDirty()}
            busy={busy}
            onSave={() => handleSave("Access & Token Settings")}
            onDiscard={handleDiscard}
          />
        </>
      )}

      {/* -------------------- 3. POLICY & QUOTAS -------------------- */}
      {tab === "policy" && (
        <>
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-fg shadow-xs">
                <IconSliders />
              </span>
              <div>
                <h3 className="font-serif text-lg font-bold text-text">Governance Policies & Space Quotas</h3>
                <p className="text-xs text-text-muted mt-0.5">
                  Push security gates, software license blocklists, remediation SLAs, and space limits.
                </p>
              </div>
            </div>
          </div>

          <SettingSectionCard
            title="Push Gating & Remediation SLAs"
            description="Automated security policies enforced during milestone ingestion."
          >
            <SettingRow
              label="Block Push Severity Gate"
              configKey="block_severity"
              description="Pushes containing open findings at or above this severity level will be blocked."
            >
              <Select
                value={String(draft.block_severity || "none")}
                onChange={(e) => setField("block_severity", e.target.value)}
                aria-label="Push block severity gate"
              >
                <option value="none">None (Never block pushes)</option>
                <option value="low">Low (Block Low, Medium, High & Critical)</option>
                <option value="medium">Medium (Block Medium, High & Critical)</option>
                <option value="high">High (Block High & Critical)</option>
                <option value="critical">Critical (Block Critical Only)</option>
              </Select>
            </SettingRow>

            <SettingRow
              label="Vulnerability Fix SLA"
              configKey="fix_sla_days"
              description="Grace period in days given to project owners before findings are flagged as overdue."
            >
              <UnitInput
                value={Number(draft.fix_sla_days) || 0}
                onChange={(v) => setField("fix_sla_days", v)}
                unit="days"
                min={1}
                max={180}
                ariaLabel="Fix SLA in days"
              />
            </SettingRow>
          </SettingSectionCard>

          <SettingSectionCard
            title="License Compliance Blocklist"
            description="Prevent copyleft or non-commercial license contamination across projects."
          >
            <div className="rounded-lg border border-border/60 bg-background/50 p-3.5 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-sm font-semibold text-text">Prohibited SPDX Licenses</span>
                <span className="font-mono text-[10px] text-text-muted">license_blocklist</span>
              </div>
              <p className="text-xs text-text-muted">
                Comma-separated list of SPDX identifiers. Any milestone with matching dependency licenses will fail compliance audit.
              </p>
              <Input
                value={String(draft.license_blocklist || "")}
                onChange={(e) => setField("license_blocklist", e.target.value)}
                placeholder="GPL-3.0-only, AGPL-3.0-only, SSPL-1.0"
                aria-label="License blocklist SPDX IDs"
                className="font-mono text-xs"
              />
              <div className="flex flex-wrap gap-1.5 pt-1">
                {String(draft.license_blocklist || "")
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
                  .map((lic) => (
                    <span
                      key={lic}
                      className="inline-flex items-center gap-1 rounded bg-danger/10 px-2 py-0.5 font-mono text-[11px] font-semibold text-danger border border-danger/20"
                    >
                      ✕ {lic}
                    </span>
                  ))}
              </div>
            </div>
          </SettingSectionCard>

          <SettingSectionCard
            title="Space Resource Quotas"
            description="Set multi-tenant storage and member boundaries. (Set 0 for unlimited)"
          >
            <SettingRow
              label="Space Storage Quota"
              configKey="space_quota_mb"
              description="Maximum disk capacity allocated per space for milestones, artifacts, and blobs."
            >
              <UnitInput
                value={Number(draft.space_quota_mb) || 0}
                onChange={(v) => setField("space_quota_mb", v)}
                unit="MB"
                min={0}
                max={1000000}
                step={512}
                ariaLabel="Space quota in megabytes"
              />
            </SettingRow>

            <SettingRow
              label="Space Member Quota"
              configKey="space_member_quota"
              description="Maximum number of collaborators that can be invited into a single space."
            >
              <UnitInput
                value={Number(draft.space_member_quota) || 0}
                onChange={(v) => setField("space_member_quota", v)}
                unit="members"
                min={0}
                max={5000}
                step={5}
                ariaLabel="Space member quota"
              />
            </SettingRow>
          </SettingSectionCard>

          <SettingsActionBar
            title="Policy & Quotas"
            dirty={isDirty()}
            busy={busy}
            onSave={() => handleSave("Policy & Quota Settings")}
            onDiscard={handleDiscard}
          />
        </>
      )}

      {/* -------------------- 4. NOTIFICATIONS -------------------- */}
      {tab === "notifications" && (
        <>
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-fg shadow-xs">
                <IconBell />
              </span>
              <div>
                <h3 className="font-serif text-lg font-bold text-text">Notifications & Alerting</h3>
                <p className="text-xs text-text-muted mt-0.5">
                  Configure outgoing security incident webhooks and SMTP email credentials.
                </p>
              </div>
            </div>
          </div>

          <SettingSectionCard
            title="Security Webhook"
            description="Real-time incident dispatch to Slack, Microsoft Teams, Discord, or SIEM endpoints."
          >
            <SettingRow
              label="Webhook Endpoint URL"
              configKey="webhook_url"
              description="Receives automated JSON POST payloads on High or Critical milestone findings."
            >
              <Input
                type="url"
                value={String(draft.webhook_url || "")}
                onChange={(e) => setField("webhook_url", e.target.value)}
                placeholder="https://hooks.slack.com/services/..."
                aria-label="Security webhook URL"
                className="font-mono text-xs"
              />
            </SettingRow>
          </SettingSectionCard>

          <SettingSectionCard
            title="Outgoing SMTP Email Server"
            description="Deliver automated security advisories, user invitations, and SLA warning notifications."
          >
            <SettingRow
              label="SMTP Server Host"
              configKey="smtp_host"
              description="Hostname or IP address of your mail transfer agent."
            >
              <Input
                value={String(draft.smtp_host || "")}
                onChange={(e) => setField("smtp_host", e.target.value)}
                placeholder="smtp.mailgun.org"
                aria-label="SMTP Host"
                className="font-mono text-xs"
              />
            </SettingRow>

            <SettingRow
              label="SMTP Port"
              configKey="smtp_port"
              description="Port number (typically 587 for STARTTLS or 465 for SSL/TLS)."
            >
              <UnitInput
                value={Number(draft.smtp_port) || 0}
                onChange={(v) => setField("smtp_port", v)}
                unit="port"
                min={1}
                max={65535}
                ariaLabel="SMTP Port"
              />
            </SettingRow>

            <SettingRow
              label="Sender 'From' Address"
              configKey="smtp_from"
              description="Email address displayed in the 'From' header of outgoing messages."
            >
              <Input
                type="email"
                value={String(draft.smtp_from || "")}
                onChange={(e) => setField("smtp_from", e.target.value)}
                placeholder="alerts@vibeforge.internal"
                aria-label="SMTP From Address"
                className="font-mono text-xs"
              />
            </SettingRow>

            <SettingRow
              label="SMTP Username"
              configKey="smtp_user"
              description="Authentication username for the mail server."
            >
              <Input
                value={String(draft.smtp_user || "")}
                onChange={(e) => setField("smtp_user", e.target.value)}
                placeholder="smtp-user"
                aria-label="SMTP Username"
                className="font-mono text-xs"
              />
            </SettingRow>

            <SettingRow
              label="SMTP Password"
              configKey="smtp_password"
              description="Authentication credential (stored sealed with AES encryption)."
            >
              <SecretInput
                value={String(draft.smtp_password || "")}
                onChange={(val) => setField("smtp_password", val)}
                placeholder="SMTP Secret Key"
                ariaLabel="SMTP Password"
              />
            </SettingRow>
          </SettingSectionCard>

          <SettingsActionBar
            title="Notifications"
            dirty={isDirty()}
            busy={busy}
            onSave={() => handleSave("Notification Settings")}
            onDiscard={handleDiscard}
          />
        </>
      )}

      {/* -------------------- 5. SSO & SCIM -------------------- */}
      {tab === "sso" && (
        <>
          <div className="rounded-xl border border-primary/20 bg-primary/5 p-4 sm:p-5">
            <div className="flex items-center gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-primary text-primary-fg shadow-xs">
                <IconLock />
              </span>
              <div>
                <h3 className="font-serif text-lg font-bold text-text">Single Sign-On (SSO) & SCIM</h3>
                <p className="text-xs text-text-muted mt-0.5">
                  Enterprise identity provider federation with OpenID Connect (OIDC) and automated SCIM v2 user provisioning.
                </p>
              </div>
            </div>
          </div>

          <SettingSectionCard
            title="Public Base URL"
            description="Canonical platform endpoint used to construct OAuth redirect URIs and deep links."
          >
            <SettingRow
              label="Public Base URL"
              configKey="public_base_url"
              description="Scheme + domain + optional port reachable by end users and identity providers."
            >
              <Input
                type="url"
                value={String(draft.public_base_url || "")}
                onChange={(e) => setField("public_base_url", e.target.value)}
                placeholder="https://forge.internal.company.com"
                aria-label="Public base URL"
                className="font-mono text-xs"
              />
            </SettingRow>
          </SettingSectionCard>

          <SettingSectionCard
            title="OpenID Connect (OIDC) Integration"
            description="Delegate authentication to Okta, Microsoft Entra ID, Google Workspace, or Keycloak."
          >
            <SettingRow
              label="OIDC Issuer URL"
              configKey="oidc_issuer"
              description="Authority endpoint that hosts .well-known/openid-configuration."
            >
              <Input
                type="url"
                value={String(draft.oidc_issuer || "")}
                onChange={(e) => setField("oidc_issuer", e.target.value)}
                placeholder="https://accounts.google.com"
                aria-label="OIDC Issuer URL"
                className="font-mono text-xs"
              />
            </SettingRow>

            <SettingRow
              label="OIDC Client ID"
              configKey="oidc_client_id"
              description="Application identifier registered in your identity provider portal."
            >
              <Input
                value={String(draft.oidc_client_id || "")}
                onChange={(e) => setField("oidc_client_id", e.target.value)}
                placeholder="vibeforge-app-id"
                aria-label="OIDC Client ID"
                className="font-mono text-xs"
              />
            </SettingRow>

            <SettingRow
              label="OIDC Client Secret"
              configKey="oidc_client_secret"
              description="Confidential client secret shared with your IdP (encrypted at rest)."
            >
              <SecretInput
                value={String(draft.oidc_client_secret || "")}
                onChange={(val) => setField("oidc_client_secret", val)}
                placeholder="Client secret string"
                ariaLabel="OIDC Client Secret"
              />
            </SettingRow>
          </SettingSectionCard>

          <SettingSectionCard
            title="SCIM v2 Automated Provisioning"
            description="Synchronize directory users and group assignments directly from your identity provider."
          >
            <SettingRow
              label="SCIM Bearer Token"
              configKey="scim_token"
              description="Static bearer token used by the IdP SCIM client to authenticate against /api/v1/scim/v2."
            >
              <SecretInput
                value={String(draft.scim_token || "")}
                onChange={(val) => setField("scim_token", val)}
                placeholder="Bearer token string"
                ariaLabel="SCIM Provisioning Token"
              />
            </SettingRow>
          </SettingSectionCard>

          <SettingsActionBar
            title="SSO & SCIM"
            dirty={isDirty()}
            busy={busy}
            onSave={() => handleSave("SSO & SCIM Settings")}
            onDiscard={handleDiscard}
          />
        </>
      )}
    </div>
  );
}
