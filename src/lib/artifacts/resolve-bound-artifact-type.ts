import "server-only";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { parseSemanticArtifactManifest } from "@cinatra-ai/objects";
import {
  resolveClaimWinner,
  claimWinnerProjectionDisposition,
} from "@cinatra-ai/objects/claims";
import {
  resolveArtifactBindingObjectType,
  type ResolveArtifactBindingObjectTypeResult,
} from "@cinatra-ai/agents/artifact-binding";
import { readArtifactTypeClaimsForOrg } from "@/lib/objects/artifact-claim-store";

// ---------------------------------------------------------------------------
// Bound-artifact-type resolution seam (cinatra#1454).
//
// The run-completion materializer + the create-from-template path resolve a
// binding/produces `{extension, objectTypeId?}` to the EXACT declared object
// type it materializes into. The retired umbrella `${extension}:artifact`
// (#1824) is GONE: a claim-based pack's declared types are HOST-registered
// (e.g. `@cinatra-ai/email:body`), and the pack CLAIM adds the artifact-safe
// disposition + representation `accepts`.
//
// Codex-converged sourcing (cinatra#1454):
//  - ELIGIBILITY (which declared types are artifact-safe for this extension)
//    comes from the ORG-CHAIN DB claim registry via WINNER ARBITRATION
//    (`resolveClaimWinner` + `claimWinnerProjectionDisposition`), intersected
//    with a currently-REGISTERED host type (`objectTypeRegistry.resolve`).
//    Arbitration is org-level truth; an omitted/invalid disposition defaults to
//    `artifact-safe` (the projector's fail-closed default). Not the arbitrary
//    on-disk manifest.
//  - `accepts` (the representation MIME forms) comes from the resolved type's
//    own `isArtifact.accepts` when it is a SELF-registered bridge artifact type;
//    otherwise (a host-registered claim type carries no `isArtifact`) from the
//    installed pack manifest's pack-level `accepts`. Fail-closed.
//
// PURE decision logic lives in `resolveArtifactBindingObjectType`
// (@cinatra-ai/agents/artifact-binding); this module supplies the host-sourced
// inputs and the accepts. Every read is injectable for unit tests.
// ---------------------------------------------------------------------------

export type ResolvedArtifactTarget = {
  objectTypeId: string;
  /** Accepted representation MIME forms (`accepts.file.mimeTypes`). */
  acceptedFileMimeTypes: string[];
};

export type ResolveBoundArtifactTargetResult =
  | { ok: true; target: ResolvedArtifactTarget }
  | { ok: false; error: string };

export type ResolveBoundArtifactTargetDeps = {
  /** The extension's EFFECTIVE artifact-safe declared type ids for the org
   *  (org-chain winner arbitration ∩ registered host type). */
  readEffectiveArtifactSafeTypeIds?: (orgId: string, extension: string) => readonly string[];
  /** The installed pack's pack-level accepted file MIME types (null when the
   *  manifest is unresolvable/invalid). */
  readExtensionPackAcceptedMimeTypes?: (extension: string) => Promise<string[] | null>;
  /** Registered-type lookup (for the accepts self-registered fallback). */
  resolveRegisteredType?: (typeId: string) => { isArtifact?: { accepts?: { file?: { mimeTypes?: string[] } } } } | null;
  /** The type ids the pack MANIFEST declares (cinatra#2536 diagnostics). */
  readExtensionPackDeclaredObjectTypeIds?: (extension: string) => Promise<string[] | null>;
  /** Install-state explanation for a zero-claim resolution (cinatra#2536). */
  explainAbsentClaims?: (input: {
    orgId: string;
    extension: string;
    declaredObjectTypeIds?: readonly string[];
  }) => Promise<string>;
};

/**
 * Effective artifact-safe declared type ids a given extension provides for an
 * org: the WINNING claim per type whose `extensionPackage` is `extension` and
 * whose projection is `artifact-safe`, intersected with a currently-registered
 * host type. Sync (the claim store is sync); safe to call inside the
 * materializer's per-output try/catch.
 */
export function readEffectiveArtifactSafeTypeIdsForExtension(
  orgId: string,
  extension: string,
): string[] {
  const claims = readArtifactTypeClaimsForOrg(orgId);
  const typeIds = new Set(claims.map((c) => c.objectTypeId));
  const out: string[] = [];
  for (const objectTypeId of typeIds) {
    const winner = resolveClaimWinner(claims, { orgId, objectTypeId });
    if (!winner) continue;
    if (winner.extensionPackage !== extension) continue;
    if (claimWinnerProjectionDisposition(winner) !== "artifact-safe") continue;
    // Intersect with a currently-registered host type — a claim over a type this
    // process never registered cannot be materialized here.
    if (objectTypeRegistry.resolve(objectTypeId) === null) continue;
    out.push(objectTypeId);
  }
  return out.sort();
}

/**
 * Read the installed artifact pack's pack-level accepted file MIME types from
 * the SRI-vetted store manifest (version-preferred) or the bundled extension
 * dir (dev/verify). Reads `package.json` only — never imports package code.
 * `null` when no readable `kind:"artifact"` manifest is found.
 */
export async function readInstalledPackAcceptedMimeTypes(
  extension: string,
): Promise<string[] | null> {
  return (await readInstalledPackManifestFields(extension))?.accepts ?? null;
}

/**
 * The object type ids the installed pack's manifest DECLARES (`objectTypes`).
 * Diagnostics-only (cinatra#2536): it lets a zero-claim failure NAME the type
 * whose claim is missing instead of blaming the manifest that declares it.
 * `null` when no readable `kind:"artifact"` manifest is found.
 */
export async function readInstalledPackDeclaredObjectTypeIds(
  extension: string,
): Promise<string[] | null> {
  return (await readInstalledPackManifestFields(extension))?.objectTypeIds ?? null;
}

/** ONE read of the pack manifest yielding every field the callers above need.
 *  Same discovery order as before: SRI-vetted store records first, then the
 *  bundled/in-tree extension dir (dev/verify). Reads `package.json` only. */
async function readInstalledPackManifestFields(
  extension: string,
): Promise<{ accepts: string[]; objectTypeIds: string[] } | null> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");

  const parseAccepts = (raw: string): { accepts: string[]; objectTypeIds: string[] } | null => {
    let pkg: { cinatra?: { kind?: unknown; artifact?: unknown } };
    try {
      pkg = JSON.parse(raw);
    } catch {
      return null;
    }
    if (pkg?.cinatra?.kind !== "artifact") return null;
    const parsed = parseSemanticArtifactManifest(pkg.cinatra?.artifact);
    if (!parsed.ok) return null;
    return {
      accepts: parsed.manifest.accepts?.file?.mimeTypes ?? [],
      objectTypeIds: (parsed.manifest.objectTypes ?? []).map((c) => c.type),
    };
  };

  // 1. Store records (production): prefer any readable materialized record for
  //    this package (a version-matched select would need the run's pinned
  //    version; the pack-level accepts is version-stable within a published
  //    line, and a mismatch fails closed at the accepts check below).
  try {
    const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
    const { discoverStoreRecordsV2 } = await import("@/lib/extension-store-io");
    const records = await discoverStoreRecordsV2(resolveExtensionDataRoot());
    for (const rec of records) {
      if (rec.packageName !== extension) continue;
      try {
        const accepts = parseAccepts(await readFile(path.join(rec.storeDir, "package.json"), "utf8"));
        if (accepts) return accepts;
      } catch {
        // next record
      }
    }
  } catch {
    // store unavailable — fall through to the bundled dir
  }

  // 2. Bundled extension dir (dev / verify stack): <root>/<vendor>/<slug> and
  //    <root>/<slug>.
  try {
    const { resolveDevExtensionSourceRoot } = await import("@cinatra-ai/agents/agent-runtime-mount");
    const root = resolveDevExtensionSourceRoot();
    const slug = extension.split("/").pop() ?? extension;
    const scope = extension.startsWith("@") ? extension.slice(1).split("/")[0] : null;
    const candidates = [
      ...(scope ? [path.join(root, scope, slug, "package.json")] : []),
      path.join(root, slug, "package.json"),
    ];
    for (const cand of candidates) {
      try {
        const accepts = parseAccepts(await readFile(cand, "utf8"));
        if (accepts) return accepts;
      } catch {
        // next candidate
      }
    }
  } catch {
    // dev root unavailable
  }
  return null;
}

/**
 * Resolve a binding/produces `{extension, objectTypeId?}` to the declared object
 * type + its accepted MIME forms. Never throws (the materializer's per-output
 * failure posture). See the module note for sourcing.
 */
export async function resolveBoundArtifactTarget(input: {
  orgId: string;
  extension: string;
  bindingObjectTypeId?: string;
  producesObjectTypeId?: string;
  deps?: ResolveBoundArtifactTargetDeps;
}): Promise<ResolveBoundArtifactTargetResult> {
  const readEffective =
    input.deps?.readEffectiveArtifactSafeTypeIds ?? readEffectiveArtifactSafeTypeIdsForExtension;
  const readAccepts =
    input.deps?.readExtensionPackAcceptedMimeTypes ?? readInstalledPackAcceptedMimeTypes;
  const resolveRegistered =
    input.deps?.resolveRegisteredType ??
    ((typeId: string) => objectTypeRegistry.resolve(typeId) as
      | { isArtifact?: { accepts?: { file?: { mimeTypes?: string[] } } } }
      | null);

  const declaredArtifactSafeTypeIds = readEffective(input.orgId, input.extension);
  const decision: ResolveArtifactBindingObjectTypeResult = resolveArtifactBindingObjectType({
    extension: input.extension,
    bindingObjectTypeId: input.bindingObjectTypeId,
    producesObjectTypeId: input.producesObjectTypeId,
    declaredArtifactSafeTypeIds,
  });
  if (!decision.ok) {
    // DIAGNOSTICS (cinatra#2536). The pure resolver can only see "this
    // extension contributes ZERO artifact-safe declared types", and reported it
    // as `declares no artifact-safe object type — … declare a produces/binding
    // objectTypeId over an artifact-safe claim`: manifest-blaming advice that
    // is WRONG whenever the manifest declares the type correctly and the type
    // IS registered. In the field that is the normal case — the real cause is
    // an incomplete install (no `installed_extension` row, an archived one, or
    // a live row whose claims never activated), so nothing ever seeded
    // `artifact_type_claims`.
    //
    // But the replacement must not overreach in the other direction (codex
    // round 2): a pack that GENUINELY declares no object types, or a binding
    // naming a type its pack never declares, really is a manifest/binding
    // error and keeps its original copy. `explainZeroClaims` therefore reads
    // the pack manifest and returns `null` for those, meaning "the pure error
    // was right". A >1 ambiguity, or an explicit id outside a NON-EMPTY
    // effective set, never reaches the explainer at all.
    if (declaredArtifactSafeTypeIds.length === 0) {
      const explained = await explainZeroClaims(input);
      if (explained !== null) return { ok: false, error: explained };
    }
    return { ok: false, error: decision.error };
  }
  const objectTypeId = decision.objectTypeId;

  // accepts: self-registered bridge artifact type first, else the installed
  // pack manifest's pack-level accepts (host-registered claim types carry no
  // isArtifact). Fail-closed when neither yields a form.
  const registered = resolveRegistered(objectTypeId);
  const selfAccepts = registered?.isArtifact?.accepts?.file?.mimeTypes;
  let acceptedFileMimeTypes: string[] | null =
    selfAccepts && selfAccepts.length > 0 ? [...selfAccepts] : null;
  if (acceptedFileMimeTypes === null) {
    acceptedFileMimeTypes = await readAccepts(input.extension);
  }
  if (acceptedFileMimeTypes === null) {
    return {
      ok: false,
      error:
        `resolved object type "${objectTypeId}" (extension "${input.extension}") has no ` +
        "resolvable representation accepts — the installed pack manifest was unreadable/invalid",
    };
  }
  return { ok: true, target: { objectTypeId, acceptedFileMimeTypes } };
}

/**
 * Build the cinatra#2536 zero-claim diagnostic: name the declared type(s) off
 * the pack manifest, then let the install-state explainer say WHAT is missing
 * and HOW it heals.
 *
 * Returns `null` when the ORIGINAL (manifest/binding) error is the truthful
 * one, so the caller keeps it (codex round 2):
 *   - the pack manifest declares NO object types at all — the pure resolver's
 *     "declares no artifact-safe object type" is then literally right;
 *   - an explicit binding/produces id names a type the pack does NOT declare —
 *     that is a binding error, not an install problem.
 * A manifest that could not be READ is not evidence of either, so it keeps the
 * install diagnosis (an unreadable pack IS an install/store problem).
 *
 * FAIL-SOFT by contract — this runs inside the materializer's per-output
 * failure path, so any reader problem degrades to a still-non-manifest-blaming
 * message rather than throwing.
 */
async function explainZeroClaims(input: {
  orgId: string;
  extension: string;
  bindingObjectTypeId?: string;
  producesObjectTypeId?: string;
  deps?: ResolveBoundArtifactTargetDeps;
}): Promise<string | null> {
  try {
    const readDeclared =
      input.deps?.readExtensionPackDeclaredObjectTypeIds ?? readInstalledPackDeclaredObjectTypeIds;
    const explain =
      input.deps?.explainAbsentClaims ??
      (async (arg: { orgId: string; extension: string; declaredObjectTypeIds?: readonly string[] }) => {
        const { explainAbsentArtifactSafeClaims } = await import(
          "@/lib/extension-install-record-heal"
        );
        return explainAbsentArtifactSafeClaims(arg);
      });
    let declaredObjectTypeIds: string[] | null;
    try {
      declaredObjectTypeIds = await readDeclared(input.extension);
    } catch {
      declaredObjectTypeIds = null; // unreadable — not evidence about the manifest
    }
    if (declaredObjectTypeIds !== null) {
      // The manifest genuinely declares nothing to claim.
      if (declaredObjectTypeIds.length === 0) return null;
      // The binding pins a type this pack never declares.
      const explicit = input.bindingObjectTypeId ?? input.producesObjectTypeId;
      if (explicit !== undefined && !declaredObjectTypeIds.includes(explicit)) return null;
    }
    return await explain({
      orgId: input.orgId,
      extension: input.extension,
      declaredObjectTypeIds: declaredObjectTypeIds ?? undefined,
    });
  } catch (err) {
    return (
      `no artifact-safe claim resolved for extension "${input.extension}" in org "${input.orgId}" and ` +
      `the install state could not be read (${err instanceof Error ? err.message : String(err)}) — ` +
      `this is an install/activation problem, not a manifest problem.`
    );
  }
}
