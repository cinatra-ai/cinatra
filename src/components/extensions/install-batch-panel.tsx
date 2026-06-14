// Install-batch progress + compensation outcomes panel (cinatra #209 item 2,
// surfaces 2 & 3).
//
// Renders the REAL `extension_install_batches` ledger: per-member install
// progress (surface 2) and the batch compensation outcome — failed member,
// rolled-back members, incomplete-rollback members (surface 3). The data is
// read at the call site (`listRecentInstallBatches`) and shaped by
// `toMemberProgressRows` / `summarizeBatchOutcome`; this component is a pure
// presenter. Server component — shadcn primitives + semantic tokens only.

import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import { Alert, AlertTitle } from "@/components/ui/alert";
import { CircleCheck, TriangleAlert, XCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  summarizeBatchOutcome,
  toMemberProgressRows,
  type BatchOutcomeTone,
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

/** One batch card: outcome headline, compensation detail, per-member progress. */
function InstallBatchCard({ batch }: { batch: InstallBatch }) {
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
              <span className="text-[10px] uppercase tracking-[0.2em] text-muted-foreground">
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
 */
export function InstallBatchPanel({ batches }: { batches: InstallBatch[] }) {
  if (batches.length === 0) return null;

  return (
    <section className="flex flex-col gap-3" data-testid="install-batch-panel">
      <h2 className="text-sm font-semibold text-foreground">Recent dependency installs</h2>
      <div className="flex flex-col gap-3">
        {batches.map((batch) => (
          <InstallBatchCard key={batch.batchId} batch={batch} />
        ))}
      </div>
    </section>
  );
}
