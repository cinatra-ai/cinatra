import "server-only";

// The CANONICAL-ROW slice of the install pipeline's default deps — every dep
// here resolves the SINGLE active `installed_extension` row for the install's
// exact (package, org) scope and reads or writes that row's canonical source /
// dependency edges:
//
//  - `recordProvenance`        — the outcome-seam provenance write (the ONLY
//                                sanctioned writer, `sourceSwitchExtension`) +
//                                the `current` mirror (cinatra#792);
//  - `readActiveDigest`        — the finalize-time cross-check basis (#792);
//  - `readCurrentSource`       — the rollback capture of the prior source;
//  - `readCurrentDependencies` — the rollback capture of the prior edges (#180);
//  - `persistDependencyEdges`  — the finalize-seam edge write (#180).
//
// Extracted VERBATIM from `extension-install-pipeline.ts`'s default factory
// (the pipeline is a baselined file-size-ratchet bottleneck: vertical slices
// move OUT; ceilings only shrink). Behavior-identical: same fail-closed
// single-row resolution, same write order, same dynamic imports.

import type { InstallPipelineDeps } from "@/lib/extension-install-pipeline";

/**
 * Canonical-row install deps for the widget-auth DECLARED token keys (owner
 * ruling 2026-07-23 — the widget-auth delivery fix, path B). Records the
 * SRI-verified manifest's declared `cinatra.widgetStream[.auth].tokenConfigKey`
 * set onto the SAME canonical row the provenance/edges/access-declaration writes
 * bind (boundRowId-aware), so the marketplace-install-PROVENANCE owner arm
 * (arm (c)) reads its P5 declaration from the tamper-proof canonical column
 * instead of re-reading the mutable `/data/extensions` store. Written at the
 * FINALIZE SEAM (after `recordProvenance`) so the column is crash-consistent
 * with the row's source: a crash between the source write and journal-finalize
 * leaves the row un-anchorable (`selectActiveDigest` mismatch), so an OLD
 * finalized anchor can never pair with NEW-version keys.
 */
export type WidgetAuthTokenKeysInstallDeps = {
  /** Persist the CURRENT declared token keys (incl. `[]` — a re-install that
   * DROPS a key clears the stale non-empty value) onto the SAME (package, org)
   * row the provenance write binds. */
  persistWidgetAuthTokenKeys?: (input: {
    packageName: string;
    orgId: string | null;
    tokenKeys: string[];
  }) => Promise<void>;
  /** Capture the row's CURRENT `widget_auth_token_keys` for the (package, org)
   * BEFORE the finalize seam overwrites it — restored on a failed UPDATE
   * (`null` = legacy/absent, restored as the explicit clear). */
  readCurrentWidgetAuthTokenKeys?: (
    packageName: string,
    orgId: string | null,
  ) => Promise<string[] | null>;
};

type CanonicalRowInstallDeps = Pick<
  InstallPipelineDeps,
  | "recordProvenance"
  | "readActiveDigest"
  | "readCurrentSource"
  | "readCurrentDependencies"
  | "persistDependencyEdges"
  | "readCurrentAccessDeclaration"
  | "persistAccessDeclaration"
  | "persistWidgetAuthTokenKeys"
  | "readCurrentWidgetAuthTokenKeys"
>;

/**
 * Build the canonical-row deps for `makeDefaultInstallPipelineDeps`.
 *
 * `provenanceRegistryUrl` maps the install request's registry URL to the FINAL
 * provenance identity: a gatekept install fetches through the marketplace
 * broker read-proxy but must record the real `registry.cinatra.ai` identity,
 * NEVER the broker URL — the loader classifies trust on the recorded registry
 * URL, so recording the delivery mechanism would corrupt the trust anchor.
 * When gatekeeping is OFF the mapper returns the input unchanged.
 */
export function makeCanonicalRowInstallDeps(opts: {
  provenanceRegistryUrl: (requestRegistryUrl: string) => string;
  /**
   * BIND every canonical-row read/write to this EXACT row id instead of the
   * (package, org) single-default-row resolution (cinatra#1040 S3 — the
   * side-by-side installer targets its own NON-DEFAULT version row; the
   * default resolution would bind the DEFAULT row and clobber its provenance/
   * edges). The bound row must still match the requested (package, org) scope
   * — a mismatch fails closed.
   */
  boundRowId?: string;
  /**
   * Whether `recordProvenance` mirrors the digest into the plain-text
   * per-PACKAGE `current` store file (default true). The side-by-side
   * installer passes FALSE: `current` is package-scoped shared state owned by
   * the DEFAULT version — a non-default install must never repoint it.
   */
  mirrorCurrentDigest?: boolean;
}): CanonicalRowInstallDeps {
  const resolveTarget = async (packageName: string, orgId: string | null) => {
    if (opts.boundRowId) {
      const { readInstalledExtensionById } = await import(
        "@cinatra-ai/extensions/canonical-store"
      );
      const row = await readInstalledExtensionById(opts.boundRowId);
      if (!row || row.packageName !== packageName || (row.organizationId ?? null) !== orgId) {
        return null; // fail closed at the call sites, same as ambiguous scope
      }
      return row;
    }
    const { readInstalledExtensionsByPackageName } = await import(
      "@cinatra-ai/extensions/canonical-store"
    );
    const { pickSingleActiveRow } = await import("@/lib/extension-install-anchor");
    const rows = await readInstalledExtensionsByPackageName(packageName);
    return pickSingleActiveRow(rows, orgId);
  };

  return {
    recordProvenance: async (p) => {
      // The ONLY sanctioned provenance writer is sourceSwitchExtension (it
      // re-validates the source then writes via the lifecycle path). Resolve the
      // canonical row for the SAME (package, org) scope the journal + grant use,
      // so a multi-org package never records one org's source against another
      // org's finalized journal/grant (the trust gate must resolve ONE row).
      // Exactly ONE active row must match this (package, org) scope; 0 or >1
      // (ambiguous owner scope) fails closed — provenance must bind the single
      // row the anchor will later resolve, never an arbitrary owner's install.
      const target = await resolveTarget(p.packageName, p.orgId);
      if (!target) {
        throw new Error(
          `recordProvenance: expected exactly 1 active installed_extension row for ${p.packageName} in org ${p.orgId ?? "(global)"} (0 or ambiguous owner scope) — fail closed`,
        );
      }
      const { sourceSwitchExtension } = await import("@cinatra-ai/extensions/lifecycle-primitive");
      await sourceSwitchExtension(
        target.id,
        {
          type: "verdaccio",
          registryUrl: opts.provenanceRegistryUrl(p.registryUrl),
          packageName: p.packageName,
          version: p.version,
          integrity: p.integrity,
          contentHash: p.contentHash,
          ...(p.attestedSha256 ? { attestedSha256: p.attestedSha256 } : {}),
          ...(p.signature ? { signature: p.signature } : {}),
          ...(p.closureHash ? { closureHash: p.closureHash } : {}),
          // cinatra#792: the DB-authoritative active digest, written at the
          // outcome seam (forward install AND durable-rollback re-record).
          // Absent when the caller carried none (legacy prior source) — read-
          // time selection then falls back to the journal digest.
          ...(p.digest ? { activeDigest: p.digest } : {}),
        },
        { actor: { source: "runtime-installer" }, reason: `runtime install provenance @ ${p.version}` },
      );
      // Mirror the digest into the plain-text `current` store file (cinatra#792)
      // on EVERY activeDigest write — best-effort, never a selector/trust input.
      // SKIPPED for a bound non-default row (cinatra#1040 S3): `current` is
      // package-scoped shared state owned by the default version.
      if (opts.mirrorCurrentDigest !== false) {
        const { mirrorCurrentDigestBestEffort } = await import("@/lib/extension-store-io");
        await mirrorCurrentDigestBestEffort({
          ...(p.storeRoot ? { dataRoot: p.storeRoot } : {}),
          kind: target.kind,
          packageName: p.packageName,
          digest: p.digest,
        });
      }
    },
    // FINALIZE-TIME CROSS-CHECK basis (cinatra#792): the canonical row's
    // just-written activeDigest at the SAME (package, org) scope.
    readActiveDigest: async (packageName, orgId) => {
      const target = await resolveTarget(packageName, orgId);
      const src = target?.source;
      if (!src || (src as { type?: string }).type !== "verdaccio") return null;
      return (src as { activeDigest?: string }).activeDigest ?? null;
    },
    // CAPTURE: read the CURRENT canonical verdaccio source for the EXACT
    // (package, org) scope the journal + grant use — captured BEFORE
    // recordProvenance overwrites it, so the post-commit rollback can re-record
    // the OLD source.
    readCurrentSource: async (packageName, orgId) => {
      const target = await resolveTarget(packageName, orgId);
      const src = target?.source;
      if (!src || (src as { type?: string }).type !== "verdaccio") return null;
      const v = src as {
        registryUrl: string;
        version: string;
        integrity: string;
        contentHash?: string;
        attestedSha256?: string;
        signature?: string;
        closureHash?: string;
        activeDigest?: string;
      };
      return {
        registryUrl: v.registryUrl,
        version: v.version,
        integrity: v.integrity,
        ...(v.contentHash ? { contentHash: v.contentHash } : {}),
        ...(v.attestedSha256 ? { attestedSha256: v.attestedSha256 } : {}),
        ...(v.signature ? { signature: v.signature } : {}),
        ...(v.closureHash ? { closureHash: v.closureHash } : {}),
        // cinatra#792: the prior install's DB-authoritative digest — re-pinned
        // (row + `current` mirror) by the durable rollback.
        ...(v.activeDigest ? { activeDigest: v.activeDigest } : {}),
      };
    },
    // CAPTURE (#180): the prior canonical row's persisted dependency edges —
    // restored by both unwind paths when an UPDATE fails after the finalize
    // seam overwrote them with the new manifest's edges.
    readCurrentDependencies: async (packageName, orgId) => {
      const target = await resolveTarget(packageName, orgId);
      return target ? target.dependencies : null;
    },
    // EDGE PERSISTENCE at the finalize seam (#180): the sanctioned canonical
    // writer, bound to the SAME single (package, org) row the provenance write
    // resolved.
    persistDependencyEdges: async (p) => {
      const target = await resolveTarget(p.packageName, p.orgId);
      if (!target) {
        throw new Error(
          `persistDependencyEdges: expected exactly 1 active installed_extension row for ${p.packageName} in org ${p.orgId ?? "(global)"} (0 or ambiguous owner scope) — fail closed`,
        );
      }
      const { recordExtensionDependencies } = await import(
        "@cinatra-ai/extensions/lifecycle-primitive"
      );
      await recordExtensionDependencies(target.id, p.dependencies, {
        actor: { source: "runtime-installer" },
        reason: `manifest dependency edges @ install`,
      });
    },
    // CAPTURE (cinatra#951): the prior canonical row's cached connector access
    // DECLARATION — restored by both unwind paths when an UPDATE fails after
    // the finalize seam overwrote it (mirrors readCurrentDependencies).
    readCurrentAccessDeclaration: async (packageName, orgId) => {
      const target = await resolveTarget(packageName, orgId);
      return target?.accessDeclaration ?? null;
    },
    // DECLARATION PERSISTENCE at the finalize seam (cinatra#951): the
    // sanctioned canonical writer, bound to the SAME single (package, org)
    // row the provenance write resolved.
    persistAccessDeclaration: async (p) => {
      const target = await resolveTarget(p.packageName, p.orgId);
      if (!target) {
        throw new Error(
          `persistAccessDeclaration: expected exactly 1 active installed_extension row for ${p.packageName} in org ${p.orgId ?? "(global)"} (0 or ambiguous owner scope) — fail closed`,
        );
      }
      const { recordExtensionAccessDeclaration } = await import(
        "@cinatra-ai/extensions/lifecycle-primitive"
      );
      await recordExtensionAccessDeclaration(target.id, p.declaration, {
        actor: { source: "runtime-installer" },
        reason: `connector access declaration @ install`,
      });
    },
    // WIDGET-AUTH DECLARED TOKEN KEYS at the finalize seam (owner ruling
    // 2026-07-23): the SRI-verified manifest's declared token keys land on the
    // SAME single (package, org) row the provenance write resolved (boundRowId-
    // aware, so a non-default side-by-side install writes to its OWN row, never
    // clobbering the default's declaration). The tamper-proof P5 source arm (c)
    // reads.
    persistWidgetAuthTokenKeys: async (p) => {
      const target = await resolveTarget(p.packageName, p.orgId);
      if (!target) {
        throw new Error(
          `persistWidgetAuthTokenKeys: expected exactly 1 active installed_extension row for ${p.packageName} in org ${p.orgId ?? "(global)"} (0 or ambiguous owner scope) — fail closed`,
        );
      }
      const { recordExtensionWidgetAuthTokenKeys } = await import(
        "@cinatra-ai/extensions/lifecycle-primitive"
      );
      await recordExtensionWidgetAuthTokenKeys(target.id, p.tokenKeys, {
        actor: { source: "runtime-installer" },
        reason: `widget-auth declared token keys @ install (owner ruling 2026-07-23)`,
      });
    },
    // CAPTURE (owner ruling 2026-07-23): the prior canonical row's recorded
    // widget-auth token keys — restored by both unwind paths when an UPDATE fails
    // after the finalize seam overwrote it (mirrors readCurrentAccessDeclaration).
    readCurrentWidgetAuthTokenKeys: async (packageName, orgId) => {
      const target = await resolveTarget(packageName, orgId);
      return target?.widgetAuthTokenKeys ?? null;
    },
  };
}

/**
 * WIDGET-AUTH TOKEN-KEYS PERSISTENCE at the FINALIZE SEAM (owner ruling
 * 2026-07-23): record the SRI-verified manifest's declared token keys on the
 * canonical row, with the same crash-consistency guarantees as the dependency
 * edges / access declaration. Written UNCONDITIONALLY (including `[]`) so a
 * re-install that DROPS a key clears a stale non-empty declaration and a null
 * column reliably means "legacy row" (arm (c) fails closed on it). A pure no-op
 * when unwired (older pipeline unit tests). A throw aborts the finalize (the
 * pipeline's existing unwind handles it).
 */
export async function persistWidgetAuthTokenKeysAtFinalize(
  deps: Pick<WidgetAuthTokenKeysInstallDeps, "persistWidgetAuthTokenKeys">,
  input: { packageName: string; orgId: string | null; tokenKeys: readonly string[] },
): Promise<void> {
  if (!deps.persistWidgetAuthTokenKeys) return;
  await deps.persistWidgetAuthTokenKeys({
    packageName: input.packageName,
    orgId: input.orgId,
    tokenKeys: [...input.tokenKeys],
  });
}

/**
 * Restore the OLD recorded token keys on a failed UPDATE (owner ruling
 * 2026-07-23) — the finalize seam may have overwritten them with the NEW
 * manifest's declaration; with the OLD install still live, leaving them would let
 * arm (c) honor the OLD provider for the NEW version's keys. Keyed on `isUpdate`
 * (a fresh install's placeholder row is dropped by the dispatcher — nothing to
 * restore); a captured NULL prior (legacy/absent column) restores to `[]`, never
 * re-manufacturing a stale non-empty value. Best-effort: a failed restore reports
 * through `onFailure` and never throws.
 */
export async function restorePriorWidgetAuthTokenKeys(
  deps: Pick<WidgetAuthTokenKeysInstallDeps, "persistWidgetAuthTokenKeys">,
  input: { packageName: string; orgId: string | null; isUpdate: boolean; prior: string[] | null },
  onFailure: (reason: string) => void,
): Promise<void> {
  if (!input.isUpdate || !deps.persistWidgetAuthTokenKeys) return;
  const persist = deps.persistWidgetAuthTokenKeys;
  try {
    await persist({ packageName: input.packageName, orgId: input.orgId, tokenKeys: input.prior ?? [] });
  } catch (restoreErr) {
    // FAIL CLOSED on a restore-write failure (owner ruling 2026-07-23, codex
    // round-4). If we cannot re-pin the OLD keys, the column must NOT be left
    // holding the failed NEW-version keys — a re-anchored OLD source paired with
    // NEW keys would let arm (c) honor a provider for a store its manifest never
    // declared. Clearing to [] makes arm (c) resolve NO owner (fail-closed) for
    // whatever source ends up anchored. This is a SECOND best-effort write; if it
    // ALSO fails the rollback is doubly non-clean (both errors reported) — the
    // operator-recovery path every durable-restore axis shares. Either way the
    // step is marked failed (a NON-clean rollback), never a silent success.
    const rMsg = restoreErr instanceof Error ? restoreErr.message : String(restoreErr);
    try {
      await persist({ packageName: input.packageName, orgId: input.orgId, tokenKeys: [] });
      onFailure(`token-keys restore failed (${rMsg}); column FAIL-CLOSED to [] instead`);
    } catch (clearErr) {
      const cMsg = clearErr instanceof Error ? clearErr.message : String(clearErr);
      onFailure(`token-keys restore AND fail-closed clear both failed (${rMsg}; ${cMsg})`);
    }
  }
}
