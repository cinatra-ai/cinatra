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
//
// THE SUPPLIED ROAD (cinatra#3204 leg 3). A package the operator supplied as a
// file or pointed at in a repository is on NO registry, so its canonical row
// records an honest `local` / `github` source rather than a `verdaccio` one.
// The import-trust anchor above admits a verdaccio source alone — by design: it
// is the gate that decides whether a package's code may be IMPORTED into this
// process, and a supplied package carries no registry attestation to weigh. So
// a supplied install resolved no payload here at all, and the agent and skill
// handlers refused bytes the pipeline had just materialized, verified against
// the previewed content digest, and finalized.
//
// `selectSuppliedStorePayloadDigest` below is the supplied road onto those same
// finalized bytes. It answers a DIFFERENT question from the anchor — "which
// finalized store dir do these bytes live in", never "may this package be
// imported" — and it is fenced accordingly:
//
//   - only the METADATA-ONLY kinds (agent / skill / artifact) resolve here. The
//     connector kind, whose whole install exists to run `register(ctx)` in this
//     process, is refused BY NAME, so nothing about in-process activation is
//     widened by this road;
//   - the row must be LIVE and its source a supplied one carrying a well-formed
//     content digest (`isSuppliedDigestSource` — the same single predicate the
//     pipeline gate reads), so a pre-#3204 local/github row keeps exactly the
//     handling it had;
//   - the install-op journal must report `finalized` — the identical PRIMARY
//     trust gate the anchor applies, unchanged;
//   - the digest is the SHARED journal-gated selection (`selectActiveDigest`),
//     so a row digest the journal does not confirm FAILS CLOSED here exactly as
//     it does on the anchor road.

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";

import { isSuppliedDigestSource } from "@cinatra-ai/extensions/canonical-types";

import { selectActiveDigest } from "@/lib/extension-install-anchor";
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
 * The kinds a SUPPLIED install may resolve a store payload for: the
 * metadata-only ones the dispatcher runs the pipeline BEFORE the handler for.
 * `connector` is deliberately absent — see the module header.
 */
const SUPPLIED_STORE_PAYLOAD_KINDS: ReadonlySet<string> = new Set([
  "agent",
  "skill",
  "artifact",
]);

/** The minimal canonical-row view the supplied selector reads. */
export type SuppliedStorePayloadRow = {
  status: string;
  kind?: string | null;
  source: unknown;
};

/**
 * PURE: the finalized store digest a SUPPLIED install pins, or null.
 *
 * Every refusal is a fail-closed one; see the module header for the four gates
 * and why each is here.
 */
export function selectSuppliedStorePayloadDigest(input: {
  expectedKind: ExtensionStoreKind;
  row: SuppliedStorePayloadRow | null | undefined;
  op: { phase: string; digest?: string | null } | null | undefined;
}): string | null {
  if (!SUPPLIED_STORE_PAYLOAD_KINDS.has(input.expectedKind)) return null;
  const row = input.row;
  if (!row || (row.status !== "active" && row.status !== "locked")) return null;
  if (!isSuppliedDigestSource(row.source)) return null;
  // KIND binding (fail closed), the same one the anchor road applies: a row
  // whose kind contradicts the caller must never hand another kind's subtree to
  // this kind's handler.
  if (row.kind != null && row.kind !== input.expectedKind) return null;
  const op = input.op;
  if (!op || op.phase !== "finalized") return null;
  const selection = selectActiveDigest({
    activeDigest: (row.source as { activeDigest?: string }).activeDigest ?? null,
    journalDigest: op.digest ?? null,
  });
  if (!selection.ok || !selection.digest) return null;
  return selection.digest;
}

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
  const hasOrgScope =
    Object.prototype.hasOwnProperty.call(input, "orgId") && input.orgId !== undefined;
  try {
    const { makeDefaultInstallAnchorResolver } = await import("@/lib/extension-install-anchor");
    const resolver = await makeDefaultInstallAnchorResolver(
      hasOrgScope ? (input.orgId ?? null) : null,
      hasOrgScope ? "exact-org" : "platform-global",
    );
    const anchor = await resolver(input.packageName);
    if (anchor && anchor.digest) {
      // KIND binding (fail closed): the anchor surfaces the canonical row's kind;
      // a contradiction with the caller's expectation must never hand a payload
      // from another kind's subtree to this kind's handler.
      if (anchor.kind != null && anchor.kind !== input.expectedKind) return null;
      return await readStorePayloadAtDigest(input, anchor.digest, {
        version: anchor.version ?? null,
        registryUrl: anchor.registryUrl ?? null,
      });
    }
  } catch {
    // Resolution is a read-only convenience seam — a store/DB hiccup reads as
    // "no finalized payload"; the caller owns the fail-loud decision.
    return null;
  }
  try {
    return await resolveSuppliedFinalizedStorePayload(input, hasOrgScope);
  } catch {
    return null;
  }
}

/**
 * The SUPPLIED road's resolution (cinatra#3204 leg 3): the live canonical row
 * plus its finalized install-op journal, through the pure selector above.
 *
 * The version is read from the FINALIZED BYTES rather than from the row. A
 * supplied source carries no version field, so the canonical store floors the
 * row's `version` column to `0.0.0` for every local/github row — comparing a
 * handler's requested version against that floor would refuse every supplied
 * install of every version. The manifest inside the digest dir is the version
 * of the exact bytes the pipeline verified and finalized, which is the thing
 * the handlers' equality check is actually asking about.
 */
async function resolveSuppliedFinalizedStorePayload(
  input: { packageName: string; orgId?: string | null; expectedKind: ExtensionStoreKind },
  hasOrgScope: boolean,
): Promise<FinalizedStorePayload | null> {
  if (!SUPPLIED_STORE_PAYLOAD_KINDS.has(input.expectedKind)) return null;
  const orgId = hasOrgScope ? (input.orgId ?? null) : null;
  const { readInstalledExtensionsByPackageName } = await import(
    "@cinatra-ai/extensions/canonical-store"
  );
  const { pickExactOrgActiveRow, pickSingleLiveRowAcrossOrgs } = await import(
    "@/lib/extension-install-anchor"
  );
  const rows = await readInstalledExtensionsByPackageName(input.packageName);
  // The same two resolution scopes the anchor resolver offers, and for the same
  // reasons: an install-time caller binds its own (package, org) scope; a caller
  // with no org context takes the single live row across orgs (fail-closed on
  // ambiguity) and reads the journal at THAT row's own org.
  const row = hasOrgScope
    ? pickExactOrgActiveRow(rows, orgId)
    : pickSingleLiveRowAcrossOrgs(rows);
  if (!row) return null;
  const journalOrgId = hasOrgScope ? orgId : (row.organizationId ?? null);
  const { readInstallOp } = await import("@/lib/extension-install-ops");
  const op = await readInstallOp(input.packageName, journalOrgId);
  const digest = selectSuppliedStorePayloadDigest({
    expectedKind: input.expectedKind,
    row: { status: row.status, kind: row.kind, source: row.source },
    op,
  });
  if (!digest) return null;
  return await readStorePayloadAtDigest(input, digest, { version: null, registryUrl: null });
}

/**
 * Bind a selected digest to the on-disk store dir, or null when the dir the
 * record pins is not there. `version` falls back to the manifest inside the
 * finalized bytes when the record carries none (the supplied road).
 */
async function readStorePayloadAtDigest(
  input: { packageName: string; expectedKind: ExtensionStoreKind },
  digest: string,
  recorded: { version: string | null; registryUrl: string | null },
): Promise<FinalizedStorePayload | null> {
  const { storeDigestDirV2, assertValidStorePackageName } = await import(
    "@/lib/extension-package-store-core"
  );
  assertValidStorePackageName(input.packageName);
  const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
  const storeDir = storeDigestDirV2(
    resolveExtensionDataRoot(),
    input.expectedKind,
    input.packageName,
    digest,
  );
  const manifestPath = path.join(storeDir, "package.json");
  if (!existsSync(manifestPath)) return null;
  let version = recorded.version;
  if (version === null) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: unknown };
      version = typeof manifest.version === "string" ? manifest.version : null;
    } catch {
      version = null;
    }
  }
  return { storeDir, digest, version, registryUrl: recorded.registryUrl };
}
