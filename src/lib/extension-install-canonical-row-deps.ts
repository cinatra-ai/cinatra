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

type CanonicalRowInstallDeps = Pick<
  InstallPipelineDeps,
  | "recordProvenance"
  | "readActiveDigest"
  | "readCurrentSource"
  | "readCurrentDependencies"
  | "persistDependencyEdges"
  | "readCurrentAccessDeclaration"
  | "persistAccessDeclaration"
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
  };
}
