// Install-anchor claim ACTIVATION hook (cinatra#1493, epic #1424) — the live
// composition that fires the artifact-extension claim lifecycle
// (`artifact-claim-lifecycle.ts`) from the host install anchor
// (`runHostExtensionInstallAndActivate`), riding the same
// finalized-artifact-install gate as the artifact-bridge rescan.
//
// IDEMPOTENCY IS THE CONTRACT. The anchor RE-FIRES for one logical install:
// the dispatcher's retry path re-runs the whole pipeline for a retried broken
// row, and the cinatra#793 compensation re-fires it for the CAPTURED PRIOR
// version after a handler failure. `reserveArtifactTypeClaim` always INSERTs,
// so a naive second activation self-conflicts on the registry's one-live-
// claimant partial-unique indexes. This module therefore diffs the extension's
// LIVE registered claims against the CURRENT manifest claims first:
//
//   - every fire            → drain ALL owed uninstall-operation replays first
//                             (see drainOwedUninstallReplays — a latest-only
//                             replay can strand an older owed operation's
//                             archived assertions);
//   - no live claims        → activate via `replayArtifactExtensionReinstall`
//                             (a plain install once the drain consumed
//                             anything owed);
//   - live claims MATCH     → no-op (the re-fire / rollback-re-fire case);
//   - live claims DIFFER    → retire + drain + replay
//                             (`retireArtifactExtensionClaims` →
//                             `replayArtifactExtensionReinstall`) — the
//                             lifecycle's sanctioned change route, NEVER a raw
//                             second activate.
//
// NON-THROWING BY CONTRACT: the anchor calls this AFTER the install pipeline
// finalized. A claim conflict (or any lifecycle failure) here must surface as
// a warning outcome — never as a pipeline throw that would roll back a
// genuinely-successful, already-finalized install. The lifecycle already
// retires this call's partially-activated claims before its conflict
// propagates, so catching leaves no partial winner set.
//
// DURABLE BACKSTOP: because a 'failed' outcome is only a warning at install
// time, `runInstallAnchorClaimBackstop` (below) re-fires this hook at BOOT for
// every install-active artifact package the bridge rescan registered — a
// failed/raced activation converges at the next boot instead of persisting
// until an unrelated qualifying install event.

import {
  ArtifactClaimConflictError,
  replayArtifactExtensionReinstall,
  retireArtifactExtensionClaims,
  type ArtifactClaimLifecycleContext,
  type LifecycleClaim,
} from "@/lib/objects/artifact-claim-lifecycle";
import {
  readArtifactTypeClaimsForExtension,
  type ArtifactTypeClaimRow,
} from "@/lib/objects/artifact-claim-store";
import {
  findReplayableUninstallOperation,
  replayArtifactUninstallOperation,
} from "@/lib/objects/artifact-uninstall-operations";
import { objectTypeRegistry, parseSemanticArtifactManifest } from "@cinatra-ai/objects";
import { parseClaimDispositions } from "@cinatra-ai/objects/claims";

export type { LifecycleClaim };

/**
 * Resolve a claimed type's registered validation predicate from the object-type
 * registry — the per-claim activation gate's fail-closed basis (cinatra#1429).
 * The bridge rescan registers per-claim validator entries
 * (`registerClaimValidators`) BEFORE the anchor fires this hook, so an
 * inline-schema claim resolves its own compiled schema; a self-/dependency-
 * registered type resolves its owner's schema; anything unregistered resolves
 * `null` and the gate blocks activation.
 */
export function resolveRegisteredTypeValidator(
  objectTypeId: string,
): ((data: unknown) => boolean) | null {
  const def = objectTypeRegistry.resolve(objectTypeId);
  const schema = def?.schema as
    | { safeParse?: (data: unknown) => { success: boolean } }
    | undefined;
  if (!schema || typeof schema.safeParse !== "function") return null;
  return (data: unknown) => schema.safeParse!(data).success;
}

/**
 * Read the manifest `objectTypes` claims from a materialized store dir's
 * `package.json` (the SRI-verified bytes the install pipeline just wrote — the
 * same trusted source the bridge rescan registers from; never imports package
 * code). Returns `[]` for a valid artifact manifest with no claims (so a
 * version that DROPPED its claims still retires them), `null` when the dir is
 * not a readable valid `kind:"artifact"` package (the rescan refused those
 * before the hook fires; belt-and-braces here).
 */
export async function readInstallAnchorManifestClaims(
  storeDir: string,
): Promise<LifecycleClaim[] | null> {
  const manifest = await readInstallAnchorManifest(storeDir);
  return manifest ? manifest.claims : null;
}

/** ONE read + parse of the store dir's `package.json` yielding the claims AND
 * the manifest's own `version` — the backstop's stale-record fence needs both
 * from the SAME bytes (codex round-5: a split second read could fail after the
 * first succeeded — e.g. a concurrently-reaped digest dir — and silently
 * disable the fence). `null` = unreadable / not a valid artifact manifest
 * (fail closed at every caller); `manifestVersion: null` = the version FIELD
 * is genuinely absent (github/local sources), which is the only fence
 * degrade-open case. */
async function readInstallAnchorManifest(
  storeDir: string,
): Promise<{ claims: LifecycleClaim[]; manifestVersion: string | null } | null> {
  let pkg: {
    name?: unknown;
    version?: unknown;
    cinatra?: { kind?: unknown; artifact?: unknown };
  };
  try {
    const { readFile } = await import("node:fs/promises");
    pkg = JSON.parse(await readFile(`${storeDir}/package.json`, "utf8"));
  } catch {
    return null;
  }
  if (pkg?.cinatra?.kind !== "artifact" || typeof pkg.name !== "string") return null;
  // A PRESENT-but-malformed version (null/number/...) must not be conflated
  // with an absent field — that would silently disable the stale-record fence
  // (codex round-6). Malformed ⇒ the whole manifest is invalid (fail closed).
  if ("version" in pkg && typeof pkg.version !== "string") return null;
  const parsed = parseSemanticArtifactManifest(pkg.cinatra?.artifact);
  if (!parsed.ok) return null;
  return {
    claims: (parsed.manifest.objectTypes ?? []).map((c) => ({
      type: c.type,
      claim: c.claim,
      ...(c.dispositions !== undefined ? { dispositions: c.dispositions } : {}),
    })),
    manifestVersion: typeof pkg.version === "string" ? pkg.version : null,
  };
}

export interface InstallAnchorClaimActivationInput {
  /** 'platform' | 'org:<id>' — from the canonical row's organization scope. */
  scope: string;
  extensionPackage: string;
  extensionVersion: string;
  /** The canonical install row id (recorded on reserved claims). */
  installId: string | null;
  /** The CURRENT manifest's `objectTypes` claims (may be empty). */
  claims: readonly LifecycleClaim[];
  /**
   * Per-claim activation-gate resolver. Defaults to the registry-backed
   * `resolveRegisteredTypeValidator` — the gate is ALWAYS supplied at this
   * anchor (fail-closed); tests inject a stub.
   */
  resolveTypeValidator?: (objectTypeId: string) => ((data: unknown) => boolean) | null;
}

export type InstallAnchorClaimActivationResult =
  | {
      /** Fresh activation (incl. reinstall-after-uninstall replay). */
      outcome: "activated";
      activatedClaims: number;
      replayedOperationIds: string[];
    }
  | {
      /** Idempotent re-fire: nothing to activate (a stranded owed replay may
       *  still have been drained — its ids are reported). */
      outcome: "noop";
      reason: "no-claims" | "live-claims-match";
      liveClaims: number;
      replayedOperationIds: string[];
    }
  | {
      /** Claim-set change: retired the stale set, replayed + activated the current one. */
      outcome: "rewired";
      retiredClaims: number;
      activatedClaims: number;
      replayedOperationIds: string[];
    }
  | {
      /** Lifecycle failure — NEVER thrown at the anchor. The lifecycle already
       *  retired this call's partially-activated claims. */
      outcome: "failed";
      conflict: boolean;
      reason: string;
    };

/** Stable sorted-key stringify so jsonb round-trips compare structurally. */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

/** Normalize a MANIFEST dispositions payload exactly like reserve-time storage
 * (zod parse applies the schema defaults) so it compares against the stored
 * jsonb. An invalid payload normalizes to a never-matching sentinel — the
 * change route then surfaces the reserve-time validation error (fail-closed). */
function normalizeManifestDispositions(dispositions: unknown): string | null {
  if (dispositions === undefined || dispositions === null) return null;
  const parsed = parseClaimDispositions(dispositions);
  if (!parsed.ok) return "<invalid-dispositions>";
  return stableStringify(parsed.dispositions);
}

/**
 * Drain EVERY owed (completed, not-yet-replayed) uninstall operation for this
 * (scope, package), newest-first — not just the latest one. The single-op
 * replay (`replayArtifactExtensionReinstall`) can strand an OLDER owed
 * operation: a retire whose claim-retirement half failed after archival leaves
 * operation A owed; the retried retire opens a (now-empty) operation B; a
 * latest-only replay consumes B and A's archived classic assertions would be
 * lost. Draining all owed operations makes every hook fire converge: the
 * per-assertion replay INSERT is guarded (skips when a live same-extension
 * assertion exists), so newest-first replay keeps the newest state and older
 * duplicates skip.
 *
 * Termination is MONOTONIC-PROGRESS, not a count cap (a cap would strand
 * whatever legitimate history sits past it): every replay stamps
 * `replayed_at`, so the owed set strictly shrinks and the loop ends. Seeing an
 * ALREADY-REPLAYED id again means the stamp did not land (a store regression)
 * — throw BEFORE any further mutation (→ the hook's non-throwing boundary
 * reports a 'failed' outcome; the next fire retries the drain).
 */
function drainOwedUninstallReplays(ctx: ArtifactClaimLifecycleContext): string[] {
  const replayedOperationIds: string[] = [];
  const seen = new Set<string>();
  for (;;) {
    const owed = findReplayableUninstallOperation({
      scope: ctx.scope,
      extensionPackage: ctx.extensionPackage,
    });
    if (!owed) break;
    if (seen.has(owed.id)) {
      throw new Error(
        `owed-replay drain is not progressing: operation '${owed.id}' is still owed after its replay — refusing to loop`,
      );
    }
    seen.add(owed.id);
    replayArtifactUninstallOperation({ operationId: owed.id, installId: ctx.installId ?? null });
    replayedOperationIds.push(owed.id);
  }
  return replayedOperationIds;
}

const HEALTHY_LIVE_STATUSES = new Set<string>(["active", "dormant"]);

function claimKey(objectTypeId: string, claimKind: string): string {
  return `${claimKind} ${objectTypeId}`;
}

/**
 * True iff the extension's LIVE claims are exactly the manifest claims, each
 * in a HEALTHY live status ('active', or 'dormant' for a dominated default)
 * with matching dispositions. 'reserved' (activation never landed) and
 * 'retiring' (retirement never finalized) are live per the one-live-claimant
 * indexes but NOT healthy — they route through retire+replay, which repairs
 * the stuck transition.
 */
function liveClaimsMatchManifest(
  live: readonly ArtifactTypeClaimRow[],
  claims: readonly LifecycleClaim[],
): boolean {
  if (live.length !== claims.length) return false;
  const liveByKey = new Map(live.map((c) => [claimKey(c.objectTypeId, c.claimKind), c]));
  if (liveByKey.size !== live.length) return false;
  for (const claim of claims) {
    const row = liveByKey.get(claimKey(claim.type, claim.claim));
    if (!row || !HEALTHY_LIVE_STATUSES.has(row.status)) return false;
    const stored = row.dispositions == null ? null : stableStringify(row.dispositions);
    if (normalizeManifestDispositions(claim.dispositions) !== stored) return false;
  }
  return true;
}

/**
 * The install-anchor activation hook body. Diff-first, then the narrowest
 * lifecycle route (see the module header). Synchronous (the lifecycle + stores
 * are sync leaves) and non-throwing.
 */
export function runInstallAnchorClaimActivation(
  input: InstallAnchorClaimActivationInput,
): InstallAnchorClaimActivationResult {
  try {
    const ctx: ArtifactClaimLifecycleContext = {
      scope: input.scope,
      extensionPackage: input.extensionPackage,
      extensionVersion: input.extensionVersion,
      actor: "system",
      installId: input.installId,
      resolveTypeValidator: input.resolveTypeValidator ?? resolveRegisteredTypeValidator,
    };
    // Drain owed replays FIRST — even a manifest with ZERO current claims (or
    // a healthy live-match re-fire) must never leave an owed operation's
    // archived classic assertions permanently ineligible.
    const replayedOperationIds = drainOwedUninstallReplays(ctx);
    const existing = readArtifactTypeClaimsForExtension(input.scope, input.extensionPackage);
    const live = existing.filter((c) => c.status !== "retired");

    if (live.length > 0) {
      // The live-match no-op is only safe when the drain consumed NOTHING: a
      // drained operation's BINDING-basis lineage is never replayed as classic
      // (bindings regenerate only via the reconcile queue that claim
      // ACTIVATION enqueues), so a match short-circuit after a real drain
      // would leave those bindings absent forever. A drain-then-match state
      // (a partially-failed retire whose survivors happen to match) forces the
      // rewire route below, whose reactivation enqueues the reconcile.
      if (replayedOperationIds.length === 0 && liveClaimsMatchManifest(live, input.claims)) {
        return {
          outcome: "noop",
          reason: "live-claims-match",
          liveClaims: live.length,
          replayedOperationIds,
        };
      }
      // Claim-set CHANGE (incl. stuck 'reserved'/'retiring' repair, a manifest
      // that dropped every claim, and the forced post-drain rewire above):
      // retire the stale set, drain its just-opened archival operation (plus
      // anything a mid-retire crash on a PRIOR fire stranded), then replay +
      // activate the current set. Never a raw second activate.
      const retired = retireArtifactExtensionClaims(ctx);
      replayedOperationIds.push(...drainOwedUninstallReplays(ctx));
      const replayed = replayArtifactExtensionReinstall(ctx, input.claims);
      return {
        outcome: "rewired",
        retiredClaims: retired.retiredClaims.length,
        activatedClaims: replayed.activated.length,
        replayedOperationIds,
      };
    }
    if (input.claims.length === 0) {
      return { outcome: "noop", reason: "no-claims", liveClaims: 0, replayedOperationIds };
    }
    // No live claims: a fresh install, or a reinstall whose owed operations the
    // drain above just replayed — the lifecycle reinstall now finds nothing
    // owed and activates the current claims (a plain install).
    const replayed = replayArtifactExtensionReinstall(ctx, input.claims);
    if (replayed.replayedOperationId) replayedOperationIds.push(replayed.replayedOperationId);
    return {
      outcome: "activated",
      activatedClaims: replayed.activated.length,
      replayedOperationIds,
    };
  } catch (error) {
    return {
      outcome: "failed",
      conflict: error instanceof ArtifactClaimConflictError,
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface InstallAnchorClaimBackstopResult {
  /** Hook fires that returned activated/rewired/noop. */
  converged: number;
  /** Hook fires that reported a 'failed' outcome, or packages that threw. */
  failed: number;
  /** Records skipped: unreadable/non-artifact manifest, or no single live
   *  default artifact canonical row in a scope. */
  skipped: number;
}

/**
 * BOOT BACKSTOP (cinatra#1493): re-fire the idempotent activation hook for
 * every install-active artifact package the boot bridge rescan just
 * registered — the claim-activation parallel of "the boot rescan is the
 * durable path". The install-time hook is NON-THROWING by contract, so a
 * fire that lost a race / hit a transient lifecycle failure ends as a
 * console.warn only; nothing else re-drives activation until another
 * qualifying install event. This backstop makes that failure converge at the
 * next boot instead of persisting indefinitely: a healthy install no-ops
 * (live-claims match — one registry read), a previously-failed or drifted
 * activation routes through the hook's ordinary repair paths.
 *
 * Fires once per (package, live canonical-row scope): an org-scoped and a
 * platform-scoped install of the same package each activate their own claim
 * registry scope. Row pick per scope mirrors the install path
 * (`pickSingleActiveRow`: live status + exactly one default row — fail
 * closed on ambiguity). Never throws; per-package failures are isolated.
 */
export async function runInstallAnchorClaimBackstop(
  records: ReadonlyArray<{ packageName: string; storeDir: string }>,
): Promise<InstallAnchorClaimBackstopResult> {
  const result: InstallAnchorClaimBackstopResult = { converged: 0, failed: 0, skipped: 0 };
  for (const rec of records) {
    try {
      // ONE read yields the claims AND the vetted manifest's version — a split
      // second read could fail after the first succeeded (concurrently-reaped
      // digest dir) and silently disable the fence below (codex round-5).
      const manifest = await readInstallAnchorManifest(rec.storeDir);
      if (manifest === null) {
        result.skipped += 1;
        continue;
      }
      const { claims, manifestVersion } = manifest;
      const { readInstalledExtensionsByPackageName } = await import(
        "@cinatra-ai/extensions/canonical-store"
      );
      const { pickSingleActiveRow } = await import("@/lib/extension-install-anchor");
      const rows = await readInstalledExtensionsByPackageName(rec.packageName);
      const liveOrgScopes = new Set(
        rows
          .filter((r) => r.status === "active" || r.status === "locked")
          .map((r) => r.organizationId ?? null),
      );
      if (liveOrgScopes.size === 0) {
        // An ungoverned (no-row) bundled/disk artifact (CG-1): no install, no
        // claim scope to activate against.
        result.skipped += 1;
        continue;
      }
      for (const orgId of liveOrgScopes) {
        const row = pickSingleActiveRow(rows, orgId);
        if (!row || row.kind !== "artifact") {
          result.skipped += 1;
          continue;
        }
        // The row's LIVE provenance identity: updates rewrite `source.version`
        // (the pipeline tail) on the SAME canonical row — the separate
        // `version` column can lag, so the trusted anchor's own identity
        // (`row.source.version`) is the one the fence must compare (codex
        // round-5 High). The column is the fallback for sources that carry no
        // version of their own.
        const rowSourceVersion =
          row.source && typeof (row.source as { version?: unknown }).version === "string"
            ? (row.source as { version: string }).version
            : null;
        const rowLiveVersion = rowSourceVersion ?? row.version ?? null;
        // STALE-RECORD FENCE (codex round-4 High): the rescan vetted this
        // store dir against the canonical state it saw; the rows above are a
        // FRESH read. A concurrent update can finalize a NEW version between
        // the two — the vetted manifest would then rewire the new row's claims
        // back to the OLD version's set while recording the new row's
        // provenance. The store manifest's own `version` identifies the vetted
        // materialization (registry versions are immutable), so a row whose
        // live provenance version no longer matches is skipped fail-closed —
        // the row's own install fire (or the next boot's rescan) carries the
        // current manifest. Degrades open only when a side genuinely carries
        // no version (github/local). Residual TOCTOU between this check and
        // the activate shrinks to the anchor's designed idempotent-overlap
        // window (a lost race converges on the next fire).
        if (manifestVersion !== null && rowLiveVersion !== null && rowLiveVersion !== manifestVersion) {
          result.skipped += 1;
          console.warn(
            `[claim-activation-backstop] "${rec.packageName}" (${orgId ? `org:${orgId}` : "platform"}) ` +
              `skipped: canonical row provenance version ${rowLiveVersion} no longer matches the ` +
              `rescan-vetted store manifest ${manifestVersion} (stale-record fence)`,
          );
          continue;
        }
        const activation = runInstallAnchorClaimActivation({
          scope: orgId ? `org:${orgId}` : "platform",
          extensionPackage: rec.packageName,
          // The live provenance version — the pipeline-RESOLVED identity the
          // trusted anchor itself uses; never a dist-tag. `0.0.0` mirrors the
          // store's own floor for version-less github/local sources.
          extensionVersion: rowLiveVersion ?? "0.0.0",
          installId: row.id,
          claims,
        });
        if (activation.outcome === "failed") {
          result.failed += 1;
          console.warn(
            `[claim-activation-backstop] "${rec.packageName}" (${orgId ? `org:${orgId}` : "platform"}) ` +
              `still failing (${activation.conflict ? "claim conflict" : "lifecycle error"}): ${activation.reason}`,
          );
        } else {
          result.converged += 1;
          if (activation.outcome !== "noop") {
            console.info(
              `[claim-activation-backstop] "${rec.packageName}" (${orgId ? `org:${orgId}` : "platform"}) ` +
                `converged: ${JSON.stringify(activation)}`,
            );
          }
        }
      }
    } catch (err) {
      result.failed += 1;
      console.warn(
        `[claim-activation-backstop] "${rec.packageName}" threw (non-fatal):`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return result;
}
