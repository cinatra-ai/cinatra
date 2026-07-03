import "server-only";

// FINALIZED store-payload resolver (cinatra#793).
//
// The unified content-addressed store (`<CINATRA_EXTENSION_DATA_ROOT>/<kind>/
// <slug>/<digest>/`) is materialized + finalized by the shared real-integrity
// install pipeline, which the dispatcher fires BEFORE the native per-kind
// handler for the metadata-only kinds (agent / skill / artifact). This module
// is the handlers' READ seam onto that store: given a package name it resolves
// the TRUSTED anchor (canonical row + finalized install-op journal — the same
// journal-gated selection the boot loader uses; the writable store itself is
// never a trust input) and returns the on-disk digest dir the anchor pins.
//
// Returns null (never throws) when no finalized verdaccio install exists for
// the package, the anchor's kind contradicts `expectedKind`, or the pinned
// digest dir is not on disk — callers decide whether that is fatal (the skill
// verdaccio installer) or a fallback trigger (the agent installer's
// registry-extract fallback for saga-external transitive dependencies).

import path from "node:path";
import { existsSync } from "node:fs";

import type { ExtensionStoreKind } from "@/lib/extension-package-store-core";

export type FinalizedStorePayload = {
  /** Absolute path of the finalized digest dir (`package.json` at its top). */
  storeDir: string;
  /** The journal-confirmed active tarball digest the dir is named by. */
  digest: string;
  /** The anchor's recorded install version (null on legacy rows). */
  version: string | null;
  /** The anchor's recorded registry identity URL (null on legacy rows). */
  registryUrl: string | null;
};

/**
 * Resolve the FINALIZED store payload dir for a package.
 *
 * `orgId` semantics mirror the anchor resolver: pass the install's org scope
 * (`null` = platform scope) for an exact-org resolution; OMIT it entirely for
 * the platform-global resolution (the single live row across all orgs — the
 * boot-loader semantics, used by callers with no org context).
 */
export async function resolveFinalizedStorePayload(input: {
  packageName: string;
  orgId?: string | null;
  expectedKind: ExtensionStoreKind;
}): Promise<FinalizedStorePayload | null> {
  try {
    const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");
    const hasOrgScope = Object.prototype.hasOwnProperty.call(input, "orgId") && input.orgId !== undefined;
    const resolver = await makeDefaultInstallAnchorResolver(
      hasOrgScope ? (input.orgId ?? null) : null,
      hasOrgScope ? "exact-org" : "platform-global",
    );
    const anchor = await resolver(input.packageName);
    if (!anchor || !anchor.digest) return null;
    // KIND binding (fail closed): the anchor surfaces the canonical row's kind;
    // a contradiction with the caller's expectation must never hand a payload
    // from another kind's subtree to this kind's handler.
    if (anchor.kind != null && anchor.kind !== input.expectedKind) return null;

    const { storeDigestDirV2, assertValidStorePackageName } = await import(
      "@/lib/extension-package-store-core"
    );
    assertValidStorePackageName(input.packageName);
    const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
    const storeDir = storeDigestDirV2(
      resolveExtensionDataRoot(),
      input.expectedKind,
      input.packageName,
      anchor.digest,
    );
    if (!existsSync(path.join(storeDir, "package.json"))) return null;
    return {
      storeDir,
      digest: anchor.digest,
      version: anchor.version ?? null,
      registryUrl: anchor.registryUrl ?? null,
    };
  } catch {
    // Resolution is a read-only convenience seam — a store/DB hiccup reads as
    // "no finalized payload"; the caller owns the fail-loud decision.
    return null;
  }
}
