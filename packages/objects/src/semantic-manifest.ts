import { z } from "zod";
import { parseArtifactUi } from "@cinatra-ai/sdk-extensions/artifact-contract";
import { artifactObjectTypeClaimManifestSchema } from "./claims";
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
    // Reverse cross-kind advisory edge: agent package names this artifact's
    // authoring/validator/enricher skills may invoke. KEPT per cinatra#1059
    // (dormant — zero live declarations today) as the counterpart to the
    // agent→artifact `cinatra.produces` edge; both feed the pure cross-kind
    // graph (`@cinatra-ai/extensions/cross-kind-dep-graph`) consumed by
    // `decideUninstall` (uninstall safety) and `checkAuthoringRecursionBudget`.
    // NOTE: this is the SEMANTIC-MANIFEST `agentDependencies`, distinct from
    // the deprecated legacy agent-package `cinatra.agentDependencies` map.
    agentDependencies: z.array(z.string().min(1)).optional(),
    // Per-extension matcher confidence floor.
    // The matcher runtime asserts the type only when the classifier's
    // returned confidence >= this value. Optional; the runtime defaults
    // to 0.7 when absent. `.min(0).max(1)` so a bad manifest value
    // can't silently overmatch (>1 => never) or undermatch (<0 =>
    // always).
    matcherConfidenceThreshold: z.number().min(0).max(1).optional(),
    // BEGIN artifact-ui-mirror (cinatra#1621, epic #1620) — kept byte-identical
    // across packages/objects/src/semantic-manifest.ts and
    // packages/extensions/src/artifact-handler.ts (the same lock-step
    // convention the objectTypes block uses; the objects↔extensions import
    // cycle forbids sharing the schema itself). The versioned
    // `cinatra.artifact.ui` block is carried here as RAW `unknown` so a
    // malformed `ui` can NEVER fail this strict manifest parse and drop the
    // extension's type registration / `objectTypes` claims (cinatra#1621 — the
    // whole-parse-rejection bug this slice fixes). The tolerant validation +
    // sanitized degradation live in the sdk-extensions LEAF (`parseArtifactUi`,
    // imported by both mirror sides): the boot path degrades-with-diagnostic and
    // KEEPS the claims; the publish/conformance gate rejects fail-closed on the
    // same result. Unknown NON-`ui` keys keep today's strict rejection. The
    // mirror test pins this block byte-identical.
    ui: z.unknown().optional(),
    // END artifact-ui-mirror
    // BEGIN objectTypes-claims-mirror (cinatra#1432) — this block is kept
    // byte-identical across packages/objects/src/semantic-manifest.ts and
    // packages/extensions/src/artifact-handler.ts (the established lock-step
    // convention). The ENTRY schema itself is shared from the pure claims
    // leaf (@cinatra-ai/objects/claims — both files import it), so only this
    // block needs the mirror; the mirror test pins it byte-identical.
    objectTypes: z.array(artifactObjectTypeClaimManifestSchema).min(1).optional(),
    // END objectTypes-claims-mirror
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
//
// The floor type's package NAME comes from the generated manifest data —
// the single "artifact-default-floor" role claimant, validated at
// generation (exactly one claimant; must be a cinatra.systemExtensions
// member) — so core source never names the concrete extension
// (cinatra#151 Stage 6).
// ---------------------------------------------------------------------------
export { DEFAULT_ARTIFACT_EXTENSION } from "./generated/artifact-floor";
import { DEFAULT_ARTIFACT_EXTENSION } from "./generated/artifact-floor";

/** True iff `extension` is the built-in floor semantic artifact type. */
export function isDefaultArtifactType(extension: string | null | undefined): boolean {
  return extension === DEFAULT_ARTIFACT_EXTENSION;
}

/**
 * Substrate-rejecting parser. Returns the manifest or a flat error list.
 *
 * The `cinatra.artifact.ui` block is parsed FIELD-TOLERANTLY (cinatra#1621):
 * the strict schema carries `ui` as raw `unknown` (so a malformed `ui` can't
 * reject the whole manifest and drop the type registration / `objectTypes`
 * claims — the bug this slice fixes), and this parser then validates it via the
 * leaf `parseArtifactUi`. On success the typed `ui` is attached; on failure the
 * manifest is returned WITHOUT `ui` (degrade to generic rendering) and a
 * sanitized `diagnostics` entry is surfaced for the caller (the boot bridge) to
 * log. Unknown NON-`ui` keys keep today's strict whole-parse rejection.
 */
export function parseSemanticArtifactManifest(
  input: unknown,
):
  | { ok: true; manifest: SemanticArtifactManifest; diagnostics?: string[] }
  | { ok: false; errors: string[] } {
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
  if (!r.success) {
    return {
      ok: false,
      errors: r.error.issues.map((i) => `${i.path.join(".") || "<root>"} ${i.message}`),
    };
  }
  const manifest = r.data;
  // Field-tolerant `ui` validation (raw `unknown` came through the strict
  // schema above). Degrade — never reject the surrounding manifest.
  const rawUi = (manifest as { ui?: unknown }).ui;
  if (rawUi === undefined) return { ok: true, manifest };
  const uiResult = parseArtifactUi(rawUi);
  if (uiResult.ok) {
    (manifest as { ui?: unknown }).ui = uiResult.ui;
    return { ok: true, manifest };
  }
  // Drop the unsupported `ui` (generic rendering) and keep everything else —
  // type registration + claims survive.
  (manifest as { ui?: unknown }).ui = undefined;
  return { ok: true, manifest, diagnostics: [uiResult.diagnostic] };
}

/**
 * PUBLISH/authoring verdict wrapper (cinatra#1621). The authoring path
 * (`artifact_source_validate`/compile/publish) is FAIL-CLOSED on the
 * `cinatra.artifact.ui` block: unlike the boot path — which DEGRADES an
 * unsupported ui (dropping it with a diagnostic, claims intact) — a
 * chat-authored package with a malformed ui must be REJECTED. Any ui diagnostic
 * from {@link parseSemanticArtifactManifest} becomes a validation error here.
 * (Kept in the objects leaf, not the caller, so the giant agents MCP-handlers
 * bottleneck file does not grow — cinatra file-size ratchet.)
 */
export function validateSemanticArtifactManifestForPublish(
  input: unknown,
): { valid: boolean; errors: string[] } {
  const r = parseSemanticArtifactManifest(input);
  if (!r.ok) return { valid: false, errors: r.errors };
  if (r.diagnostics && r.diagnostics.length > 0) return { valid: false, errors: r.diagnostics };
  return { valid: true, errors: [] };
}
