/**
 * Gate-volume panel (cinatra#2047 row 9 — fatigue/scale).
 *
 * The acceptance row exists to answer two questions that had NO surface at all:
 * a reviewer's "how many reviews are open?" and an administrator's "are the
 * policy defaults generating a survivable volume?". Both are answered by the same
 * org-scoped rollup, so this is ONE presentational component with two mounts —
 * the reviewer's Reviews page (`/agents/reviews`) and the admin console's Review
 * policy tab, where it sits beside the bounds that would change it.
 *
 * Pure presentation over a plain data object: no data access, no session, no
 * client runtime — the two mounts own authorization and pass the read in. The
 * rollup axes are deliberately the POLICY KEY's own axes (artifact type ·
 * destination class · origin kind), because tuning is only actionable when the
 * volume is broken down along the dimensions a bound is written in.
 */
import Link from "next/link";

import type {
  GateVolumeBucket,
  OrgReviewGateVolume,
} from "@cinatra-ai/agents/lifecycle-policy-store";
import { Empty, EmptyDescription, EmptyHeader } from "@/components/ui/empty";

/**
 * Deep-link a gate to the run-embedded review surface that decides it:
 * `/agents/{vendor}/{package}/{runId}/review/{reviewTaskId}`.
 *
 * The SAME five-segment shape (and the same `unknown/unknown` degrade) the
 * execution path already emits for a marked reviewer gate — the review page keys
 * ONLY on the run id, so an unresolved package still resolves rather than 404ing.
 */
export function gateReviewHref(
  runId: string,
  reviewTaskId: string,
  runPackageName: string | null,
): string {
  const scoped = runPackageName?.match(/^@([^/]+)\/(.+)$/);
  const base = scoped
    ? `/agents/${scoped[1]}/${scoped[2]}/${encodeURIComponent(runId)}`
    : runPackageName
      ? `/agents/${runPackageName}/${encodeURIComponent(runId)}`
      : `/agents/unknown/unknown/${encodeURIComponent(runId)}`;
  return `${base}/review/${encodeURIComponent(reviewTaskId)}`;
}

function formatAge(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 60) return `${Math.max(minutes, 0)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-1 rounded-lg border border-line bg-surface-strong px-4 py-3">
      <span className="font-mono text-badge-2xs font-bold uppercase tracking-kicker text-muted-foreground">
        {label}
      </span>
      <span className="text-lg font-semibold text-foreground">{value}</span>
    </div>
  );
}

function BucketList({ title, buckets }: { title: string; buckets: GateVolumeBucket[] }) {
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-strong px-4 py-3">
      <span className="font-mono text-badge-2xs font-bold uppercase tracking-kicker text-muted-foreground">
        {title}
      </span>
      {buckets.length === 0 ? (
        <span className="text-xs text-muted-foreground">No open gates.</span>
      ) : (
        <ul className="flex flex-col gap-1">
          {buckets.map((b) => (
            <li key={b.key} className="flex items-baseline justify-between gap-3 text-xs">
              <span className="truncate font-mono text-foreground">{b.key}</span>
              <span className="tabular-nums font-semibold text-foreground">{b.open}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function GateVolumePanel({
  volume,
  showListing = true,
  listingCap = false,
}: {
  volume: OrgReviewGateVolume;
  /** The admin console shows the rollup only; the reviewer surface also shows the
   * backlog head so an open review is one click away. */
  showListing?: boolean;
  /** Say plainly that the listing is the oldest slice of a larger backlog (and,
   * on the reviewer surface, that run access narrows it further) — the counts
   * are org-wide, the rows are not. */
  listingCap?: boolean;
}) {
  if (volume.totalOpen === 0) {
    return (
      <Empty data-testid="gate-volume" data-conformance-id="gate-volume" data-state="empty">
        <EmptyHeader>
          <EmptyDescription>
            No review gates are open in this organization.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  return (
    <div
      className="flex flex-col gap-4"
      data-testid="gate-volume"
      data-conformance-id="gate-volume"
      data-total-open={volume.totalOpen}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Open gates" value={String(volume.totalOpen)} />
        <Stat label="Under 24h" value={String(volume.aging.under24h)} />
        <Stat label="1–7 days" value={String(volume.aging.under7d)} />
        <Stat label="Over 7 days" value={String(volume.aging.over7d)} />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        <BucketList title="By artifact type" buckets={volume.byArtifactType} />
        <BucketList title="By destination class" buckets={volume.byDestinationClass} />
        <BucketList title="By origin kind" buckets={volume.byOriginKind} />
      </div>

      {volume.rollupTruncated ? (
        <p className="text-xs text-muted-foreground">
          The open-gate total is exact; the breakdown describes the {volume.rollupScanned}{" "}
          oldest gates only, because this organization has more open gates than one
          scan reads.
        </p>
      ) : null}

      {showListing ? (
        <div
          className="overflow-hidden rounded-lg border border-line bg-surface-strong"
          data-testid="gate-volume-listing"
        >
          <div className="overflow-x-auto">
            <table className="w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  {["Artifact type", "Destination", "Origin", "Targets", "Open for", ""].map((h, i) => (
                    <th
                      key={h || `col-${i}`}
                      className="border-b border-line bg-surface px-3.5 py-2.5 text-left font-mono text-badge-2xs font-bold uppercase tracking-kicker text-muted-foreground"
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {volume.openGates.length === 0 ? (
                  <tr>
                    <td
                      className="px-3.5 py-6 text-center text-muted-foreground"
                      colSpan={6}
                      data-testid="gate-volume-listing-empty"
                    >
                      None of the open reviews are on a run you can access.
                    </td>
                  </tr>
                ) : null}
                {volume.openGates.map((g, i) => {
                  const last = i === volume.openGates.length - 1;
                  const cell = `px-3.5 py-3${last ? "" : " border-b border-line"}`;
                  return (
                    <tr key={g.gateId} data-testid="gate-volume-row">
                      <td className={`${cell} font-mono text-foreground`}>{g.artifactType}</td>
                      <td className={`${cell} text-muted-foreground`}>{g.destinationClass}</td>
                      <td className={`${cell} text-muted-foreground`}>{g.originKind}</td>
                      <td className={`${cell} tabular-nums text-muted-foreground`}>{g.targetCount}</td>
                      <td className={`${cell} tabular-nums text-muted-foreground`}>{formatAge(g.ageMs)}</td>
                      <td className={cell}>
                        <Link
                          href={gateReviewHref(g.runId, g.reviewTaskId, g.runPackageName)}
                          className="font-semibold text-foreground underline underline-offset-2"
                        >
                          Open review
                        </Link>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {showListing && listingCap ? (
        <p className="text-xs text-muted-foreground" data-testid="gate-volume-listing-note">
          {volume.openGates.length === 0
            ? `The counts above are organization-wide; the list shows only reviews on runs you can access.`
            : `Showing the ${volume.openGates.length} oldest of ${volume.totalOpen} open ${
                volume.totalOpen === 1 ? "review" : "reviews"
              } in this organization — reviews on runs you cannot access are hidden.`}
        </p>
      ) : null}
    </div>
  );
}
