import { z } from "zod";
import type { SemanticArtifactManifest, SemanticArtifactRef } from "./types";

// ---------------------------------------------------------------------------
// Semantic artifact-extension manifest contract (schema + parser ONLY).
// A `kind:"artifact"` extension's `cinatra.artifact` block declares a
// SEMANTIC work-product type via representation forms + interface relations
// + templates + an auditor-pattern skill bundle + agent dependencies.
//
// This is the CANONICAL schema. `packages/extensions/src/artifact-handler.ts`
// keeps a byte-mirrored copy (an objects<->extensions import cycle forbids
// sharing). Any edit here MUST be applied identically there;
// `__tests__/semantic-manifest.test.ts` + the artifact-handler tests pin both.
// ---------------------------------------------------------------------------

// Skill refs are skills-CATALOG ids (resolved at runtime via upsertSkill /
// skills_installed_get), NEVER filesystem paths. Reject anything path-shaped
// so a local-file resolver shortcut cannot sneak in.
const skillCatalogId = z
  .string()
  .min(1)
  .refine(
    (s) => !/\.md$/i.test(s) && !/^\.{0,2}\//.test(s) && !s.startsWith("/"),
    { message: "skill refs must be skills-catalog ids, not filesystem paths" },
  );

const representationFormsSchema = z
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
  });

export const semanticArtifactManifestSchema: z.ZodType<SemanticArtifactManifest> = z
  .object({
    accepts: representationFormsSchema,
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
    // Per-extension matcher confidence floor.
    // The matcher runtime asserts the type only when the classifier's
    // returned confidence >= this value. Optional; the runtime defaults
    // to 0.7 when absent. `.min(0).max(1)` so a bad manifest value
    // can't silently overmatch (>1 => never) or undermatch (<0 =>
    // always).
    matcherConfidenceThreshold: z.number().min(0).max(1).optional(),
  })
  .strict() as z.ZodType<SemanticArtifactManifest>;

/**
 * Agent-extension counterpart: `produces: SemanticArtifactRef[]` - agents
 * declare which semantic artifact types they emit. This parser owns only the
 * schema contract; adoption and cross-kind validation live outside this file.
 */
export const semanticProducesSchema: z.ZodType<SemanticArtifactRef[]> = z.array(
  z.object({ extension: z.string().min(1) }).strict(),
);

// ---------------------------------------------------------------------------
// Built-in FLOOR semantic artifact type.
//
// FLOOR INVARIANT (enforced atomically by the assertion service + DB guards,
// under an artifact-scoped advisory lock): an artifact carries a
// `default-artifact` **eligible** assertion **iff it has NO non-default
// eligible assertion**. Creation always writes a default-eligible assertion
// (asserted_by = the creating source, NEVER `matcher`); a matcher adds a
// non-default `draft`; confirming a draft INSERTs a new non-default eligible
// assertion + archives the draft + archives the default; archiving the last
// non-default eligible re-asserts the default. Every artifact ALWAYS has
// >=1 eligible semantic type; never co-asserted with a confident non-default
// eligible. It is the FLOOR, not a parallel match.
// ---------------------------------------------------------------------------
export const DEFAULT_ARTIFACT_EXTENSION = "@cinatra-ai/default-artifact";

/** True iff `extension` is the built-in floor semantic artifact type. */
export function isDefaultArtifactType(extension: string | null | undefined): boolean {
  return extension === DEFAULT_ARTIFACT_EXTENSION;
}

/** Substrate-rejecting parser. Returns the manifest or a flat error list. */
export function parseSemanticArtifactManifest(
  input: unknown,
): { ok: true; manifest: SemanticArtifactManifest } | { ok: false; errors: string[] } {
  // Fail loud on the substrate shape rather than silently dropping its keys
  // (.strict() already rejects, but this gives a precise semantic-drift
  // diagnostic).
  if (input && typeof input === "object" && "artifactType" in (input as object)) {
    return {
      ok: false,
      errors: [
        "substrate `artifactType` descriptor is unsupported - declare a semantic manifest (accepts/satisfies/templates/skills/agentDependencies)",
      ],
    };
  }
  const r = semanticArtifactManifestSchema.safeParse(input);
  if (r.success) return { ok: true, manifest: r.data };
  return {
    ok: false,
    errors: r.error.issues.map((i) => `${i.path.join(".") || "<root>"} ${i.message}`),
  };
}
