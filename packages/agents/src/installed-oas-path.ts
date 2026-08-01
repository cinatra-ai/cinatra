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
//
// ── cinatra#2297 — the DEV second read root ──────────────────────────────────
//
// A stock dev install (`make setup` → `pnpm setup:dev`) ingests its agents
// GIT-NATIVELY from `<cwd>/extensions` (dev-boot's `dev-agents-skills-scan`).
// That is not an install, so NOTHING on the stock dev path ever writes the
// runtime mount: the explicit package installer never runs, the boot
// projection selects only `source.type === "verdaccio"` finalized rows (a
// git-native ingest produces none), and the image-seed materializer no-ops
// outside prod. The mount root itself resolves to the container default
// `/data/extensions`, which nothing in the repo provisions for dev. So the
// mount-only resolver below returned `null` for EVERY agent a fresh checkout
// has, and the context trust root answered `404 oas_missing` (or, on a
// composed child, `403 attestation_node_unrecognized` from the earlier run-OAS
// read) for the whole interactive context-slot path.
//
// `probeInstalledOasPathForRead` adds the dev source tree as a SECOND read
// root, behind the same dev gate the `agent-marker-backfill` boot phase
// already carries for exactly this class (cinatra#1137: keeping only the mount
// served ZERO agents on a fresh dev environment), and mirroring the
// unconditional two-root probe /api/llm-bridge already runs. Three properties
// make it safe:
//
//   1. PRODUCTION TRUST-ROOT RESOLUTION IS UNCHANGED. The dev root is only
//      ever APPENDED to the root list — never substituted, never reordered —
//      so with the gate closed the root list is the single runtime mount and
//      the probe reduces to the mount-only resolver: both walk the SAME
//      `parsePackageId` guard and the SAME `oasPathIfExists` naming rule, the
//      one shared helper below. (The one deliberate production difference is
//      AC4's miss LOG — a diagnostic, not a resolution change.) A test pins
//      the two agreeing under a production env.
//   2. THE GATE IS THE DEPLOY'S, NOT THE CALLER'S. It reads
//      `CINATRA_RUNTIME_MODE === "development" && NODE_ENV !== "production"`
//      — process env only; no request input can open it.
//   3. THE TREE IS THE ONE THE DEV RUNTIME ALREADY EXECUTES. In dev,
//      docker-compose bind-mounts `./extensions:/agents:ro` into wayflow, so
//      the dev source tree IS the runtime's own agent tree. Reading it here
//      CONVERGES the two trees dev was already split across; it does not
//      introduce a new trust surface. (A projected COPY under the mount would
//      instead be free to drift from the OAS wayflow is actually running.)
//
// The strictness the trust root depends on is untouched in both modes: the
// same scope-derived `<root>/<vendor>/<slug>/cinatra/oas.json` naming rule,
// the same parsePackageId traversal guard, `cinatra/oas.json` ONLY (no
// agent.json / legacy-flat fallback), and the mount keeps precedence so an
// explicitly installed package always wins.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { parsePackageId } from "@cinatra-ai/registries";
import { isStrictDevelopmentRuntime } from "@/lib/install-profile";
import {
  resolveAgentRuntimeMountDir,
  resolveDevExtensionSourceRoot,
} from "./agent-runtime-mount";

/** THE one naming rule, applied under an arbitrary read root:
 *  `@vendor/slug` → `<root>/<vendor>/<slug>/cinatra/oas.json`, or null when
 *  nothing is there. Takes the two ALREADY-PARSED segments (not a raw package
 *  name) so no caller can reach a `path.join` without having passed the
 *  parsePackageId guard first — parsePackageId types `vendor` as
 *  `string | null`, and both callers narrow it before they get here. */
function oasPathIfExists(root: string, vendor: string, name: string): string | null {
  const oasPath = join(root, vendor, name, "cinatra", "oas.json");
  return existsSync(oasPath) ? oasPath : null;
}

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
  // Semantics deliberately UNCHANGED from the pre-#2297 resolver, down to the
  // ordering: the name is rejected BEFORE the mount root is resolved (that
  // resolution reads env + a SYNCHRONOUS DB metadata query), so a malformed
  // name still costs nothing.
  const id = parsePackageId(packageName);
  if (!id || !id.vendor) return null;
  return oasPathIfExists(resolveAgentRuntimeMountDir(), id.vendor, id.name);
}

/** Which on-disk root served (or was probed for) an installed OAS. */
type InstalledOasReadRootLabel = "runtime-mount" | "dev-source";

/** The outcome of a context-trust-root OAS probe. `roots` is EVERY root that
 *  was probed, in precedence order — carried so a miss can be logged with the
 *  concrete paths that were looked at (cinatra#2297 AC4). Server-side only:
 *  these paths must never reach an API response. */
export type InstalledOasProbeResult = {
  /** The resolved on-disk OAS path, or null on a miss. */
  path: string | null;
  /** Which root resolved it; null on a miss. */
  servedBy: InstalledOasReadRootLabel | null;
  /** Every root probed, in precedence order. */
  roots: ReadonlyArray<{ label: InstalledOasReadRootLabel; dir: string }>;
};

/** The dev gate (cinatra#2297) — THE canonical strict-development predicate
 *  (`@/lib/install-profile`), the same one `dev-auto-setup` and the fixture
 *  seeder gate on and semantically identical to the inline conjunction the
 *  `agent-marker-backfill` boot phase carries for this very class. Reused
 *  rather than re-inlined so the trust root's dev gate can never drift from
 *  the rest of the codebase's notion of "development". Process env ONLY: a
 *  request can never open it, and a production deploy (NODE_ENV=production)
 *  can never satisfy it. */
function isDevExtensionSourceReadEnabled(): boolean {
  return isStrictDevelopmentRuntime();
}

/** The context trust root's read roots, in PRECEDENCE order. The deploy-owned
 *  runtime mount is always FIRST — and, in production, alone — so an explicitly
 *  installed package always wins over a same-named dev-tree source, and the
 *  production root list is byte-identical to the mount-only resolver's. */
function installedOasReadRoots(): InstalledOasProbeResult["roots"] {
  const roots: Array<{ label: InstalledOasReadRootLabel; dir: string }> = [
    { label: "runtime-mount", dir: resolveAgentRuntimeMountDir() },
  ];
  if (isDevExtensionSourceReadEnabled()) {
    roots.push({ label: "dev-source", dir: resolveDevExtensionSourceRoot() });
  }
  return roots;
}

/**
 * Probe every context-trust-root read root for a FULLY SCOPED package name's
 * installed `cinatra/oas.json` (cinatra#2297).
 *
 * In PRODUCTION this is `resolveInstalledOasPathForRead` plus a probe record:
 * the runtime mount is the only root, and both functions apply the same
 * `parsePackageId` guard and the same `oasPathIfExists` naming rule. In DEV
 * (and only in dev — see
 * `isDevExtensionSourceReadEnabled`) the git-native dev source tree
 * (`<cwd>/extensions`, the same tree the dev wayflow container bind-mounts) is
 * probed after the mount, so a fresh `setup:dev` checkout resolves the agents
 * it actually ingested instead of answering `oas_missing` for all of them.
 *
 * Probe semantics: never throws; a miss returns `path: null` with the probed
 * roots so the caller can log WHY (an unscoped/malformed/traversal name misses
 * under every root — the parsePackageId guard precedes every join).
 */
export function probeInstalledOasPathForRead(
  packageName: string,
): InstalledOasProbeResult {
  // Roots first (not the name): a miss must be able to NAME what it probed
  // (AC4) — including the miss caused by a malformed name.
  const roots = installedOasReadRoots();
  // The SAME guard the mount-only resolver applies, applied ONCE for every
  // root: no root is reachable without it, so a traversal/separator payload in
  // a package name can never reach a `path.join` under ANY root.
  const id = parsePackageId(packageName);
  if (!id || !id.vendor) return { path: null, servedBy: null, roots };
  for (const root of roots) {
    const hit = oasPathIfExists(root.dir, id.vendor, id.name);
    if (hit !== null) return { path: hit, servedBy: root.label, roots };
  }
  return { path: null, servedBy: null, roots };
}
