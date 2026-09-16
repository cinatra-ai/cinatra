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
 * here, so this module never needs the parser's import graph. The endpoint below
 * is what that boundary produced, and it is DATA here: the request URL is read
 * for its parts and assembled again from validated ones before anything is
 * fetched.
 */
export type SuppliedRepositoryArchiveTarget = {
  owner: string;
  repo: string;
  /** The ref as submitted, or null for the default branch. */
  ref: string | null;
  /** The public archive endpoint, as the link parser's builder produced it -
   *  re-read and re-assembled from validated parts before it is requested. */
  archiveUrl: string;
};

/**
 * The ONLY host this road downloads from - a constant, never a part of anything
 * anyone typed. The endpoint that arrives from the boundary above is DATA: a
 * road that fetches whatever URL it is handed is a request-forgery sink,
 * whatever the caller meant, so nothing below fetches that string. It is read
 * for its parts, every part is checked against the shapes below, and the request
 * URL is assembled again from this constant and those parts.
 */
const ARCHIVE_HOST = "codeload.github.com";

// THE SHAPES A PART MAY HAVE. They restate the link parser's own guards in
// `@cinatra-ai/skills` (`isSafeOwnerAndRepo`, `isSafeArchiveRef`) rather than
// importing them, because this module must not pull the parser's import graph
// (the Octokit client, the connection client) into the install road.
/** A GitHub owner login: alphanumerics and single inner hyphens. */
const OWNER_SHAPE = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/;
/** A GitHub repository name: alphanumerics plus `.`, `_`, `-`. */
const REPO_SHAPE = /^[A-Za-z0-9._-]+$/;
/** Characters a ref may not carry: control codes, whitespace, and the URL
 *  punctuation that would make the archive path mean something else. */
const UNSAFE_REF_CHARS = new RegExp("[" + "\\u0000-\\u001f\\u007f" + "\\s?#%]");
/** The longest archive ref PATH this road will splice in. The parser caps the
 *  ref itself at 255 characters, and the link builder qualifies a release ref
 *  with "refs/tags/" (ten more) before it reaches this module, so a cap of 255
 *  here would measure a different string and refuse long tags the parser
 *  accepts. */
const MAX_REF_PATH_LENGTH = 265;

/** The owner and repository, in the shape GitHub gives them. */
function isSafeOwnerAndRepo(owner: string, repo: string): boolean {
  if (!OWNER_SHAPE.test(owner)) return false;
  if (repo === "." || repo === ".." || !REPO_SHAPE.test(repo)) return false;
  return true;
}

/**
 * A branch, a tag (qualified or not) or a 40-character commit id, in the shape
 * an archive path carries it.
 *
 * This RESTATES the parser's `isSafeArchiveRef` rule for rule, and deliberately
 * is no STRICTER than it: a shape that merely looks safer is drift, and it
 * refuses archives the parser accepts and GitHub serves - the scoped release tag
 * shape a monorepo publishes under ("refs/tags/@scope/name@1.2.3") and any
 * non-ASCII branch name among them.
 *
 * Refused: an empty or over-long path, a traversal, a backslash, a control or
 * whitespace character, a query, fragment or percent character (the path arrives
 * here DECODED, so a percent left in it is a second encoding), a leading or
 * trailing slash, a leading "-", and an empty or "." segment. Whatever survives
 * is percent-encoded segment by segment in the builder below, so no character in
 * it can mean anything but one path segment.
 */
function isSafeArchiveRefPath(refPath: string): boolean {
  if (refPath.length === 0 || refPath.length > MAX_REF_PATH_LENGTH) return false;
  if (refPath.includes("\\") || refPath.includes("..")) return false;
  if (UNSAFE_REF_CHARS.test(refPath)) return false;
  if (refPath.startsWith("/") || refPath.endsWith("/") || refPath.startsWith("-")) return false;
  return refPath.split("/").every((segment) => segment.length > 0 && segment !== ".");
}

/**
 * READ the parts out of the endpoint the boundary handed down - owner,
 * repository and ref - decoding one path segment at a time.
 *
 * NULL IS A REFUSAL: a foreign host (or one that merely looks like the archive
 * host), plain http, credentials or a port, a query or a fragment, and any path
 * that is not the public source archive of one repository come back as null and
 * are never requested.
 */
function readArchiveEndpointParts(
  archiveUrl: string,
): { owner: string; repo: string; refPath: string } | null {
  let url: URL;
  try {
    url = new URL(archiveUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== ARCHIVE_HOST) return null;
  if (url.port !== "" || url.username !== "" || url.password !== "") return null;
  if (url.search !== "" || url.hash !== "") return null;

  // `/<owner>/<repo>/zip/<ref...>` and nothing else.
  const raw = url.pathname.split("/");
  if (raw.length < 5 || raw[0] !== "" || raw[3] !== "zip") return null;
  let segments: string[];
  try {
    segments = raw.slice(1).map(decodeURIComponent);
  } catch {
    return null;
  }
  const [owner, repo, , ...refSegments] = segments;
  return { owner: owner ?? "", repo: repo ?? "", refPath: refSegments.join("/") };
}

/**
 * BUILD the request URL from validated parts, or refuse.
 *
 * This is the one place a URL is made on this road: the host is the constant
 * above, and each part is checked against its shape and percent-encoded before
 * it is spliced in, so no byte of anyone's string reaches the request
 * unvalidated.
 */
function buildArchiveRequestUrl(parts: {
  owner: string;
  repo: string;
  refPath: string;
}): string | null {
  const { owner, repo, refPath } = parts;
  if (!isSafeOwnerAndRepo(owner, repo)) return null;
  if (!isSafeArchiveRefPath(refPath)) return null;
  const encodedRef = refPath.split("/").map(encodeURIComponent).join("/");
  return `https://${ARCHIVE_HOST}/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/${encodedRef}`;
}

export type FetchedRepositoryArchive = {
  /** The ZIP bytes exactly as they arrived. */
  archive: Uint8Array;
  /** The immutable commit id the archive itself declares. */
  resolvedSha: string;
  /** The ref as submitted, or null when the link named none. */
  ref: string | null;
  /**
   * THE BRANCH NAME PROVED AGAINST THESE BYTES, for a link that named no ref -
   * or null when none was proved. Nothing is guessed: a name is proved only
   * when the archive host serves it the very tree this download received.
   */
  provedRef: string | null;
  /**
   * The repository name the bytes ACTUALLY came from — the last endpoint in the
   * redirect chain, which is the repository's current name when the link named
   * one it has since been renamed away from. The generated root folder is named
   * after THAT name, so it is that name the folder is read against.
   */
  effectiveRepo: string;
  /** The public endpoint the bytes came from - shown, so the operator can check it. */
  archiveUrl: string;
};

const COMMIT_ID_PATTERN = /^[0-9a-f]{40}$/;

/**
 * THE NAMES A BARE LINK'S DEFAULT BRANCH MAY GO BY, in the order they are
 * tried. Two, and no more: every further name is another request on every bare
 * link, and a repository whose default branch is called neither still refuses
 * with the sentence that already tells the operator to type the branch.
 */
const DEFAULT_BRANCH_CANDIDATES = ["main", "master"] as const;

/**
 * The entity tag a response carries, exactly as the host wrote it - or null
 * when it carried none.
 *
 * THE WEAK FORM IS KEPT, and kept WHOLE. The archive host answers a client that
 * accepts compression - which every runtime fetch here is - with a weak
 * validator ("W/..."), because the bytes on the wire are the compressed ones;
 * it is the same content hash it writes strongly to a client that takes the
 * archive uncompressed. Reading that as "no validator" would have made the
 * proof below never fire in the product while passing a fixture that answers
 * strongly. The prefix is NOT stripped: two tags count as one only when the
 * host wrote the identical string for both, weak marker and all, so a weak tag
 * is never compared equal to a strong one.
 */
function archiveEntityTag(response: Response): string | null {
  const etag = response.headers.get("etag")?.trim() ?? "";
  if (etag.length === 0) return null;
  return etag;
}

/**
 * PROVE which branch the bytes that just arrived came from - for a link that
 * named no ref, whose archive the host serves at the stand-in path and whose
 * generated root folder is therefore named after the stand-in rather than after
 * a branch.
 *
 * IT IS AN IDENTITY TEST, NOT AN EXISTENCE TEST. Whether a branch called "main"
 * exists answers a different question: a repository can carry a main branch
 * that is not its default, and recording it would name a branch the bytes did
 * not come from. A candidate counts ONLY when the host answers for it with the
 * very same validator it returned for the download, character for character -
 * the host saying, of its own accord, that the two paths denote one tree. Both
 * tags are read from the same client in the same way, so they are weak or
 * strong together and a difference in kind is itself a mismatch.
 *
 * NO SECOND HOST AND NO SECOND BUILDER. Every request URL comes from the
 * validated-parts builder above, against the one archive-host constant; each
 * request is header-only, follows no redirect, and there are at most two of
 * them. Anything else - no validator on the download, no answer, a different
 * validator, a redirect, a request that fails - proves nothing, and the
 * caller's existing refusal stands word for word.
 */
async function proveDefaultBranchNameOfArchive(input: {
  owner: string;
  repo: string;
  validator: string | null;
  get: typeof fetch;
}): Promise<string | null> {
  if (input.validator === null) return null;
  for (const candidate of DEFAULT_BRANCH_CANDIDATES) {
    const url = buildArchiveRequestUrl({
      owner: input.owner,
      repo: input.repo,
      refPath: `refs/heads/${candidate}`,
    });
    if (url === null) continue;
    let response: Response;
    try {
      response = await input.get(url, { method: "HEAD", redirect: "manual" });
    } catch {
      continue;
    }
    if (!response.ok) continue;
    if (archiveEntityTag(response) === input.validator) return candidate;
  }
  return null;
}

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
  const repository = `${input.owner}/${input.repo}`;
  const refLabel = input.ref ?? "its default branch";
  const get = input.fetchImpl ?? fetch;

  // THE ENDPOINT IS REBUILT, NEVER FETCHED AS HANDED. What arrived is read for
  // its parts, the parts are checked against their shapes, and the URL below is
  // assembled from the host constant and those parts alone. It must also name
  // the repository this install is for: a link that resolves to anything else is
  // refused here, before any request.
  const parts = readArchiveEndpointParts(input.archiveUrl);
  const archiveUrl =
    parts && parts.owner === input.owner && parts.repo === input.repo
      ? buildArchiveRequestUrl(parts)
      : null;
  if (archiveUrl === null) {
    throw new Error(
      `[supplied-install] refusing to download an extension package from "${input.archiveUrl}" — ` +
        `this road downloads only the public source archive of ${repository} from ${ARCHIVE_HOST}, ` +
        `at a branch, tag or commit it can name.`,
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

  // THE NAME FOR THE ROW, PROVED AGAINST THESE BYTES. A link that named no ref
  // means the repository's default branch, and the stand-in path is exactly how
  // the archive host serves it - which is why these bytes name no branch
  // themselves. The identity test asks the host, in at most two header-only
  // requests, which branch denotes exactly this tree; when it proves none, the
  // name settler refuses as it always has.
  const servedBy = readArchiveEndpointParts(target);
  const provedRef =
    usableSubmittedRef(input.ref) === null && parts !== null && isPlaceholderRefName(parts.refPath)
      ? await proveDefaultBranchNameOfArchive({
          owner: servedBy?.owner || input.owner,
          repo: servedBy?.repo || input.repo,
          validator: archiveEntityTag(response),
          get,
        })
      : null;

  return {
    archive: new Uint8Array(buffer),
    resolvedSha: declared,
    // A LINK THAT NAMED NO REF SAYS SO, and says it as nothing rather than as a
    // word. "HEAD" is the sentinel the canonical row's validator rejects, so a
    // download that minted it here was minting the refusal three steps later.
    ref: input.ref,
    provedRef,
    // READ OFF THE ENDPOINT THAT SERVED THE BYTES, not off the link as typed: a
    // renamed repository is served under its current name, and its archive's
    // root folder carries that name.
    effectiveRepo: servedBy?.repo || input.repo,
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

/**
 * The sentinels a canonical row may NEVER carry — the set
 * `validateExtensionSource` refuses a source for (`canonical-types.ts`,
 * PROVENANCE_PLACEHOLDERS). They are stand-ins written before a real
 * resolution, so one arriving from a caller means "nothing was named here",
 * never "this is the ref the operator typed".
 */
const REF_PLACEHOLDERS = new Set(["pending-resolution", "latest", "HEAD"]);

/** Whether a value is one of those stand-ins rather than a name. */
export function isPlaceholderRefName(value: string | null | undefined): boolean {
  return typeof value === "string" && REF_PLACEHOLDERS.has(value.trim());
}

/**
 * The ref the operator TYPED, or null when nothing was typed. A stand-in
 * arriving from a caller is nothing, never a typed ref.
 */
function usableSubmittedRef(value: string | null | undefined): string | null {
  const submitted = value?.trim() ?? "";
  if (submitted.length === 0 || isPlaceholderRefName(submitted)) return null;
  return submitted;
}

/**
 * THE BRANCH NAME THE DOWNLOADED ARCHIVE ITSELF CARRIES.
 *
 * A generated source archive has exactly one root folder and the host names it
 * after the repository and the ref it was generated for - "thing-main". For a
 * link that named no ref that folder is the only place the bytes say which
 * branch they came from, and reading it costs nothing: the archive is already
 * downloaded and the folder is already stripped.
 *
 * NOTHING IS GUESSED. A root that does not begin with the repository's own
 * name, an empty remainder, a stand-in, or the commit id the archive declares
 * (which is exactly what a download BY COMMIT names its folder after) all yield
 * null, and the caller refuses instead of recording a name the repository never
 * used. The host flattens a slash in a ref into a dash, so what comes back is
 * the name the archive carries, not a reconstruction of a namespaced ref.
 */
export function defaultBranchNameFromGeneratedRoot(input: {
  /** The name the archive was generated under — the endpoint that served it. */
  repo: string;
  rootFolder: string | null | undefined;
  resolvedSha: string;
}): string | null {
  const root = input.rootFolder?.trim() ?? "";
  const prefix = `${input.repo}-`;
  if (!root.startsWith(prefix)) return null;
  const name = root.slice(prefix.length);
  if (name.length === 0 || isPlaceholderRefName(name)) return null;
  if (/^[0-9a-f]{7,40}$/.test(name) && input.resolvedSha.startsWith(name)) return null;
  return name;
}

/**
 * THE NAME THE ROW WILL RECORD, settled before any row is written.
 *
 * It is the ref the operator typed when they typed one, and otherwise the
 * default branch as the archive itself names it. When it can be neither, this
 * refuses and says which of the two it could not have - a row carrying a
 * stand-in is refused by the install's own validator anyway, so recording one
 * would only move the refusal somewhere the operator cannot act on it.
 */
function finalizeRecordedRef(input: {
  owner: string;
  repo: string;
  /**
   * The repository name the downloaded archive was generated under. It is the
   * link's own name except when the download was redirected to a repository
   * that has been renamed, and it is the only name the root folder can be read
   * against - reading "thing-new-main" against a stale "thing" would strip the
   * wrong prefix and record "new-main", a ref no repository ever had.
   */
  archiveRepo?: string;
  submitted: string | null | undefined;
  rootFolder: string | null | undefined;
  /**
   * The branch name the download PROVED against the bytes it returned, for a
   * link that named no ref. It is consulted only when neither the operator nor
   * the archive's own root folder named one.
   */
  proved?: string | null;
  resolvedSha: string;
}): string {
  const submitted = usableSubmittedRef(input.submitted);
  if (submitted !== null) return submitted;
  const derived = defaultBranchNameFromGeneratedRoot({
    repo: input.archiveRepo ?? input.repo,
    rootFolder: input.rootFolder,
    resolvedSha: input.resolvedSha,
  });
  if (derived !== null) return derived;
  // THE NAME THE DOWNLOAD PROVED - the one case the root folder cannot cover,
  // because a bare link's archive is generated at the stand-in and named after
  // it. It is a name the bytes are proved to have come from, never a guess.
  const proved = input.proved?.trim() ?? "";
  if (proved.length > 0 && !isPlaceholderRefName(proved)) return proved;
  throw new Error(
    `[supplied-install] ${input.owner}/${input.repo}: this install could not resolve the branch, tag or ` +
      `release name to record - the link named none and the archive that was downloaded does not name the ` +
      `branch it was generated from. Type the branch, tag or release to install from and try again. ` +
      `Nothing was written.`,
  );
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
  // WHAT THE SCREEN SHOWS IS WHAT THE ROW WILL RECORD. The preview settles the
  // name here, so the operator approves the same ref the install writes.
  const ref = finalizeRecordedRef({
    owner: input.owner,
    repo: input.repo,
    archiveRepo: fetched.effectiveRepo,
    submitted: fetched.ref,
    rootFolder: preview.generatedRootFolder,
    proved: fetched.provedRef,
    resolvedSha: fetched.resolvedSha,
  });
  return {
    ...preview,
    repo: `${input.owner}/${input.repo}`,
    ref,
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
          // Through the same builder as every other request on this road; an
          // out-of-shape pin yields no URL at all and is refused below, before
          // any request.
          archiveUrl:
            buildArchiveRequestUrl({
              owner: input.owner,
              repo: input.repo,
              refPath: input.pin.resolvedSha,
            }) ?? "",
        }
      : input,
  );
  const repository = `${input.owner}/${input.repo}`;

  // The archive asked for by commit id must still DECLARE that commit: a host
  // that served something else is not serving the approved tree.
  if (input.pin && fetched.resolvedSha !== input.pin.resolvedSha) {
    throw new Error(
      `[supplied-install] ${repository}: the approved commit ${input.pin.resolvedSha} is not the commit ` +
        `the downloaded archive was generated from (${fetched.resolvedSha}) - refusing before any write.`,
    );
  }

  // THE NAME IS SETTLED BEFORE ANYTHING IS STAGED. What arrives from the screen
  // is the name the operator typed - or the stand-in the preview once produced
  // for a bare link, which is read here as "nothing was typed" and resolved from
  // the archive's own root folder. Neither resolvable is a refusal taken HERE,
  // before the intake below writes the snapshot to the store, so a refused
  // install leaves nothing behind at all. The root folder costs one read of the
  // bytes already in memory, and only on the road that has no typed ref.
  const recordedRef = finalizeRecordedRef({
    owner: input.owner,
    repo: input.repo,
    archiveRepo: fetched.effectiveRepo,
    submitted: input.ref,
    rootFolder:
      usableSubmittedRef(input.ref) === null
        ? (await previewSuppliedArchive(fetched.archive, { unwrapGeneratedRootFolder: true }))
            .generatedRootFolder
        : undefined,
    proved: fetched.provedRef,
    resolvedSha: fetched.resolvedSha,
  });

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
