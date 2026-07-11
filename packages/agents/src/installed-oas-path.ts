// cinatra#1196 — the SHARED multi-vendor resolver for an INSTALLED package's
// on-disk OAS in the agent runtime mount.
//
// The runtime mount is package-keyed by ONE naming rule — `@vendor/slug` →
// `<mount>/<vendor>/<slug>/` — shared by the materializer
// (materialize-agent-package.ts PACKAGE_NAME_RE) and the boot projection
// phase (agent-mount-projection). A full package name therefore CARRIES its
// vendor, and resolution derives the single candidate path from the scope.
// This is deliberately NOT the identity-segment enumeration used by the
// slug-keyed dev-source resolvers (safeVendorSegmentsForRead /
// resolveAgentJsonPathForRead in mcp/agent-source-paths.ts): those start from
// a slug with the vendor UNKNOWN. Enumerating vendor candidates for a fully
// scoped name would let a same-slug package under one vendor shadow another
// (the cinatra#538 class) and would decouple reads from the mount's own
// naming rule.
//
// Kept OUT of agent-runtime-mount.ts on purpose: that module is a leaf import
// of many handler suites that partially mock @cinatra-ai/registries, and it
// must stay free of registry imports — the same module-load trap the
// DEFAULT_VENDOR_SEGMENT note in mcp/agent-source-paths.ts documents.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parsePackageId } from "@cinatra-ai/registries";
import { resolveAgentRuntimeMountDir } from "./agent-runtime-mount";

/**
 * Resolve the installed `cinatra/oas.json` path for a FULLY SCOPED package
 * name (`@vendor/slug`) in the runtime mount, or `null` when the name is
 * unscoped/malformed or nothing is installed there (probe semantics — a read
 * resolver never throws on a miss).
 *
 * Path safety: parsePackageId (THE canonical `@vendor/name` splitter,
 * cinatra#537) validates BOTH segments as single filesystem-safe path
 * segments before the join, so a traversal/separator payload in a package
 * name can never reach `path.join`.
 *
 * `cinatra/oas.json` ONLY: the materializer REQUIRES it (a mount dir without
 * it never finalizes), and the trust-root consumers (the context routes)
 * deliberately stay strict — no agent.json / legacy-flat-layout fallback
 * here. First-party (`@cinatra-ai/...`) and operator/third-party vendors
 * resolve identically (cinatra#1196).
 */
export function resolveInstalledOasPathForRead(packageName: string): string | null {
  const id = parsePackageId(packageName);
  if (!id || !id.vendor) return null;
  const oasPath = join(
    resolveAgentRuntimeMountDir(),
    id.vendor,
    id.name,
    "cinatra",
    "oas.json",
  );
  return existsSync(oasPath) ? oasPath : null;
}
