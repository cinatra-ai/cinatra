import "server-only";

import type { ReactNode } from "react";

import type { ArtifactRendererProps } from "@/lib/artifacts/artifact-renderer-props";
import type {
  ReviewMountFloorReason,
  ReviewTargetMount as ReviewTargetMountDescriptor,
} from "@/lib/artifacts/artifact-review-preparation";

import { ExtensionRendererSlot } from "./extension-renderer-slot";
import { DynamicRendererLoader } from "./dynamic-renderer-loader";
import { runRuntimeRendererFreshnessPreflight } from "./runtime-renderer-preflight";
import { MarkdownHandler } from "./handlers/markdown-handler";
import { PlainTextHandler } from "./handlers/plain-text-handler";

/**
 * The client artifact-MOUNT BRIDGE for the generic review surface (cinatra#1795,
 * epic #1620 S12, item 3). Given a HOST-produced mount descriptor + the pinned
 * display props, it mounts the resolved extension renderer inside a review
 * context, with the never-blank floor on EVERY failure class.
 *
 * NO CLIENT-SUPPLIED RENDERER-ID PATH: the descriptor is produced by the server
 * preparation action from the artifact's TYPE (the S2 dispatch spine) — this
 * bridge only branches on the OPAQUE `mount.kind` and passes the host's
 * generatedKey / descriptor through. There is deliberately no prop by which a
 * caller could name a renderer; the renderer identity crosses ONLY as host-
 * resolved side data. G1-clean.
 *
 * The two loadable paths reuse the S2 seams unchanged:
 *   - `build-map` → the server-only `ExtensionRendererSlot` (the server→client
 *     component-reference handoff — the RSC resolves the client-reference module
 *     from the generated build map and hands it to the client, the chat-views
 *     pattern; SSR fast path).
 *   - `runtime`   → the main-realm dynamic `DynamicRendererLoader` behind the
 *     BOUND fail-closed freshness preflight (marketplace-installed, zero host
 *     rebuild). A descriptor that already carries a pre-import `reason` floors in
 *     the loader without importing.
 *   - `form`      → the FORM-RENDERING RUNG (plan `PLAN: Agents Lifecycle (B)`
 *     §5): the host's own renderer for a declared text form, server-rendered
 *     here — inside the card's authenticated island — against the PINNED
 *     revision the gate froze. It is the rung the card was missing, and the
 *     reason the same markdown draft that renders on its own page used to show
 *     "cannot render" under review.
 *   - `floor`     → the never-blank host floor: a sanitized, telemetry-safe
 *     diagnostic + the caller's generic fallback node.
 *
 * THE ORGANIZATION SCOPE COMES FROM THE HOST. The form arm reads artifact bytes,
 * so it needs a tenant, and it takes it as a prop from the surface that already
 * authorized the reader — never from the display props (which are a client-
 * facing snapshot) and never from ambient request state.
 *
 * This bridge is type-agnostic PLUMBING. The decision chrome that WRAPS it (the
 * approve/reject/comment affordances + the review context) is a design-surface
 * that lands with the pinned review-surface spec — until then no end-user review
 * screen wires this bridge (fenced). The bridge + its floor stay minimal and
 * design-neutral so they commit to no unpinned chrome.
 */
export async function ReviewTargetMount({
  mount,
  props,
  orgId,
  fallback,
}: {
  mount: ReviewTargetMountDescriptor;
  /** The pinned display props — non-null for the loadable paths; may be null on
   * an artifact-level floor (unknown / read-denied / non-member revision) where
   * there is no authorized artifact to render props from. */
  props: ArtifactRendererProps | null;
  /** The reviewing surface's TRUSTED organization scope — supplied by the host
   * that already resolved and authorized the reader. The form arm reads bytes
   * under it; every other mount kind ignores it. */
  orgId: string;
  /** The host's generic floor node — rendered on EVERY non-mount state. */
  fallback: ReactNode;
}): Promise<ReactNode> {
  // EXHAUSTIVE over the mount kinds and over the form arms. A trailing `return
  // reviewFloor(...)` would silently draw a FUTURE kind as a floor, and a
  // trailing plain-text return would silently draw a future arm as plain text —
  // both are wrong answers that compile. The `never` assertions below turn
  // either into a type error at the moment the kind is added.
  switch (mount.kind) {
    case "build-map": {
      // Defensive: the core always pairs a loadable mount with non-null props.
      if (!props) return reviewFloor(mount.packageName, mount.slot, "no-representation", fallback);
      return (
        <ExtensionRendererSlot
          generatedKey={mount.generatedKey}
          packageName={mount.packageName}
          slot={mount.slot}
          props={props}
          fallback={fallback}
        />
      );
    }
    case "runtime": {
      if (!props) return reviewFloor(mount.packageName, mount.slot, "no-representation", fallback);
      // Bind the descriptor's exact tuple into the freshness preflight so the client
      // loader re-confirms "still admitted" immediately before importing.
      const preflight = runRuntimeRendererFreshnessPreflight.bind(null, mount.descriptor.tuple);
      return (
        <DynamicRendererLoader
          descriptor={mount.descriptor}
          props={props}
          fallback={fallback}
          preflight={preflight}
        />
      );
    }
    case "form": {
      // The pinned revision is the ONE the gate froze: it travels on the host-built
      // props, which the preparation core built from the gate's pinned target, so
      // this arm can never render the artifact's latest.
      const revisionId = props?.representation?.revisionId ?? null;
      if (!props || !revisionId) {
        return reviewFloor(null, mount.slot, "no-representation", fallback);
      }
      switch (mount.form) {
        case "markdown":
          return (
            <MarkdownHandler artifactId={props.artifact.id} revisionId={revisionId} orgId={orgId} />
          );
        case "text":
          return (
            <PlainTextHandler artifactId={props.artifact.id} revisionId={revisionId} orgId={orgId} />
          );
        default:
          return assertNeverMount(mount.form);
      }
    }
    case "floor":
      return reviewFloor(mount.packageName, mount.slot, mount.reason, fallback);
    default:
      return assertNeverMount(mount);
  }
}

/** Compile-time exhaustiveness for the mount kinds and the form arms. A new kind
 * or arm makes this call a type error at the call site rather than shipping a
 * silently wrong reading (a floor where a renderer was meant, or plain text
 * where a new form was meant). At runtime — only reachable through malformed
 * data that bypassed the type — it throws rather than drawing a guess. */
function assertNeverMount(value: never): never {
  throw new Error(`unhandled review target mount: ${JSON.stringify(value)}`);
}

/** A sanitized, telemetry-safe review floor: package + slot + reason ONLY, never
 * a raw error / manifest value — plus the caller's generic fallback (never
 * blank). Deliberately design-neutral (no branded chrome) so the fenced
 * decision-surface owns the visual notice. */
function reviewFloor(
  packageName: string | null,
  slot: string,
  reason: ReviewMountFloorReason | "no-representation",
  fallback: ReactNode,
): ReactNode {
  return (
    <div data-review-target-floor={reason} data-review-floor-package={packageName ?? ""} data-review-floor-slot={slot}>
      <p role="status" className="text-muted-foreground text-sm">
        {reviewTargetFloorDiagnostic(packageName, slot, reason)}
      </p>
      {fallback}
    </div>
  );
}

export function reviewTargetFloorDiagnostic(
  packageName: string | null,
  slot: string,
  reason: string,
): string {
  const pkg = packageName ? `package "${packageName}", ` : "";
  return `review target unavailable — ${pkg}slot "${slot}", reason "${reason}"`;
}
