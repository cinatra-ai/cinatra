import "server-only";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { Validator } from "@cfworker/json-schema";
import { ARTIFACT_ALLOWED_CINATRA_KEYS as ALLOWED_CINATRA_KEYS } from "@cinatra-ai/sdk-extensions/artifact-contract";
import { objectTypeRegistry } from "../registry";
import type { ArtifactObjectTypeClaim, SemanticArtifactManifest } from "../types";
import { validateObjectTypeClaimSchemaSources, claimedTypeRegisteringPackage } from "../claims";
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
// THREE MANIFEST MODES (cinatra#1452, epic #1448), keyed off the manifest
// `mode` discriminator (see `resolveArtifactManifestMode`):
//   - "descriptor-only" (classic): mint ONE generic `${pkg.name}:artifact`
//     umbrella carrying the whole descriptor as `isArtifact`.
//   - "hybrid": the umbrella PLUS a per-claim VALIDATOR (not surfaced) for each
//     `objectTypes` claim — today's behavior when a descriptor also ships claims
//     (e.g. the `default-artifact` floor).
//   - "claim-only" (connector artifacts packs, epic #1448): mint NO umbrella and
//     inherit NO package-wide matcher/authoring behavior; register EACH
//     `objectTypes` claim as its OWN first-class artifact type, surfaced in
//     `listArtifacts()` under its exact objectTypeId. This is the substrate a
//     context slot / agent `produces` `objectTypeId` discriminator resolves
//     against (the consumer surfaces are wired in sibling substrate lanes).
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
  // Everything above is mode-INDEPENDENT parse/validation. The registration
  // below forks on the resolved manifest mode (cinatra#1452, epic #1448).
  return registerParsedArtifactManifest(descriptor, pkg.name);
}

// The ratified artifact manifest modes (cinatra#1452, epic #1448). The mode
// governs whether the bridge mints the generic `${pkg.name}:artifact` umbrella.
export type ArtifactManifestMode = "descriptor-only" | "hybrid" | "claim-only";

/**
 * Resolve a parsed manifest's registration mode.
 *
 * `mode` is the ratified claim-only discriminator (epic #1448). Its SCHEMA +
 * TYPE definition are owned by sibling substrate lanes — #1449 (`SemanticArtifactManifest`
 * in types.ts) and #1453 (the kind-gate + the byte-mirrored semantic schema) —
 * so this bridge is the CONSUMER, not the definer. It is read defensively so this
 * slice compiles and stays green before those land: until `mode` is carried by
 * the strict manifest schema, the parser strips it and every real manifest
 * resolves to today's behavior EXACTLY (umbrella minted).
 */
export function resolveArtifactManifestMode(
  descriptor: SemanticArtifactManifest,
): ArtifactManifestMode {
  const declared = (descriptor as { mode?: unknown }).mode;
  if (declared === "claim-only") return "claim-only";
  if (declared === "descriptor-only") return "descriptor-only";
  if (declared === "hybrid") return "hybrid";
  // No explicit mode (every manifest today): preserve current behavior — mint
  // the umbrella. A pack that also ships claims is "hybrid" (umbrella + per-claim
  // validators); otherwise "descriptor-only". Both mint the umbrella.
  return (descriptor.objectTypes?.length ?? 0) > 0 ? "hybrid" : "descriptor-only";
}

/**
 * Register a parsed (already schema-validated) artifact manifest into the object
 * registry, forking on the resolved manifest mode. Exported as the mode-dispatch
 * seam so the mode behavior is unit-testable directly (the fs/parse path in
 * `registerOneArtifactDir` cannot yet carry a `mode` manifest field — that
 * schema plumbing lands in #1449/#1453). Returns true iff at least one artifact
 * type registered.
 */
export function registerParsedArtifactManifest(
  descriptor: SemanticArtifactManifest,
  packageName: string,
): boolean {
  const mode = resolveArtifactManifestMode(descriptor);
  // A claim-only manifest with no claims is invalid (the kind-gate #1453 requires
  // `objectTypes`); skip WITHOUT tearing down any prior registration.
  if (mode === "claim-only" && (descriptor.objectTypes?.length ?? 0) === 0) {
    console.warn(
      `[artifacts:bridge] ${packageName} declares claim-only mode but ships no objectTypes claims — nothing to register, skipped`,
    );
    return false;
  }
  // RECONCILE before re-registering: drop this package's prior bridge
  // registrations (object types + semantic renderers) so a manifest change —
  // especially a MODE change (hybrid -> claim-only) on the dev-watcher / rescan
  // re-register path — never leaves stale state. The registry is replace-by-id,
  // which only overwrites the ids the NEW manifest re-emits; ids it no longer emits
  // (e.g. the old `${pkg.name}:artifact` umbrella once a pack becomes claim-only,
  // which MUST NOT survive per epic #1448) must be actively removed. Host built-in
  // types register without provenance and are therefore never touched.
  objectTypeRegistry.removeByPackage(packageName);
  semanticRendererRegistry.removeByPackage(packageName);
  if (mode === "claim-only") {
    return registerClaimOnlyManifest(descriptor, packageName);
  }
  // descriptor-only / hybrid (classic — UNCHANGED registration): mint the generic
  // `${pkg.name}:artifact` umbrella carrying the whole descriptor as isArtifact.
  const umbrellaType = `${packageName}:artifact`;
  objectTypeRegistry.register(
    {
      // Namespaced id `@scope/pkg:artifact` (matches OBJECT_TYPE_NAMESPACE_RE).
      type: umbrellaType,
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
    packageName,
  );
  // Per-claim validators (cinatra#1429): make the activation gate enforce each
  // claimed type's declared inline schema (the umbrella above is permissive).
  if (descriptor.objectTypes && descriptor.objectTypes.length > 0) {
    registerClaimValidators(descriptor.objectTypes, umbrellaType, packageName);
  }
  // Renderer dispatch spine (cinatra#1629, epic #1620 S2; S7/M2 slot
  // activation cinatra#1631): if the manifest declares a semantic
  // `cinatra.artifact.ui.renderers` slot (`detail`, `listRow`), register the
  // extension's SEMANTIC renderer(s) for its type(s). Per-org arbitration is
  // the effective-identity winner's job at resolve time; this table just records
  // "this extension ships a renderer for type T at slot S". Retired on
  // archive/uninstall via the capability-teardown path (removeByPackage). The
  // ORG-SCOPED representation-provider registrations bind at install/activation
  // (M1/S4), not here. A malformed `ui` is already degraded away above (the
  // manifest keeps `ui: undefined`), so this only fires for valid declared slots.
  const rendererTypeIds = new Set<string>([umbrellaType]);
  for (const claim of descriptor.objectTypes ?? []) rendererTypeIds.add(claim.type);
  registerSemanticRenderersForTypes(descriptor, rendererTypeIds, packageName);
  return true;
}

/**
 * Claim-only manifest mode (cinatra#1452, epic #1448). The pack mints NO
 * `${pkg.name}:artifact` umbrella; each `objectTypes` claim is registered as its
 * OWN first-class artifact type — surfaced in `listArtifacts()` under its exact
 * objectTypeId, enforcing its inline schema (permissive fallback when a claim
 * ships none), rendered generically (or via its declared semantic renderers),
 * and reaped by provenance on teardown exactly like the umbrella. This is the
 * registry substrate a context-slot / agent-`produces` `objectTypeId`
 * discriminator resolves against (those consumer surfaces are wired in the
 * sibling substrate lanes). Returns true iff at least one claim registered.
 */
function registerClaimOnlyManifest(
  descriptor: SemanticArtifactManifest,
  packageName: string,
): boolean {
  // Caller (registerParsedArtifactManifest) guarantees `objectTypes` is non-empty
  // and has already reconciled this package's prior registrations.
  const claims = descriptor.objectTypes ?? [];
  const perClaimDescriptor = claimOnlyArtifactDescriptor(descriptor);
  const registeredTypeIds: string[] = [];
  for (const claim of claims) {
    // OWNERSHIP is by NAMESPACE, never by inline schema. Epic #1448 / #1424: "exactly
    // one package remains the runtime type registrar per type; the claimant schema is
    // activation evidence, not a second registrar." A claim-only pack registers ONLY
    // the types it OWNS (a self-namespaced id, `@scope/pkg:local` where `@scope/pkg`
    // is this package). A cross-namespace claim — WITH or WITHOUT an inline schema —
    // is registered by its owning package; the bridge never registers it here. (The
    // registry is replace-by-id, so shadowing another package's registrant and then
    // reaping it via this pack's removeByPackage would delete the real owner's type.)
    if (claimedTypeRegisteringPackage(claim.type) !== packageName) continue;
    // Enforce the claim's inline JSON Schema when present; fall back to the same
    // permissive record schema the umbrella used when a self-owned claim ships
    // none. An uncompilable inline schema fail-closes the single claim.
    const schema = claim.schema
      ? compileClaimValidator(claim.schema)
      : z.record(z.string(), z.unknown());
    if (!schema) {
      console.warn(
        `[artifacts:bridge] ${packageName} claim '${claim.type}' has an uncompilable inline JSON Schema — claim-only type not registered (the claim cannot activate)`,
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
        // Each claim IS an artifact (surfaced generically in listArtifacts) under
        // a per-claim descriptor that carries the representation forms but DROPS
        // the package-wide matcher/authoring surface — a claim-only type inherits
        // none of it (epic #1448).
        isArtifact: perClaimDescriptor,
      },
      // Provenance = the claiming package, so removeByPackage reaps every
      // claim-only type on archive/uninstall (identical teardown to the umbrella).
      packageName,
    );
    registeredTypeIds.push(claim.type);
  }
  if (registeredTypeIds.length === 0) return false;
  registerSemanticRenderersForTypes(descriptor, registeredTypeIds, packageName);
  return true;
}

/**
 * The per-claim artifact descriptor for claim-only mode: representation forms
 * (`accepts`) + `satisfies` + `ui`, with the package-wide matcher/authoring
 * surface (`skills`, `matcherConfidenceThreshold`, `templates`,
 * `agentDependencies`) and nested `objectTypes` DROPPED — the epic #1448 "inherit
 * no package-wide matcher/authoring behavior" rule. (Per-type representation
 * refinement — a form-per-type — is #1451's follow-on; until then the pack-level
 * `accepts` is the representation surface every claim shares.)
 */
function claimOnlyArtifactDescriptor(
  descriptor: SemanticArtifactManifest,
): SemanticArtifactManifest {
  const perClaim: SemanticArtifactManifest = { accepts: descriptor.accepts };
  if (descriptor.satisfies) perClaim.satisfies = descriptor.satisfies;
  if (descriptor.ui) perClaim.ui = descriptor.ui;
  return perClaim;
}

// Register the extension's semantic renderers (per declared SEMANTIC slot —
// `detail`, and since S7/M2 `listRow`; `preview` is representation-only) for the
// given object type ids — each slot keyed to its own generated build entry (an
// extension ships at most ONE renderer per slot). Idempotent replace-by-(type,
// slot). The caller supplies the exact type-id set: the umbrella + every claimed
// type in classic (descriptor-only / hybrid) mode, or the claim types alone in
// claim-only mode (no umbrella exists).
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
