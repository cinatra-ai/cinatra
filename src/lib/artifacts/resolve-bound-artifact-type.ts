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
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");

  const parseAccepts = (raw: string): string[] | null => {
    let pkg: { cinatra?: { kind?: unknown; artifact?: unknown } };
    try {
      pkg = JSON.parse(raw);
    } catch {
      return null;
    }
    if (pkg?.cinatra?.kind !== "artifact") return null;
    const parsed = parseSemanticArtifactManifest(pkg.cinatra?.artifact);
    if (!parsed.ok) return null;
    return parsed.manifest.accepts?.file?.mimeTypes ?? [];
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
  if (!decision.ok) return { ok: false, error: decision.error };
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
