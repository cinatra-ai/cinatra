import "server-only";

// ---------------------------------------------------------------------------
// INSTALL ADMISSION for dynamically-loaded artifact-renderer CLIENT bundles
// (epic #1620 M1 Slice B — cinatra#1630, plan §2.4 / §3.1). Closes the "no
// admission caller" dormancy gap: `runtimeAssetRegistry.admitAndActivate` had no
// production caller, so an installed runtime artifact-ui extension (e.g. the
// json-artifact fixture) never became loadable.
//
// This module is the caller. When the artifact-bridge rescan registers a
// materialized `kind:"artifact"` package (boot + hot-activate), it also drives
// each of the package's admitted client-bundle manifests through the FULL
// admission chain Slice A defined and, on a green verdict, activates the runtime
// binding so the dispatch spine's two-path predicate resolves it `loadable`
// (`classifyLoadablePath` → "runtime") and the mount seam serves it via the
// digest-pinned immutable route — with ZERO host rebuild.
//
// THE ADMISSION CHAIN (fail-closed on ANY miss, plan §3.1 "re-evaluated at every
// load", ruling: a dynamic in-page renderer requires a GENUINE verification):
//   - materialize → verify → activate is ATOMIC (the registry writes the binding
//     only after BOTH succeed);
//   - MATERIALIZE re-checks the sha512 SRI `integrity` — the materialize root of
//     trust — BEFORE writing the bytes into the content-addressed serving store
//     (a mismatch throws → `materialize-failed`, never a written asset);
//   - VERIFY re-checks the exact-tuple store `digest` AND re-verifies the Ed25519
//     signature over the canonical (tuple + integrity) payload against the host
//     trust root (`isClientBundleSignatureVerified`, which treats an unsigned /
//     unverifiable / no-trusted-key bundle as FAIL-CLOSED for an in-page
//     renderer);
//   - the generation is strictly monotonic, so an upgrade supersedes and a
//     replay of a torn-down epoch is rejected (ABA-safe).
//
// Archive/uninstall retirement is the LANDED teardown path
// (`invalidateArtifactRenderersForPackage` → `retireByPackage`) — this module
// only admits; it never revokes.
//
// NEVER executes package code: it reads the published client-bundle manifest
// (pure JSON) + the built bundle bytes; the bytes execute ONLY later, in the
// browser, via the digest-pinned dynamic import.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  parseClientBundleTuple,
  type AdmittedClientBundleTuple,
  type ClientBundleSignatureFields,
} from "@cinatra-ai/sdk-extensions/artifact-client-bundle";

import { runtimeAssetRegistry, type AdmitAndActivateResult } from "@/lib/artifacts/runtime-renderer-registry";
import { isClientBundleSignatureVerified } from "@/lib/artifacts/renderer-bundle-signature";
import { resolveExtensionDataRoot } from "@/lib/extension-data-root";

const ARTIFACT_KIND = "artifact";
/** The published admission-manifest basename the client-bundle builder emits. */
const CLIENT_BUNDLE_MANIFEST = "client-bundle.manifest.json";
/** The optional per-slot manifest directory inside a published package. */
const CLIENT_BUNDLES_DIR = "client-bundles";

/** A monotonic per-process admission generation — strictly increasing so each
 * admission supersedes a prior one for its key and a replay of a torn-down epoch
 * (generation ≤ the tombstoned floor) is rejected by the registry (ABA-safe). */
let admissionSeq = 0;
function nextAdmissionGeneration(): number {
  admissionSeq += 1;
  return admissionSeq;
}

/** The published admission manifest the builder emits alongside a bundle. */
interface ClientBundleAdmissionManifest {
  tuple: unknown;
  integrity?: unknown;
  signature?: unknown;
  scheme?: unknown;
}

/** A refusal reason: the registry's fail-closed reasons plus a manifest-level one. */
export type RuntimeRendererAdmissionRefusal =
  | "quarantined"
  | "materialize-failed"
  | "verify-failed"
  | "stale-generation"
  | "invalid-manifest";

/** One admitted (or refused) client-bundle slot. */
export interface RuntimeRendererAdmissionOutcome {
  packageName: string;
  slot: string;
  digest: string;
  ok: boolean;
  reason?: RuntimeRendererAdmissionRefusal;
}

/** sha512 hex — the exact-tuple store digest of the bundle bytes. */
function sha512Hex(bytes: Buffer): string {
  return createHash("sha512").update(bytes).digest("hex");
}

/** sha512 SRI (`sha512-<base64>`) — the materialize root of trust. */
function sha512Sri(bytes: Buffer): string {
  return `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
}

/** The content-addressed serving dir for a (package, bundle digest): the SAME
 * layout the digest-pinned serving route reads
 * (`<root>/<kind>/<...slug>/<digest>/`). Built only from the validated tuple. */
function servingDigestDir(dataRoot: string, packageName: string, digest: string): string {
  const slugParts = (packageName.startsWith("@") ? packageName.slice(1) : packageName).split("/");
  return path.join(dataRoot, ARTIFACT_KIND, ...slugParts, digest);
}

async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

/** Discover every published client-bundle admission manifest under a package's
 * store dir: the top-level `client-bundle.manifest.json` (the builder's default
 * single emission) plus any `client-bundles/<slot>/client-bundle.manifest.json`
 * (the multi-slot layout). Bounded depth; never executes package code. */
async function discoverAdmissionManifests(
  storeDir: string,
): Promise<Array<{ manifestDir: string; raw: string }>> {
  const found: Array<{ manifestDir: string; raw: string }> = [];
  const tryRead = async (dir: string): Promise<void> => {
    try {
      const raw = await readFile(path.join(dir, CLIENT_BUNDLE_MANIFEST), "utf8");
      found.push({ manifestDir: dir, raw });
    } catch {
      /* absent — not every package ships a client bundle */
    }
  };
  await tryRead(storeDir);
  const bundlesDir = path.join(storeDir, CLIENT_BUNDLES_DIR);
  if (await isDir(bundlesDir)) {
    let entries: string[] = [];
    try {
      entries = await readdir(bundlesDir);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const sub = path.join(bundlesDir, name);
      if (await isDir(sub)) await tryRead(sub);
    }
  }
  return found;
}

/** Admit ONE client-bundle slot through the full atomic admission chain. */
async function admitOneBundle(args: {
  manifestDir: string;
  tuple: AdmittedClientBundleTuple;
  integrity: string;
  signature: string | null;
}): Promise<AdmitAndActivateResult> {
  const { manifestDir, tuple, integrity, signature } = args;
  const fields: ClientBundleSignatureFields = { ...tuple, integrity };
  const bundlePath = path.join(manifestDir, tuple.entry);
  const dataRoot = resolveExtensionDataRoot();

  // Read the built bytes ONCE; both materialize and verify close over them.
  let bytes: Buffer | null = null;
  const readBytes = async (): Promise<Buffer> => {
    if (bytes === null) bytes = await readFile(bundlePath);
    return bytes;
  };

  const materialize = async (): Promise<void> => {
    const b = await readBytes();
    // The sha512 SRI integrity is the materialize ROOT OF TRUST — verified BEFORE
    // the bytes are written into the content-addressed serving store.
    if (sha512Sri(b) !== integrity) {
      throw new Error("client-bundle integrity mismatch (materialize root of trust)");
    }
    const dir = servingDigestDir(dataRoot, tuple.packageName, tuple.digest);
    await mkdir(dir, { recursive: true });
    // Idempotent: content-addressed, so re-writing the same digest is a no-op in
    // effect (identical bytes).
    await writeFile(path.join(dir, tuple.entry), b);
  };

  const verify = async (): Promise<boolean> => {
    const b = await readBytes();
    // Exact-tuple store digest must match the bytes.
    if (sha512Hex(b) !== tuple.digest) return false;
    // Re-verify the Ed25519 signature over (tuple + integrity) against the host
    // trust root — fail-closed for an in-page renderer (unsigned/unverifiable =>
    // false).
    return isClientBundleSignatureVerified(fields, { signature });
  };

  return runtimeAssetRegistry.admitAndActivate({
    tuple,
    generation: nextAdmissionGeneration(),
    materialize,
    verify,
  });
}

/**
 * Admit + activate every published client-bundle renderer of a materialized
 * artifact package. Best-effort + fail-closed per slot: a package with no client
 * bundle is a clean no-op; a slot whose manifest is malformed or whose
 * integrity/digest/signature does not verify is REFUSED (never activated) and the
 * others still proceed. Returns one outcome per discovered slot.
 */
export async function admitRuntimeArtifactRenderersForStoreDir(args: {
  packageName: string;
  storeDir: string;
}): Promise<RuntimeRendererAdmissionOutcome[]> {
  const manifests = await discoverAdmissionManifests(args.storeDir);
  const outcomes: RuntimeRendererAdmissionOutcome[] = [];

  for (const { manifestDir, raw } of manifests) {
    let parsed: ClientBundleAdmissionManifest;
    try {
      parsed = JSON.parse(raw) as ClientBundleAdmissionManifest;
    } catch {
      outcomes.push({ packageName: args.packageName, slot: "?", digest: "?", ok: false, reason: "invalid-manifest" });
      continue;
    }
    const tupleResult = parseClientBundleTuple(parsed.tuple);
    const integrity = typeof parsed.integrity === "string" ? parsed.integrity : null;
    const signature = typeof parsed.signature === "string" ? parsed.signature : null;
    if (!tupleResult.ok || !integrity) {
      outcomes.push({ packageName: args.packageName, slot: "?", digest: "?", ok: false, reason: "invalid-manifest" });
      continue;
    }
    const tuple = tupleResult.tuple;
    // Defence-in-depth: the manifest's package must be the one being admitted —
    // a store dir can only admit ITS OWN package's bundles.
    if (tuple.packageName !== args.packageName) {
      outcomes.push({ packageName: args.packageName, slot: tuple.slot, digest: tuple.digest, ok: false, reason: "invalid-manifest" });
      continue;
    }

    let result: AdmitAndActivateResult;
    try {
      result = await admitOneBundle({ manifestDir, tuple, integrity, signature });
    } catch (err) {
      // A read/materialize throw is contained per slot (fail-closed) — never
      // aborts the rescan.
      console.warn(
        `[artifact-renderer-admission] ${args.packageName} slot "${tuple.slot}" admission threw (refused):`,
        err instanceof Error ? err.message : err,
      );
      outcomes.push({ packageName: args.packageName, slot: tuple.slot, digest: tuple.digest, ok: false, reason: "materialize-failed" });
      continue;
    }
    outcomes.push({
      packageName: args.packageName,
      slot: tuple.slot,
      digest: tuple.digest,
      ok: result.ok,
      reason: result.ok ? undefined : result.reason,
    });
  }

  return outcomes;
}

/**
 * Admit the runtime renderers for a batch of just-registered artifact store
 * records (the artifact-bridge rescan's `registeredRecords`). Best-effort:
 * per-package failures log + continue; never throws. Returns the flattened
 * outcomes (for boot/telemetry logging).
 */
export async function admitRuntimeArtifactRenderersForRecords(
  records: ReadonlyArray<{ packageName: string; storeDir: string }>,
): Promise<RuntimeRendererAdmissionOutcome[]> {
  const all: RuntimeRendererAdmissionOutcome[] = [];
  for (const rec of records) {
    try {
      const outcomes = await admitRuntimeArtifactRenderersForStoreDir(rec);
      all.push(...outcomes);
    } catch (err) {
      console.warn(
        `[artifact-renderer-admission] failed to admit renderers for ${rec.packageName}:`,
        err instanceof Error ? err.message : err,
      );
    }
  }
  return all;
}
