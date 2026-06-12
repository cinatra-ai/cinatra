import "server-only";
import { z } from "zod";
import type {
  Actor,
  ActiveExtensionManifest,
  ExtensionDiscoveryScope,
  ExtensionTypeHandler,
  PackageRef,
  ValidationResult,
} from "@cinatra-ai/extension-types";
import { visibleManifestPackageNames } from "@cinatra-ai/extension-types";
import { objectTypeRegistry } from "@cinatra-ai/objects";

// Validate the SEMANTIC artifact manifest. An artifact extension declares a
// semantic work-product type; representation details live under
// accepts/templates/skills. It is never an agent (no oas/agent.json).
// BYTE-MIRROR of the canonical
// `packages/objects/src/semantic-manifest.ts semanticArtifactManifestSchema`
// — an objects↔extensions import cycle forbids sharing, so the two copies
// are kept in lock-step (semantic-manifest.test.ts + artifact-handler tests
// pin both). Any edit here MUST be applied identically there.
const skillCatalogId = z
  .string()
  .min(1)
  .refine(
    (s) => !/\.md$/i.test(s) && !/^\.{0,2}\//.test(s) && !s.startsWith("/"),
    { message: "skill refs must be skills-catalog ids, not filesystem paths" },
  );
const artifactDescriptorSchema = z
  .object({
    accepts: z
      .object({
        file: z.object({ mimeTypes: z.array(z.string().min(1)).min(1) }).strict().optional(),
        connectorRef: z
          .object({ resolvedMimeTypes: z.array(z.string().min(1)).min(1) })
          .strict()
          .optional(),
        dashboard: z.literal(true).optional(),
      })
      .strict()
      .refine((a) => Boolean(a.file || a.connectorRef || a.dashboard), {
        message: "accepts must declare at least one representation form (file/connectorRef/dashboard)",
      }),
    satisfies: z.array(z.string().min(1)).optional(),
    templates: z
      .array(
        z
          .object({
            id: z.string().min(1),
            form: z.enum(["file", "connectorRef", "dashboard"]),
            mimeType: z.string().min(1),
            path: z.string().min(1),
            default: z.boolean().optional(),
          })
          .strict(),
      )
      .optional(),
    skills: z
      .object({
        authoring: z.array(skillCatalogId).optional(),
        matchers: z.array(skillCatalogId).optional(),
        validators: z.array(skillCatalogId).optional(),
        enrichers: z.array(skillCatalogId).optional(),
      })
      .strict()
      .optional(),
    agentDependencies: z.array(z.string().min(1)).optional(),
    // BYTE-MIRROR of `packages/objects/src/semantic-manifest.ts`
    // `matcherConfidenceThreshold`. The objects↔extensions import cycle
    // forbids sharing; the parity test pins both copies.
    matcherConfidenceThreshold: z.number().min(0).max(1).optional(),
  })
  .strict();
// Allowlist the whole `cinatra` block — an artifact extension's manifest may
// ONLY carry these keys. Anything else (any agent-package field:
// manifestVersion, riskLevel, toolAccess, type, sourceVersionId, uiAdapter,
// …) is rejected outright. `dependencies` (cross-kind ExtensionDependency[],
// extension-deps gate) and `roles` (cinatra#151 Stage 5 role bindings,
// validated fail-closed by the agent-bindings generator) are permitted
// CROSS-KIND metadata on any extension manifest; keep in lock-step with
// register-artifact-extensions.ts ALLOWED_CINATRA_KEYS.
const ALLOWED_CINATRA_KEYS = new Set(["kind", "apiVersion", "artifact", "dependencies", "roles"]);

// ---------------------------------------------------------------------------
// ArtifactExtensionTypeHandler.
//
// Registers `kind:"artifact"` as a first-class extension kind alongside
// `agent`, `skill`, and `connector`. An artifact extension declares ONE
// SEMANTIC work-product type via the semantic manifest (accepts
// representation forms / satisfies / templates / skills / agentDependencies).
// File/dashboard/connector-ref are representation forms, not artifact types.
// The set is extensible purely by adding more `kind:"artifact"` extensions;
// the registry bridge (objects) consumes them generically via the byte-mirrored
// semantic schema.
//
// CRITICAL — this handler is intentionally NOT a structural copy of
// `ConnectorExtensionTypeHandler`. Connectors are workspace-compiled and
// throw on runtime install/update/uninstall. Artifact extensions are
// **metadata-discoverable**: their descriptor is registered into the object
// registry by the descriptor bridge at load/boot. The lifecycle mutators here
// are clean audit-logged no-ops (NOT throws) so:
//   - the typeId resolves (deriveTypeId → "artifact"), letting
//     extensions_purge / extensions_force_delete reach DB + audit + Verdaccio
//     cleanup, exactly like the connector handler;
//   - install/update mean "(re)register descriptor", which is owned by the
//     bridge, not a bundle rebuild — so there is nothing to throw about.
//
// validate(): real validation — confirms the package declares
//   `cinatra.kind === "artifact"`, matches the `@cinatra-ai/<slug>-artifact`
//   kind-at-end naming convention, and does NOT carry an agent payload
//   (`cinatra.oas` / agent-only manifest fields) — an artifact extension is
//   metadata-only and must never be mountable by WayFlow's agent loader.
// ---------------------------------------------------------------------------

const ARTIFACT_NAME_RE = /^@cinatra-ai\/[a-z0-9][a-z0-9-]*-artifact$/;

export function createArtifactExtensionHandler(): ExtensionTypeHandler {
  return {
    typeId: "artifact",

    async install(ref: PackageRef, _actor: Actor): Promise<void> {
      // Descriptor (re)registration is owned by the registry bridge at
      // load/boot. The handler call is recorded for audit parity with the
      // other kinds; no bundle work and nothing to throw.
      console.info(
        `[artifactExtensionHandler] install recorded for "${ref.packageName}" (descriptor registered via the object-registry bridge)`,
      );
    },

    async update(ref: PackageRef, _actor: Actor): Promise<void> {
      console.info(
        `[artifactExtensionHandler] update recorded for "${ref.packageName}" (descriptor refreshed via the object-registry bridge)`,
      );
    },

    async uninstall(ref: PackageRef, _actor: Actor): Promise<void> {
      // Descriptor removal is guarded by the bridge: a type with live
      // artifact rows is archived (kept resolvable for replay), not dropped.
      console.info(
        `[artifactExtensionHandler] uninstall recorded for "${ref.packageName}" (descriptor de-registered/archived via the object-registry bridge)`,
      );
    },

    async archive(ref: PackageRef, _actor: Actor): Promise<void> {
      console.info(
        `[artifactExtensionHandler] archive recorded for "${ref.packageName}" (artifact type marked unavailable; existing artifacts stay readable)`,
      );
    },

    async restore(ref: PackageRef, _actor: Actor): Promise<void> {
      console.info(
        `[artifactExtensionHandler] restore recorded for "${ref.packageName}" (artifact type marked available)`,
      );
    },

    // Reader facet. The object-type registry is the artifact VISIBILITY +
    // capability authority; the dispatcher's `manifests` are only a coarse
    // lifecycle-live candidate set. Artifact descriptors are registered into
    // the in-memory registry at server boot by the object-registry bridge, so
    // this facet READS that registry directly — it never re-scans the
    // filesystem (cwd-fragile, slow on every call) nor triggers registration.
    // A descriptor's package identity is the namespace of its typeId
    // (`@scope/pkg:slug` -> `@scope/pkg`); we keep only descriptors whose
    // package is BOTH lifecycle-live AND owner-visible per the shared gate, so
    // a row is never surfaced just because its package name is live elsewhere.
    async listActive({
      scope,
      manifests,
    }: {
      actor: Actor;
      scope: ExtensionDiscoveryScope;
      manifests: ActiveExtensionManifest[];
    }) {
      const live = visibleManifestPackageNames(manifests, scope);
      return objectTypeRegistry
        .listArtifacts()
        .filter((def) => live.has(def.type.split(":")[0]));
    },

    async validate(spec: unknown): Promise<ValidationResult> {
      const errors: string[] = [];
      const s = spec as
        | { name?: unknown; cinatra?: { kind?: unknown; oas?: unknown } }
        | null;
      if (!s || typeof s !== "object") {
        return { valid: false, errors: ["spec is not an object"] };
      }
      if (typeof s.name !== "string") {
        errors.push("package.json is missing `name`");
      } else if (!ARTIFACT_NAME_RE.test(s.name)) {
        errors.push(
          `package name "${s.name}" does not match the kind-at-end convention ` +
            `(expected @cinatra-ai/<slug>-artifact)`,
        );
      }
      const cinatra = s.cinatra as
        | { kind?: unknown; oas?: unknown; artifact?: unknown }
        | undefined;
      const kind = cinatra?.kind;
      if (kind !== "artifact") {
        errors.push(
          `package.json must declare \`cinatra.kind: "artifact"\` (got ${JSON.stringify(kind)})`,
        );
      }
      if (cinatra && "oas" in cinatra && cinatra.oas != null) {
        errors.push(
          "artifact extensions are metadata-only and must NOT carry a `cinatra.oas` payload " +
            "(an artifact extension must never be mountable by the WayFlow agent loader)",
        );
      }
      // The `cinatra.artifact` descriptor is mandatory and must match the
      // metadata-only schema.
      if (!cinatra || cinatra.artifact == null) {
        errors.push(
          "package.json must declare a `cinatra.artifact` descriptor " +
            "(accepts[, satisfies][, templates][, skills][, agentDependencies])",
        );
      } else {
        const parsed = artifactDescriptorSchema.safeParse(cinatra.artifact);
        if (!parsed.success) {
          errors.push(
            `cinatra.artifact descriptor is invalid: ${parsed.error.issues
              .map((i) => `${i.path.join(".") || "<root>"} ${i.message}`)
              .join("; ")}`,
          );
        }
      }
      // Allowlist the cinatra block — reject ANY non-artifact manifest key
      // (agent-package fields and anything else).
      if (cinatra != null) {
        const extraneous = Object.keys(cinatra).filter(
          (k) => !ALLOWED_CINATRA_KEYS.has(k),
        );
        if (extraneous.length > 0) {
          errors.push(
            `artifact extensions may only declare cinatra.{kind,apiVersion,artifact,dependencies,roles}; ` +
              `unexpected key(s): ${extraneous.join(", ")}`,
          );
        }
      }
      return { valid: errors.length === 0, errors: errors.length ? errors : undefined };
    },
  };
}
