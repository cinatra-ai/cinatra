import "server-only";

// On-disk path resolution + vendor-segment derivation for the agent-source
// authoring pipeline. Extracted verbatim from handlers.ts (no behavior change)
// so the agent-source handlers stay under the file-size ratchet ceiling. The
// path-safety guard CALLS live both here (helper definitions) and at every
// join site in handlers.ts; only the definitions moved.

import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { resolveAgentInstallDir } from "../agent-install-path";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { isSafePathSegment, assertSafePathSegment } from "@cinatra-ai/registries";

// ---------------------------------------------------------------------------
// 4-rung agent definition path resolution.
// New canonical layout: <installDir>/cinatra/<slug>-agent/cinatra/oas.json
// the resolver introduces a 4-rung probe so legacy installs still resolve
// while we migrate forward:
//   1. <installDir>/cinatra/<slug>/cinatra/oas.json    — NEW canonical
//   2. <installDir>/cinatra/<slug>/cinatra/agent.json  — transitional (same dir, old filename)
//   3. <installDir>/<legacySlug>/cinatra/agent.json    — legacy
//   4. <installDir>/<legacySlug>/agent.json            — legacy (older layout)
// LEGACY_SLUG_MAP handles the two slugs whose legacy directory names differed from the slug.
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
  /** Agent package root dir (parent of cinatra/ for rungs 1–3; the file's own
   *  dir for the flat rung-4 layout). Sibling reads (package.json, LICENSE,
   *  skills/) resolve against this so they cannot disagree with `path`. */
  rootDir: string;
} | null {
  const root = resolveAgentInstallDir();
  // Fail-closed: never probe with a slug that isn't a single safe segment
  // (cinatra#537 hardening — a `..`/separator slug must not reach path.join).
  if (!isSafePathSegment(packageSlug)) return null;
  // Rungs 1–2 probe the NEW canonical `<root>/<vendor>/<slug>/cinatra/` layout.
  // We probe the operator's OWN vendor segment FIRST (where agents authored on
  // this instance are now written — cinatra#537), then fall back to the
  // first-party "cinatra-ai" segment so bundled/installed first-party agents
  // still resolve. Only filesystem-safe vendor segments are probed.
  for (const vendor of safeVendorSegmentsForRead()) {
    const newRoot = join(root, vendor, packageSlug);
    // Rung 1 — NEW canonical
    const rung1 = join(newRoot, "cinatra", "oas.json");
    if (existsSync(rung1)) return { path: rung1, relPath: relative(process.cwd(), rung1), rootDir: newRoot };
    // Rung 2 — transitional (same dir, old filename)
    const rung2 = join(newRoot, "cinatra", "agent.json");
    if (existsSync(rung2)) return { path: rung2, relPath: relative(process.cwd(), rung2), rootDir: newRoot };
  }
  // Rung 3 — legacy: explicit map for renamed slugs, otherwise keep slug as-is
  const legacySlug = LEGACY_SLUG_MAP[packageSlug] ?? packageSlug;
  const legacyRoot = join(root, legacySlug);
  const rung3 = join(legacyRoot, "cinatra", "agent.json");
  if (existsSync(rung3)) return { path: rung3, relPath: relative(process.cwd(), rung3), rootDir: legacyRoot };
  // Rung 4 — legacy (older layout)
  const rung4 = join(legacyRoot, "agent.json");
  if (existsSync(rung4)) return { path: rung4, relPath: relative(process.cwd(), rung4), rootDir: legacyRoot };
  return null;
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
  // sibling lookup, which is exactly what #602 removes. Legacy installs stay
  // READABLE via resolveAgentJsonPathForRead's rungs 3–4; only writes converge.
  const root = resolveAgentInstallDir();
  const canonicalDir = join(root, resolveInstanceVendorSegment(), packageSlug, "cinatra");
  const canonicalPath = join(canonicalDir, "oas.json");
  return {
    dir: canonicalDir,
    path: canonicalPath,
    relPath: relative(process.cwd(), canonicalPath),
  };
}
