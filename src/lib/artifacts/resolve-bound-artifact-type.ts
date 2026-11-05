import "server-only";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
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
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import type { InstallAnchorRow } from "@/lib/extension-install-anchor";
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
 * except the manifest read (cinatra#3319): rules 0, 1, 3, 4 and 6, through the
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
 * whose type is host-registered (4). No manifest is read. A failed claim read
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
 *   2. the manifest of the winner's install declares no `skills.matchers`;
 *   3. it won exactly one type;
 *   4. that type is host-registered (no registering package);
 *   5. that manifest's `accepts` is non-empty;
 *   6. the winning claim is bound to an install row (`installId`).
 * Rules 0, 1, 3, 4 and 6 read the claims and the registry only
 * (`readClaimBackedCandidates`, which `readClaimBackedCandidatePackagesForOrg`
 * reads too); the manifest is read only for an extension that passes them, and
 * only through the winner's own install row (`readClaimWinnerManifestFields`):
 * for a store install, the one store record at the digest the runtime's own
 * trust gate selects for that row, and no other store record; for a bundled
 * install, the development tree, through the manifest that names the package.
 * Each entry names the winner it was read for: version, install and scope. The
 * install row's organisation is not compared with the claim's scope here; the
 * claim-scoped gate the upload actions ask
 * (`canActorAccessClaimedArtifactExtension`) refuses a bound row that does not
 * govern that scope. The caller warms the registry. Both reads are injectable
 * for unit tests. A failed claim read or install-row read throws, and so does a
 * live install whose manifest cannot be read at the claim's version: the
 * pack's claim state is then unknown, and the caller must read the whole
 * answer as failed, never as "not claim-backed" (the upload actions then refuse
 * a matcher entry whose claim state is unknown). An extension that a rule
 * other than 2 and 5 drops is dropped before its manifest is read, so its
 * install is never read and cannot fail the answer.
 */
export async function readClaimBackedMeaningTypesForOrg(
  orgId: string,
  deps?: {
    readClaimsForOrg?: (orgId: string) => readonly ClaimRowForOrg[];
    readManifestFields?: (winner: {
      extension: string;
      extensionVersion: string;
      installId: string;
    }) => Promise<{ accepts: string[]; objectTypeIds: string[]; matchers: string[] } | null>;
  },
): Promise<ClaimBackedMeaningType[]> {
  const readManifestFields = deps?.readManifestFields ?? readClaimWinnerManifestFields;
  const out: ClaimBackedMeaningType[] = [];
  for (const candidate of readClaimBackedCandidates(orgId, deps?.readClaimsForOrg)) {
    const { objectTypeId, extensionPackage: extension, extensionVersion, installId, scope } =
      candidate;
    // Null: the claim names no live artifact install of the pack. A live install
    // whose manifest cannot be read throws (the reader fails closed).
    const fields = await readManifestFields({ extension, extensionVersion, installId });
    // 2. no matchers, read from the manifest (not the mutable matcher registry);
    // 5. the manifest accepts something.
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

type InstalledPackManifestFields = {
  accepts: string[];
  objectTypeIds: string[];
  matchers: string[];
  /** The manifest's own `version`, or null when it is not a string. */
  version: string | null;
  /** The manifest's own `name`, or null when it is not a string. */
  name: string | null;
};

/** Parse one `package.json` text into the manifest fields, or null when it is
 *  not a readable, valid `kind:"artifact"` manifest. */
function parsePackManifestFields(raw: string): InstalledPackManifestFields | null {
  let pkg: { name?: unknown; version?: unknown; cinatra?: { kind?: unknown; artifact?: unknown } };
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
    matchers: parsed.manifest.skills?.matchers ?? [],
    version: typeof pkg.version === "string" ? pkg.version : null,
    name: typeof pkg.name === "string" ? pkg.name : null,
  };
}

/** The bundled/in-tree `package.json` paths of a package (dev / verify stack):
 *  <root>/<vendor>/<slug> and <root>/<slug>. Throws when the dev root is
 *  unavailable. */
async function devTreeManifestPaths(extension: string): Promise<string[]> {
  const path = await import("node:path");
  const { resolveDevExtensionSourceRoot } = await import("@cinatra-ai/agents/agent-runtime-mount");
  const root = resolveDevExtensionSourceRoot();
  const slug = extension.split("/").pop() ?? extension;
  const scope = extension.startsWith("@") ? extension.slice(1).split("/")[0] : null;
  return [
    ...(scope ? [path.join(root, scope, slug, "package.json")] : []),
    path.join(root, slug, "package.json"),
  ];
}

/** ONE read of the pack manifest yielding every field the callers above need.
 *  Same discovery order as before: SRI-vetted store records first, then the
 *  bundled/in-tree extension dir (dev/verify). Reads `package.json` only. */
async function readInstalledPackManifestFields(
  extension: string,
): Promise<InstalledPackManifestFields | null> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");

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
        const accepts = parsePackManifestFields(await readFile(path.join(rec.storeDir, "package.json"), "utf8"));
        if (accepts) return accepts;
      } catch {
        // next record
      }
    }
  } catch {
    // store unavailable — fall through to the bundled dir
  }

  // 2. Bundled extension dir (dev / verify stack).
  try {
    for (const cand of await devTreeManifestPaths(extension)) {
      try {
        const accepts = parsePackManifestFields(await readFile(cand, "utf8"));
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
 * THE MANIFEST OF THE WINNING CLAIM'S OWN INSTALL (cinatra#3319): read through
 * the install row the claim is bound to, the way the runtime pairs that row
 * with its bytes, and never from another store record of the same package.
 * The claim's install row (`installId`) must be a live (`active` or `locked`)
 * `kind:"artifact"` row of this package; any other row, or none, answers null
 * (the claim names no live install of the pack). Then, by the row's source:
 *   - a STORE install (`verdaccio`, `local` or `github`) is first passed
 *     through the runtime's own trust gate, `resolveInstallAnchor`, with the
 *     row and its finalized install-op journal, read in the namespace the
 *     multi-version anchor resolver reads for that row (`0.0.0` for the default
 *     row, else the row's version). A row that gate refuses (no finalized
 *     journal, a row digest the journal does not confirm, placeholder
 *     integrity, no content hash) can never be activated by the runtime, so
 *     the reader throws. The digest the gate selects must be a store digest
 *     segment (an empty or malformed one throws) and names the one store
 *     record that answers, `<root>/artifact/<slug>/<digest>/package.json`, read by its path:
 *     no other record is listed or read. A gate that selects no digest (a
 *     legacy row the journal pins no digest for) takes, as the runtime loader
 *     does, the one record of the package in the store, and throws when the
 *     store holds none or more than one.
 *   - a BUNDLED install (`bundled`) answers through the development tree only
 *     when the store holds no record of the package at all, and exactly one
 *     development manifest names the package. That tree carries no install
 *     identity: it is taken as the bundled install's bytes, bound to the claim
 *     by the manifest's package name and the version check below.
 *   - any other source, or none, is no install the runtime anchors: the reader
 *     throws.
 * In every case the manifest must be a valid `kind:"artifact"` manifest that
 * names this package, at the claim's version.
 * FAIL CLOSED: a failed install-row read throws, and so does every case in
 * which the live install's manifest cannot be read in that way. A store
 * read that fails for any reason but the absence of the package's folder is a
 * failure, never "the store holds no record": an unreadable folder, a record
 * whose manifest cannot be opened and a data root that cannot be located all
 * throw. The pack's claim state is then unknown, so the answer must never read
 * as "not claim-backed" (see `readClaimBackedMeaningTypesForOrg`).
 */
async function readClaimWinnerManifestFields(winner: {
  extension: string;
  extensionVersion: string;
  installId: string;
}): Promise<InstalledPackManifestFields | null> {
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
  const atVersion = (fields: InstalledPackManifestFields | null): InstalledPackManifestFields => {
    if (!fields) return unreadable("no valid artifact manifest");
    if (fields.name !== winner.extension) {
      return unreadable("the manifest names another package");
    }
    if (fields.version !== winner.extensionVersion) {
      return unreadable("the manifest is at another version than the claim");
    }
    return fields;
  };
  const sourceType = (row.source as { type?: unknown } | null | undefined)?.type;
  if (sourceType === "bundled") {
    return atVersion(await readBundledInstallManifest(winner.extension, unreadable));
  }
  if (sourceType !== "verdaccio" && sourceType !== "local" && sourceType !== "github") {
    return unreadable("the install row has no source the runtime anchors");
  }
  const digest = await readAnchoredStoreDigest(row, unreadable);
  return atVersion(await readStoreInstallManifest(winner.extension, digest, unreadable));
}

/**
 * The store digest the runtime's own trust gate selects for one live install
 * row (cinatra#3319): `resolveInstallAnchor` over exactly this row, with the
 * finalized install-op journal read in the namespace
 * `makeDefaultInstallAnchorsResolver` reads for it. Null when the gate selects
 * no digest. A refused row, and a failed journal read, throw through
 * `unreadable`.
 */
async function readAnchoredStoreDigest(
  row: InstalledExtension,
  unreadable: (why: string) => never,
): Promise<string | null> {
  const { resolveInstallAnchor } = await import("@/lib/extension-install-anchor");
  const { readInstallOpForVersion } = await import("@/lib/extension-install-ops");
  const namespace = row.isDefault !== false ? "0.0.0" : (row.version ?? "0.0.0");
  let anchor: Awaited<ReturnType<typeof resolveInstallAnchor>>;
  try {
    anchor = await resolveInstallAnchor(row.packageName, {
      orgId: row.organizationId ?? null,
      readActiveInstall: async () => ({
        id: row.id,
        status: row.status,
        kind: row.kind,
        isDefault: row.isDefault,
        organizationId: row.organizationId ?? null,
        widgetAuthTokenKeys: row.widgetAuthTokenKeys ?? null,
        // The anchor reads the source defensively, field by field.
        source: row.source as unknown as InstallAnchorRow["source"],
      }),
      // The port grant decides approved ports only, never whether the bytes
      // are trusted, so the reader does not read it.
      readGrant: async () => null,
      readInstallOp: (pkg, oid) => readInstallOpForVersion(pkg, oid, namespace),
    });
  } catch {
    return unreadable("the install's journal cannot be read");
  }
  if (!anchor) {
    return unreadable("the runtime's trust gate refuses the install");
  }
  return anchor.digest ?? null;
}

/** The package's store folder, `<root>/artifact/<slug>` (the row's kind is
 *  `artifact`, and the store is kind-segregated). */
async function storeSlugDir(
  extension: string,
  unreadable: (why: string) => never,
): Promise<string> {
  try {
    const { resolveExtensionDataRoot } = await import("@/lib/extension-data-root");
    const { storeSlugDirV2 } = await import("@/lib/extension-package-store-core");
    return storeSlugDirV2(resolveExtensionDataRoot(), "artifact", extension);
  } catch {
    return unreadable("the store cannot be located");
  }
}

/** The digests of the package's store records. The folder's absence is the
 *  only "none": every other failure to list it throws through `unreadable`. */
async function listStoreRecordDigests(
  slugDir: string,
  unreadable: (why: string) => never,
): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const { isStoreDigestSegment } = await import("@/lib/extension-package-store-core");
  let entries: string[];
  try {
    entries = await readdir(slugDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return [];
    return unreadable("the store folder of the package cannot be listed");
  }
  return entries.filter((entry) => isStoreDigestSegment(entry));
}

/** The manifest of a store install's record at `digest` (or, for no digest,
 *  of the package's one store record), read by its path. */
async function readStoreInstallManifest(
  extension: string,
  digest: string | null,
  unreadable: (why: string) => never,
): Promise<InstalledPackManifestFields | null> {
  const { readFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { isStoreDigestSegment } = await import("@/lib/extension-package-store-core");
  const slugDir = await storeSlugDir(extension, unreadable);
  let recordDigest: string;
  if (digest !== null) {
    if (!isStoreDigestSegment(digest)) return unreadable("the install's digest is no store digest");
    recordDigest = digest;
  } else {
    const digests = await listStoreRecordDigests(slugDir, unreadable);
    if (digests.length !== 1) {
      return unreadable(`the install pins no digest and the store holds ${digests.length} records of the package`);
    }
    recordDigest = digests[0];
  }
  let raw: string;
  try {
    raw = await readFile(path.join(slugDir, recordDigest, "package.json"), "utf8");
  } catch {
    return unreadable("the manifest of the install's store record cannot be opened");
  }
  return parsePackManifestFields(raw);
}

/** The manifest of a bundled install: the one development manifest that names
 *  the package, read only when the store holds no record of the package. */
async function readBundledInstallManifest(
  extension: string,
  unreadable: (why: string) => never,
): Promise<InstalledPackManifestFields> {
  const { readFile } = await import("node:fs/promises");
  const slugDir = await storeSlugDir(extension, unreadable);
  if ((await listStoreRecordDigests(slugDir, unreadable)).length > 0) {
    return unreadable("the install records no digest while the store holds a record of the package");
  }
  let paths: string[];
  try {
    paths = await devTreeManifestPaths(extension);
  } catch {
    return unreadable("the development root is unavailable");
  }
  const found: InstalledPackManifestFields[] = [];
  for (const cand of paths) {
    let raw: string;
    try {
      raw = await readFile(cand, "utf8");
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | null)?.code;
      if (code === "ENOENT" || code === "ENOTDIR") continue;
      return unreadable("a development manifest cannot be opened");
    }
    let name: unknown;
    try {
      name = (JSON.parse(raw) as { name?: unknown } | null)?.name;
    } catch {
      return unreadable("a development manifest is not readable");
    }
    // Another package's manifest at the same folder name is not this one's.
    if (name !== extension) continue;
    const fields = parsePackManifestFields(raw);
    if (!fields) return unreadable("a development manifest of the package is no valid artifact manifest");
    found.push(fields);
  }
  if (found.length !== 1) {
    return unreadable(`${found.length} development manifests name the package`);
  }
  return found[0];
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
