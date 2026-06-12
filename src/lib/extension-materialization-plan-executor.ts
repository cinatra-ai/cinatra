import "server-only";

// VERBATIM executor for SIGNED MATERIALIZATION PLANS (cinatra#181 — library
// dependency closure, host side).
//
// The plan is the publish-time LOCKED description of an extension's npm
// LIBRARY dependency closure (see `extension-materialization-plan-core.ts`,
// the pure half of this split). This module is the server-only IO half: it
// executes a PARSED + VALIDATED plan against an extracted (NOT yet published)
// extension package dir — pure unpack-to-path operations building an
// npm-style NESTED `node_modules` of real directories. ZERO resolver
// decisions: every node's bytes are pinned by per-node sha512 SRI and every
// placement path is pinned by the plan (Node's default file:// resolution
// then works unchanged at runtime — the loader needs no plan knowledge).
//
// Invoked ONLY from `materializePackageToStore` (step 4.7 — after the
// built-artifacts gate, BEFORE the step-5 content hash, so the content hash
// and the install trust anchor cover the POST-closure tree automatically).
//
// TRUST: the executor RE-DERIVES the closureHash from the threaded plan and
// refuses a caller-threading mismatch (defense in depth — the pipeline
// verified the v2 signature against its own recomputation, but the executor
// never trusts that the caller threaded the same plan).
//
// REFUSAL BATTERY (every refusal throws `MaterializationExecutorError`,
// fail-closed, test-pinned):
//   - closureHash mismatch (caller threading);
//   - per-node SRI mismatch over the fetched bytes;
//   - tar-header-level entry-type filter: ONLY File + Directory entries are
//     accepted — SymbolicLink, Link (HARDLINK — `lstat`-based walks cannot
//     catch these, the header is the only reliable refusal point),
//     CharacterDevice, BlockDevice, FIFO, and anything else are refused for
//     EVERY plan-node tarball (the materializer applies the same filter to
//     the extension tarball itself);
//   - `node_modules` path segments INSIDE a node tarball (bundled deps in
//     library tarballs are refused in plan format v1 — the plan, not the
//     tarball, is the only closure authority);
//   - lifecycle scripts (preinstall/install/postinstall/prepare) in a node's
//     package.json — the installer NEVER executes package code;
//   - native addons: any `*.node` file, a `binding.gyp`, or
//     node-gyp/node-pre-gyp/prebuild-install in ANY script — native builds
//     are install-time code execution and platform-dependent bytes (both
//     banned; determinism would also break);
//   - extracted package.json name/version differing from the plan node;
//   - placement target already exists (collision = malformed plan; the plan
//     guarantees unique placements, so a pre-existing dir is tampering or a
//     plan bug — never overwrite);
//   - total fetched tarball bytes above the per-package cap.
//
// FETCH SEAM: per-node fetches ride the SAME injected `fetchTarball` seam as
// the root extension tarball (`MaterializeDeps.fetchTarball`) — a gatekept
// (broker/token-authorized) install fetches its plan nodes through the SAME
// broker grant and identity, never around it.

import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import {
  computeClosureHash,
  planExecutionOrder,
  type MaterializationPlan,
  type MaterializationPlanNode,
} from "@/lib/extension-materialization-plan-core";
import { sriMatches } from "@/lib/extension-package-store-core";
import type { FetchTarball } from "@/lib/extension-package-store";

/** Thrown for EVERY executor refusal — callers fail closed. */
export class MaterializationExecutorError extends Error {
  constructor(message: string) {
    super(`[materialization-executor] ${message}`);
    this.name = "MaterializationExecutorError";
  }
}

/** Hard cap on the SUM of fetched plan-node tarball bytes per package. */
export const MAX_PLAN_TOTAL_TARBALL_BYTES = 256 * 1024 * 1024; // 256 MiB

/**
 * Per-node UNPACKED caps: the compressed-byte cap
 * alone admits a decompression bomb — a tiny gzip tarball can declare a huge
 * tree that the step-5 content hash would then read into memory. Caps are
 * enforced AT THE TAR HEADER (declared entry sizes/counts) during streaming
 * extraction, before the offending bytes land on disk.
 */
export const MAX_PLAN_NODE_UNPACKED_BYTES = 64 * 1024 * 1024; // 64 MiB per node
export const MAX_PLAN_NODE_ENTRIES = 10_000; // files+dirs per node

/** Max individual violations carried into a refusal message (detail bound). */
const MAX_REPORTED_VIOLATIONS = 20;

/** The lifecycle scripts the installer refuses (it never executes package code). */
const REFUSED_LIFECYCLE_SCRIPTS = ["preinstall", "install", "postinstall", "prepare"] as const;

/** Script-text markers of native-addon build tooling (refused wholesale). */
const NATIVE_BUILD_TOOL_RE = /\b(node-gyp|node-pre-gyp|prebuild-install)\b/;

/**
 * tar entry types accepted by the HARDENED extraction filter. Everything else
 * — SymbolicLink, Link (hardlink), CharacterDevice, BlockDevice, FIFO,
 * GNUDumpDir, … — is refused AT THE HEADER, before any byte is written.
 * (A walk-time `isFile()` check passes a hardlinked entry — node-tar
 * materializes it as a hardlink to a previously extracted path — so the
 * header is the only reliable refusal point for the Link type.)
 */
const ACCEPTED_TAR_ENTRY_TYPES = new Set(["File", "Directory"]);

/**
 * Extract a tarball buffer into `destDir` (npm layout: the leading `package/`
 * segment is stripped) with the HARDENED, fail-closed filter:
 *   - entry types: ONLY File + Directory (tar-header-level — see above);
 *   - `forbidNodeModules`: any `node_modules` path segment inside the tarball
 *     is refused (plan-node tarballs must not carry bundled deps);
 *   - no lifecycle scripts are ever executed (tar.x never does);
 *   - `..` and absolute entry paths are stripped/refused by node-tar itself.
 * Violations are COLLECTED during streaming and thrown AFTER extraction
 * returns (the offending entries were skipped, nothing of them written), so
 * one refusal message can name every violation.
 */
export async function extractTarballHardened(input: {
  bytes: Buffer;
  destDir: string;
  /** Label for refusal messages (e.g. `name@version`). */
  label: string;
  /** Refuse `node_modules` segments inside the tarball (plan nodes: true). */
  forbidNodeModules: boolean;
  /**
   * Optional UNPACKED caps, enforced at the tar header during streaming
   * (declared sizes/entry counts). The plan-node executor always passes them;
   * the extension-tarball path omits them (its size profile is the existing,
   * unchanged contract).
   */
  caps?: { maxUnpackedBytes: number; maxEntries: number };
}): Promise<void> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), "cinatra-plan-node-tgz-"));
  const violations: string[] = [];
  let suppressedViolations = 0;
  let declaredBytes = 0;
  let entryCount = 0;
  let capBreached: string | null = null;
  try {
    const tgzPath = path.join(tmpRoot, "node.tgz");
    await writeFile(tgzPath, input.bytes);
    await tar.x({
      file: tgzPath,
      cwd: input.destDir,
      strip: 1,
      filter: (entryPath, entry) => {
        // Once a cap is breached, skip EVERYTHING (fail-closed; one message).
        if (capBreached) return false;
        // Caps count EVERY header — including entries the type/node_modules
        // checks below will skip (a tarball of a
        // million symlink headers must hit the entry cap, not stream on).
        if (input.caps) {
          entryCount += 1;
          declaredBytes += Number((entry as { size?: unknown }).size ?? 0) || 0;
          if (entryCount > input.caps.maxEntries) {
            capBreached = `more than ${input.caps.maxEntries} entries`;
            return false;
          }
          if (declaredBytes > input.caps.maxUnpackedBytes) {
            capBreached = `declared unpacked size above ${input.caps.maxUnpackedBytes} bytes`;
            return false;
          }
        }
        const entryType = String((entry as { type?: unknown }).type ?? "Unknown");
        if (!ACCEPTED_TAR_ENTRY_TYPES.has(entryType)) {
          // Bounded detail: refusal is already certain — keep the message O(1).
          if (violations.length < MAX_REPORTED_VIOLATIONS) violations.push(`${entryType} entry "${entryPath}"`);
          else suppressedViolations += 1;
          return false;
        }
        if (input.forbidNodeModules && entryPath.split("/").includes("node_modules")) {
          if (violations.length < MAX_REPORTED_VIOLATIONS) violations.push(`node_modules segment in entry "${entryPath}"`);
          else suppressedViolations += 1;
          return false;
        }
        return true;
      },
    });
  } finally {
    await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
  }
  if (capBreached) {
    throw new MaterializationExecutorError(
      `${input.label}: refused tarball — ${capBreached} (decompression-bomb cap, fail-closed)`,
    );
  }
  if (violations.length > 0) {
    const suppressed = suppressedViolations > 0 ? ` (+${suppressedViolations} more)` : "";
    throw new MaterializationExecutorError(
      `${input.label}: refused tarball entr${violations.length === 1 && suppressedViolations === 0 ? "y" : "ies"} — ` +
        `${violations.join("; ")}${suppressed}. Only regular files and directories are accepted ` +
        `(symlinks/hardlinks/devices are escape vectors${input.forbidNodeModules ? "; bundled node_modules inside a plan-node tarball is refused in plan format v1" : ""}).`,
    );
  }
}

/**
 * The post-extraction per-node refusal battery (everything that needs the
 * extracted tree): plan-identity check, lifecycle scripts, native addons.
 * Symlinks/hardlinks/devices were already refused at the tar header.
 */
async function assertNodeTreeSafe(nodeDir: string, node: MaterializationPlanNode): Promise<void> {
  const label = `plan node ${node.name}@${node.version} (${node.placementPath})`;

  // (finding 10) the extracted package's OWN manifest must agree with the plan
  // node — a registry serving renamed/re-versioned bytes under a matching
  // digest is a plan/registry inconsistency the executor refuses.
  const pkgRaw = await readFile(path.join(nodeDir, "package.json"), "utf8").catch(() => null);
  if (!pkgRaw) {
    throw new MaterializationExecutorError(`${label}: extracted tarball has no package.json`);
  }
  let pkg: Record<string, unknown>;
  try {
    pkg = JSON.parse(pkgRaw) as Record<string, unknown>;
  } catch {
    throw new MaterializationExecutorError(`${label}: extracted package.json is not valid JSON`);
  }
  if (pkg.name !== node.name || pkg.version !== node.version) {
    throw new MaterializationExecutorError(
      `${label}: extracted package.json identifies as ` +
        `${JSON.stringify(pkg.name)}@${JSON.stringify(pkg.version)} — must equal the plan node exactly`,
    );
  }

  // Lifecycle scripts + native build tooling in ANY script value.
  const scripts = pkg.scripts;
  if (scripts && typeof scripts === "object" && !Array.isArray(scripts)) {
    const scriptEntries = Object.entries(scripts as Record<string, unknown>);
    const lifecycle = scriptEntries.filter(([k]) => (REFUSED_LIFECYCLE_SCRIPTS as readonly string[]).includes(k));
    if (lifecycle.length > 0) {
      throw new MaterializationExecutorError(
        `${label}: declares lifecycle script(s) ${lifecycle.map(([k]) => k).join(", ")} — the installer ` +
          `NEVER executes package code (the security-hardening rule); libraries with install hooks are refused.`,
      );
    }
    const nativeTooling = scriptEntries.filter(
      ([, v]) => typeof v === "string" && NATIVE_BUILD_TOOL_RE.test(v),
    );
    if (nativeTooling.length > 0) {
      throw new MaterializationExecutorError(
        `${label}: script(s) ${nativeTooling.map(([k]) => k).join(", ")} invoke native-addon build tooling ` +
          `(node-gyp/node-pre-gyp/prebuild-install) — native addons are refused (install-time code execution + ` +
          `platform-dependent bytes).`,
      );
    }
  }

  // Native-addon artifacts anywhere in the tree: `*.node` binaries and
  // `binding.gyp` build manifests.
  await (async function walk(current: string, rel: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const e of entries) {
      const entryRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        await walk(path.join(current, e.name), entryRel);
      } else if (e.name.endsWith(".node") || e.name === "binding.gyp") {
        throw new MaterializationExecutorError(
          `${label}: contains native-addon artifact "${entryRel}" — native addons are refused ` +
            `(platform-dependent bytes break byte-determinism; loading them is unaudited host code).`,
        );
      }
    }
  })(nodeDir, "");
}

export type ExecuteMaterializationPlanInput = {
  /** The PARSED + VALIDATED plan (`parseMaterializationPlan` output). */
  plan: MaterializationPlan;
  /**
   * The closureHash the pipeline verified the v2 signature against. The
   * executor RE-DERIVES the hash from `plan` and refuses a mismatch — it
   * never trusts that the caller threaded the same plan it verified.
   */
  expectedClosureHash: string;
  /** The extracted (NOT yet published) extension package dir to build into. */
  packageDir: string;
  /** The extension package name (refusal messages only). */
  packageName: string;
};

export type ExecuteMaterializationPlanDeps = {
  /**
   * The SAME injected tarball-fetch seam the root extension tarball used
   * (broker/token identity included) — REQUIRED, no default: defaulting here
   * could silently route a gatekept install's node fetches around the broker.
   */
  fetchTarball: FetchTarball;
};

export type ExecutedMaterializationPlan = {
  closureHash: string;
  nodesPlaced: number;
  totalTarballBytes: number;
};

/**
 * Execute the plan VERBATIM against `packageDir`: for every node, in
 * parents-before-children order — fetch via the injected seam, SRI-verify the
 * exact bytes, extract HARDENED into a temp dir, run the per-node refusal
 * battery, and rename into the exact `placementPath`. On ANY refusal the
 * temp state is cleaned and the error propagates — the materializer's
 * temp-dir lifecycle discards the partially-built package dir (nothing was
 * published).
 */
export async function executeMaterializationPlan(
  input: ExecuteMaterializationPlanInput,
  deps: ExecuteMaterializationPlanDeps,
): Promise<ExecutedMaterializationPlan> {
  const { plan, packageDir, packageName } = input;

  const closureHash = computeClosureHash(plan);
  if (closureHash !== input.expectedClosureHash) {
    throw new MaterializationExecutorError(
      `${packageName}: threaded plan's closureHash ${closureHash.slice(0, 16)}… does not equal the ` +
        `verified expected hash ${input.expectedClosureHash.slice(0, 16)}… — refusing to execute ` +
        `(the executor never trusts caller threading).`,
    );
  }

  let totalTarballBytes = 0;
  const order = planExecutionOrder(plan);
  for (const node of order) {
    const label = `plan node ${node.name}@${node.version} (${node.placementPath})`;

    // Fetch through the SAME seam (broker identity preserved) + re-verify.
    const { bytes } = await deps.fetchTarball({
      packageName: node.name,
      packageVersion: node.version,
      expectedIntegrity: node.integrity,
    });
    if (!sriMatches(bytes, node.integrity)) {
      throw new MaterializationExecutorError(
        `${label}: fetched tarball does not match the plan's integrity ${node.integrity} — refusing`,
      );
    }
    totalTarballBytes += bytes.byteLength;
    if (totalTarballBytes > MAX_PLAN_TOTAL_TARBALL_BYTES) {
      throw new MaterializationExecutorError(
        `${packageName}: plan-node tarballs exceed the ${MAX_PLAN_TOTAL_TARBALL_BYTES}-byte total cap ` +
          `at ${label} — refusing (fail-closed)`,
      );
    }

    // Hardened extract into a temp sibling, battery, then rename into place.
    const tmpRoot = await mkdtemp(path.join(tmpdir(), "cinatra-plan-node-"));
    try {
      const nodeDir = path.join(tmpRoot, "pkg");
      await mkdir(nodeDir, { recursive: true });
      await extractTarballHardened({
        bytes,
        destDir: nodeDir,
        label,
        forbidNodeModules: true,
        caps: { maxUnpackedBytes: MAX_PLAN_NODE_UNPACKED_BYTES, maxEntries: MAX_PLAN_NODE_ENTRIES },
      });
      await assertNodeTreeSafe(nodeDir, node);

      // Placement: the plan-core grammar guarantees `placementPath` is a safe
      // `node_modules/<pkg>` chain (no `..`/absolute/NUL by construction);
      // resolve + containment re-check as defense in depth.
      const target = path.resolve(packageDir, node.placementPath);
      const rootResolved = path.resolve(packageDir);
      if (target !== rootResolved && !target.startsWith(rootResolved + path.sep)) {
        throw new MaterializationExecutorError(
          `${label}: placement resolves outside the package dir — refusing`,
        );
      }
      let targetExists = false;
      try {
        await lstat(target);
        targetExists = true;
      } catch {
        targetExists = false;
      }
      if (targetExists) {
        throw new MaterializationExecutorError(
          `${label}: placement target already exists — a collision is a malformed plan or a tampered ` +
            `tarball (the extension tarball must not pre-create plan placements); refusing, never overwriting`,
        );
      }
      await mkdir(path.dirname(target), { recursive: true });
      await rename(nodeDir, target);
    } finally {
      await rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  return { closureHash, nodesPlaced: order.length, totalTarballBytes };
}
