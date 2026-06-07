// ---------------------------------------------------------------------------
// Standalone agent `produces:` reader.
//
// Returns the agent's declared `produces: SemanticArtifactRef[]` from an
// already-loaded agent manifest blob. The reader is pure (no I/O, no
// registry/db imports) so it can be unit-tested without a verdaccio
// roundtrip and so it carries NO cross-package edges that would violate
// the dependency direction (agents may depend outward; extensions must
// not import the agents barrel). The caller passes the manifest object
// (`getAgentPackage(...).manifest`); the reader extracts and validates
// only the `cinatra.produces` slice.
//
// Keep this standalone in extensions with a local mirrored parser. Do not
// move it into the agents package barrel or import the agents barrel here.
//
// This does NOT wire into `createSemanticArtifact`: caller-supplied
// `producesSource: {agentSlug, agentVersion}` is not trusted enough for
// artifact provenance until the agent-output emit path can provide a
// run-bound source. This reader keeps the parsing logic ready for that
// integration without adding a cross-package edge.
// ---------------------------------------------------------------------------

import { z } from "zod";

/** SemanticArtifactRef byte-mirror — kept inline to avoid a cross-package
 *  dep edge (extensions → objects). Drift here would be caught by the
 *  `byte-mirror` test that parses the SAME input against both the local
 *  schema and `@cinatra-ai/objects/semantic-manifest.semanticProducesSchema`. */
export type SemanticArtifactRefLeaf = { extension: string };

const semanticArtifactRefSchema = z
  .object({ extension: z.string().min(1) })
  .strict();

const producesArraySchema = z.array(semanticArtifactRefSchema);

/**
 * Parse an agent package manifest and return its declared `produces`
 * array (or `[]` for legacy / absent / malformed). Never throws on
 * shape mismatch — a quietly-empty result is the back-compat surface
 * for agents with no schema field.
 */
export function readAgentProducesFromPackageManifest(
  manifest: unknown,
): SemanticArtifactRefLeaf[] {
  // The contract is "quietly empty on bad input, never throws". A hostile
  // manifest object can carry throwing getters or Proxies; wrap every
  // property read in a single try/catch so the reader's caller
  // (artifact-creation, agent runner) never crashes on malformed input.
  try {
    if (!manifest || typeof manifest !== "object") return [];
    const cinatra = (manifest as { cinatra?: unknown }).cinatra;
    if (!cinatra || typeof cinatra !== "object") return [];
    const produces = (cinatra as { produces?: unknown }).produces;
    if (produces === undefined || produces === null) return [];
    const parsed = producesArraySchema.safeParse(produces);
    if (!parsed.success) return [];
    // Defensive: return a new array of {extension} objects only — never
    // pass through a caller-supplied object reference (which could carry
    // smuggled prototype-walk fields).
    return parsed.data.map((r) => ({ extension: r.extension }));
  } catch {
    return [];
  }
}
