import "server-only";

// On-disk path resolution + vendor-segment derivation for the agent-source
// authoring pipeline. Extracted verbatim from handlers.ts (no behavior change)
// so the agent-source handlers stay under the file-size ratchet ceiling. The
// path-safety guard CALLS live both here (helper definitions) and at every
// join site in handlers.ts; only the definitions moved.

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveDevExtensionSourceRoot } from "../agent-runtime-mount";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { isSafePathSegment, assertSafePathSegment } from "@cinatra-ai/registries";
import { findOldLayoutAgentDirs, oldLayoutAgentMessage, warnOldLayoutAgentDir } from "../old-agent-layout";

// ---------------------------------------------------------------------------
// Agent definition path resolution (cinatra#4920).
// An agent's definition file is `<installDir>/<vendor>/<slug>/cinatra/oas.json`,
// probed under the operator's own vendor segment first and the first-party one
// second. Nothing else is read: a source tree in the old layout (an `agent.json`
// and no `cinatra/oas.json`) resolves to null, and `oldLayoutAgentErrorForSlug`
// names the directory and the move for the handlers that report the miss.
// LEGACY_SLUG_MAP only lets that lookup find the two old directory names that
// differed from their slug.
// ---------------------------------------------------------------------------

export const LEGACY_SLUG_MAP: Record<string, string> = {
  "drupal-agent": "drupal-content-editor",
  "wordpress-agent": "wordpress-content-editor",
};

// Default on-disk vendor segment when no instance identity is configured.
// This is the first-party scope (`@cinatra-ai`) WITHOUT npm's leading "@" —
// kept as a plain literal (rather than deriving it from
// `FIRST_PARTY_PACKAGE_SCOPE`) so the many handler tests that partially mock
// `@cinatra-ai/registries` don't break at module load. It matches the
// publish-side scope derivation and the package.json#name fallback in
// handleAgentBuilderGitWriteFiles, and equals
// `FIRST_PARTY_PACKAGE_SCOPE.replace(/^@/, "")` by construction.
export const DEFAULT_VENDOR_SEGMENT = "cinatra-ai";

/**
 * The on-disk vendor directory segment for agents authored on THIS instance.
 *
 * Source of truth: the operator's instance identity (vendorName, with the
 * legacy instanceNamespace as fallback). When identity is unset, defaults to
 * the first-party "cinatra-ai" segment — matching both the publish-side scope
 * derivation and the `package.json#name` rescope in
 * handleAgentBuilderGitWriteFiles.
 *
 * Using this for BOTH the package.json writer and the oas.json read/write
 * resolvers means a user agent (e.g. "@marcushorndt-local/...") is written
 * under `extensions/marcushorndt-local/...` rather than being split across the
 * first-party `extensions/cinatra-ai/...` dir and the operator's own dir
 * (cinatra#537).
 */
export function resolveInstanceVendorSegment(): string {
  const identity = readInstanceIdentity();
  const segment = identity
    ? ((identity as { vendorName?: string; instanceNamespace?: string }).vendorName ??
       (identity as { vendorName?: string; instanceNamespace?: string }).instanceNamespace ??
       DEFAULT_VENDOR_SEGMENT)
    : DEFAULT_VENDOR_SEGMENT;
  // Fail-closed: the vendor segment is identity-derived and is joined directly
  // into the on-disk path. A `..` / separator / control-char / drive-like value
  // must NEVER reach `path.join`. assertSafePathSegment throws on an unsafe
  // segment (a misconfigured identity), and the default is always safe.
  // (cinatra#537 hardening.)
  assertSafePathSegment(segment, "instance vendor segment");
  return segment;
}

/**
 * The deduped, FILESYSTEM-SAFE vendor-segment candidates for READ probes
 * (operator vendor first, then first-party). Unsafe identity-derived segments
 * are dropped (not thrown) here because the read resolvers return `null` on a
 * miss — a malformed identity must not crash a read, it just yields no probe
 * under that segment. The first-party default is always retained. (cinatra#537.)
 */
export function safeVendorSegmentsForRead(): string[] {
  const out: string[] = [];
  const identity = readInstanceIdentity();
  const instanceSegment = identity
    ? ((identity as { vendorName?: string; instanceNamespace?: string }).vendorName ??
       (identity as { vendorName?: string; instanceNamespace?: string }).instanceNamespace ??
       DEFAULT_VENDOR_SEGMENT)
    : DEFAULT_VENDOR_SEGMENT;
  for (const seg of [instanceSegment, DEFAULT_VENDOR_SEGMENT]) {
    if (isSafePathSegment(seg) && !out.includes(seg)) out.push(seg);
  }
  return out;
}

export function resolveAgentJsonPathForRead(packageSlug: string): {
  path: string;
  relPath: string;
  /** Agent package root dir (the parent of `cinatra/`). Sibling reads
   *  (package.json, LICENSE, skills/) resolve against this so they cannot
   *  disagree with `path`. */
  rootDir: string;
} | null {
  const root = resolveDevExtensionSourceRoot();
  // Fail-closed: never probe with a slug that isn't a single safe segment
  // (cinatra#537 hardening — a `..`/separator slug must not reach path.join).
  if (!isSafePathSegment(packageSlug)) return null;
  // Probe `<root>/<vendor>/<slug>/cinatra/oas.json`: the operator's OWN vendor
  // segment FIRST (where agents authored on this instance are written —
  // cinatra#537), then the first-party "cinatra-ai" segment so bundled/installed
  // first-party agents still resolve. Only filesystem-safe vendor segments are
  // probed. This file is the only definition an agent has (cinatra#4920).
  for (const vendor of safeVendorSegmentsForRead()) {
    const newRoot = join(root, vendor, packageSlug);
    const oasPath = join(newRoot, "cinatra", "oas.json");
    if (existsSync(oasPath)) return { path: oasPath, relPath: relative(process.cwd(), oasPath), rootDir: newRoot };
  }
  return null;
}

/**
 * EVERY directory of this slug's agent in the OLD layout (an `agent.json`, no
 * `cinatra/oas.json`). Probes where the retired read ladder looked: the vendor
 * directories and the flat `<root>/<slug>` (or its old directory name). Two
 * directories can share a slug, and each is returned.
 */
export function findOldLayoutAgentDirsForSlug(packageSlug: string): string[] {
  if (!isSafePathSegment(packageSlug)) return [];
  return findOldLayoutAgentDirs(
    resolveDevExtensionSourceRoot(),
    safeVendorSegmentsForRead(),
    packageSlug,
    LEGACY_SLUG_MAP[packageSlug] ?? packageSlug,
  );
}

/**
 * One sentence per old-layout directory: it names the directory (relative to
 * the working directory) and says to move it to `cinatra/oas.json`. With
 * `alsoLog` each is also logged once per directory, for a reader, like the
 * listing, that carries on without the agent.
 */
export function oldLayoutAgentMessagesForDirs(dirs: readonly string[], alsoLog = false): string[] {
  return dirs.map((dir) => {
    if (alsoLog) warnOldLayoutAgentDir(dir);
    return oldLayoutAgentMessage(relative(process.cwd(), dir));
  });
}

/**
 * The text a slug-keyed handler returns when it cannot find the agent because
 * the source tree is in the old layout: the sentence for EVERY old-layout
 * directory of the slug, joined. Null when the slug has none, so a handler
 * keeps its own "not found" text.
 */
export function oldLayoutAgentErrorForSlug(packageSlug: string): string | null {
  const dirs = findOldLayoutAgentDirsForSlug(packageSlug);
  return dirs.length === 0 ? null : oldLayoutAgentMessagesForDirs(dirs).join(" ");
}

// Resolves the on-disk directory that contains the agent (for sibling reads
// like package.json, skills/). Delegates to resolveAgentJsonPathForRead so
// the two resolvers can never disagree about which package a slug maps to.
export function resolveAgentRootDirForRead(packageSlug: string): string | null {
  return resolveAgentJsonPathForRead(packageSlug)?.rootDir ?? null;
}

export function resolveAgentJsonPathForWrite(packageSlug: string): {
  dir: string;
  path: string;
  relPath: string;
} {
  // Fail-closed: the slug is joined directly into the on-disk path. Reject any
  // non-single-segment slug before it reaches path.join (cinatra#537 hardening;
  // the calling handler already rejects separators, this is defense-in-depth).
  assertSafePathSegment(packageSlug, "packageSlug");
  // SINGLE canonical write root (cinatra#537 / CodeRabbit data-integrity fix):
  // OAS always writes to `<installDir>/<vendor>/<slug>/cinatra/oas.json` under
  // the operator's OWN vendor segment — the SAME `<vendor>/<slug>/` dir that
  // handleAgentBuilderGitWriteFiles writes package.json + skills/ into. We do
  // NOT honor a pre-existing legacy-flat `<installDir>/<legacySlug>/agent.json`
  // for WRITES: doing so split the agent's identity (oas.json under the legacy
  // root, package.json under the canonical vendor root) and broke the read-side
  // sibling lookup, which is exactly what #602 removes. The old layout is no
  // longer read either (cinatra#4920).
  const root = resolveDevExtensionSourceRoot();
  const canonicalDir = join(root, resolveInstanceVendorSegment(), packageSlug, "cinatra");
  const canonicalPath = join(canonicalDir, "oas.json");
  return {
    dir: canonicalDir,
    path: canonicalPath,
    relPath: relative(process.cwd(), canonicalPath),
  };
}
