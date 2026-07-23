import "server-only";

import type { ReactNode } from "react";
import Link from "next/link";

import { Button } from "@/components/ui/button";
import type { PreparedReviewTarget } from "@/lib/artifacts/artifact-review-preparation";
import { ReviewTargetMount } from "@/app/artifacts/[id]/review-target-mount";
import {
  reviewProvenanceConformanceId,
  reviewProvenanceLabel,
  reviewRevisionMarker,
  reviewTypeLabel,
} from "@/app/artifacts/review/review-surface-model";

/**
 * ONE review target panel (cinatra#1795 S12 item 4; spec design@30a0f9c9 §II/§III):
 * the immutable target HEADER (display title + a mono meta line, inert — no edit
 * control, no revision picker, because the target is versioned and frozen) over
 * the RENDERER-PROVENANCE chip, over the REPRESENTATION SLOT into which the
 * artifact's type renderer mounts (fed host display-only props). Every target is
 * type-agnostic: it keys on the OPAQUE host mount kind only (G1-clean).
 *
 * Conformance anchors (design@30a0f9c9): the panel is `review-target`; the
 * provenance region is `review-provenance-native` (build-time), `review-
 * provenance-marketplace` (runtime), or `review-target-floor` (any floor) — the
 * §III axis derived from the mount kind.
 */
export function ReviewTargetPanel({ prepared }: { prepared: PreparedReviewTarget }): ReactNode {
  const { target, props, mount } = prepared;
  const title = props?.artifact.title ?? target.artifactId;
  const objectType = props?.artifact.objectType ?? "";
  const typeLabel = objectType ? reviewTypeLabel(objectType) : "Artifact";
  const revision = reviewRevisionMarker(target.representationRevisionId);
  const provenance = reviewProvenanceLabel(mount);
  const provenanceConformanceId = reviewProvenanceConformanceId(mount);

  // The never-blank generic FLOOR fallback (§III): a type-level floor renders it
  // BENEATH the diagnostic (there is an authorized representation); an artifact-
  // level floor (props null) has nothing to show, so the fallback is empty and
  // ReviewTargetMount shows the sanitized diagnostic alone.
  const genericFloor: ReactNode = props ? <ReviewGenericFloor prepared={prepared} /> : null;

  return (
    <div
      data-conformance-id="review-target"
      data-field="name=type.displayName"
      className="overflow-hidden rounded-control border border-line bg-surface-strong"
    >
      {/* §II — the immutable target header (inert). */}
      <div className="border-b border-line px-4 py-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-sans text-sm font-bold text-foreground">{title}</span>
          <span className="inline-flex items-center rounded-full border border-blue/30 bg-blue/10 px-2 py-0.5 text-xs font-semibold text-blue">
            {typeLabel}
          </span>
        </div>
        <p className="mt-1 font-mono text-badge-xs tracking-tight text-muted-foreground">
          {objectType ? <span>{objectType} · </span> : null}
          <span title={revision.full}>revision {revision.short}</span>
          <span className="text-mustard-ink"> · pinned</span>
          {props ? (
            <>
              {" · "}
              {props.artifact.ownerLevel} · {props.artifact.visibility} · {props.artifact.mime} · updated{" "}
              {props.artifact.updatedAt}
            </>
          ) : null}
        </p>
      </div>

      {/* §III — renderer provenance chip. */}
      <div
        data-conformance-id={provenanceConformanceId}
        className="flex flex-wrap items-center gap-2 border-b border-line bg-surface px-4 py-2"
      >
        {provenance.kind === "floor" ? (
          <span className="inline-flex items-center rounded-full border border-line-strong px-2 py-0.5 text-badge-xs font-semibold text-muted-foreground">
            Floor
          </span>
        ) : (
          <span className="inline-flex items-center rounded-full border border-blue/30 bg-blue/10 px-2 py-0.5 text-badge-xs font-semibold text-blue">
            {typeLabel}
          </span>
        )}
        {provenance.kind === "runtime" && provenance.packageName ? (
          <span className="inline-flex items-center rounded-full border border-line bg-surface-muted px-2 py-0.5 font-mono text-badge-2xs text-foreground">
            {provenance.packageName}
          </span>
        ) : null}
        <span className="font-mono text-badge-2xs tracking-tight text-muted-foreground">
          {provenance.kind === "build-time"
            ? `build-time · ${provenance.slot}`
            : provenance.kind === "runtime"
              ? `runtime · ${provenance.slot}`
              : "structured data"}
        </span>
      </div>

      {/* The representation slot — the type renderer mounts here, or the floor. */}
      <div className="p-4" data-review-representation-slot="">
        <ReviewTargetMount mount={mount} props={props} fallback={genericFloor} />
      </div>
    </div>
  );
}

/**
 * The generic, read-only floor content (§III) — a design-neutral view built from
 * the host display-only props: the artifact title, a muted note that no type
 * renderer resolved, and the host-authorized (version-pinned) preview / download
 * links. Never the raw bytes; never blank. Shown BENEATH the ReviewTargetMount
 * sanitized diagnostic for a type-level floor.
 */
function ReviewGenericFloor({ prepared }: { prepared: PreparedReviewTarget }): ReactNode {
  const { props } = prepared;
  if (!props) return null;
  return (
    <div className="rounded-control bg-surface p-3">
      <div className="font-sans text-xs font-bold text-foreground">
        {props.artifact.title ?? props.artifact.id}
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        No type renderer resolved for this artifact — showing the generic read-only view.
      </p>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-badge-xs text-muted-foreground">
        <dt>type</dt>
        <dd className="text-foreground">{props.artifact.objectType}</dd>
        <dt>mime</dt>
        <dd className="text-foreground">{props.artifact.mime}</dd>
        <dt>revision</dt>
        <dd className="text-foreground">{props.representation?.revisionId ?? "—"}</dd>
      </dl>
      {props.urls.preview || props.urls.download ? (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {props.urls.preview ? (
            <Button asChild variant="link" size="sm" className="h-auto px-0">
              <Link href={props.urls.preview}>Preview</Link>
            </Button>
          ) : null}
          {props.urls.download ? (
            <Button asChild variant="link" size="sm" className="h-auto px-0">
              <Link href={props.urls.download} download>
                Download
              </Link>
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
