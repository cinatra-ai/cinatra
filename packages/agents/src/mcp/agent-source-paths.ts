import "server-only";

// On-disk path resolution + vendor-segment derivation for the agent-source
// authoring pipeline. Extracted verbatim from handlers.ts (no behavior change)
// so the agent-source handlers stay under the file-size ratchet ceiling. The
// path-safety guard CALLS live both here (helper definitions) and at every
// join site in handlers.ts; only the definitions moved.

import { join, relative } from "node:path";
import { resolveDevExtensionSourceRoot } from "../agent-runtime-mount";
import { findAgentDefinition } from "../agent-definition-order";
import { LEGACY_AGENT_DIR_NAMES } from "../agent-source-dirs";
import { readInstanceIdentity } from "@/lib/instance-identity-store";
import { isSafePathSegment, assertSafePathSegment } from "@cinatra-ai/registries";

// The slugs whose legacy directory name differs from the slug (by-slug reads
// only name that directory in the old-layout error; it is never read).
export const LEGACY_SLUG_MAP = LEGACY_AGENT_DIR_NAMES;

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

export type AgentOasRead = { path: string; relPath: string; rootDir: string };

/**
 * By-slug read of an agent definition (cinatra#4920): `cinatra/oas.json` only.
 * The directory order and the old-layout error live in findAgentDefinition
 * (../agent-definition-order), shared with the compiler: the first directory
 * that holds ANY definition file decides (the operator's vendor segment, then
 * first-party, then the legacy `<root>/<slug>/` directory). Returns `null`
 * when nothing is there, and `{ error }` when that directory holds only an old
 * definition file. Never reads an old file.
 */
export function resolveAgentOasPathForRead(packageSlug: string): AgentOasRead | { error: string } | null {
  const root = resolveDevExtensionSourceRoot();
  if (!isSafePathSegment(packageSlug)) return null;
  const found = findAgentDefinition({
    root,
    vendors: safeVendorSegmentsForRead(),
    slug: packageSlug,
    legacySlug: LEGACY_SLUG_MAP[packageSlug] ?? packageSlug,
  });
  if (!found) return null;
  if (found.kind === "old") return { error: found.message };
  return { path: found.path, relPath: relative(process.cwd(), found.path), rootDir: found.rootDir };
}

// Resolves the on-disk directory that contains the agent (for sibling reads
// like package.json, skills/). Delegates to resolveAgentOasPathForRead so the
// two resolvers can never disagree about which package a slug maps to. An
// old-layout directory has no root here (null), like an absent one.
export function resolveAgentRootDirForRead(packageSlug: string): string | null {
  const resolved = resolveAgentOasPathForRead(packageSlug);
  return resolved && "rootDir" in resolved ? resolved.rootDir : null;
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
  // sibling lookup, which is exactly what #602 removes. An old-layout file is
  // not read (resolveAgentOasPathForRead); writes converge on the canonical file.
  const root = resolveDevExtensionSourceRoot();
  const canonicalDir = join(root, resolveInstanceVendorSegment(), packageSlug, "cinatra");
  const canonicalPath = join(canonicalDir, "oas.json");
  return {
    dir: canonicalDir,
    path: canonicalPath,
    relPath: relative(process.cwd(), canonicalPath),
  };
}
