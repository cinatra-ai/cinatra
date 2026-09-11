// ---------------------------------------------------------------------------
// Functional-acceptance harness for §III's METADATA FLOOR (cinatra#3164, epic
// #3155 W8).
//
// §III: "A target is never blank." Where the artifact's type resolves to a
// renderer the target shows it and says nothing about it; where no renderer
// resolves, the target falls to the metadata floor, "which does say so: a
// sanitized one-line diagnostic above the generic read-only view of the
// representation."
//
// THE REAL BRIDGE DRAWS IT. `ReviewTargetMount` is the shipped client-artifact
// mount bridge the review island itself uses, and the floor arm below is the
// same descriptor the server preparation produces for a type whose semantic
// renderer is runtime-installed and absent from this build. The diagnostic is
// composed by the shipped `reviewTargetFloorDiagnostic` — the harness names a
// package, a slot and a reason, and the component decides every word.
//
// THE FALLBACK IS THE HOST'S, WHICH IS THE BRIDGE'S OWN CONTRACT: the floor
// draws "the caller's generic fallback node" beneath the diagnostic, so the
// generic read-only view of the representation is composed here, exactly as a
// hosting surface composes it.
//
// THE OTHER TWO TIERS ARE NOT MOUNTED HERE, and are not approximated either. A
// build-time renderer resolves out of the generated build map and a runtime one
// out of an installed extension; this harness admits neither, and a stand-in
// renderer would prove nothing about which tier resolved. Their drivers are
// written in full and skip on the missing mount (contract.ts), and they are on
// this wave's surface-readiness list.
// ---------------------------------------------------------------------------

import { type ReactElement } from "react";

import { ReviewTargetMount } from "@/app/artifacts/[id]/review-target-mount";
import type { ReviewTargetMount as ReviewTargetMountDescriptor } from "@/lib/artifacts/artifact-review-preparation";

/**
 * The floor descriptor: a FICTIONAL package (a core file naming a real
 * extension instance is banned) whose semantic detail renderer is runtime
 * installed and absent from this build — the one reason §III's floor exists for.
 */
const METADATA_FLOOR_MOUNT: ReviewTargetMountDescriptor = {
  kind: "floor",
  slot: "detail",
  packageName: "@acme/support",
  reason: "requires-rebuild",
};

/** The organization scope the floor arm ignores (only the form arm reads bytes),
 *  passed because the bridge takes it from the host that authorized the reader. */
const CONFORMANCE_ORG_ID = "conformance-harness";

/** The generic read-only view of the representation — the host's own fallback,
 *  which §III draws BENEATH the diagnostic and which is why a floored target is
 *  never blank. */
function FloorStructuredData(): ReactElement {
  return (
    <div data-conformance-id="review-target-floor-structured-data" className="mt-2">
      <p className="font-mono text-badge-2xs uppercase tracking-widest text-muted-foreground">
        Floor structured data
      </p>
      <pre className="mt-1 overflow-x-auto rounded-panel border border-line bg-surface px-3 py-2 font-mono text-xs text-foreground">
        {JSON.stringify({ subject: "Login loop on SSO", priority: "high" }, null, 2)}
      </pre>
    </div>
  );
}

/** §III's metadata floor, mounted on the manifest surface it stands for. */
export function LifecycleTierFloorFixture(): ReactElement {
  return (
    <div
      data-surface-id="tier-metadata-floor"
      // The harness's own root convention: a mount names the variant it
      // draws, the way every other conformance fixture on this route does.
      data-variant="populated"
      className="flex flex-col gap-3"
    >
      <ReviewTargetMount
        mount={METADATA_FLOOR_MOUNT}
        props={null}
        orgId={CONFORMANCE_ORG_ID}
        fallback={<FloorStructuredData />}
      />
    </div>
  );
}
