// Install-batch progress + compensation outcomes panel (cinatra #209 item 2,
// surfaces 2 & 3).
//
// Renders the REAL `extension_install_batches` ledger: per-member install
// progress (surface 2) and the batch compensation outcome — failed member,
// rolled-back members, incomplete-rollback members (surface 3). The data is
// read at the call site (`listRecentInstallBatches`) and shaped by
// `toMemberProgressRows` / `summarizeBatchOutcome`; this component is a pure
// presenter. Server component — shadcn primitives + semantic tokens only.

import Link from "next/link";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CircleCheck, Settings2, TriangleAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  summarizeBatchOutcome,
  toMemberProgressRows,
  type BatchOutcomeTone,
  type ConfigurationNeedsSummary,
  type MemberProgressTone,
} from "@/lib/extension-dependency-ux";
import type { InstallBatch } from "@/lib/extension-install-batch-ops";

/** Member progress tone → StatusPill status (shared status vocabulary). */
const MEMBER_TONE_PILL: Record<MemberProgressTone, StatusPillStatus> = {
  pending: "queued",
  active: "running",
  done: "approved",
  skipped: "idle",
  failed: "failed",
};

function BatchOutcomeAlert({ tone, headline }: { tone: BatchOutcomeTone; headline: string }) {
  if (tone === "active") {
    return (
      <Alert variant="info">
        <AlertTitle>{headline}</AlertTitle>
      </Alert>
    );
  }
  if (tone === "success") {
    return (
      <Alert variant="success">
        <CircleCheck />
        <AlertTitle>{headline}</AlertTitle>
      </Alert>
    );
  }
  if (tone === "compensated") {
    return (
      <Alert variant="warning">
        <TriangleAlert />
        <AlertTitle>{headline}</AlertTitle>
      </Alert>
    );
  }
  return (
    <Alert variant="destructive">
      <XCircle />
      <AlertTitle>{headline}</AlertTitle>
    </Alert>
  );
}

/**
 * Post-install "needs configuration" affordance (cinatra #1057; owner-review
 * rework #1234). Surfaces the installed connectors that are present but NOT yet
 * configured, each deep-linked to its own setup surface.
 *
 * DESIGN — this uses the app design system's **Callout** pattern in its info
 * variant (see docs.cinatra.ai/references/design), compiled here as the app's
 * `Alert variant="info"` — the SAME construct the batch-outcome headline one
 * row up already uses. The installed-extensions surface specifies no
 * post-install activity block, so the closest governing pattern (the info
 * Callout) is used deliberately: a tinted info ground, a hairline border, an
 * icon-led label, and body copy lifted out of the reading flow. Nothing
 * invented.
 *
 * NAME — each row leads with the connector's HUMAN-READABLE manifest
 * `displayName` (e.g. "LinkedIn"), exactly as the /connectors card grid and the
 * setup header render it; the package name is muted secondary text only, never
 * the primary label (owner review #1234).
 *
 * SEMANTICS — per the ratified readiness-chaining decision, each connector is
 * an INDEPENDENT row (the installed extension and every required connector
 * dependency surface separately, driven by each connector's own readiness
 * probe). Renders nothing when there is nothing to configure — install never
 * blocks on configuration.
 */
function ConfigurationNeedsBlock({ summary }: { summary: ConfigurationNeedsSummary }) {
  if (summary.needs.length === 0) return null;

  return (
    <Alert variant="info" data-testid="batch-configuration-needs">
      <Settings2 />
      <AlertTitle>Finish setting up these connectors</AlertTitle>
      <AlertDescription>
        <p>
          These connectors were installed, but each one still needs its settings before this
          extension can use it. Select <span className="font-medium text-foreground">Configure</span>{" "}
          to set one up.
        </p>
        <ul className="mt-2.5 flex flex-col gap-2">
          {summary.needs.map((need) => (
            <li
              key={need.packageName}
              className="flex items-center justify-between gap-3"
              data-testid="configuration-need-row"
            >
              <span className="flex min-w-0 flex-col">
                <span className="truncate text-sm font-medium text-foreground">
                  {need.displayName}
                </span>
                <code className="truncate font-mono text-xs text-muted-foreground">
                  {need.packageName}
                </code>
              </span>
              {need.settingsHref ? (
                <Button asChild size="sm" variant="outline" className="shrink-0">
                  <Link href={need.settingsHref} data-testid="configuration-need-link">
                    <Settings2 data-icon="inline-start" />
                    Configure
                  </Link>
                </Button>
              ) : (
                <span className="shrink-0 text-xs text-muted-foreground">
                  Set up in connector settings
                </span>
              )}
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}

/** One batch card: outcome headline, compensation detail, per-member progress. */
function InstallBatchCard({
  batch,
  configurationNeeds,
}: {
  batch: InstallBatch;
  configurationNeeds?: ConfigurationNeedsSummary;
}) {
  const outcome = summarizeBatchOutcome(batch);
  const rows = toMemberProgressRows(batch);

  return (
    <div
      className="soft-panel rounded-card px-5 py-4 flex flex-col gap-3"
      data-testid="install-batch-card"
      data-phase={outcome.phase}
    >
      <BatchOutcomeAlert tone={outcome.tone} headline={outcome.headline} />

      {/* Compensation outcomes (surface 3) — only when something was rolled
          back or a rollback failed. Reads the ledger's compensated /
          compensation-failed member sets directly. */}
      {(outcome.compensated.length > 0 || outcome.compensationFailed.length > 0) && (
        <div className="text-xs text-muted-foreground flex flex-col gap-1" data-testid="batch-compensation">
          {outcome.compensated.length > 0 && (
            <p>
              <span className="font-medium text-foreground">Rolled back:</span>{" "}
              {outcome.compensated.join(", ")}
            </p>
          )}
          {outcome.compensationFailed.length > 0 && (
            <p className="text-destructive">
              <span className="font-medium">Rollback incomplete (manual cleanup may be needed):</span>{" "}
              {outcome.compensationFailed.join(", ")}
            </p>
          )}
        </div>
      )}

      {/* Per-member install progress (surface 2) — ledger order is
          dependencies-first, root last. */}
      <ul className="flex flex-col gap-1.5">
        {rows.map((row) => (
          <li
            key={row.packageName}
            className="flex items-center gap-2 text-sm"
            data-testid="batch-member-row"
            data-status={row.status}
          >
            <StatusPill status={MEMBER_TONE_PILL[row.tone]}>{row.label}</StatusPill>
            <code className={cn("font-mono text-xs", row.isRoot ? "text-foreground font-semibold" : "text-muted-foreground")}>
              {row.packageName}
            </code>
            <span className="text-xs text-muted-foreground">v{row.version}</span>
            {row.isRoot && (
              <span className="text-[10px] uppercase tracking-kicker-wide text-muted-foreground">
                root
              </span>
            )}
            {row.detail && (
              <span className="text-xs text-destructive truncate" title={row.detail}>
                {row.detail}
              </span>
            )}
          </li>
        ))}
      </ul>

      {/* Post-install configuration follow-up (cinatra #1057) — the installed
          connectors that still need configuring, each deep-linked. Present
          only for a finalized batch that carries unconfigured connectors. */}
      {configurationNeeds && <ConfigurationNeedsBlock summary={configurationNeeds} />}
    </div>
  );
}

/**
 * The install-activity panel for the extensions admin view. Renders the most
 * recent install batches (any phase) so an operator can see per-member
 * progress and compensation outcomes from the durable ledger. Returns null
 * when there are no batches (a single-package install never wrote a ledger
 * row, so an instance that only ever installed depless extensions shows
 * nothing — no empty pane).
 *
 * `configurationNeedsByBatch` (cinatra #1057) carries, per finalized batch, the
 * connectors that installed but are not yet configured — resolved server-side
 * from each connector's own readiness probe and rendered as deep-linked
 * "Configure" affordances. Optional: omitting it simply renders no
 * configuration follow-up.
 */
export function InstallBatchPanel({
  batches,
  configurationNeedsByBatch,
}: {
  batches: InstallBatch[];
  configurationNeedsByBatch?: Record<string, ConfigurationNeedsSummary>;
}) {
  if (batches.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" data-testid="install-batch-panel">
      <h2 className="text-sm font-semibold text-foreground">Recent dependency installs</h2>
      <div className="flex flex-col gap-3">
        {batches.map((batch) => (
          <InstallBatchCard
            key={batch.batchId}
            batch={batch}
            configurationNeeds={configurationNeedsByBatch?.[batch.batchId]}
          />
        ))}
      </div>
    </section>
  );
}
