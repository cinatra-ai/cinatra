import "server-only";

// ---------------------------------------------------------------------------
// extension-install-supplied-source.ts — D1 of cinatra#3204: a SOURCE-AGNOSTIC
// entry into the install pipeline, for a package an operator SUPPLIED rather
// than one a registry published.
//
// THE OBSERVATION THIS IS BUILT ON. The install pipeline
// (`installExtensionFromRegistry`) was never registry-coupled in its gates. Its
// signed materialization plan, signature verdict, host-compat gate, install-op
// journal, host-port grants, provenance write, finalize cross-check and
// rollback all operate on bytes plus a digest, and care nothing about where the
// bytes came from. The coupling lives in exactly two INJECTED seams:
//
//   - `resolveIntegrity` — reads the sha512 SRI off a registry packument;
//   - `materialize`      — fetches that registry's tarball into the store.
//
// So a supplied package needs no second installer, and this module builds none.
// It seals the delivered tree into an immutable snapshot whose bytes are their
// own root of trust, and swaps ONLY those two seams. Every gate after them is
// the gate a store install runs, in the order a store install runs it.
//
// WHAT "ITS OWN ROOT OF TRUST" MEANS, AND WHAT IT DOES NOT. The SRI below is
// computed over the tarball this host packed from the tree this host verified —
// it binds DELIVERY (the bytes that reach the store are the bytes the operator
// supplied and the preview digested), and it binds nothing about a publisher.
// A supplied package is unsigned and stays untrusted: its recorded registry
// identity is deliberately not a trusted activation host, so trust
// classification lands on `untrusted`, host-port grants stay `pending` until an
// admin approves them, and the provenance recorded on the canonical row reads
// `local` or `github` — never registry-attested.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

import {
  EXTENSION_TREE_DIGEST_RE,
  computeExtensionTreeDigest,
} from "@cinatra-ai/extensions/extension-package-digest";
import type {
  ExtensionSourceGithub,
  ExtensionSourceLocal,
} from "@cinatra-ai/extensions/canonical-types";
import type { InstallPipelineDeps } from "@/lib/extension-install-pipeline";
import type { ExtensionStoreKind } from "@/lib/extension-package-store-core";
import type { MaterializeInput, MaterializeDeps, MaterializedPackage } from "@/lib/extension-package-store";

/**
 * The "registry" identity a supplied install records.
 *
 * It is a scheme, not a host, and it resolves to nothing. That is the point:
 * trust classification asks whether the recorded registry is a TRUSTED
 * ACTIVATION HOST, and this value can never be one however the deployment's
 * trusted-host list is configured. A supplied package therefore classifies
 * untrusted by construction rather than by a rule someone must remember to
 * keep in place.
 */
export const SUPPLIED_SOURCE_REGISTRY_IDENTITY = "supplied:operator-upload";

/** Where the operator got the package. Drives the recorded provenance shape. */
export type SuppliedPackageOrigin =
  | { kind: "file"; fileName: string }
  | { kind: "github"; repo: string; ref: string; resolvedSha: string };

export type SuppliedPackageInput = {
  packageName: string;
  version: string;
  extensionKind: ExtensionStoreKind;
  /** The digest the PREVIEW stated for this tree. Verified here, never trusted. */
  contentDigest: string;
  /** The delivered tree, package-root-relative. */
  files: Map<string, Uint8Array>;
  origin: SuppliedPackageOrigin;
};

export type SealedSuppliedPackage = {
  packageName: string;
  version: string;
  extensionKind: ExtensionStoreKind;
  /** The RE-COMPUTED digest — equal to the stated one, or this object does not exist. */
  contentDigest: string;
  origin: SuppliedPackageOrigin;
  /** The npm-shaped tarball packed from the verified tree. */
  tarball: Buffer;
  /** The sha512 SRI over `tarball`. */
  integrity: string;
};

// ---------------------------------------------------------------------------
// Packing
// ---------------------------------------------------------------------------

const BLOCK = 512;
const NPM_PREFIX = "package/";

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, "0") + "\0";
}

function splitUstarName(name: string): { name: string; prefix: string } {
  // BYTES, not characters. The header fields are 100 and 155 BYTES wide and
  // `Buffer.write` truncates silently at the field width, so measuring UTF-16
  // code units would let a short non-ASCII path be written as a corrupted one —
  // a package extracted under a name nobody chose.
  const bytes = (value: string) => Buffer.byteLength(value, "utf8");
  if (bytes(name) <= 100) return { name, prefix: "" };
  // ustar splits a long path at a "/" boundary: up to 155 bytes of prefix plus
  // up to 100 bytes of name. Walk the boundaries from the FRONT and take the
  // first that fits, so the prefix stays as short as the format allows and the
  // leaf keeps as much of the path as it can hold.
  for (let i = 0; i < name.length; i++) {
    if (name[i] !== "/") continue;
    const prefix = name.slice(0, i);
    const rest = name.slice(i + 1);
    if (bytes(prefix) <= 155 && bytes(rest) <= 100) return { name: rest, prefix };
  }
  throw new Error(
    `[supplied-source] path ${JSON.stringify(name)} is too long to record in a tar archive ` +
      `(the ustar format admits at most 155 bytes of directory prefix plus 100 bytes of name)`,
  );
}

function ustarHeader(path: string, size: number): Buffer {
  const header = Buffer.alloc(BLOCK, 0);
  const { name, prefix } = splitUstarName(path);
  header.write(name, 0, 100, "utf8");
  header.write(octal(0o644, 8), 100, 8, "ascii");
  header.write(octal(0, 8), 108, 8, "ascii"); // uid
  header.write(octal(0, 8), 116, 8, "ascii"); // gid
  header.write(octal(size, 12), 124, 12, "ascii");
  // mtime 0 — the tarball must be a DETERMINISTIC function of the tree, so the
  // same delivered files always produce the same SRI. A wall-clock mtime would
  // make the digest-to-integrity mapping unreproducible for no benefit.
  header.write(octal(0, 12), 136, 12, "ascii");
  header.write("        ", 148, 8, "ascii"); // checksum placeholder: 8 spaces
  header.write("0", 156, 1, "ascii"); // typeflag: regular file
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  if (prefix) header.write(prefix, 345, 155, "utf8");
  let checksum = 0;
  for (const byte of header) checksum += byte;
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  return header;
}

/**
 * Pack a delivered tree into the npm-shaped tarball the store materializer
 * consumes: every file under the `package/` prefix the materializer strips.
 *
 * Deterministic by construction — sorted paths, fixed mode, zero mtime, no
 * gzip timestamp — so the SRI is a pure function of the tree.
 */
export function packSuppliedPackageTarball(files: Map<string, Uint8Array>): Buffer {
  const paths = [...files.keys()].sort();
  const chunks: Buffer[] = [];
  for (const path of paths) {
    const data = Buffer.from(files.get(path)!);
    chunks.push(ustarHeader(`${NPM_PREFIX}${path}`, data.length));
    chunks.push(data);
    const remainder = data.length % BLOCK;
    if (remainder !== 0) chunks.push(Buffer.alloc(BLOCK - remainder, 0));
  }
  // Two zero blocks terminate the archive.
  chunks.push(Buffer.alloc(BLOCK * 2, 0));
  return gzipSync(Buffer.concat(chunks), { level: 9 });
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

/**
 * Seal a supplied package: verify the stated digest against the delivered
 * bytes, bind the stated identity to the package's own manifest, pack the
 * tarball, and compute its SRI.
 *
 * THE DIGEST CHECK IS THE PREVIEW-TO-INSTALL GUARD. The operator saw a preview,
 * chose a scope, and pressed install; between those moments a moving branch, a
 * retagged release or a second upload could substitute different bytes. The
 * digest the preview stated travels with the request and is re-verified here
 * against what actually arrived, so a substitution is REFUSED rather than
 * installed under a scope decision made about something else.
 */
export async function sealSuppliedPackage(
  input: SuppliedPackageInput,
): Promise<SealedSuppliedPackage> {
  if (!EXTENSION_TREE_DIGEST_RE.test(input.contentDigest)) {
    throw new Error(
      `[supplied-source] the stated content digest ${JSON.stringify(input.contentDigest)} is not a ` +
        `canonical extension tree digest — refusing to seal a package whose attestation is unreadable`,
    );
  }
  if (input.files.size === 0) {
    throw new Error("[supplied-source] the delivered tree holds no files — nothing to install");
  }

  const recomputed = await computeExtensionTreeDigest(input.files);
  if (recomputed !== input.contentDigest) {
    throw new Error(
      `[supplied-source] ${input.packageName}@${input.version}: the delivered tree digests to ` +
        `${recomputed} and does not match the content digest stated for it (${input.contentDigest}). ` +
        `The bytes changed between the preview and this install; refusing.`,
    );
  }

  // The stated identity must be the package's OWN identity. Otherwise a scope
  // decision, an authority check and a canonical row could all be made about
  // one name while another name is what lands in the store.
  const manifestBytes = input.files.get("package.json");
  if (manifestBytes === undefined) {
    throw new Error(
      `[supplied-source] ${input.packageName}@${input.version}: the delivered tree has no package.json`,
    );
  }
  let manifest: { name?: unknown; version?: unknown };
  try {
    manifest = JSON.parse(new TextDecoder("utf-8").decode(manifestBytes)) as typeof manifest;
  } catch {
    throw new Error(
      `[supplied-source] ${input.packageName}@${input.version}: the delivered package.json is not valid JSON`,
    );
  }
  if (manifest.name !== input.packageName || manifest.version !== input.version) {
    throw new Error(
      `[supplied-source] the delivered tree identifies as ` +
        `${JSON.stringify(String(manifest.name))}@${JSON.stringify(String(manifest.version))}, ` +
        `not as "${input.packageName}"@"${input.version}" — refusing to install one package under ` +
        `another's identity`,
    );
  }

  const tarball = packSuppliedPackageTarball(input.files);
  const integrity = `sha512-${createHash("sha512").update(tarball).digest("base64")}`;

  return {
    packageName: input.packageName,
    version: input.version,
    extensionKind: input.extensionKind,
    contentDigest: recomputed,
    origin: input.origin,
    tarball,
    integrity,
  };
}

// ---------------------------------------------------------------------------
// Provenance
// ---------------------------------------------------------------------------

/**
 * The HONEST canonical-row provenance for a sealed supplied package: `local`
 * for a file upload, `github` for a repository, each carrying the D2 content
 * digest. Never `verdaccio`, and never an `integrity: "dispatcher-install"`
 * placeholder standing in for a registry attestation that does not exist.
 */
export function suppliedPackageProvenance(
  sealed: SealedSuppliedPackage,
): ExtensionSourceLocal | ExtensionSourceGithub {
  if (sealed.origin.kind === "github") {
    return {
      type: "github",
      repo: sealed.origin.repo,
      ref: sealed.origin.ref,
      resolvedSha: sealed.origin.resolvedSha,
      contentDigest: sealed.contentDigest,
    };
  }
  return {
    type: "local",
    // The path is a STABLE DESCRIPTION of where the bytes came from, not a
    // filesystem location: nothing re-reads it, and the uploaded file is gone.
    path: `upload:${sealed.origin.fileName}`,
    // The revision field a local source has always carried. It is not the
    // attestation — `contentDigest` is — and it says so.
    resolvedCommitOrTreeHash: `upload@${sealed.version}`,
    contentDigest: sealed.contentDigest,
  };
}

// ---------------------------------------------------------------------------
// The seam
// ---------------------------------------------------------------------------

export type SuppliedSourceSeamDeps = {
  /** Injected for tests; production uses the store's own materializer. */
  materializePackageToStore?: (
    input: MaterializeInput,
    deps?: MaterializeDeps,
  ) => Promise<MaterializedPackage>;
};

/**
 * Build the install-pipeline deps a SUPPLIED package runs on.
 *
 * Exactly two seams are replaced. Everything else — the journal hooks, the
 * grant hooks, the provenance writer, the compat reader, the activation hooks,
 * the operational-event sink — is passed through by identity from `base`, so
 * there is no second copy of any gate to drift.
 */
export function makeSuppliedSourceInstallPipelineDeps(
  base: InstallPipelineDeps,
  sealed: SealedSuppliedPackage,
  seam: SuppliedSourceSeamDeps = {},
): InstallPipelineDeps {
  const assertSealedTarget = (packageName: string, version: string): void => {
    if (packageName !== sealed.packageName || version !== sealed.version) {
      throw new Error(
        `[supplied-source] this install was sealed for "${sealed.packageName}@${sealed.version}" but ` +
          `the pipeline asked for "${packageName}@${version}" — refusing to serve one package's bytes ` +
          `under another's install`,
      );
    }
  };

  return {
    ...base,

    resolveIntegrity: async (packageName, version) => {
      assertSealedTarget(packageName, version);
      return {
        integrity: sealed.integrity,
        registryUrl: SUPPLIED_SOURCE_REGISTRY_IDENTITY,
        // NO signature and NO materialization plan. A supplied package is
        // unsigned; declaring a plan it cannot sign would drive it into the
        // plan-bearing signature gate, which refuses on an unverified plan —
        // and declaring a signature it does not have would be a lie the trust
        // classifier would believe.
        signature: null,
        resolvedVersion: sealed.version,
      };
    },

    materialize: async (input) => {
      assertSealedTarget(input.packageName, input.version);
      if (input.expectedIntegrity !== sealed.integrity) {
        throw new Error(
          `[supplied-source] the pipeline asked to materialize integrity ` +
            `${JSON.stringify(input.expectedIntegrity)}, which does not match the sealed package ` +
            `(${sealed.integrity}) — refusing`,
        );
      }
      const materialize =
        seam.materializePackageToStore ??
        (await import("@/lib/extension-package-store")).materializePackageToStore;
      return materialize(
        {
          packageName: input.packageName,
          version: input.version,
          expectedIntegrity: input.expectedIntegrity,
          registryUrl: SUPPLIED_SOURCE_REGISTRY_IDENTITY,
          storeRoot: input.storeRoot,
          expectedKind: input.expectedKind ?? sealed.extensionKind,
          plan: null,
          expectedClosureHash: null,
        },
        {
          // The delivery seam. The materializer still re-verifies the SRI over
          // these exact bytes before it writes anything, so serving them from
          // memory instead of from a registry weakens no check.
          fetchTarball: async () => ({ bytes: sealed.tarball, integrity: sealed.integrity }),
        },
      );
    },
  };
}
