// ---------------------------------------------------------------------------
// extension-package-digest.ts — D2 of cinatra#3204: a CONTENT DIGEST for the
// non-registry source types, plus the EXPLICIT provenance predicates that
// replace the package-NAME heuristics standing in for source discrimination.
//
// WHY THIS EXISTS
//
// A registry install's root of trust is the published tarball's sha512 SRI: the
// registry attested those exact bytes. A package an operator SUPPLIES — a
// dropped archive, a repository at a pinned commit — has no such attestation.
// The two non-registry source shapes could previously record only a REVISION
// identifier (`ExtensionSourceGithub.resolvedSha`,
// `ExtensionSourceLocal.resolvedCommitOrTreeHash`): a pointer at a history, not
// a statement about the tree that was actually delivered. A branch that moved
// between preview and install, or a retagged release, changes the tree without
// changing anything the row records.
//
// The digest below is that missing statement. It is computed over the DELIVERED
// TREE — the exact file set the intake accepted — and it is what makes a
// supplied package drivable through the same install pipeline a store install
// uses: the pipeline verifies bytes against a digest the caller states in
// advance, and here the caller can finally state one.
//
// WHAT IT IS NOT. It is deliberately NOT a Git object id. A commit SHA names a
// revision in a history; this names a byte-for-byte tree, and the two must not
// be confused at a trust boundary (a repository can serve a tree that no commit
// in its history contains). The `sha256-` prefix, the line-oriented encoding and
// the excluded object header all make the two structurally non-interchangeable.
//
// PURE + ISOMORPHIC. No Node imports and no server-only imports: the browser
// preview computes the same digest the server re-computes, over the same bytes,
// so a preview-to-install mismatch is detectable rather than assumed away.
// ---------------------------------------------------------------------------

import { EXTENSION_CONTENT_DIGEST_RE } from "./canonical-types";
import type { ExtensionSource } from "./canonical-types";

/**
 * THE CANONICAL TREE ENCODING.
 *
 * One line per file, in ascending byte order of the UTF-8 path:
 *
 *     <64 lowercase hex sha256 of the file bytes> <byte length> <path>\n
 *
 * Three properties this shape is chosen for:
 *
 *  - ORDER-INDEPENDENT. Entries are sorted, so two archives holding the same
 *    files in a different central-directory order digest identically. Order is
 *    a packaging artefact, not content.
 *  - PATH-BOUND AND LENGTH-BOUND. Renaming a file, or moving bytes from one
 *    file into another, changes the encoding. Without the length a crafted path
 *    containing a newline could otherwise be made to imitate a second line.
 *  - DIRECTORY-FREE. Directory entries carry no bytes, so they are not part of
 *    the tree; an archive that ships explicit directory entries and one that
 *    does not describe the same delivered content.
 */
const DIGEST_PREFIX = "sha256-";

/**
 * The shape every recorded `source.contentDigest` must satisfy. ONE regular
 * expression, declared beside the field in canonical-types (where the source
 * validators read it) and re-exported here under the name the digest callers
 * use — so a change to the grammar can never leave the two out of step.
 */
export const EXTENSION_TREE_DIGEST_RE = EXTENSION_CONTENT_DIGEST_RE;

export function isExtensionTreeDigest(value: unknown): value is string {
  return typeof value === "string" && EXTENSION_TREE_DIGEST_RE.test(value);
}

/**
 * Fail-closed guard for a digest arriving from anywhere but this module — a
 * persisted row, a client preview, a repository intake. `label` names the field
 * so the refusal says WHICH digest was rejected, not merely that one was.
 */
export function assertExtensionTreeDigest(value: unknown, label: string): asserts value is string {
  if (!isExtensionTreeDigest(value)) {
    throw new Error(
      `${label} is not a canonical extension tree digest ` +
        `(expected "sha256-" followed by 64 lowercase hex characters, got ${JSON.stringify(value)})`,
    );
  }
}

export type ExtensionTreeEntry = readonly [path: string, bytes: Uint8Array];

function toHex(buf: ArrayBuffer): string {
  const view = new Uint8Array(buf);
  let out = "";
  for (const byte of view) out += byte.toString(16).padStart(2, "0");
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // `crypto.subtle` is present in every runtime this module is bundled for
  // (the browser preview and Node 18+ on the server), so the digest is ONE
  // implementation rather than a per-runtime pair that could drift.
  const view = new Uint8Array(bytes.byteLength);
  view.set(bytes);
  return toHex(await crypto.subtle.digest("SHA-256", view));
}

/**
 * The canonical encoding of a tree whose per-file hashes are ALREADY computed.
 * Split out from {@link computeExtensionTreeDigest} so the encoding itself is
 * synchronous, directly assertable, and reusable by a caller that hashed the
 * files while streaming them.
 */
export function canonicalExtensionTreeEncodingFromHashes(
  entries: Iterable<readonly [path: string, sha256Hex: string, byteLength: number]>,
): string {
  const rows: { path: string; line: string }[] = [];
  const seen = new Set<string>();
  for (const [path, hex, length] of entries) {
    if (seen.has(path)) {
      throw new Error(
        `cannot digest this tree: duplicate path "${path}" — the delivered file set is ambiguous`,
      );
    }
    seen.add(path);
    rows.push({ path, line: `${hex} ${length} ${path}\n` });
  }
  rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return rows.map((r) => r.line).join("");
}

/**
 * The canonical encoding of a tree, hashing each file synchronously is not
 * possible with WebCrypto, so this overload takes entries whose bytes are
 * hashed by the caller. Kept for the single-entry / test path: it hashes with
 * the synchronous fallback only when the platform offers one, and otherwise
 * callers use {@link computeExtensionTreeDigest}.
 *
 * NOTE this is the SYNCHRONOUS encoding helper used by tests and by callers who
 * already hold per-file hashes; production intake uses
 * {@link computeExtensionTreeDigest}.
 */
export function canonicalExtensionTreeEncoding(entries: Iterable<ExtensionTreeEntry>): string {
  const rows: { path: string; hexPromiseless: string; length: number }[] = [];
  for (const [path, bytes] of entries) {
    rows.push({ path, hexPromiseless: syncSha256Hex(bytes), length: bytes.byteLength });
  }
  return canonicalExtensionTreeEncodingFromHashes(
    rows.map((r) => [r.path, r.hexPromiseless, r.length] as const),
  );
}

/**
 * Compute the tree digest over the delivered files.
 *
 * Refuses an EMPTY tree: an archive with no files attests nothing, and a digest
 * over nothing would be a constant every empty upload shares.
 */
export async function computeExtensionTreeDigest(
  entries: Iterable<ExtensionTreeEntry>,
): Promise<string> {
  const rows: (readonly [string, string, number])[] = [];
  for (const [path, bytes] of entries) {
    rows.push([path, await sha256Hex(bytes), bytes.byteLength] as const);
  }
  if (rows.length === 0) {
    throw new Error("cannot digest this tree: it holds no files");
  }
  const encoding = canonicalExtensionTreeEncodingFromHashes(rows);
  const te = new TextEncoder();
  return `${DIGEST_PREFIX}${await sha256Hex(te.encode(encoding))}`;
}

// ---------------------------------------------------------------------------
// EXPLICIT PROVENANCE
//
// What these replace: `isVerdaccioBackedRef` (packages/extensions/src/index.ts)
// and `isVerdaccioPackageRef` (packages/skills/src/skill-package-source.ts)
// both answered "is this registry-backed?" by looking at the package NAME — a
// scoped name, or the mere presence of a version, meant registry. A scoped
// local package, or any supplied ref carrying a version, was therefore
// misclassified as registry-backed. A name is not a source. These predicates
// read the source's own discriminant instead.
// ---------------------------------------------------------------------------

/**
 * Is this source's content attested by a package registry?
 *
 * TRUE for `verdaccio` ONLY. `bundled` is image-compiled (trusted, but attested
 * by the image build, not a registry); `local` and `github` are supplied by an
 * operator and attested by nothing but this digest. The distinction is a TRUST
 * boundary — a supplied package must never be presented, or classified, as
 * registry-attested.
 */
export function isRegistryAttestedSource(source: ExtensionSource | null | undefined): boolean {
  return source?.type === "verdaccio";
}

/** The D2 digest recorded on a non-registry source, or null when there is none. */
export function sourceContentDigest(source: ExtensionSource | null | undefined): string | null {
  if (!source) return null;
  if (source.type !== "local" && source.type !== "github") return null;
  const digest = (source as { contentDigest?: unknown }).contentDigest;
  return isExtensionTreeDigest(digest) ? digest : null;
}

export type ExtensionProvenanceLabel =
  | "registry-attested"
  | "image-bundled"
  | "supplied file"
  | "supplied repository"
  | "unknown";

/**
 * The honest, operator-facing provenance label. A supplied package NEVER reads
 * as registry-attested — that is the whole point of recording provenance
 * separately from the install road.
 */
export function describeSourceProvenance(
  source: ExtensionSource | null | undefined,
): ExtensionProvenanceLabel {
  switch (source?.type) {
    case "verdaccio":
      return "registry-attested";
    case "bundled":
      return "image-bundled";
    case "local":
      return "supplied file";
    case "github":
      return "supplied repository";
    default:
      return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Synchronous sha256 — the encoding helper's private hash.
//
// WebCrypto is async-only, so the synchronous encoding helper carries a compact
// sha256 of its own. It is used ONLY by `canonicalExtensionTreeEncoding` (the
// assertable encoding seam); every production digest goes through
// `computeExtensionTreeDigest`, which uses WebCrypto. The two agree by
// construction — the suite digests the same bytes both ways.
// ---------------------------------------------------------------------------

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function syncSha256Hex(input: Uint8Array): string {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLen = input.length * 8;
  const withPad = new Uint8Array((((input.length + 9) >> 6) + 1) << 6);
  withPad.set(input);
  withPad[input.length] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, Math.floor(bitLen / 0x100000000), false);
  dv.setUint32(withPad.length - 4, bitLen >>> 0, false);

  const w = new Uint32Array(64);
  for (let offset = 0; offset < withPad.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7]];
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + hh) >>> 0;
  }
  let out = "";
  for (const word of h) out += word.toString(16).padStart(8, "0");
  return out;
}

function rotr(x: number, n: number): number {
  return ((x >>> n) | (x << (32 - n))) >>> 0;
}
