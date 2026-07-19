import "server-only";

// Wires the host-injected, FAIL-CLOSED artifact claim-archival lifecycle hook
// (cinatra#1454). On the committed-archive path of a `kind:"artifact"` extension
// — an org-admin uninstall, a platform-admin archive-branch uninstall, or an
// explicit archive — retire the extension's `objectTypes` claims and archive its
// eligible semantic assertions (the durable, replayable half of the claim
// lifecycle: `retireArtifactExtensionClaims`). Before this, the artifact
// archive/uninstall dispatch only logged, so an archived artifact extension left
// its claims live and its governed rows un-archived — the gap #1454 closes.
//
// Kept SEPARATE from `@/lib/extensions` (which eagerly registers all kind
// handlers + pulls the heavy host graph) so it loads cheaply on every path that
// can archive an extension — including the UI Server Actions in
// `@cinatra-ai/extensions`, which must NOT pull the full handler graph. This
// module touches only `@cinatra-ai/extensions` (the hook setter) + the SYNC
// claim-lifecycle leaf (`retireArtifactExtensionClaims`), so importing it is
// cheap. It is co-located with the artifact handler's registration
// (handler-bootstrap.ts side-effect import) so the FAIL-CLOSED fire never hits an
// unwired slot in a worker where the artifact kind is dispatchable.
//
// Loaded on the Server Action path via `@cinatra-ai/extensions/handler-bootstrap`
// and on the MCP path via `@/lib/extensions` — both idempotent (last set wins).
//
// SCOPE mapping: `organizationId` → the claim-registry scope the install
// activated against (`org:<id>` | "platform"), mirroring the install anchor
// (`artifact-claim-install-anchor.ts`). Retirement is scope-symmetric with
// activation, so an org-scoped archive retires exactly that org's claims and a
// platform archive retires the platform claims.

import { setExtensionArtifactClaimArchivalHook } from "@cinatra-ai/extensions";
import { retireArtifactExtensionClaims } from "@/lib/objects/artifact-claim-lifecycle";

let wired = false;

/** Idempotently install the durable, fail-closed artifact claim-archival hook. */
export function wireExtensionArtifactClaimArchivalHook(): void {
  if (wired) return;
  wired = true;
  setExtensionArtifactClaimArchivalHook((input) => {
    // NULLISH mapping + fail-closed on an EMPTY org id: a truthiness check would
    // map "" to the "platform" scope, whose archival is a cross-org sweep (no
    // org filter). The dispatcher already refuses an empty org id, but the seam
    // is defensively fail-closed here too (codex convergence 2026-07-19).
    if (input.organizationId === "") {
      throw new Error(
        `[artifact-claim-archival] "${input.packageName}": empty organizationId — refusing ` +
          `(would map to a cross-org "platform" assertion sweep)`,
      );
    }
    const scope = input.organizationId == null ? "platform" : `org:${input.organizationId}`;
    // SYNC leaf; a store error PROPAGATES (fail-closed) — the seam fires this
    // before the durable row transition, so the throw aborts the archive.
    const result = retireArtifactExtensionClaims({
      scope,
      extensionPackage: input.packageName,
      extensionVersion: input.extensionVersion,
      actor: input.actorPrincipalId ?? "system",
      installId: input.installId ?? null,
    });
    console.info(
      `[artifact-claim-archival] "${input.packageName}" (${scope}): retired ` +
        `${result.retiredClaims.length} claim(s), archived ${result.archivedAssertions} ` +
        `assertion(s) across ${result.processedArtifacts} artifact(s) (operation ${result.operationId})`,
    );
    return result;
  });
}

// Wire on import — a side-effect import installs the hook.
wireExtensionArtifactClaimArchivalHook();
