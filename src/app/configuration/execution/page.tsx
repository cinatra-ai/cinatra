import type { Metadata } from "next";

import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import { SettingsTabNav } from "@/components/settings-tab-nav";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { requireAdminSession } from "@/lib/auth-session";
import { readExecutionAuditRows } from "@/lib/execution/execution-audit-read";
import {
  getExecutionBrokerStatus,
  type ExecutionBrokerComposite,
} from "@/lib/execution/execution-broker-slot";
import {
  EXECUTION_PLANE_MODES,
  OPERABLE_EXECUTION_PLANE_MODES,
  isExecutionPlaneRolloutOn,
  readExecutionPlaneSettings,
  type ExecutionEgressMode,
  type ExecutionPlaneMode,
} from "@/lib/execution/execution-plane-settings";
import { resolveExecutionEnvironmentReadiness } from "@/lib/execution/environment-execution-service";
import { getExecutionServiceState } from "@/lib/execution/register-execution-environment-service";
import { SaveExecutionPlaneForm } from "@/app/configuration/execution/save-execution-plane-form";

export const metadata: Metadata = { title: "Execution" };

// The health tab runs a LIVE broker↔worker handshake, so it must never be
// served from a cache.
export const dynamic = "force-dynamic";

const TABS = [
  { value: "settings", label: "Settings" },
  { value: "health", label: "Health" },
];

const MODE_COPY: Record<
  ExecutionPlaneMode,
  { label: string; description: string }
> = {
  remote: {
    label: "Remote",
    description:
      "Sandbox commands run on a managed worker pool outside this app, reached over mutual TLS. This instance needs the broker's address, its service token and a client certificate before the mode can come up; until the broker and its worker both answer, nothing runs and the health tab says why.",
  },
  "local-dev": {
    label: "Local development",
    description:
      "Sandbox commands run in hardened containers on this host's Docker daemon: non-root, read-only root filesystem, all capabilities dropped, no host mounts, and all network egress through the attributing gateway.",
  },
  disabled: {
    label: "Disabled",
    description:
      "No broker, no worker, no sandbox capability. Models are told the capability is unavailable and continue without it.",
  },
};

const EGRESS_COPY: Record<
  ExecutionEgressMode,
  { label: string; description: string }
> = {
  default_internet: {
    label: "Internet, via the gateway",
    description:
      "Sandboxes can reach the internet so models can download and install tools — but only through the attributing gateway, never over a direct route.",
  },
  allowlist: {
    label: "Allowlist only",
    description:
      "The gateway serves only the hosts listed below and refuses everything else at the network layer.",
  },
  none: {
    label: "No network",
    description: "Sandboxes run with no network interface at all.",
  },
};

type Props = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export default async function ConfigurationExecutionPage({ searchParams }: Props) {
  const session = await requireAdminSession();
  const resolved = await (searchParams ?? Promise.resolve({} as Record<string, string | string[] | undefined>));
  const requested = (Array.isArray(resolved.tab) ? resolved.tab[0] : resolved.tab) ?? "settings";
  const tab = TABS.some((item) => item.value === requested) ? requested : "settings";

  const settings = readExecutionPlaneSettings();
  // An instance without the rollout flag is INERT by design: nothing is wired
  // and nothing would honor a setting change. Render read-only rather than
  // offering controls that quietly do nothing.
  const rolloutOn = isExecutionPlaneRolloutOn();

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Execution"
        description="Where the sandbox models run commands in lives, what it may reach on the network, and whether it is actually up."
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <SettingsTabNav tabs={TABS} activeTab={tab} />

        {tab === "settings" && <SettingsTab settings={settings} rolloutOn={rolloutOn} />}
        {tab === "health" && (
          <HealthTab orgId={session.session?.activeOrganizationId ?? null} />
        )}
      </PageContent>
    </Main>
  );
}

function SettingsTab({
  settings,
  rolloutOn,
}: {
  settings: ReturnType<typeof readExecutionPlaneSettings>;
  rolloutOn: boolean;
}) {
  return (
    <SaveExecutionPlaneForm className="flex flex-col gap-4">
      {!rolloutOn && (
        <div className="max-w-3xl rounded-control border border-line bg-surface-muted p-4 text-sm leading-6 text-muted-foreground">
          The execution plane is not enabled on this instance, so these settings are
          read-only and nothing runs sandbox commands. Turning it on for users is a
          separate, deliberate decision made outside this screen.
        </div>
      )}
      <Card className="max-w-3xl border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Execution mode</CardTitle>
          <CardDescription className="leading-6">
            Where sandbox commands run. The broker is wired at boot, so a mode change takes
            effect on the next instance restart.
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          <RadioGroup name="mode" defaultValue={settings.mode}>
            <FieldGroup>
              {EXECUTION_PLANE_MODES.map((mode) => {
                const operable = OPERABLE_EXECUTION_PLANE_MODES.includes(mode);
                return (
                  <Field key={mode} orientation="horizontal">
                    <RadioGroupItem
                      id={`mode-${mode}`}
                      value={mode}
                      disabled={!operable || !rolloutOn}
                    />
                    <FieldContent
                      className={operable ? undefined : "opacity-50"}
                    >
                      <FieldLabel htmlFor={`mode-${mode}`}>
                        {MODE_COPY[mode].label}
                        {operable ? null : " — not available yet"}
                      </FieldLabel>
                      <FieldDescription>{MODE_COPY[mode].description}</FieldDescription>
                    </FieldContent>
                  </Field>
                );
              })}
            </FieldGroup>
          </RadioGroup>
        </CardContent>
      </Card>

      <Card className="max-w-3xl border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Network reach</CardTitle>
          <CardDescription className="leading-6">
            What a running sandbox may reach. Enforced at the network layer, not by
            inspecting commands.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-6 pb-4">
          <RadioGroup name="egressMode" defaultValue={settings.egressMode}>
            <FieldGroup>
              {(Object.keys(EGRESS_COPY) as ExecutionEgressMode[]).map((mode) => (
                <Field key={mode} orientation="horizontal">
                  <RadioGroupItem id={`egress-${mode}`} value={mode} disabled={!rolloutOn} />
                  <FieldContent>
                    <FieldLabel htmlFor={`egress-${mode}`}>
                      {EGRESS_COPY[mode].label}
                    </FieldLabel>
                    <FieldDescription>{EGRESS_COPY[mode].description}</FieldDescription>
                  </FieldContent>
                </Field>
              ))}
            </FieldGroup>
          </RadioGroup>
          <Field>
            <FieldLabel htmlFor="egressAllowlist">Allowed hosts</FieldLabel>
            <Textarea
              id="egressAllowlist"
              name="egressAllowlist"
              rows={3}
              defaultValue={settings.egressAllowlist.join("\n")}
              placeholder={"pypi.org\nregistry.npmjs.org"}
              disabled={!rolloutOn}
            />
            <FieldDescription>
              One host per line. A host also covers its subdomains. Used only by the
              allowlist mode.
            </FieldDescription>
          </Field>
        </CardContent>
        <CardFooter>
          <Button
            type="submit"
            disabled={!rolloutOn}
            title={rolloutOn ? undefined : "The execution plane is not enabled on this instance"}
          >
            Save execution settings
          </Button>
        </CardFooter>
      </Card>
    </SaveExecutionPlaneForm>
  );
}

async function HealthTab({ orgId }: { orgId: string | null }) {
  const status = getExecutionBrokerStatus();
  // The REAL state, not a cached boot verdict: re-run the broker↔worker
  // handshake when the plane claims to be running.
  const liveness = status.probeLiveness ? await status.probeLiveness() : null;
  // Prefer the composite from THIS probe over the one the boot handshake
  // recorded: the rows below answer "what is true now", and a boot-time verdict
  // shown next to a live one would be the more convincing of the two lies. A
  // placement with no composite at all (local-dev) renders no rows rather than
  // rows that imply a check that never ran.
  const composite = liveness?.composite ?? status.composite ?? null;
  const readiness = resolveExecutionEnvironmentReadiness();
  const serviceState = getExecutionServiceState();
  const rows = readExecutionAuditRows({ orgId, limit: 25 });

  const brokerPill: StatusPillStatus =
    status.state === "running" ? (liveness?.ok ? "running" : "failed") : status.state === "unavailable" ? "failed" : "idle";
  const brokerLabel =
    status.state === "running"
      ? liveness?.ok
        ? "Running"
        : "Not responding"
      : status.state === "unavailable"
        ? "Unavailable"
        : "Not wired";

  return (
    <div className="flex flex-col gap-4">
      <Card className="max-w-3xl border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Broker and worker</CardTitle>
          <CardDescription className="leading-6">
            A running plane means a real command completed in a real container just now —
            this page re-runs that handshake every time it loads.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pb-4">
          <HealthRow label="Broker">
            <StatusPill status={brokerPill}>{brokerLabel}</StatusPill>
          </HealthRow>
          <HealthRow label="Mode">
            <span className="text-sm text-muted-foreground">
              {MODE_COPY[status.mode].label}
              {status.rolloutEnabled ? "" : " (rollout not enabled on this instance)"}
            </span>
          </HealthRow>
          <HealthRow label="Network reach">
            <span className="text-sm text-muted-foreground">
              {status.egressMode ? EGRESS_COPY[status.egressMode].label : "—"}
              {status.gateway
                ? ` · gateway ${status.gateway.containerName}:${status.gateway.proxyPort}`
                : ""}
            </span>
          </HealthRow>
          <HealthRow label="Last handshake">
            <span className="block text-sm break-all text-muted-foreground">
              {liveness
                ? liveness.detail
                : status.handshake
                  ? `Completed in ${status.handshake.wallMs} ms over image ${status.handshake.imageDigest}.`
                  : (status.detail ?? "No handshake has completed on this instance.")}
            </span>
          </HealthRow>
          {composite && (
            <>
              <HealthRow label="Worker">
                <SubsystemHealth health={composite.worker} />
              </HealthRow>
              <HealthRow label="Gateway">
                <SubsystemHealth health={composite.gateway} />
              </HealthRow>
              <HealthRow label="Host lease">
                <SubsystemHealth health={composite.lease} />
              </HealthRow>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="max-w-3xl border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Environment readiness</CardTitle>
          <CardDescription className="leading-6">
            Whether an agent that declares its own tools can have that environment built and
            mounted. Anything other than ready refuses such a run rather than quietly running
            it without the tools.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 pb-4">
          <HealthRow label="State">
            <StatusPill status={serviceState === "ready" ? "approved" : serviceState === "unavailable" ? "failed" : "idle"}>
              {serviceState}
            </StatusPill>
          </HealthRow>
          <HealthRow label="Detail">
            <span className="text-sm text-muted-foreground">
              {readiness.state === "ready"
                ? "A broker-backed executor is bound and layers can be built and mounted."
                : readiness.state === "disabled"
                  ? "This instance has not opted into the execution plane."
                  : readiness.reason}
            </span>
          </HealthRow>
        </CardContent>
      </Card>

      <Card className="max-w-5xl border-line bg-surface backdrop-blur-none">
        <CardHeader>
          <CardTitle>Recent sandbox activity</CardTitle>
          <CardDescription className="leading-6">
            One row per command the plane ran or refused. Event details only — never the
            command itself, never its output, never credentials, never the individual
            addresses it reached.
          </CardDescription>
        </CardHeader>
        <CardContent className="pb-4">
          {rows.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No sandbox commands have been recorded yet.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Surface</TableHead>
                  <TableHead>Run</TableHead>
                  <TableHead>Outcome</TableHead>
                  <TableHead>Network</TableHead>
                  <TableHead>Environment</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="whitespace-nowrap text-muted-foreground">
                      {row.createdAt.replace("T", " ").slice(0, 19)}
                    </TableCell>
                    <TableCell>{row.surface ?? "—"}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.runId ? row.runId.slice(0, 12) : "—"}
                    </TableCell>
                    <TableCell>
                      <StatusPill status={row.decision === "allowed" ? "approved" : "failed"}>
                        {row.decision === "allowed"
                          ? `exit ${row.exitCode ?? "?"}`
                          : (row.reason ?? "refused")}
                      </StatusPill>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.egressMode ?? "—"}
                      {row.egressTotalBytes !== null ? ` · ${row.egressTotalBytes} B` : ""}
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {row.imageDigest ? row.imageDigest.slice(0, 19) : "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * One composite sub-state. `not-applicable` renders as its own neutral pill, not
 * as a pass: an operator must be able to tell "checked and healthy" from "this
 * deployment has no such dependency" at a glance, because the two lead to very
 * different next steps when something is wrong.
 */
function SubsystemHealth({ health }: { health: ExecutionBrokerComposite["worker"] }) {
  const pill: StatusPillStatus =
    health.state === "ok" ? "running" : health.state === "unhealthy" ? "failed" : "idle";
  const label =
    health.state === "ok" ? "Healthy" : health.state === "unhealthy" ? "Unhealthy" : "Not used";
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-3">
      <StatusPill status={pill}>{label}</StatusPill>
      <span className="min-w-0 text-sm break-words text-muted-foreground">{health.detail}</span>
    </div>
  );
}

function HealthRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1 sm:flex-row sm:items-baseline sm:gap-4">
      <span className="w-40 shrink-0 text-sm font-medium">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
