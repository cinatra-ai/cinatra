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

import {
  setExtensionArtifactClaimArchivalHook,
  setExtensionArtifactClaimReactivationHook,
  setExtensionArtifactClaimArchivalAllScopesHook,
} from "@cinatra-ai/extensions";
import {
  retireArtifactExtensionClaims,
  retireArtifactExtensionClaimsAllScopes,
} from "@/lib/objects/artifact-claim-lifecycle";

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
        `assertion(s) across ${result.processedArtifacts} artifact(s) (operation ` +
        `${result.operationId ?? "none"}${
          result.resumedOperationIds.length
            ? `; resumed [${result.resumedOperationIds.join(", ")}]`
            : ""
        })`,
    );
    return result;
  });
}

// ---------------------------------------------------------------------------
// cinatra#1837 R3 — the FAIL-CLOSED claim-REACTIVATION wiring (restore), the
// mirror of the archival wiring. Co-located HERE (not a separate module) so it
// adds no module to the locked route graphs. The install-anchor activation + the
// claim-lifecycle graph are HEAVY, so they are DYNAMICALLY imported inside the
// async hook (which only runs on an actual restore) — keeping this module a cheap
// static leaf. Registers the restored type surface (a restore-scoped exception to
// the bridge write-allowed gate) so the activation gate resolves the type's
// validator on a still-archived row, reactivates via the install-anchor
// activation BEFORE the row flips active (no boot cycle); on failure runs a
// fresh-op compensation + conditional de-register (never a live sibling's
// surface) then THROWS so restore aborts.
// ---------------------------------------------------------------------------

let reactivationWired = false;

/** Idempotently install the durable, fail-closed artifact claim-reactivation hook. */
export function wireExtensionArtifactClaimReactivationHook(): void {
  if (reactivationWired) return;
  reactivationWired = true;
  setExtensionArtifactClaimReactivationHook(async (input) => {
    if (input.organizationId === "" || input.organizationId == null) {
      throw new Error(
        `[artifact-claim-reactivation] "${input.packageName}": empty/absent organizationId — ` +
          `refusing (org-scoped restore reactivation only; platform is deferred, cinatra#1837 R1)`,
      );
    }
    const scope = `org:${input.organizationId}`;
    const pkg = input.packageName;

    // HEAVY graphs — dynamically imported so this module stays a cheap leaf.
    const { retireArtifactExtensionClaims: retire } = await import(
      "@/lib/objects/artifact-claim-lifecycle"
    );
    const { readInstallAnchorManifestClaims, resolveRegisteredTypeValidator, runInstallAnchorClaimActivation } =
      await import("@/lib/objects/artifact-claim-install-anchor");

    // (1) Register the restored type surface BEFORE reactivation (the R3 restore
    // exception to the write-allowed gate), scoped to THIS package, so the
    // activation gate resolves the type's validator on the still-archived row.
    const { rescanArtifactBridgeFromStore } = await import("@/lib/extension-artifact-bridge-rescan");
    const rescan = await rescanArtifactBridgeFromStore({ onlyPackage: pkg, restorePackage: pkg });
    const record = rescan.registeredRecords.find((r) => r.packageName === pkg);
    if (!record) {
      throw new Error(
        `[artifact-claim-reactivation] "${pkg}" (${scope}): could not register the restored type ` +
          `surface from the package store — refusing to reactivate against a missing/unresolved schema (fail-closed)`,
      );
    }
    const hasLiveSibling = await packageHasLiveSibling(pkg);

    // (2) Read the CURRENT manifest claims from the SAME registered store dir.
    const claims = await readInstallAnchorManifestClaims(record.storeDir);
    if (claims === null) {
      await deregisterIfOwned(pkg, hasLiveSibling);
      throw new Error(
        `[artifact-claim-reactivation] "${pkg}" (${scope}): the restored store dir is not a readable ` +
          `valid artifact manifest — refusing to reactivate (fail-closed)`,
      );
    }

    // (3) Reactivate BEFORE the transition — the type is live the instant the row
    // flips active (no boot cycle, the AC).
    const activation = runInstallAnchorClaimActivation({
      scope,
      extensionPackage: pkg,
      extensionVersion: input.extensionVersion,
      installId: input.installId ?? null,
      claims,
      resolveTypeValidator: resolveRegisteredTypeValidator,
    });

    if (activation.outcome === "failed") {
      // FRESH-op compensation: re-archive any partial replay + re-retire the
      // claims (resume-aware), restoring the archived-consistent state; then
      // conditionally de-register + THROW so restore aborts (no active row with
      // dead claims). The durable retry/reconciler is the guarantee if this fails.
      try {
        retire({
          scope,
          extensionPackage: pkg,
          extensionVersion: input.extensionVersion,
          actor: input.actorPrincipalId ?? "system",
          installId: input.installId ?? null,
        });
      } catch (compErr) {
        console.warn(
          `[artifact-claim-reactivation] "${pkg}" (${scope}): fresh-op compensation after a failed ` +
            `reactivation also failed — the durable retry is the guarantee:`,
          compErr instanceof Error ? compErr.message : compErr,
        );
      }
      await deregisterIfOwned(pkg, hasLiveSibling);
      throw new Error(
        `[artifact-claim-reactivation] "${pkg}" (${scope}): reactivation failed (${activation.reason}) — ` +
          `restore aborted; the row stays archived with no live claim (fail-closed)`,
      );
    }

    console.info(
      `[artifact-claim-reactivation] "${pkg}" (${scope}): reactivated (${activation.outcome}), ` +
        `replayed operations [${activation.replayedOperationIds.join(", ")}]`,
    );
    return activation;
  });
}

/** True iff the package has ANY active/locked canonical row (a live sibling of
 *  the archived row being restored). Fail-closed toward NOT de-registering. */
async function packageHasLiveSibling(packageName: string): Promise<boolean> {
  try {
    const { readInstalledExtensionsByPackageName } = await import(
      "@cinatra-ai/extensions/canonical-store"
    );
    const rows = await readInstalledExtensionsByPackageName(packageName);
    return rows.some((r) => r.status === "active" || r.status === "locked");
  } catch {
    return true;
  }
}

/** De-register the package's bridge type surface on a restore abort — ONLY when
 *  no live sibling relies on it (R2-4). */
async function deregisterIfOwned(packageName: string, hasLiveSibling: boolean): Promise<void> {
  if (hasLiveSibling) return;
  try {
    const { objectTypeRegistry } = await import("@cinatra-ai/objects");
    objectTypeRegistry.removeByPackage(packageName);
  } catch (err) {
    console.warn(
      `[artifact-claim-reactivation] "${packageName}": de-register on abort failed (non-fatal):`,
      err instanceof Error ? err.message : err,
    );
  }
}

// ---------------------------------------------------------------------------
// cinatra#1837 R2 — the FAIL-CLOSED ALL-SCOPES claim-archival wiring (package-
// global destruction). Co-located here (no new module). Reads the package's
// canonical-row scopes (async) and hands them to the all-scopes primitive, which
// unions them with the store-sourced legs.
// ---------------------------------------------------------------------------

let allScopesWired = false;

/** Idempotently install the durable, fail-closed all-scopes claim-archival hook. */
export function wireExtensionArtifactClaimArchivalAllScopesHook(): void {
  if (allScopesWired) return;
  allScopesWired = true;
  setExtensionArtifactClaimArchivalAllScopesHook(async (input) => {
    let canonicalScopes: string[] = [];
    try {
      const { readInstalledExtensionsByPackageName } = await import(
        "@cinatra-ai/extensions/canonical-store"
      );
      const rows = await readInstalledExtensionsByPackageName(input.packageName);
      canonicalScopes = rows.map((r) => (r.organizationId ? `org:${r.organizationId}` : "platform"));
    } catch (err) {
      console.warn(
        `[artifact-claim-archival-all-scopes] "${input.packageName}": canonical-row scope read failed ` +
          `— proceeding on the store-sourced scope legs only:`,
        err instanceof Error ? err.message : err,
      );
    }
    const result = retireArtifactExtensionClaimsAllScopes({
      extensionPackage: input.packageName,
      extensionVersion: input.extensionVersion,
      actor: input.actorPrincipalId ?? "system",
      canonicalScopes,
    });
    console.info(
      `[artifact-claim-archival-all-scopes] "${input.packageName}": retired across ` +
        `${result.retiredScopes.length} org scope(s) [${result.retiredScopes.join(", ")}] ` +
        `(${result.totalRetiredClaims} claim(s), ${result.totalArchivedAssertions} assertion(s)); ` +
        `deferred [${result.deferredScopes.join(", ")}]`,
    );
    return result;
  });
}

// Wire all three fail-closed seams on import — a side-effect import installs them.
wireExtensionArtifactClaimArchivalHook();
wireExtensionArtifactClaimReactivationHook();
wireExtensionArtifactClaimArchivalAllScopesHook();
