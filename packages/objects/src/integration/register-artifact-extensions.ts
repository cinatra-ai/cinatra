import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Validator } from "@cfworker/json-schema";
import { ARTIFACT_ALLOWED_CINATRA_KEYS as ALLOWED_CINATRA_KEYS } from "@cinatra-ai/sdk-extensions/artifact-contract";
import { objectTypeRegistry } from "../registry";
import type { ArtifactObjectTypeClaim, SemanticArtifactManifest } from "../types";
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

// Per-claim JSON-Schema → Zod validator (cinatra#1429, epic #1424). The generic
// artifact umbrella (`${pkg}:artifact`) registered below carries a permissive
// `z.record` schema, so the objects_save / objects_update activation gate is
// INERT for a bridge-registered claimed type. Compile each manifest
// `objectTypes` claim's INLINE JSON Schema into a real validator and register it
// under the CLAIMED type id, so the gate's `resolve(type).schema.safeParse`
// actually enforces the declared shape once the claim activates. A z.custom
// wrapper delegates to a `@cfworker/json-schema` validator (a fast, standards
// JSON-Schema validator already vendored in the monorepo). A malformed inline
// schema compiles to null → the type is left unregistered here, so the
// pre-activation gate (assertClaimActivatable) fail-closes and the claim cannot
// activate — never a silently-permissive validator.
function compileClaimValidator(jsonSchema: Record<string, unknown>): z.ZodType<unknown> | null {
  let validator: Validator;
  try {
    validator = new Validator(jsonSchema as ConstructorParameters<typeof Validator>[0]);
  } catch {
    return null;
  }
  return z.custom<unknown>((data) => {
    try {
      return validator.validate(data).valid;
    } catch {
      return false;
    }
  });
}

// Register a per-claim VALIDATOR-ONLY object type for each inline-schema claim.
// Deliberately WITHOUT `isArtifact` — `listArtifacts()` (the serving / library /
// MCP surface) must stay one-generic-type-per-package; these entries exist so
// the activation gate can `resolve()` a real schema, nothing more. Provenance is
// threaded so the teardown hook (`removeByPackage`) reaps them on
// archive/uninstall exactly like the umbrella. Claims with no inline schema are
// self- or dependency-registered — their owning package registers the validator
// (the bridge already fail-closed such claims via
// validateObjectTypeClaimSchemaSources before reaching here).
function registerClaimValidators(
  claims: readonly ArtifactObjectTypeClaim[],
  umbrellaType: string,
  packageName: string,
): void {
  for (const claim of claims) {
    if (!claim.schema) continue;
    if (claim.type === umbrellaType) continue; // never clobber the umbrella
    const schema = compileClaimValidator(claim.schema);
    if (!schema) {
      console.warn(
        `[artifacts:bridge] ${packageName} claim '${claim.type}' has an uncompilable inline JSON Schema — per-claim validation skipped (the claim cannot activate)`,
      );
      continue;
    }
    objectTypeRegistry.register(
      {
        type: claim.type,
        category: "report",
        schema,
        lifecycle: {
          sources: ["agent", "user", "import"],
          mutableBy: ["agent", "user"],
        },
        renderers: {
          listRow: GenericObjectListRow,
          card: GenericObjectCard,
          detail: GenericObjectDetail,
        },
      },
      packageName,
    );
  }
}

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
  // A malformed `cinatra.artifact.ui` block DEGRADES (generic rendering) but
  // NEVER blocks registration — the type + its `objectTypes` claims still land
  // (cinatra#1621). Surface the sanitized diagnostic; keep going.
  if (parsed.diagnostics && parsed.diagnostics.length > 0) {
    console.warn(
      `[artifacts:bridge] ${pkg.name} declares an unsupported cinatra.artifact.ui — rendering generically (type + claims still registered): ${parsed.diagnostics.join("; ")}`,
    );
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
  // Per-claim validators (cinatra#1429): make the activation gate enforce each
  // claimed type's declared inline schema (the umbrella above is permissive).
  if (descriptor.objectTypes && descriptor.objectTypes.length > 0) {
    registerClaimValidators(descriptor.objectTypes, `${pkg.name}:artifact`, pkg.name);
  }
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
