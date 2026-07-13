import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { ARTIFACT_ALLOWED_CINATRA_KEYS as ALLOWED_CINATRA_KEYS } from "@cinatra-ai/sdk-extensions/artifact-contract";
import { objectTypeRegistry } from "../registry";
import type { SemanticArtifactManifest } from "../types";
import { validateObjectTypeClaimSchemaSources } from "../claims";
import { parseSemanticArtifactManifest } from "../semantic-manifest";
import {
  GenericObjectListRow,
  GenericObjectCard,
  GenericObjectDetail,
} from "./generic-renderers";

// ---------------------------------------------------------------------------
// Object-registry descriptor bridge.
//
// Scans `extensions/cinatra-ai/*-artifact/package.json`, reads the metadata-
// only `cinatra.artifact` descriptor, and registers ONE generic
// `ObjectTypeDefinition` per artifact type carrying `isArtifact`. The
// library / serving / MCP layers then consume `objectTypeRegistry
// .listArtifacts()` GENERICALLY — a NEW artifact type appears purely by
// adding a `kind:"artifact"` extension dir, with ZERO core per-type
// branches. That pluggability guarantee is proven by the fixture test in
// `__tests__/artifact-bridge.test.ts`.
//
// Server-only + sync fs (mirrors the boot-time registration model). NOT
// exported from the package barrel — the barrel is SSR/React-free; this is
// reached via the `@cinatra-ai/objects/register-artifact-extensions`
// subpath by server callers only (register-all-object-types, dev-watcher).
// ---------------------------------------------------------------------------

// The bridge ingests the semantic artifact manifest. Canonical schema/parser
// lives in ../semantic-manifest; artifact-handler.ts keeps a byte-mirrored copy
// (objects↔extensions cycle forbids sharing — same lock-step constraint).
// The cinatra-key allowlist itself is NO LONGER duplicated here: both this
// file and artifact-handler.ts import `ARTIFACT_ALLOWED_CINATRA_KEYS` from
// `@cinatra-ai/sdk-extensions/artifact-contract` (a leaf package outside the
// objects↔extensions cycle, cinatra#979) instead of each keeping their own
// literal.

function registerOneArtifactDir(dir: string): boolean {
  const pkgPath = path.join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  let pkg: { name?: unknown; cinatra?: { kind?: unknown; artifact?: unknown } };
  try {
    pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  } catch {
    return false;
  }
  if (pkg?.cinatra?.kind !== "artifact" || typeof pkg.name !== "string") {
    return false;
  }
  // Keep the same cinatra allowlist as the handler: reject any manifest
  // carrying non-artifact (agent-package) keys.
  const extraneous = Object.keys(pkg.cinatra ?? {}).filter(
    (k) => !ALLOWED_CINATRA_KEYS.has(k),
  );
  if (extraneous.length > 0) {
    console.warn(
      `[artifacts:bridge] ${pkg.name} declares disallowed cinatra key(s) [${extraneous.join(", ")}] — skipped`,
    );
    return false;
  }
  const parsed = parseSemanticArtifactManifest(pkg.cinatra?.artifact);
  if (!parsed.ok) {
    console.warn(
      `[artifacts:bridge] ${pkg.name} has an invalid semantic artifact manifest — skipped: ${parsed.errors.join("; ")}`,
    );
    return false;
  }
  const descriptor: SemanticArtifactManifest = parsed.manifest;
  // Schema-source rule for objectTypes claims (cinatra#1432 AC-4): same
  // fail-closed check the handler's validate() runs — a claim with no inline
  // JSON Schema, no self-registered type, and no declared dependency on the
  // registering extension never registers (warn + skip, the bridge's skip
  // convention).
  if (descriptor.objectTypes && descriptor.objectTypes.length > 0) {
    const rawDeps = (pkg.cinatra as { dependencies?: unknown } | undefined)?.dependencies;
    const declaredDeps = Array.isArray(rawDeps)
      ? rawDeps
          .map((d) =>
            d != null &&
            typeof d === "object" &&
            typeof (d as { packageName?: unknown }).packageName === "string"
              ? (d as { packageName: string }).packageName
              : null,
          )
          .filter((n): n is string => n != null)
      : [];
    const sourceErrors = validateObjectTypeClaimSchemaSources({
      packageName: pkg.name,
      claims: descriptor.objectTypes,
      dependencyPackageNames: declaredDeps,
    });
    if (sourceErrors.length > 0) {
      console.warn(
        `[artifacts:bridge] ${pkg.name} has objectTypes claims without a schema source — skipped: ${sourceErrors.join("; ")}`,
      );
      return false;
    }
  }
  objectTypeRegistry.register(
    {
      // Namespaced id `@scope/pkg:artifact` (matches OBJECT_TYPE_NAMESPACE_RE).
      type: `${pkg.name}:artifact`,
      category: "report",
      schema: z.record(z.string(), z.unknown()),
      lifecycle: {
        sources: ["agent", "user", "import"],
        mutableBy: ["agent", "user"],
      },
      renderers: {
        listRow: GenericObjectListRow,
        card: GenericObjectCard,
        detail: GenericObjectDetail,
      },
      isArtifact: descriptor,
    },
    // PROVENANCE (cinatra#661): record the owning package so the runtime
    // teardown hook (`teardownExtensionCapabilities` → `removeByPackage`) can
    // deregister exactly this bridge-registered artifact type on
    // archive/uninstall. WITHOUT this arg the provenance index never recorded
    // the type, so `removeByPackage` was a no-op for every bridge-registered
    // artifact type — the teardown blocker. The HOST built-in artifact types
    // (`@cinatra-ai/artifact:object`, `@cinatra-ai/artifacts:artifact-ref`)
    // register in `register-all-object-types.ts` WITHOUT a package name, so
    // they stay provenance-less and are NEVER reaped by `removeByPackage`.
    pkg.name,
  );
  return true;
}

/**
 * Register exactly ONE artifact-extension package dir (its `package.json` is
 * directly at `dir`). Used by the production package-store rescan
 * (`extension-artifact-bridge-rescan.ts`), where each materialized store record
 * IS the package dir (`<dataRoot>/<kind>/<slug>/<digest>/`, cinatra#791), so the
 * `<root>/*-artifact` scan layout of `registerArtifactExtensions` does not
 * apply. Reuses the SAME manifest validation + provenance threading as the
 * bundled scan — never imports or executes the package's code (reads
 * `package.json` only). Returns true iff a valid `kind:"artifact"` package was
 * registered.
 */
export function registerArtifactExtensionDir(dir: string): boolean {
  return registerOneArtifactDir(dir);
}

function scanDirForArtifacts(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !dirent.name.endsWith("-artifact")) continue;
    if (registerOneArtifactDir(path.join(dir, dirent.name))) n += 1;
  }
  return n;
}

/**
 * Register every `kind:"artifact"` extension under `root`. Robust to caller
 * depth: scans BOTH `<root>/*-artifact` AND `<root>/<vendor>/*-artifact`, so it
 * is correct whether the caller passes the `extensions/` root (dev-watcher /
 * instrumentation) or the `extensions/cinatra-ai` vendor dir
 * (registerAllObjectTypes). Idempotent — the registry is replace-by-id.
 * Returns the count registered.
 */
export function registerArtifactExtensions(root: string): number {
  if (!existsSync(root)) return 0;
  let registered = scanDirForArtifacts(root);
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name.endsWith("-artifact")) continue;
    registered += scanDirForArtifacts(path.join(root, dirent.name));
  }
  return registered;
}
