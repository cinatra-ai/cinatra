import "server-only";
import { objectTypeRegistry, type ArtifactPackSurfaceEntry } from "@cinatra-ai/objects/registry";
import { parseSemanticArtifactManifest } from "@cinatra-ai/objects/semantic-manifest";
import {
  resolveClaimWinner,
  claimWinnerProjectionDisposition,
  type ArbitrableClaim,
} from "@cinatra-ai/objects/claims";
import {
  resolveArtifactBindingObjectType,
  type ResolveArtifactBindingObjectTypeResult,
} from "@cinatra-ai/agents/artifact-binding";
import { isExactVersion } from "@cinatra-ai/registries/src/version-compare";
import { readArtifactTypeClaimsForOrg } from "@/lib/objects/artifact-claim-store";
import { ensureArtifactTypesRegistered } from "./ensure-artifact-registry";
import type { ClaimBackedMeaningType } from "./installed-type-picker";

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

/** One artifact-safe claim WINNER: the type it is over, the package that won
 *  it, that package's version the claim was activated at, the claim's scope and
 *  the install row the claim is bound to (null for an unbound claim). */
type ArtifactSafeClaimWinner = {
  objectTypeId: string;
  extensionPackage: string;
  extensionVersion: string;
  scope: string;
  installId: string | null;
};

/** A claim row as the store reads it: the arbitrable fields and the install row
 *  it is bound to (`installId`, absent from a bare arbitrable fixture). */
type ClaimRowForOrg = ArbitrableClaim & { installId?: string | null };

/**
 * THE ONE CLAIM ARBITRATION BOTH SIDES OF THE ARTIFACT BOUNDARY READ
 * (cinatra#3603).
 *
 * Four steps, in this order, written ONCE: read the organisation's claim chain,
 * arbitrate a WINNER per distinct claimed type (`resolveClaimWinner` — ratified
 * PURE policy in the claims leaf: kind over scope, domination, generation), keep
 * a winner whose PROJECTION disposition is `artifact-safe`, and intersect with a
 * currently-registered host type.
 *
 * The WRITE side (`readEffectiveArtifactSafeTypeIdsForExtension`) narrows the
 * result to one extension; the READ side
 * (`readAdmissibleArtifactTypeIdsForOrg`) takes it whole. Two copies of these
 * four steps IS the drift cinatra#3603 exists to close, so there is exactly one
 * and both exported functions call it.
 *
 * Sync — the claim store is sync. `readClaimsForOrg` is injectable for unit
 * tests only; the default is the real org-chain store read.
 */
function readArtifactSafeClaimWinners(
  orgId: string,
  readClaimsForOrg: (
    orgId: string,
  ) => readonly ClaimRowForOrg[] = readArtifactTypeClaimsForOrg,
): ArtifactSafeClaimWinner[] {
  const claims = readClaimsForOrg(orgId);
  const typeIds = new Set(claims.map((c) => c.objectTypeId));
  const out: ArtifactSafeClaimWinner[] = [];
  for (const objectTypeId of typeIds) {
    const winner = resolveClaimWinner(claims, { orgId, objectTypeId });
    if (!winner) continue;
    if (claimWinnerProjectionDisposition(winner) !== "artifact-safe") continue;
    // Intersect with a currently-registered host type — a claim over a type this
    // process never registered cannot be materialized here.
    if (objectTypeRegistry.resolve(objectTypeId) === null) continue;
    out.push({
      objectTypeId,
      extensionPackage: winner.extensionPackage,
      extensionVersion: winner.extensionVersion,
      scope: winner.scope,
      installId: winner.installId ?? null,
    });
  }
  return out;
}

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
  return readArtifactSafeClaimWinners(orgId)
    .filter((w) => w.extensionPackage === extension)
    .map((w) => w.objectTypeId)
    .sort();
}

/**
 * The package whose WINNING artifact-safe claim in this organisation is over
 * `objectTypeId`, or null when no such claim wins it (cinatra#3319). The same
 * arbitration as both functions above. A claim-backed type is registered by the
 * host, so the object-type registry names no pack for it: this is how a caller
 * learns which pack owns the row's type. A failed claim read throws.
 */
export function readArtifactSafeClaimWinnerForType(
  orgId: string,
  objectTypeId: string,
  readClaimsForOrg?: (orgId: string) => readonly ArbitrableClaim[],
): string | null {
  const winner = readArtifactSafeClaimWinners(orgId, readClaimsForOrg).find(
    (w) => w.objectTypeId === objectTypeId,
  );
  return winner ? winner.extensionPackage : null;
}

/**
 * The packages that pass every rule of `readClaimBackedMeaningTypesForOrg`
 * except the surface read (cinatra#3319): rules 0, 1, 3, 4 and 6, through the
 * same code (`readClaimBackedCandidates`). Sorted. Only such a package can be
 * claim-backed, so the upload actions read it after the claim-backed read
 * failed, to tell which matcher entries could be a claim-backed pack's; a
 * package this list does not name can never be claim-backed under the same
 * arbitration. Reads the claims and the registry only. A failed claim read
 * throws.
 */
export function readClaimBackedCandidatePackagesForOrg(
  orgId: string,
  readClaimsForOrg?: (orgId: string) => readonly ClaimRowForOrg[],
): string[] {
  return readClaimBackedCandidates(orgId, readClaimsForOrg)
    .map((w) => w.extensionPackage)
    .sort();
}

/** A claim winner that passes rules 0, 1, 3, 4 and 6 of
 *  `readClaimBackedMeaningTypesForOrg`: bound to an install row. */
type ClaimBackedCandidate = ArtifactSafeClaimWinner & { installId: string };

/**
 * Rules 0, 1, 3, 4 and 6 of `readClaimBackedMeaningTypesForOrg`, written once:
 * from THE ONE arbitration, grouped by the winning extension, the one winner of
 * each extension that wins exactly one type (3) at an exact version (0), is
 * bound to an install row (6), registers no type with `isArtifact` (1), and
 * whose type is host-registered (4). No surface is read. A failed claim read
 * throws.
 */
function readClaimBackedCandidates(
  orgId: string,
  readClaimsForOrg?: (orgId: string) => readonly ClaimRowForOrg[],
): ClaimBackedCandidate[] {
  const byExtension = new Map<string, ArtifactSafeClaimWinner[]>();
  for (const winner of readArtifactSafeClaimWinners(orgId, readClaimsForOrg)) {
    const group = byExtension.get(winner.extensionPackage);
    if (group) group.push(winner);
    else byExtension.set(winner.extensionPackage, [winner]);
  }
  const out: ClaimBackedCandidate[] = [];
  for (const [extension, winners] of byExtension) {
    // 3. exactly one winning type, so exactly one version.
    if (winners.length !== 1) continue;
    const winner = winners[0];
    // 0. a versionless claim has no manifest version to bind to.
    if (winner.extensionVersion === "0.0.0" || !isExactVersion(winner.extensionVersion)) continue;
    // 6. an unbound claim names no install whose bytes could answer.
    if (winner.installId === null) continue;
    // 1. the pack mints no own artifact type.
    const ownsArtifactType = objectTypeRegistry
      .getTypesForPackage(extension)
      .some((typeId) => objectTypeRegistry.resolve(typeId)?.isArtifact != null);
    if (ownsArtifactType) continue;
    // 4. the claimed type is host-registered.
    if (objectTypeRegistry.getRegisteringPackage(winner.objectTypeId) !== null) continue;
    out.push({ ...winner, installId: winner.installId });
  }
  return out;
}

// ---------------------------------------------------------------------------
// THE ADMISSIBLE ARTIFACT TYPES OF ONE ORGANISATION (cinatra#3603).
//
// THE DEFECT THIS CLOSES. The host's artifact WRITER admits a type when the
// organisation's WINNING claim over it is artifact-safe and the type is
// registered in this process — `readEffectiveArtifactSafeTypeIdsForExtension`
// just above, and `createSemanticArtifact`'s write boundary. Every READ path
// tested a DIFFERENT list: the in-process `objectTypeRegistry.listArtifacts()`,
// which holds exactly the definitions carrying an `isArtifact` descriptor. A
// CLAIM-BACKED HOST-REGISTERED type (the claiming pack's name is not the type's
// namespace, so the artifact bridge never registers it as a type and the host
// registrar attaches no `isArtifact` — by design, see the accepts note above)
// can never be on that list, so bytes this host's own writer authored were
// refused by every reader with "does not resolve".
//
// THE ONE SOURCE. The readers now ask THIS function, which returns the
// registered artifact types TOGETHER WITH the organisation's live,
// artifact-safe claim-winner types — through the SAME arbitration the write
// side reads, so the set is never WIDER than what the writer admits (pinned by
// a unit case comparing the two, not asserted here).
//
// WHY NOT THE REGISTRY'S OWN DISPOSITION. `resolveTypeProjectionDisposition`
// would be one line shorter and is wrong for this: the registry is
// process-global and ORGANISATION-INDEPENDENT (registry.ts calls it "unscoped
// — what a cache may be and an ownership authority must not"), so it would
// admit a claim-backed type on an organisation that holds NO claim over it, and
// would admit MORE than the writer does. The CLAIM registry is the authority;
// registry membership is only the intersection the write side already applies.
//
// NO CACHE. Both halves are read at CALL time, deliberately: the registry half
// already was (a hot-installed pack must be admitted immediately), and a cache
// would be a new lifetime rule with no owner.
// ---------------------------------------------------------------------------

/**
 * The artifact object type ids admissible for `orgId`: every REGISTERED
 * artifact type, plus every type whose WINNING claim in this organisation's
 * scope chain projects `artifact-safe` and which this process has registered.
 * Sorted and de-duplicated. Synchronous — the claim store is synchronous.
 *
 * Takes no extension argument: a reader asks "is this type admissible for this
 * organisation", never "which extension provides it".
 *
 * `deps.readClaimsForOrg` is injectable for unit tests only; the default is the
 * real org-chain store read.
 */
export function readAdmissibleArtifactTypeIdsForOrg(
  orgId: string,
  deps?: { readClaimsForOrg?: (orgId: string) => readonly ArbitrableClaim[] },
): string[] {
  // Warm the registry first: the read paths do not transitively trigger boot
  // registration, so a cold process would see an empty artifact-type set.
  ensureArtifactTypesRegistered();
  const admissible = new Set<string>(
    objectTypeRegistry.listArtifacts().map((d) => d.type),
  );
  for (const winner of readArtifactSafeClaimWinners(
    orgId,
    deps?.readClaimsForOrg,
  )) {
    admissible.add(winner.objectTypeId);
  }
  return [...admissible].sort();
}

/**
 * The CLAIM-BACKED meaning surfaces of an org's upload picker (cinatra#3319).
 * From THE ONE arbitration (`readArtifactSafeClaimWinners`), grouped by the
 * winning extension, keep an extension only when all seven hold:
 *   0. its winner's `extensionVersion` is an exact version (not `"0.0.0"`);
 *   1. it registered no type with `isArtifact`;
 *   2. the pack's surface declares no matcher skills;
 *   3. it won exactly one type;
 *   4. that type is host-registered (no registering package);
 *   5. the pack's surface accepts a file MIME type;
 *   6. the winning claim is bound to an install row (`installId`).
 * Rules 0, 1, 3, 4 and 6 read the claims and the registry only
 * (`readClaimBackedCandidates`, which `readClaimBackedCandidatePackagesForOrg`
 * reads too). Rules 2 and 5 read the pack's surface, and only for an extension
 * that passes them: the capabilities the runtime-discovery dispatcher reports
 * for the pack (`readOrgPackSurfaces`, read once per call and only when an
 * extension reaches it), bound to the winner's own install row
 * (`readClaimWinnerSurfaceFields`). The reader opens no manifest. Each entry
 * names the winner it was read for: version, install and scope. The
 * dispatcher is read in this organisation's visibility scope, so a pack whose
 * live installs this organisation cannot see reports no surface. The install
 * row's organisation is not compared with the claim's scope here; the
 * claim-scoped gate the upload actions ask
 * (`canActorAccessClaimedArtifactExtension`) refuses a bound row that does not
 * govern that scope. The caller warms the registry. The claim read, the
 * surface read and the per-winner read are injectable for unit tests. A failed
 * claim read, install-row read, dispatcher read or trust-gate read throws, and
 * so does a reported surface that is not the surface of the claim's install at
 * the claim's version: the pack's claim state is then unknown, and the caller
 * must read the whole answer as failed, never as "not claim-backed" (the
 * upload actions then refuse a matcher entry whose claim state is unknown). An
 * extension that a rule other than 2 and 5 drops is dropped before its surface
 * is read, so it cannot fail the answer.
 */
export async function readClaimBackedMeaningTypesForOrg(
  orgId: string,
  deps?: {
    readClaimsForOrg?: (orgId: string) => readonly ClaimRowForOrg[];
    /** The organisation's pack surfaces; the runtime-discovery dispatcher by
     *  default (`readOrgPackSurfaces`). */
    readPackSurfaces?: (orgId: string) => Promise<readonly ArtifactPackSurfaceEntry[]>;
    /** The per-winner read in place of `readClaimWinnerSurfaceFields` (which
     *  reads the surfaces above): the pack's accepts and matcher skills for the
     *  winner's install, or null for no entry. */
    readManifestFields?: (winner: {
      extension: string;
      extensionVersion: string;
      installId: string;
    }) => Promise<{ accepts: string[]; objectTypeIds: string[]; matchers: string[] } | null>;
  },
): Promise<ClaimBackedMeaningType[]> {
  const readPackSurfaces = deps?.readPackSurfaces ?? readOrgPackSurfaces;
  let surfaces: Promise<readonly ArtifactPackSurfaceEntry[]> | null = null;
  const surfacesOnce = () => (surfaces ??= readPackSurfaces(orgId));
  const readManifestFields =
    deps?.readManifestFields ??
    ((winner: { extension: string; extensionVersion: string; installId: string }) =>
      readClaimWinnerSurfaceFields(winner, surfacesOnce));
  const out: ClaimBackedMeaningType[] = [];
  for (const candidate of readClaimBackedCandidates(orgId, deps?.readClaimsForOrg)) {
    const { objectTypeId, extensionPackage: extension, extensionVersion, installId, scope } =
      candidate;
    // Null: the claim names no live artifact install of the pack, or the
    // runtime reports no surface of the pack. A reported surface that is not
    // the install's throws (the reader fails closed).
    const fields = await readManifestFields({ extension, extensionVersion, installId });
    // 2. no matcher skills; 5. the surface accepts something.
    if (!fields || fields.matchers.length > 0 || fields.accepts.length === 0) continue;
    out.push({
      objectTypeId,
      extension,
      acceptMimes: fields.accepts,
      extensionVersion,
      installId,
      scope,
    });
  }
  return out;
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
 * The pack surfaces the runtime-discovery dispatcher reports for one
 * organisation (cinatra#3319): `discoverActiveExtensionCapabilities` for the
 * artifact kind, whose reader facet lists the surfaces the object-registry
 * bridge recorded for each lifecycle-live pack it registered, one per kind of
 * record (`artifactPackSurfaceRegistry`, written from the manifest the bridge
 * validated, with the store record or development tree it read). This is the
 * one road the reader takes to a pack's capabilities: it opens no manifest
 * itself. The artifact handler is registered first if this process has not
 * registered one (`registerIfAbsent`; the handler bootstrap registers the same
 * handler, and a later `register` there replaces it), so the facet is there in
 * a worker the bootstrap has not reached. The visibility scope is the
 * organisation's own: a system read that admits every install anchored to the
 * organisation and the deployment-wide ones, never another organisation's.
 * Which actor may use an entry is decided later, by the claim-scoped gate of
 * the upload actions. A failed dispatcher read, a facet that throws and a
 * facet that is not there all throw: none of them is "no surface".
 */
async function readOrgPackSurfaces(orgId: string): Promise<ArtifactPackSurfaceEntry[]> {
  const [{ discoverActiveExtensionCapabilities }, { extensionRegistry }, { createArtifactExtensionHandler }] =
    await Promise.all([
      import("@cinatra-ai/extensions/runtime-discovery-host"),
      import("@cinatra-ai/extensions"),
      import("@cinatra-ai/extensions/artifact-handler"),
    ]);
  extensionRegistry.registerIfAbsent(createArtifactExtensionHandler());
  const facet: { failed: boolean; error: unknown } = { failed: false, error: null };
  const discovered = await discoverActiveExtensionCapabilities({
    kind: "artifact",
    actor: { actorType: "system", source: "worker" },
    scope: { userId: null, organizationId: orgId, teamIds: [], orgRole: "org_admin" },
    onError: (_kind, error) => {
      facet.failed = true;
      facet.error = error;
    },
  });
  if (facet.failed) {
    throw facet.error instanceof Error ? facet.error : new Error("the artifact reader facet failed");
  }
  if (discovered.unmigratedKinds.includes("artifact")) {
    throw new Error("the runtime-discovery dispatcher has no artifact reader facet");
  }
  const out: ArtifactPackSurfaceEntry[] = [];
  for (const descriptor of discovered.byKind.artifact ?? []) {
    const surface = (descriptor as { artifactPack?: unknown } | null)?.artifactPack;
    if (surface && typeof surface === "object") out.push(surface as ArtifactPackSurfaceEntry);
  }
  return out;
}

/**
 * THE CAPABILITIES OF THE WINNING CLAIM'S OWN INSTALL (cinatra#3319), as the
 * runtime registered them. The claim's install row (`installId`) must be a live
 * (`active` or `locked`) `kind:"artifact"` row of this package; any other row,
 * or none, answers null (the claim names no live install of the pack). The
 * answer is the pack's surface as the runtime-discovery dispatcher reports it
 * (`readOrgPackSurfaces`), and null when the dispatcher reports none for the
 * package: the runtime registered no capability of the pack, so the picker
 * offers none (the bridge's registration of a manifest file writes a pack's
 * matcher entry only on a pass that also writes its surface). The dispatcher
 * can report a store surface and a development-tree surface of one pack; the
 * install's own kind of record picks one. It answers only when it is the
 * surface of this install's bytes:
 *   - its manifest is at the claim's version;
 *   - for a STORE install (`verdaccio`, `local` or `github`), the runtime's own
 *     multi-version trust gate (`makeDefaultInstallAnchorsResolver`, as boot
 *     builds it, with a read of no port grant: the grant decides approved
 *     ports, never whether a row anchors) must anchor this row: a row it
 *     refuses, or skips because two live owner rows share its version, or a
 *     package it refuses for two resolved defaults, can never be activated by
 *     the runtime. The surface must be the one the bridge registered from a
 *     store record at the digest that anchor selects (any store record of the
 *     package when the anchor selects none: the store rescan then registers a
 *     package only from its one store record);
 *   - for a BUNDLED install (`bundled`), the surface must be the one the bridge
 *     registered from the development tree;
 *   - any other source, or none, is no install the runtime anchors.
 * FAIL CLOSED: in every case where a surface of the pack is reported but none
 * is this install's, and on a failed install-row, dispatcher or trust-gate
 * read, the reader throws. The pack's claim state is then unknown, so the answer must
 * never read as "not claim-backed" (see `readClaimBackedMeaningTypesForOrg`).
 */
async function readClaimWinnerSurfaceFields(
  winner: { extension: string; extensionVersion: string; installId: string },
  surfaces: () => Promise<readonly ArtifactPackSurfaceEntry[]>,
): Promise<{ accepts: string[]; objectTypeIds: string[]; matchers: string[] } | null> {
  const { readInstalledExtensionById } = await import("@cinatra-ai/extensions/canonical-store");
  const row = await readInstalledExtensionById(winner.installId);
  if (
    !row ||
    row.packageName !== winner.extension ||
    (row.status !== "active" && row.status !== "locked") ||
    row.kind !== "artifact"
  ) {
    return null;
  }
  const unreadable = (why: string): never => {
    throw new Error(
      `the manifest of the claim's install cannot be read: ${why} ` +
        `(${winner.extension}@${winner.extensionVersion}, install ${winner.installId})`,
    );
  };
  let reported: readonly ArtifactPackSurfaceEntry[];
  try {
    reported = await surfaces();
  } catch {
    return unreadable("the runtime-discovery dispatcher cannot be read");
  }
  const own = reported.filter((s) => s.packageName === winner.extension);
  if (own.length === 0) return null;
  // The pack's surface from this install's own kind of record: the registry
  // keeps a store surface and a development-tree surface side by side.
  let surface: ArtifactPackSurfaceEntry | undefined;
  const sourceType = (row.source as { type?: unknown } | null | undefined)?.type;
  if (sourceType === "bundled") {
    surface = own.find((s) => s.record?.source === "bundled");
    if (!surface) {
      return unreadable("the runtime registered the pack from no development tree");
    }
  } else if (sourceType === "verdaccio" || sourceType === "local" || sourceType === "github") {
    const digest = await readAnchoredStoreDigest(row.packageName, row.id, unreadable);
    surface = own.find((s) => s.record?.source === "store");
    const record = surface?.record;
    if (!surface || record?.source !== "store" || (digest !== null && record.digest !== digest)) {
      return unreadable("the runtime registered the pack from another record than the install's");
    }
  } else {
    return unreadable("the install row has no source the runtime anchors");
  }
  if (surface.version !== winner.extensionVersion) {
    return unreadable("the runtime registered the pack at another version than the claim");
  }
  return {
    accepts: [...surface.fileMimeTypes],
    objectTypeIds: [],
    matchers: [...surface.matcherSkillIds],
  };
}

/**
 * The store digest the runtime's own multi-version trust gate selects for one
 * live install row (cinatra#3319): the anchor `makeDefaultInstallAnchorsResolver`
 * (platform-global, as boot builds it) resolves for the row `installId`. Null
 * when that anchor selects no digest. No anchor for the row (refused, skipped
 * as an ambiguous version, or every version refused for two resolved
 * defaults), and a failed read, throw through `unreadable`. The port grant is
 * not read: it decides approved ports only.
 */
async function readAnchoredStoreDigest(
  packageName: string,
  installId: string,
  unreadable: (why: string) => never,
): Promise<string | null> {
  const { makeDefaultInstallAnchorsResolver } = await import("@/lib/extension-install-anchor");
  let anchors: readonly { installId?: string | null; digest?: string | null }[];
  try {
    const resolve = await makeDefaultInstallAnchorsResolver(null, "platform-global", {
      readGrant: async () => null,
    });
    anchors = await resolve(packageName);
  } catch {
    return unreadable("the install's trust anchor cannot be read");
  }
  const anchor = anchors.find((a) => a.installId === installId);
  if (!anchor) {
    return unreadable("the runtime's trust gate anchors no version of the install");
  }
  return anchor.digest ?? null;
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
          "@/lib/extension-install-anchor"
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
