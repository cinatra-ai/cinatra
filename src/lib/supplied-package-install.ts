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
import { MAX_ARCHIVE_TOTAL_BYTES, readZipArchiveComment } from "@cinatra-ai/agents/upload-archive";
import {
  prepareSuppliedArchiveSnapshot,
  previewSuppliedArchive,
  validateSuppliedPackageForKind,
  type PreparedSuppliedSnapshot,
  type SuppliedArchivePreview,
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

// ---------------------------------------------------------------------------
// THE ANONYMOUS ARCHIVE (cinatra#3204 fix leg)
//
// THE MAINTAINER'S RULING, in their words: "Anyone can download a ZIP of
// origin/main of a repo or a ZIP of a release - no need to be logged in at
// GitHub. The user provides that link and Cinatra gets the ZIP."
//
// So the repository road stops being a connected-account road. It downloads the
// public source archive the link names and then does the one thing that keeps
// this honest: it hands those bytes to `prepareSuppliedArchiveSnapshot` - the
// FILE road's own intake - unchanged. Same reader, same caps, same entry-name
// and symlink refusals, same kind resolution, same validator, same packer, same
// staging, same dispatcher. The only thing this module adds is where the bytes
// came from and how that is recorded.
//
// THE PIN SURVIVES THE CHANGE. A generated archive carries the commit id of the
// tree it packed in its ZIP comment, so the road still names ONE immutable
// commit - read off the bytes that actually arrived rather than off a ref that
// can move between the preview and the install - and the previewed digest is
// still re-checked before anything is staged.
// ---------------------------------------------------------------------------

/**
 * What the link said to fetch. The screen's server boundary parses the link (the
 * parser and the URL builder are `@cinatra-ai/skills`) and hands the RESULT down
 * here, so this module never needs the parser's import graph — and never gets to
 * invent a URL of its own.
 */
export type SuppliedRepositoryArchiveTarget = {
  owner: string;
  repo: string;
  /** The ref as submitted, or null for the default branch. */
  ref: string | null;
  /** The public archive endpoint, as the link parser's builder produced it. */
  archiveUrl: string;
};

/**
 * The ONLY host this road downloads from. The URL arrives as data from the
 * boundary above, so it is re-checked here rather than trusted: a road that
 * fetches whatever URL it is handed is a request-forgery sink, whatever the
 * caller meant.
 */
const ARCHIVE_HOST = "codeload.github.com";

export type FetchedRepositoryArchive = {
  /** The ZIP bytes exactly as they arrived. */
  archive: Uint8Array;
  /** The immutable commit id the archive itself declares. */
  resolvedSha: string;
  /** The ref as submitted, or "HEAD" when the link named none. */
  ref: string;
  /** The public endpoint the bytes came from - shown, so the operator can check it. */
  archiveUrl: string;
};

const COMMIT_ID_PATTERN = /^[0-9a-f]{40}$/;

/**
 * DOWNLOAD the public source archive, anonymously.
 *
 * Every way this can fail is a sentence an operator can act on, because the one
 * thing they cannot see from here is why a link did not work. A private
 * repository and a wrong link are indistinguishable from outside (the host
 * answers 404 to both, deliberately), so the refusal names both possibilities
 * instead of asserting the one it cannot know.
 */
export async function fetchSuppliedRepositoryArchive(
  input: SuppliedRepositoryArchiveTarget & { fetchImpl?: typeof fetch },
): Promise<FetchedRepositoryArchive> {
  const archiveUrl = input.archiveUrl;
  const repository = `${input.owner}/${input.repo}`;
  const refLabel = input.ref ?? "its default branch";
  const get = input.fetchImpl ?? fetch;

  let host: string;
  try {
    host = new URL(archiveUrl).hostname;
  } catch {
    host = "";
  }
  if (host !== ARCHIVE_HOST) {
    throw new Error(
      `[supplied-install] refusing to download an extension package from "${archiveUrl}" — ` +
        `this road downloads only from ${ARCHIVE_HOST}.`,
    );
  }

  // EVERY HOP IS CHECKED, not just the first. `redirect: "follow"` would hand the
  // request to whatever Location came back, which is the one thing the host
  // allow-list above exists to prevent, so redirects are followed BY HAND and
  // each destination is re-checked against the same allow-list before it is
  // fetched. Three hops is more than the archive endpoint has ever needed.
  let response: Response;
  let target = archiveUrl;
  for (let hop = 0; ; hop++) {
    try {
      response = await get(target, { redirect: "manual" });
    } catch (err) {
      throw new Error(
        `[supplied-install] the archive for ${repository} could not be downloaded from ${target}: ` +
          `${err instanceof Error ? err.message : String(err)}.`,
      );
    }
    if (response.status < 300 || response.status > 399) break;
    const location = response.headers.get("location");
    if (!location) {
      throw new Error(
        `[supplied-install] the archive download for ${repository} was redirected (HTTP ` +
          `${response.status}) without saying where - refusing.`,
      );
    }
    let next: URL;
    try {
      next = new URL(location, target);
    } catch {
      throw new Error(
        `[supplied-install] the archive download for ${repository} was redirected to "${location}", ` +
          `which is not a URL this road can follow - refusing.`,
      );
    }
    if (next.protocol !== "https:" || next.hostname !== ARCHIVE_HOST) {
      throw new Error(
        `[supplied-install] the archive download for ${repository} was redirected to "${next.href}" - ` +
          `this road downloads only from ${ARCHIVE_HOST} over https, so it stops here.`,
      );
    }
    if (hop >= 3) {
      throw new Error(
        `[supplied-install] the archive download for ${repository} redirected more than three times - ` +
          `refusing.`,
      );
    }
    target = next.href;
  }

  if (response.status === 404) {
    throw new Error(
      `[supplied-install] GitHub served no archive for ${repository} at ${refLabel} (HTTP 404). ` +
        `This instance downloads the archive anonymously, so a private repository - or a branch, tag ` +
        `or release that does not exist - cannot be read. Check the link, or upload the package as a file.`,
    );
  }
  if (response.status === 403 || response.status === 429) {
    throw new Error(
      `[supplied-install] GitHub refused the anonymous archive download for ${repository} ` +
        `(HTTP ${response.status}) - its rate limit for this instance. Wait and try again, or upload ` +
        `the package as a file.`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `[supplied-install] GitHub could not serve the archive for ${repository} at ${refLabel} ` +
        `(HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}).`,
    );
  }

  const overCap = (bytes: number) =>
    new Error(
      `[supplied-install] the archive for ${repository} at ${refLabel} is ${bytes} bytes, ` +
        `over the ${MAX_ARCHIVE_TOTAL_BYTES}-byte limit - refusing.`,
    );

  // THE CAP IS ENFORCED WHILE THE BODY ARRIVES, not after it. A repository whose
  // archive is far over the limit must never be allocated in full first: the
  // stream is read chunk by chunk, the running total is checked against the cap
  // on every chunk, and the download is cancelled the moment it is exceeded.
  const declaredLength = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_ARCHIVE_TOTAL_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw overCap(declaredLength);
  }

  const buffer = await readCappedBody(response, MAX_ARCHIVE_TOTAL_BYTES, overCap);

  // THE PIN, read off the bytes that arrived (see the module note above).
  const declared = readZipArchiveComment(buffer)?.trim() ?? "";
  if (!COMMIT_ID_PATTERN.test(declared)) {
    throw new Error(
      `[github-install] "${declared}" is not an immutable 40-character commit sha - ` +
        `the archive downloaded for ${repository} at ${refLabel} declares no commit it was generated ` +
        `from, so this install cannot be pinned. Refusing.`,
    );
  }

  return {
    archive: new Uint8Array(buffer),
    resolvedSha: declared,
    ref: input.ref ?? "HEAD",
    archiveUrl,
  };
}

/**
 * READ a response body under a hard byte cap, cancelling the download the moment
 * the cap is passed. Falls back to `arrayBuffer()` only when the response
 * carries no readable stream (a stubbed Response in a test), and checks the cap
 * there too.
 */
async function readCappedBody(
  response: Response,
  cap: number,
  overCap: (bytes: number) => Error,
): Promise<ArrayBuffer> {
  const body = response.body;
  if (!body || typeof body.getReader !== "function") {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > cap) throw overCap(buffer.byteLength);
    return buffer;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => undefined);
      throw overCap(total);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out.buffer;
}

export type SuppliedRepositoryArchivePreview = SuppliedArchivePreview & {
  repo: string;
  ref: string;
  resolvedSha: string;
  archiveUrl: string;
};

/**
 * PREVIEW a link: download the archive and read it with the FILE road's reader.
 * Writes nothing and stages nothing, exactly as the file tab's preview does.
 */
export async function previewSuppliedRepositoryArchive(
  input: SuppliedRepositoryArchiveTarget & { fetchImpl?: typeof fetch },
): Promise<SuppliedRepositoryArchivePreview> {
  const fetched = await fetchSuppliedRepositoryArchive(input);
  const preview = await previewSuppliedArchive(fetched.archive, {
    unwrapGeneratedRootFolder: true,
  });
  return {
    ...preview,
    repo: `${input.owner}/${input.repo}`,
    ref: fetched.ref,
    resolvedSha: fetched.resolvedSha,
    archiveUrl: fetched.archiveUrl,
  };
}

/**
 * DOWNLOAD, then READ, VALIDATE, PACK and STAGE through the FILE road's intake -
 * the repository road's twin of `prepareSuppliedArchiveSnapshot`, and now
 * literally a call to it.
 *
 * The pin is re-checked twice: the commit the archive declares must be the
 * commit the operator approved, and the digest the file road computes over the
 * delivered tree must be the digest they were shown. Either mismatch refuses
 * before anything is packed. The provenance recorded is `github` - the file
 * road's honest `local` provenance would name the staged snapshot and forget the
 * repository it came from.
 */
export async function prepareSuppliedRepositoryArchiveSnapshot(
  input: SuppliedRepositoryArchiveTarget & {
    pin?: { resolvedSha: string; contentDigest: string };
    resolveValidator?: SuppliedKindValidatorResolver;
    stageSnapshot?: (contentDigest: string, tarball: Uint8Array) => Promise<string>;
    fetchImpl?: typeof fetch;
  },
): Promise<PreparedRepositorySnapshot> {
  if (input.pin) {
    const { assertWellFormedPin } = await import("@/lib/repository-supplied-install");
    assertWellFormedPin(input.pin);
  }

  // THE INSTALL DOWNLOADS AT THE APPROVED COMMIT, not at the ref the operator
  // typed. A ref moves; a commit does not. Once a pin exists the archive is
  // asked for BY ITS COMMIT ID - the same public endpoint, the same host, an
  // immutable path - so a branch that advanced between the preview and the click
  // installs exactly what was approved instead of failing the comparison below.
  // The submitted ref is still what the row records: it is where the package was
  // found, and the commit is what was installed.
  const fetched = await fetchSuppliedRepositoryArchive(
    input.pin
      ? {
          ...input,
          ref: input.pin.resolvedSha,
          archiveUrl: `https://${ARCHIVE_HOST}/${input.owner}/${input.repo}/zip/${input.pin.resolvedSha}`,
        }
      : input,
  );
  const repository = `${input.owner}/${input.repo}`;
  const recordedRef = input.ref ?? fetched.ref;

  // The archive asked for by commit id must still DECLARE that commit: a host
  // that served something else is not serving the approved tree.
  if (input.pin && fetched.resolvedSha !== input.pin.resolvedSha) {
    throw new Error(
      `[supplied-install] ${repository}: the approved commit ${input.pin.resolvedSha} is not the commit ` +
        `the downloaded archive was generated from (${fetched.resolvedSha}) - refusing before any write.`,
    );
  }

  // THE FILE ROAD'S OWN INTAKE. Nothing below this line is repository-specific.
  const prepared = await prepareSuppliedArchiveSnapshot({
    archive: fetched.archive,
    unwrapGeneratedRootFolder: true,
    ...(input.pin ? { expectedContentDigest: input.pin.contentDigest } : {}),
    ...(input.resolveValidator ? { resolveValidator: input.resolveValidator } : {}),
    ...(input.stageSnapshot ? { stageSnapshot: input.stageSnapshot } : {}),
  });

  const provenance: SuppliedPackageProvenance = {
    type: "github",
    repo: repository,
    ref: recordedRef,
    resolvedSha: fetched.resolvedSha,
    contentDigest: prepared.package.contentDigest,
    ...(prepared.provenance.path ? { path: prepared.provenance.path } : {}),
  };
  if (!isSuppliedPackageProvenance(provenance)) {
    throw new Error(
      `[supplied-install] ${prepared.package.packageName}: the staged snapshot did not produce complete ` +
        `github provenance - refusing before any write.`,
    );
  }

  return {
    kind: prepared.package.kind,
    packageName: prepared.package.packageName,
    version: prepared.package.version,
    provenance,
    validatorRan: prepared.validatorRan,
    repo: repository,
    ref: recordedRef,
    resolvedSha: fetched.resolvedSha,
    entryCount: prepared.package.deliveredEntries.size,
    totalBytes: prepared.tarball.byteLength,
    contentDigest: prepared.package.contentDigest,
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
