// ---------------------------------------------------------------------------
// repository-supplied-install.ts — THE REPOSITORY ROAD'S DRIVER (cinatra#3204 leg 2,
// criteria 7, 8, 18-20).
//
// It joins three things that already exist and adds nothing of its own to the
// gate set:
//
//   the INTAKE (packages/skills/repository-package-intake) — which resolved the ref
//   to one immutable commit sha, staged the tree at that sha under the
//   containment policy, and resolved the kind through the shared predicate;
//
//   the PACKER (supplied-package-tarball) — which turns the delivered tree into
//   the npm-layout tarball the store already materializes;
//
//   leg 1's ENTRY (installExtensionFromSuppliedSnapshot) — which runs the SAME
//   gate set a registry install runs, verifies the digest over what actually
//   landed, and records honest `github` provenance instead of a registry row.
//
// The one judgement this module makes is the PIN CHECK. An install carries the
// pin the preview produced, and the bytes are re-read AT THAT COMMIT — never by
// re-resolving the ref, because re-resolving is precisely the window a moving
// branch needs. A different sha, or the same sha delivering a different digest,
// is REFUSED here — before the packer runs, before the store is touched, and
// therefore before anything durable exists to undo.
// ---------------------------------------------------------------------------

import { isContentDigest } from "@cinatra-ai/extension-types";
import {
  COMMIT_SHA_PATTERN,
  fetchGitHubSuppliedPackageAtPin,
  type GitHubSuppliedPackagePreview,
  type GitHubTreeClient,
} from "@cinatra-ai/skills/repository-package-intake";
import {
  installExtensionFromSuppliedSnapshot,
  type InstallPipelineResult,
  type SuppliedInstallPipelineDeps,
} from "@/lib/extension-install-pipeline";
import type { ExtensionStoreKind } from "@/lib/extension-package-store-core";
import { writeSuppliedSnapshot } from "@/lib/extension-package-store";
import { buildNpmLayoutTarball } from "@/lib/supplied-package-tarball";

export { previewGitHubSuppliedPackage } from "@cinatra-ai/skills/repository-package-intake";
export type { GitHubSuppliedPackagePreview, GitHubTreeClient };

/**
 * What the caller echoes back from the preview. Both halves are checked: the sha
 * says which commit was approved, the digest says which bytes were read at it,
 * and an install that cannot reproduce BOTH is not the install that was
 * previewed.
 */
export type GitHubSuppliedInstallPin = {
  resolvedSha: string;
  contentDigest: string;
};

export type GitHubSuppliedInstallInput = {
  client: GitHubTreeClient;
  owner: string;
  repo: string;
  /** The ref the operator submitted — recorded on the row, never re-resolved here. */
  ref: string;
  pin: GitHubSuppliedInstallPin;
  /**
   * The preview the pin came from, when the caller still holds it. Passing it
   * lets the driver refuse a pin that was never previewed at all — the caller
   * side of the same mismatch the staging echo-check catches on the server side.
   */
  preview?: GitHubSuppliedPackagePreview;
  orgId?: string | null;
  actorUserId?: string | null;
  storeRoot?: string;
  installOpId?: string;
  /**
   * Stage the packed snapshot and return the ROOT-RELATIVE name recorded as the
   * provenance `path`. Injectable so a unit test can prove the row carries a
   * snapshot location without writing into the host's snapshot root; production
   * uses the store's own writer, which owns the root and derives the file name
   * from the content digest alone.
   */
  stageSnapshot?: (contentDigest: string, tarball: Uint8Array) => Promise<string>;
};

export type GitHubSuppliedInstallResult = {
  result: InstallPipelineResult;
  /** What was actually read at the pin — the row's own account of the install. */
  package: GitHubSuppliedPackagePreview;
};

/**
 * Refuse a pin the preview could not have produced, before a single request is
 * made. A malformed pin is a caller bug, and the cheapest place to say so is
 * before the network.
 */
export function assertWellFormedPin(pin: GitHubSuppliedInstallPin): void {
  if (!COMMIT_SHA_PATTERN.test(pin.resolvedSha)) {
    throw new Error(
      `[github-install] "${pin.resolvedSha}" is not an immutable 40-character commit sha — ` +
        `refusing to install from a reference that can move.`,
    );
  }
  if (!isContentDigest(pin.contentDigest)) {
    throw new Error(
      `[github-install] the pinned content digest "${pin.contentDigest}" is not a well-formed digest — ` +
        `refusing an install that cannot prove the previewed bytes are the installed bytes.`,
    );
  }
}

/**
 * Refuse a pin that does not belong to the preview it claims to come from.
 *
 * Separate from `assertWellFormedPin` because it answers a different question: a
 * pin can be perfectly well-formed and still be somebody else's commit.
 */
export function assertPinMatchesPreview(
  preview: GitHubSuppliedPackagePreview,
  pin: GitHubSuppliedInstallPin,
): void {
  if (preview.resolvedSha !== pin.resolvedSha) {
    throw new Error(
      `[github-install] the install pin names commit ${pin.resolvedSha}, but the preview resolved ` +
        `${preview.resolvedSha} — refusing an install of a commit that was never previewed.`,
    );
  }
  if (preview.contentDigest !== pin.contentDigest) {
    throw new Error(
      `[github-install] the install pin names content digest ${pin.contentDigest}, but the preview read ` +
        `${preview.contentDigest} — refusing an install of bytes that were never previewed.`,
    );
  }
}

/**
 * Install a GitHub repository as a supplied package of WHATEVER KIND it declares.
 *
 * The kind is not a parameter: it comes from the repository's manifest through
 * the shared predicate, and it is what the store placement and the pipeline's
 * trust decision are both told. A connector reaching this entry is refused
 * downstream by the trust boundary leg 1 established — correctly, and without
 * this module needing to know why.
 */
export async function installGitHubSuppliedPackage(
  input: GitHubSuppliedInstallInput,
  deps: SuppliedInstallPipelineDeps,
): Promise<GitHubSuppliedInstallResult> {
  assertWellFormedPin(input.pin);
  if (input.preview) assertPinMatchesPreview(input.preview, input.pin);

  // Re-read AT THE PIN. `fetchGitHubSuppliedPackageAtPin` does not resolve the
  // ref again, and it refuses a commit that comes back under a different id.
  const staged = await fetchGitHubSuppliedPackageAtPin({
    client: input.client,
    owner: input.owner,
    repo: input.repo,
    ref: input.ref,
    resolvedSha: input.pin.resolvedSha,
  });

  if (staged.resolvedSha !== input.pin.resolvedSha) {
    throw new Error(
      `[github-install] ${input.owner}/${input.repo}: the previewed commit ${input.pin.resolvedSha} is not the ` +
        `commit that was staged (${staged.resolvedSha}) — refusing before any write.`,
    );
  }
  if (staged.contentDigest !== input.pin.contentDigest) {
    throw new Error(
      `[github-install] ${input.owner}/${input.repo} at ${input.pin.resolvedSha}: the repository no longer delivers ` +
        `the previewed bytes (previewed ${input.pin.contentDigest}, fetched ${staged.contentDigest}) — refusing ` +
        `before any write.`,
    );
  }

  const tarball = buildNpmLayoutTarball(staged.deliveredEntries);

  // STAGE THE SNAPSHOT, then record where it went. A `github` row whose
  // provenance names no staged snapshot is refused by `readSuppliedSnapshot` the
  // next time the runtime activates it, so installing without staging would
  // write a row that works once and then never again. The name comes from the
  // content digest, never from anything the repository supplies.
  const stage = input.stageSnapshot ?? writeSuppliedSnapshot;
  const snapshotPath = await stage(staged.contentDigest, tarball);

  const result = await installExtensionFromSuppliedSnapshot(
    {
      packageName: staged.packageName,
      version: staged.version,
      orgId: input.orgId ?? null,
      ...(input.actorUserId === undefined ? {} : { actorUserId: input.actorUserId }),
      ...(input.storeRoot ? { storeRoot: input.storeRoot } : {}),
      ...(input.installOpId ? { installOpId: input.installOpId } : {}),
      expectedKind: staged.kind as ExtensionStoreKind,
      supplied: { tarball, provenance: { ...staged.provenance, path: snapshotPath } },
    },
    deps,
  );

  return { result, package: staged };
}
