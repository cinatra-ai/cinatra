// ---------------------------------------------------------------------------
// supplied-package-install.ts — THE ROAD THE UPLOAD SCREEN TAKES
// (cinatra#3204 leg 3, criteria 18-22).
//
// Both upload roads end here, and this module's whole job is to make sure they
// end in the SAME place a store install ends:
//
//   `extensionRegistry.install(kind, ref, actor, { rowOwnership })`.
//
// That single call is the reason there is no parallel installer on this road.
// The dispatcher writes the canonical row at the CHOSEN anchor with HONEST
// supplied provenance (leg 1's `resolveRefSourceRoad` reads the ref's declared
// provenance), then fires the activate hook — which recognises a digest-carrying
// row and drives it through leg 1's supplied pipeline entry, the identical gate
// set the registry road runs — and then runs the kind's NATIVE handler, in the
// order the kind declares it (`agent`, `skill`, `artifact`: pipeline first;
// `connector`: handler first, because its handler is the requires-rebuild
// refusal gate). Nothing in that sentence is re-implemented here.
//
// What IS here is the small amount of honesty the road needs before that call:
//
//   - the snapshot is STAGED first, because the row's provenance must name the
//     bytes it was installed from or the row is unusable the next time the
//     runtime activates it;
//   - the ref DECLARES its provenance, so the row is never a registry claim;
//   - the version is the package's own, read from the package, never supplied by
//     a caller.
// ---------------------------------------------------------------------------

import "server-only";

import {
  isSuppliedPackageProvenance,
  type SuppliedPackageKind,
  type SuppliedPackageProvenance,
} from "@cinatra-ai/extension-types";
import type { InstallRowOwnership } from "@cinatra-ai/extensions/canonical-types";
import type { GitHubTreeClient } from "@cinatra-ai/skills/repository-package-intake";
import {
  prepareSuppliedArchiveSnapshot,
  validateSuppliedPackageForKind,
  type PreparedSuppliedSnapshot,
  type SuppliedKindValidatorResolver,
} from "@/lib/archive-supplied-install";
import { SUPPLIED_PACKAGE_ORIGIN } from "@/lib/extension-install-pipeline";
import { writeSuppliedSnapshot } from "@/lib/extension-package-store";
import { buildNpmLayoutTarball } from "@/lib/supplied-package-tarball";

export type { PreparedSuppliedSnapshot };
export { prepareSuppliedArchiveSnapshot };

/** The one description both roads hand to the dispatcher. */
export type SuppliedInstallCandidate = {
  kind: SuppliedPackageKind;
  packageName: string;
  version: string;
  provenance: SuppliedPackageProvenance;
  /** Whether the kind's own validator ran before anything was staged. */
  validatorRan: boolean;
};

export type PreparedRepositorySnapshot = SuppliedInstallCandidate & {
  repo: string;
  ref: string;
  resolvedSha: string;
  entryCount: number;
  totalBytes: number;
  contentDigest: string;
};

/**
 * READ AT THE PIN, VALIDATE, PACK and STAGE — the repository road's twin of
 * `prepareSuppliedArchiveSnapshot`.
 *
 * The ref is NOT resolved again: re-resolving it is precisely the window the pin
 * exists to close. The bytes are re-read at the commit the operator approved, and
 * a commit or a digest that does not reproduce is refused before anything is
 * packed.
 */
export async function prepareSuppliedRepositorySnapshot(input: {
  client: GitHubTreeClient;
  owner: string;
  repo: string;
  ref: string;
  pin: { resolvedSha: string; contentDigest: string };
  resolveValidator?: SuppliedKindValidatorResolver;
  stageSnapshot?: (contentDigest: string, tarball: Uint8Array) => Promise<string>;
}): Promise<PreparedRepositorySnapshot> {
  const { assertWellFormedPin } = await import("@/lib/repository-supplied-install");
  assertWellFormedPin(input.pin);

  const { fetchGitHubSuppliedPackageAtPin } = await import(
    "@cinatra-ai/skills/repository-package-intake"
  );
  const staged = await fetchGitHubSuppliedPackageAtPin({
    client: input.client,
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
    resolvedSha: input.pin.resolvedSha,
  });

  if (staged.resolvedSha !== input.pin.resolvedSha) {
    throw new Error(
      `[supplied-install] ${input.owner}/${input.repo}: the approved commit ${input.pin.resolvedSha} is not ` +
        `the commit that was staged (${staged.resolvedSha}) — refusing before any write.`,
    );
  }
  if (staged.contentDigest !== input.pin.contentDigest) {
    throw new Error(
      `[supplied-install] ${input.owner}/${input.repo} at ${input.pin.resolvedSha}: the repository no longer ` +
        `delivers the previewed bytes (previewed ${input.pin.contentDigest}, fetched ${staged.contentDigest}) — ` +
        `refusing before any write.`,
    );
  }

  // CRITERION 4, on this road too: the kind's own validator, before the packer.
  const validation = await validateSuppliedPackageForKind({
    kind: staged.kind,
    packageJson: staged.packageJson,
    ...(input.resolveValidator ? { resolveValidator: input.resolveValidator } : {}),
  });

  const tarball = buildNpmLayoutTarball(staged.deliveredEntries);
  const stage = input.stageSnapshot ?? writeSuppliedSnapshot;
  const snapshotPath = await stage(staged.contentDigest, tarball);

  const provenance: SuppliedPackageProvenance = { ...staged.provenance, path: snapshotPath };
  if (!isSuppliedPackageProvenance(provenance)) {
    throw new Error(
      `[supplied-install] ${staged.packageName}: the staged snapshot did not produce complete github ` +
        `provenance — refusing before any write.`,
    );
  }

  return {
    kind: staged.kind,
    packageName: staged.packageName,
    version: staged.version,
    provenance,
    validatorRan: validation.ran,
    repo: staged.repo,
    ref: staged.ref,
    resolvedSha: staged.resolvedSha,
    entryCount: staged.entryCount,
    totalBytes: staged.totalBytes,
    contentDigest: staged.contentDigest,
  };
}

/** The archive road's projection onto the same candidate shape. */
export function candidateFromPreparedArchive(
  prepared: PreparedSuppliedSnapshot,
): SuppliedInstallCandidate {
  return {
    kind: prepared.package.kind,
    packageName: prepared.package.packageName,
    version: prepared.package.version,
    provenance: prepared.provenance,
    validatorRan: prepared.validatorRan,
  };
}

/**
 * Hand a prepared supplied package to the SAME dispatcher a store install uses.
 *
 * `registryUrl` carries the non-registry marker rather than a URL: a supplied
 * package was on no registry, and writing one there would be a claim. The
 * dispatcher never reads it on this road — the ref's declared provenance is what
 * decides the road and what the row records.
 */
export async function installSuppliedCandidate(input: {
  candidate: SuppliedInstallCandidate;
  actor: { actorType: "human" | "model" | "system" | "a2a"; source: "ui"; userId?: string; orgId?: string | null };
  rowOwnership: InstallRowOwnership;
}): Promise<void> {
  // The handler set, registered BEFORE the dispatch and in THIS worker.
  //
  // `extensionRegistry` is per-process state, and a Server Action worker only
  // holds the handlers some module in its own import graph registered. The
  // upload screen's actions are their own entry point: nothing in their graph
  // pulled the registration in, so the registry they reached was empty and the
  // dispatcher answered every supplied install of every kind with
  // `No extension handler registered for typeId: "<kind>"` — the exact failure
  // `handler-bootstrap` was written to prevent, named in its own docstring.
  // Registering here rather than at the module top keeps this the road's own
  // precondition: every caller of the one dispatch entry gets it, on both
  // supplied roads, and no future entry point can forget it.
  await import("@cinatra-ai/extensions/handler-bootstrap");
  const { extensionRegistry } = await import("@cinatra-ai/extensions");
  const { candidate } = input;
  await extensionRegistry.install(
    candidate.kind,
    {
      registryUrl: SUPPLIED_PACKAGE_ORIGIN,
      packageName: candidate.packageName,
      version: candidate.version,
      provenance: candidate.provenance,
    } as never,
    input.actor as never,
    { rowOwnership: input.rowOwnership },
  );
}
