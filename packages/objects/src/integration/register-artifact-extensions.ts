import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Validator } from "@cfworker/json-schema";
import { ARTIFACT_ALLOWED_CINATRA_KEYS as ALLOWED_CINATRA_KEYS } from "@cinatra-ai/sdk-extensions/artifact-contract";
import { objectTypeRegistry } from "../registry";
import type { SemanticArtifactManifest } from "../types";
import { validateObjectTypeClaimSchemaSources, claimedTypeRegisteringPackage } from "../claims";
import { isTombstonedObjectTypeId } from "../namespace";
import { parseSemanticArtifactManifest } from "../semantic-manifest";
import {
  semanticRendererRegistry,
  SEMANTIC_RENDERER_SLOTS,
} from "../artifact-renderer-registry";
import {
  GenericObjectListRow,
  GenericObjectCard,
  GenericObjectDetail,
} from "./generic-renderers";

// ---------------------------------------------------------------------------
// Object-registry descriptor bridge.
//
// Scans `extensions/cinatra-ai/*-artifact/package.json`, reads the metadata-
// only `cinatra.artifact` descriptor, and registers `ObjectTypeDefinition`(s)
// carrying `isArtifact`. The library / serving / MCP layers then consume
// `objectTypeRegistry.listArtifacts()` GENERICALLY — a NEW artifact type
// appears purely by adding a `kind:"artifact"` extension dir, with ZERO core
// per-type branches. That pluggability guarantee is proven by the fixture test
// in `__tests__/artifact-bridge.test.ts`.
//
// EXPLICIT-DECLARED-TYPES ONLY (ratified manifest rule, entry 95, epic
// cinatra#1785): a pack DECLARES the object types it owns in its manifest
// `objectTypes`, and the bridge registers EXACTLY those (each as its own
// first-class artifact type, surfaced in `listArtifacts()` under its exact
// objectTypeId, enforcing its inline schema). There is NO umbrella and NO
// auto-derivation: the retired `${pkg.name}:artifact` catch-all is GONE and the
// `mode` discriminator DIES — resolution reads declared types only. A manifest
// that declares NO `objectTypes` mints NO type (the deprecation/no-op path);
// umbrella minting NEVER happens. Package-wide matcher/authoring surface
// (`skills`, `matcherConfidenceThreshold`, `templates`) is KEPT in the manifest
// — it classifies content INTO the declared types — but is NOT inherited onto
// the per-type registered descriptor.
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

// Per-claim JSON-Schema → Zod validator (cinatra#1429, epic #1424). Compile each
// declared `objectTypes` type's INLINE JSON Schema into a real validator and
// register it under the declared type id, so the objects_save / objects_update
// activation gate's `resolve(type).schema.safeParse` actually enforces the
// declared shape. A z.custom wrapper delegates to a `@cfworker/json-schema`
// validator (a fast, standards JSON-Schema validator already vendored in the
// monorepo). A malformed inline schema compiles to null → the type is left
// unregistered, so the pre-activation gate (assertClaimActivatable) fail-closes
// and the type cannot activate — never a silently-permissive validator.
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
  // Everything above is parse/validation. The registration below reads the
  // manifest's explicitly declared `objectTypes` only (entry 95, epic #1785).
  return registerParsedArtifactManifest(descriptor, pkg.name);
}

/**
 * Register a parsed (already schema-validated) artifact manifest into the object
 * registry, reading its EXPLICITLY DECLARED `objectTypes` only. Exported as the
 * registration seam so the behavior is unit-testable directly. Returns true iff
 * at least one artifact type registered.
 *
 * Umbrella/derived-type minting is RETIRED (ratified manifest rule, entry 95,
 * epic cinatra#1785): the `${pkg.name}:artifact` catch-all is never
 * minted and the `mode` discriminator is gone. Every pack declares the types it
 * owns; a manifest with no declared types mints nothing (the no-op/deprecation
 * path), never an umbrella.
 */
export function registerParsedArtifactManifest(
  descriptor: SemanticArtifactManifest,
  packageName: string,
): boolean {
  // PERMANENT namespace tombstone (cinatra#1789, epic #1785): a package under a
  // retired dynamic namespace (`@dynamic/types` / `@cinatra-ai/dynamic`) can NEVER
  // register — reject the whole package before any type lands or any prior
  // registration is reconciled away. Its self-owned declared types share the
  // package namespace, so probing the (never-minted) `${packageName}:artifact` id
  // classifies the whole reserved scope as tombstoned. This is the
  // registration-path half of the tombstone (the manifest schema already rejects
  // tombstoned `objectTypes[].type` on the fs path); it also covers direct callers
  // of this exported seam that bypass schema parse.
  if (isTombstonedObjectTypeId(`${packageName}:artifact`)) {
    console.warn(
      `[artifacts:bridge] ${packageName} is under a permanently-retired dynamic namespace — nothing registered (cinatra#1789)`,
    );
    return false;
  }
  // RECONCILE before re-registering: drop this package's prior bridge
  // registrations (object types + semantic renderers) so a manifest change on the
  // dev-watcher / rescan re-register path never leaves stale state. The registry
  // is replace-by-id, which only overwrites the ids the NEW manifest re-emits; ids
  // it no longer emits must be actively removed. Host built-in types register
  // without provenance and are therefore never touched.
  objectTypeRegistry.removeByPackage(packageName);
  semanticRendererRegistry.removeByPackage(packageName);
  // A manifest with no explicitly declared types mints NO type. Umbrella
  // derivation is RETIRED (entry 95, epic #1785) — resolution reads declared
  // types only, so a type-less manifest is a no-op here (a pure-representation
  // renderer binds via the org-scoped representation provider at install/
  // activation, not through this object-type bridge). A legacy pack that still
  // relied on the derived `${pkg.name}:artifact` catch-all lands here too and
  // hits this deprecation path — it never mints an umbrella.
  if ((descriptor.objectTypes?.length ?? 0) === 0) {
    console.warn(
      `[artifacts:bridge] ${packageName} declares no objectTypes — umbrella/derived-type minting is retired (entry 95, cinatra#1785); no object type registered`,
    );
    return false;
  }
  return registerDeclaredArtifactTypes(descriptor, packageName);
}

/**
 * Register each EXPLICITLY DECLARED `objectTypes` type this pack OWNS as its own
 * first-class artifact type — surfaced in `listArtifacts()` under its exact
 * objectTypeId, enforcing its inline schema (permissive fallback when a self-owned
 * type ships none), rendered generically (or via its declared semantic
 * renderers), and reaped by provenance on teardown. No umbrella is ever minted.
 * This is the registry substrate a context-slot / agent-`produces` `objectTypeId`
 * discriminator resolves against. Returns true iff at least one type registered.
 */
function registerDeclaredArtifactTypes(
  descriptor: SemanticArtifactManifest,
  packageName: string,
): boolean {
  // Caller (registerParsedArtifactManifest) guarantees `objectTypes` is non-empty
  // and has already reconciled this package's prior registrations.
  const claims = descriptor.objectTypes ?? [];
  const perTypeDescriptor = declaredTypeArtifactDescriptor(descriptor);
  const registeredTypeIds: string[] = [];
  for (const claim of claims) {
    // OWNERSHIP is by NAMESPACE, never by inline schema. Epic #1448 / #1424: "exactly
    // one package remains the runtime type registrar per type; the claimant schema is
    // activation evidence, not a second registrar." A pack registers ONLY the types
    // it OWNS (a self-namespaced id, `@scope/pkg:local` where `@scope/pkg` is this
    // package). A cross-namespace claim — WITH or WITHOUT an inline schema — is
    // registered by its owning package; the bridge never registers it here. (The
    // registry is replace-by-id, so shadowing another package's registrant and then
    // reaping it via this pack's removeByPackage would delete the real owner's type
    // — and, with the registry conflict guard, would throw at boot.)
    if (claimedTypeRegisteringPackage(claim.type) !== packageName) continue;
    // Enforce the type's inline JSON Schema when present; fall back to a permissive
    // record schema when a self-owned type ships none. An uncompilable inline
    // schema fail-closes the single type.
    const schema = claim.schema
      ? compileClaimValidator(claim.schema)
      : z.record(z.string(), z.unknown());
    if (!schema) {
      console.warn(
        `[artifacts:bridge] ${packageName} type '${claim.type}' has an uncompilable inline JSON Schema — not registered (the type cannot activate)`,
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
        // Each declared type IS an artifact (surfaced generically in
        // listArtifacts) under a per-type descriptor that carries the
        // representation forms but DROPS the package-wide matcher/authoring surface
        // — a declared type inherits none of it (epic #1448 / entry 95).
        isArtifact: perTypeDescriptor,
      },
      // Provenance = the owning package, so removeByPackage reaps every declared
      // type on archive/uninstall.
      packageName,
    );
    registeredTypeIds.push(claim.type);
  }
  if (registeredTypeIds.length === 0) return false;
  registerSemanticRenderersForTypes(descriptor, registeredTypeIds, packageName);
  return true;
}

/**
 * The per-type artifact descriptor for a declared type: representation forms
 * (`accepts`) + `satisfies` + `ui`, with the package-wide matcher/authoring
 * surface (`skills`, `matcherConfidenceThreshold`, `templates`,
 * `agentDependencies`) and nested `objectTypes` DROPPED — the epic #1448 / entry
 * 95 "inherit no package-wide matcher/authoring behavior" rule (matchers/
 * thresholds/templates are KEPT in the manifest to classify content INTO the
 * declared types, never inherited onto a type's descriptor). (Per-type
 * representation refinement — a form-per-type — is #1451's follow-on; until then
 * the pack-level `accepts` is the representation surface every type shares.)
 */
function declaredTypeArtifactDescriptor(
  descriptor: SemanticArtifactManifest,
): SemanticArtifactManifest {
  const perType: SemanticArtifactManifest = { accepts: descriptor.accepts };
  if (descriptor.satisfies) perType.satisfies = descriptor.satisfies;
  if (descriptor.ui) perType.ui = descriptor.ui;
  return perType;
}

// Register the extension's semantic renderers (per declared SEMANTIC slot —
// `detail`, and since S7/M2 `listRow`; `preview` is representation-only) for the
// given object type ids — each slot keyed to its own generated build entry (an
// extension ships at most ONE renderer per slot). Idempotent replace-by-(type,
// slot). The caller supplies the exact type-id set: every declared type this
// pack owns (there is no umbrella).
function registerSemanticRenderersForTypes(
  descriptor: SemanticArtifactManifest,
  typeIds: Iterable<string>,
  packageName: string,
): void {
  const renderers = descriptor.ui?.renderers;
  if (!renderers) return;
  const declaredSlots = SEMANTIC_RENDERER_SLOTS.filter((slot) => renderers[slot]);
  if (declaredSlots.length === 0) return;
  for (const objectTypeId of typeIds) {
    for (const slot of declaredSlots) {
      // The registry derives the generated-map key from the package + slot — a
      // claimant can only ever resolve to its OWN module for that slot.
      semanticRendererRegistry.register({ objectTypeId, packageName, slot });
    }
  }
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

// An artifact-extension directory is named for its package slug, which ends in
// either the SINGULAR `-artifact` (single-type pack) or the PLURAL `-artifacts`
// (multi-type pack) suffix — both ratified by the plural-naming decision (epic
// cinatra#1448 / cinatra#1453, merged #1769; the host name gate
// `GENERIC_VENDOR_ARTIFACT_NAME_RE` is `-artifacts?`). The bundled-scan layout
// mirrors the slug, so this predicate must accept both or a plural pack (e.g.
// `email-artifacts`) is silently skipped at boot.
function isArtifactExtensionDirName(name: string): boolean {
  return name.endsWith("-artifact") || name.endsWith("-artifacts");
}

function scanDirForArtifacts(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const dirent of readdirSync(dir, { withFileTypes: true })) {
    if (!dirent.isDirectory() || !isArtifactExtensionDirName(dirent.name)) continue;
    if (registerOneArtifactDir(path.join(dir, dirent.name))) n += 1;
  }
  return n;
}

/**
 * Register every `kind:"artifact"` extension under `root`. Robust to caller
 * depth: scans BOTH `<root>/*-artifact(s)` AND `<root>/<vendor>/*-artifact(s)`,
 * so it is correct whether the caller passes the `extensions/` root (dev-watcher
 * / instrumentation) or the `extensions/cinatra-ai` vendor dir
 * (registerAllObjectTypes). Idempotent — the registry is replace-by-id.
 * Returns the count registered.
 */
export function registerArtifactExtensions(root: string): number {
  if (!existsSync(root)) return 0;
  let registered = scanDirForArtifacts(root);
  for (const dirent of readdirSync(root, { withFileTypes: true })) {
    if (!dirent.isDirectory() || isArtifactExtensionDirName(dirent.name)) continue;
    registered += scanDirForArtifacts(path.join(root, dirent.name));
  }
  return registered;
}
