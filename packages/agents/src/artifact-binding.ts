// ---------------------------------------------------------------------------
// Declarative EndNode artifact-output binding grammar (cinatra#923).
//
// SINGLE SOURCE of the binding schema. Every consumer — the OAS compiler
// (compile-time validation), the run-completion materializer
// (`@/lib/artifacts/run-artifact-materializer`), the publish-time parity
// gates (#924) and the `artifact_materialize` passthrough tool (#925) —
// parses bindings THROUGH this module so there is exactly one grammar and
// no duplicate parser to drift.
//
// A binding annotates one EndNode output in `cinatra/oas.json`:
//
//   "outputs": [{ "title": "draft", ...,
//     "cinatra": { "artifact": {
//       "extension": "@cinatra-ai/blog-post-artifact",  // ∈ package.json cinatra.produces
//       "contentFrom": "draft",       // names an EndNode output (edge-sourced per OAS-RUNTIME-005)
//       "declaredMime": "text/markdown",                 // XOR mimeFrom
//       "titleFrom": "title"          // explicit — a title is never prompt-invented
//     }}}]
//
// Every field is an explicit reference to a sourced flow output; the host
// materializes the artifact deterministically at run completion. This module
// is dependency-light on purpose (zod only): it must be importable from CI
// validators and host code alike without pulling any server-only surface.
// ---------------------------------------------------------------------------

import { z } from "zod";

/**
 * Byte-mirror of `TEXT_AUTHORING_COMPATIBLE_MIMES` in
 * `src/lib/artifacts/artifact-authoring.ts` (which cannot be imported from
 * this package without inverting the packages→app dependency direction).
 * Set equality is pinned by
 * `src/lib/artifacts/__tests__/run-artifact-materializer.test.ts`.
 * Declarative bindings are v1-scoped to text-authorable MIMEs — binary
 * artifacts stay on the upload/template paths.
 */
export const ARTIFACT_BINDING_AUTHORABLE_MIMES: ReadonlySet<string> = new Set([
  "text/markdown",
  "text/plain",
  "text/html",
  "application/json",
  "application/xml",
]);

export const artifactOutputBindingSchema = z
  .object({
    /** Artifact-extension package name — must be ∈ `cinatra.produces`. */
    extension: z.string().min(1),
    /** EndNode output name that carries the artifact CONTENT. */
    contentFrom: z.string().min(1),
    /** Static MIME. XOR `mimeFrom`. Must be text-authorable (v1). */
    declaredMime: z.string().min(1).optional(),
    /** EndNode output name that carries the MIME at run time. XOR `declaredMime`. */
    mimeFrom: z.string().min(1).optional(),
    /** EndNode output name that carries the artifact TITLE. */
    titleFrom: z.string().min(1),
  })
  .strict()
  .superRefine((value, ctx) => {
    const hasDeclared = value.declaredMime !== undefined;
    const hasFrom = value.mimeFrom !== undefined;
    if (hasDeclared === hasFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of declaredMime / mimeFrom is required",
      });
    }
    if (
      value.declaredMime !== undefined &&
      !ARTIFACT_BINDING_AUTHORABLE_MIMES.has(value.declaredMime)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["declaredMime"],
        message:
          `declaredMime "${value.declaredMime}" is not text-authorable; allowed: ` +
          `${[...ARTIFACT_BINDING_AUTHORABLE_MIMES].join(", ")} (binary artifacts ` +
          "use the upload/template paths)",
      });
    }
  });

export type ArtifactOutputBinding = z.infer<typeof artifactOutputBindingSchema>;

export type CollectedArtifactBinding = {
  /** EndNode component id the annotated output lives on. */
  nodeId: string;
  /** The annotated EndNode output name — the ledger `output_id` identity. */
  outputId: string;
  binding: ArtifactOutputBinding;
};

export type CollectArtifactBindingsResult = {
  /** Fully valid bindings only — a binding with any error is NOT returned here. */
  bindings: CollectedArtifactBinding[];
  /** Human-readable errors, one per invalid annotation/reference. */
  errors: string[];
};

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Collect + validate every `outputs[].cinatra.artifact` annotation on the
 * TOP-LEVEL EndNode components of an OAS Flow document (matching the scope
 * of the OAS-RUNTIME-005 EndNode scan — subflow EndNodes do not surface
 * outputs through the run-completion sentinel and cannot bind).
 *
 * Validation performed here (grammar + graph-local references):
 *   - schema shape (strict; declaredMime XOR mimeFrom; authorable MIME);
 *   - `contentFrom` / `titleFrom` / `mimeFrom` each name a REAL output of
 *     the SAME EndNode (OAS-RUNTIME-005 then guarantees those outputs are
 *     edge-sourced);
 *   - when `produces` is provided (compile/install time — the sibling
 *     package.json is readable): `binding.extension ∈ produces`.
 *
 * Registry/manifest checks (extension installed, accepts intersection) are
 * deliberately NOT here: a package publishes fine against a registry it
 * cannot see into; the materializer re-validates at run time.
 */
export function collectArtifactBindingsFromOasDocument(
  doc: Record<string, unknown>,
  opts?: { produces?: readonly string[] | null },
): CollectArtifactBindingsResult {
  const bindings: CollectedArtifactBinding[] = [];
  const errors: string[] = [];
  const refs = isPlainObject(doc.$referenced_components)
    ? (doc.$referenced_components as Record<string, unknown>)
    : {};

  for (const [nodeId, componentRaw] of Object.entries(refs)) {
    if (!isPlainObject(componentRaw)) continue;
    if (componentRaw.component_type !== "EndNode") continue;
    const outputsRaw = Array.isArray(componentRaw.outputs)
      ? componentRaw.outputs
      : [];
    const outputTitles = new Set(
      outputsRaw
        .filter(isPlainObject)
        .map((o) => o.title)
        .filter((t): t is string => typeof t === "string"),
    );

    for (const outputRaw of outputsRaw) {
      if (!isPlainObject(outputRaw)) continue;
      const title = typeof outputRaw.title === "string" ? outputRaw.title : null;
      const annotation = isPlainObject(outputRaw.cinatra)
        ? (outputRaw.cinatra as Record<string, unknown>)
        : null;
      const artifactRaw = annotation?.artifact;
      if (artifactRaw === undefined || artifactRaw === null) continue;

      const where = `$referenced_components.${nodeId}.outputs[${title ?? "<untitled>"}].cinatra.artifact`;
      if (title === null) {
        errors.push(`${where}: the annotated output has no string "title"`);
        continue;
      }
      const parsed = artifactOutputBindingSchema.safeParse(artifactRaw);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const path = issue.path.length > 0 ? `.${issue.path.join(".")}` : "";
          errors.push(`${where}${path}: ${issue.message}`);
        }
        continue;
      }
      const binding = parsed.data;

      let referenceError = false;
      for (const [field, ref] of [
        ["contentFrom", binding.contentFrom],
        ["titleFrom", binding.titleFrom],
        ...(binding.mimeFrom !== undefined
          ? ([["mimeFrom", binding.mimeFrom]] as const)
          : []),
      ] as ReadonlyArray<readonly [string, string]>) {
        if (!outputTitles.has(ref)) {
          errors.push(
            `${where}.${field}: "${ref}" does not name an output of EndNode ` +
              `"${nodeId}" (outputs: [${[...outputTitles].join(", ")}])`,
          );
          referenceError = true;
        }
      }
      if (referenceError) continue;

      // Parity is FAIL-CLOSED against a known produces set (codex round 0):
      // an EMPTY array (package.json readable but `cinatra.produces`
      // absent/malformed) rejects every binding — a binding without its
      // declared production is a contract violation, never a skip. Only
      // null/undefined (the produces set is UNKNOWN — e.g. the builder path
      // with no package.json on disk) skips the check.
      if (opts?.produces != null && !opts.produces.includes(binding.extension)) {
        errors.push(
          `${where}.extension: "${binding.extension}" is not declared in ` +
            `package.json cinatra.produces ([${opts.produces.join(", ")}]) — ` +
            "declared production and bindings must agree",
        );
        continue;
      }

      bindings.push({ nodeId, outputId: title, binding });
    }
  }

  return { bindings, errors };
}
