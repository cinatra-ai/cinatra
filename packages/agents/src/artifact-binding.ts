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
//       "extension": "@cinatra-ai/email-artifacts",      // ∈ package.json cinatra.produces
//       "objectTypeId": "@cinatra-ai/email:body",        // OPTIONAL declared-type discriminator (see below)
//       "contentFrom": "draft",       // names an EndNode output (edge-sourced per the runtime invariant)
//       "declaredMime": "text/markdown",                 // XOR mimeFrom
//       "titleFrom": "title"          // explicit — a title is never prompt-invented
//     }}}]
//
// `objectTypeId` (cinatra#1454, completing the #1788 direction on the binding
// side — symmetric with `cinatra.produces`'s SemanticArtifactRef.objectTypeId)
// names the EXACT `@scope/pkg:local-id` object type the bound output
// materializes into. The umbrella `${extension}:artifact` type is RETIRED
// (#1824): a claim-based artifact pack registers its DECLARED types
// (e.g. `@cinatra-ai/email:body`), never an `:artifact` umbrella, so the
// materializer resolves a binding to its declared type. The field is OPTIONAL:
// a single-artifact-safe-type pack resolves from `{extension}` alone; an
// AMBIGUOUS multi-type pack REQUIRES it (the materializer fails closed, never
// guesses — see `resolveArtifactBindingObjectType`).
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

/**
 * Namespaced object-type id shape (`@scope/package:local-id`) — byte-mirror of
 * `CLAIMED_OBJECT_TYPE_ID_RE` (`@cinatra-ai/objects/claims`) and the produces
 * reader's `semanticArtifactRefSchema.objectTypeId` regex
 * (`@cinatra-ai/extensions/agent-produces-reader`). Kept inline so this leaf
 * stays import-light; equivalence is pinned by the binding grammar test.
 */
export const BINDING_OBJECT_TYPE_ID_RE = /^@[\w-]+\/[\w-]+:[\w-]+$/;

export const artifactOutputBindingSchema = z
  .object({
    /** Artifact-extension package name — must be ∈ `cinatra.produces`. */
    extension: z.string().min(1),
    /**
     * OPTIONAL exact declared-type discriminator (`@scope/pkg:local-id`,
     * cinatra#1454). When present it pins the bound output to ONE claimed type
     * of the extension (symmetric with `cinatra.produces`); when absent the
     * materializer resolves a single-artifact-safe-type pack from `extension`
     * alone and FAILS CLOSED on an ambiguous multi-type pack. Never the retired
     * `${extension}:artifact` umbrella (#1824).
     */
    objectTypeId: z
      .string()
      .regex(BINDING_OBJECT_TYPE_ID_RE, {
        message:
          "objectTypeId must be a namespaced object type id (@scope/package:local-id)",
      })
      .optional(),
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

/**
 * A `cinatra.produces` entry — structural mirror of `@cinatra-ai/objects`
 * `SemanticArtifactRef` and the agent-produces-reader leaf. Passed to the
 * collectors as `producesRefs` so a binding/materialize `objectTypeId` can be
 * cross-checked against the TYPED produces declaration (cinatra#1454): a coarse
 * `{extension}` produces entry may be NARROWED by an explicit binding
 * objectTypeId, but a TYPED produces entry and an explicit binding objectTypeId
 * must AGREE (a contradiction is fail-closed at compile/publish time).
 */
export type SemanticArtifactProducesRef = { extension: string; objectTypeId?: string };

/**
 * The `objectTypeId` a TYPED `produces` entry pins for `extension`, or null when
 * the produces set is unknown/absent OR every entry for that extension is coarse
 * (`{extension}` only). Returns the FIRST typed entry's objectTypeId — the
 * publish/install typed-production contract already rejects a manifest that
 * declares two conflicting typed entries for one extension, so first-typed is
 * deterministic here. A pure helper shared by both collectors + the resolver.
 */
export function producesObjectTypeIdForExtension(
  producesRefs: readonly SemanticArtifactProducesRef[] | null | undefined,
  extension: string,
): string | null {
  if (producesRefs == null) return null;
  for (const ref of producesRefs) {
    if (ref.extension === extension && ref.objectTypeId !== undefined) return ref.objectTypeId;
  }
  return null;
}

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
 * of the EndNode output-source runtime-invariant scan — subflow EndNodes do not surface
 * outputs through the run-completion sentinel and cannot bind).
 *
 * Validation performed here (grammar + graph-local references):
 *   - schema shape (strict; declaredMime XOR mimeFrom; authorable MIME);
 *   - `contentFrom` / `titleFrom` / `mimeFrom` each name a REAL output of
 *     the SAME EndNode (the output-source runtime invariant then guarantees those outputs are
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
  opts?: {
    produces?: readonly string[] | null;
    /** Full typed `produces` entries (cinatra#1454). When provided, a binding
     *  `objectTypeId` that CONTRADICTS a typed produces entry for the same
     *  extension is rejected; the extension-name parity set is derived from
     *  these when `produces` is not separately supplied. */
    producesRefs?: readonly SemanticArtifactProducesRef[] | null;
  },
): CollectArtifactBindingsResult {
  const bindings: CollectedArtifactBinding[] = [];
  const errors: string[] = [];
  // Extension-name parity set: prefer an explicit `produces` list; else derive
  // from `producesRefs` (so a single fuller source suffices at each caller).
  const producesNames: readonly string[] | null =
    opts?.produces ??
    (opts?.producesRefs != null ? opts.producesRefs.map((r) => r.extension) : null);
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
      if (producesNames != null && !producesNames.includes(binding.extension)) {
        errors.push(
          `${where}.extension: "${binding.extension}" is not declared in ` +
            `package.json cinatra.produces ([${producesNames.join(", ")}]) — ` +
            "declared production and bindings must agree",
        );
        continue;
      }

      // Typed-produces AGREEMENT (cinatra#1454): when the manifest declares a
      // TYPED produces entry for this extension, an explicit binding
      // `objectTypeId` must equal it — the binding may NARROW a coarse
      // `{extension}` produces entry but must never CONTRADICT a typed one.
      const producesType = producesObjectTypeIdForExtension(opts?.producesRefs, binding.extension);
      if (
        producesType != null &&
        binding.objectTypeId !== undefined &&
        binding.objectTypeId !== producesType
      ) {
        errors.push(
          `${where}.objectTypeId: "${binding.objectTypeId}" contradicts the typed ` +
            `cinatra.produces entry for "${binding.extension}" (declares type "${producesType}") — ` +
            "a binding may narrow a coarse produces entry but must agree with a typed one",
        );
        continue;
      }

      bindings.push({ nodeId, outputId: title, binding });
    }
  }

  return { bindings, errors };
}

// ---------------------------------------------------------------------------
// Binding → declared-type resolution (cinatra#1454).
//
// The materializer + create-from-template seams resolve a binding/produces
// `{extension, objectTypeId?}` to the EXACT declared object type it
// materializes into. The retired umbrella `${extension}:artifact` (#1824) is
// GONE: a claim-based pack registers its declared types (host-owned, e.g.
// `@cinatra-ai/email:body`), so resolution names the declared type.
//
// PURE + host-agnostic on purpose: the caller supplies the extension's
// EFFECTIVE artifact-safe declared type ids (the host sources these from the
// org-chain DB claim registry via winner arbitration, intersected with a
// currently-registered host type — see
// `src/lib/artifacts/resolve-bound-artifact-type`). This function only decides
// WHICH declared type the binding targets, fail-closed:
//   - explicit `objectTypeId` (binding first, else the typed produces entry) →
//     must be one of the extension's artifact-safe declared types;
//   - no explicit id → resolve iff the extension has EXACTLY ONE artifact-safe
//     declared type (the single-claim fallback); 0 or >1 fails closed (never a
//     guess — an ambiguous multi-type pack REQUIRES an explicit objectTypeId).
// ---------------------------------------------------------------------------

export type ResolveArtifactBindingObjectTypeInput = {
  /** The bound artifact-extension package name. */
  extension: string;
  /** The OAS binding's explicit `objectTypeId` (highest precedence). */
  bindingObjectTypeId?: string;
  /** The matching `cinatra.produces` entry's `objectTypeId`, if typed. */
  producesObjectTypeId?: string;
  /** The extension's EFFECTIVE artifact-safe declared type ids (projection
   *  `artifact-safe`), each already intersected with a registered host type. */
  declaredArtifactSafeTypeIds: readonly string[];
};

export type ResolveArtifactBindingObjectTypeResult =
  | { ok: true; objectTypeId: string; source: "explicit" | "single-claim-fallback" }
  | { ok: false; error: string };

/**
 * Resolve a binding/produces reference to its declared object type id.
 * PURE — see the module note above. Never throws.
 */
export function resolveArtifactBindingObjectType(
  input: ResolveArtifactBindingObjectTypeInput,
): ResolveArtifactBindingObjectTypeResult {
  const declared = input.declaredArtifactSafeTypeIds;
  // Precedence: an explicit binding objectTypeId wins; else the typed produces
  // entry. (A binding objectTypeId that contradicts a typed produces entry is
  // rejected upstream at compile/publish — collectArtifactBindingsFromOasDocument.)
  const explicit = input.bindingObjectTypeId ?? input.producesObjectTypeId;
  if (explicit !== undefined) {
    if (!declared.includes(explicit)) {
      return {
        ok: false,
        error:
          `objectTypeId "${explicit}" is not an artifact-safe declared type of extension ` +
          `"${input.extension}" (declares: [${declared.join(", ") || "none"}])`,
      };
    }
    return { ok: true, objectTypeId: explicit, source: "explicit" };
  }
  if (declared.length === 1) {
    return { ok: true, objectTypeId: declared[0]!, source: "single-claim-fallback" };
  }
  if (declared.length === 0) {
    return {
      ok: false,
      error:
        `extension "${input.extension}" declares no artifact-safe object type — ` +
        "cannot materialize a binding (declare a produces/binding objectTypeId over an artifact-safe claim)",
    };
  }
  return {
    ok: false,
    error:
      `extension "${input.extension}" declares ${declared.length} artifact-safe object types ` +
      `([${declared.join(", ")}]); the binding must set an explicit objectTypeId to disambiguate ` +
      "(fail-closed — the materializer never guesses)",
  };
}

// ---------------------------------------------------------------------------
// Deterministic `artifact_materialize` passthrough-tool nodes (cinatra#925).
//
// Mid-flow / conditional artifact emission: an ApiNode targets the
// deterministic passthrough route with an object-shaped data block
//
//   "data": { "tool": "artifact_materialize", "agent_run_id": "{{ cinatra_run_id }}",
//     "input": {
//       "extension": "@cinatra-ai/blog-post-artifact",  // LITERAL, ∈ cinatra.produces
//       "content": "{{ draft }}",                        // flow variable
//       "title": "{{ title }}",                          // flow variable
//       "declaredMime": "text/markdown",                 // LITERAL, text-authorable
//       "node_id": "<this ApiNode's id>",                // LITERAL — ledger identity
//       "contentJsonField": "body"                       // optional LITERAL: parse-then-project
//     } }
//
// The host materializes through the SAME core + idempotency ledger as the
// run-completion path (`path:'materialize_tool'`, ledger `output_id` = the
// calling node id). This collector is the compile-time validator: statics
// only (grammar + produces parity); registry checks (extension installed,
// accepts) stay at run time, exactly like the EndNode bindings above.
// ---------------------------------------------------------------------------

export const ARTIFACT_MATERIALIZE_TOOL = "artifact_materialize";

/** URL marker identifying the deterministic passthrough route. */
export const AGENTS_PASSTHROUGH_URL_MARKER = "/api/agents/passthrough";

export type CollectedArtifactMaterializeNode = {
  /** The calling ApiNode's component id — the ledger `output_id` identity. */
  nodeId: string;
  extension: string;
  declaredMime: string;
  /** OPTIONAL declared-type discriminator (cinatra#1454) — the exact
   *  `@scope/pkg:local-id` the tool materializes into; resolved the same way as
   *  an EndNode binding (single-artifact-safe-type fallback else fail-closed). */
  objectTypeId?: string;
};

export type CollectArtifactMaterializeNodesResult = {
  /** Fully valid materialize nodes only. */
  nodes: CollectedArtifactMaterializeNode[];
  /** Human-readable errors, one per invalid node/field. */
  errors: string[];
};

/** A `{{ ... }}` placeholder makes a value runtime-templated — not a literal. */
function isTemplated(value: string): boolean {
  return value.includes("{{");
}

function walkPassthroughApiNodes(
  doc: Record<string, unknown>,
  visit: (node: Record<string, unknown>, refKey: string, path: string) => void,
): void {
  function go(value: unknown, refKey: string, path: string): void {
    if (!isPlainObject(value)) return;
    if (value.component_type === "ApiNode") {
      const url = value.url;
      if (typeof url === "string" && url.includes(AGENTS_PASSTHROUGH_URL_MARKER)) {
        visit(value, refKey, path);
      }
    }
    const refs = value.$referenced_components;
    if (isPlainObject(refs)) {
      for (const [k, v] of Object.entries(refs)) {
        go(v, k, `${path}.$referenced_components.${k}`);
      }
    }
    // Subflow on a FlowNode.
    if (isPlainObject(value.subflow)) {
      go(value.subflow, refKey, `${path}.subflow`);
    }
  }
  go(doc, "$", "$");
}

/**
 * Collect + validate every `artifact_materialize` passthrough ApiNode of an
 * OAS document (top-level components AND FlowNode subflows — the tool fires
 * mid-flow, so unlike EndNode bindings there is no top-level-only scoping).
 *
 * Fail-closed statics (codex round 0 of the #925 lane):
 *   - `data.tool` on ANY passthrough-route ApiNode must be a LITERAL string —
 *     a templated/dynamic tool selection cannot be compile-validated and
 *     could resolve to `artifact_materialize` at run time unvalidated;
 *   - string-shaped `data` is accepted only when it parses to a JSON object
 *     (then validated identically); an unparseable string mentioning the
 *     tool is rejected;
 *   - `input.node_id` must be a LITERAL equal to the ApiNode's own component
 *     id — it is the idempotency-ledger `output_id`; a free-form literal
 *     would let two distinct materialize nodes share one ledger identity and
 *     silently collapse same-byte outputs into one artifact;
 *   - `input.extension` / `input.declaredMime` / `input.contentJsonField`
 *     must be LITERAL (extension additionally ∈ `produces` when the produces
 *     set is known — same fail-closed parity semantics as the EndNode
 *     bindings: an empty known set rejects; only null/unknown skips);
 *   - `input.content` / `input.title` must be present non-empty strings
 *     (flow-variable placeholders expected).
 */
export function collectArtifactMaterializeNodesFromOasDocument(
  doc: Record<string, unknown>,
  opts?: {
    produces?: readonly string[] | null;
    /** Full typed `produces` entries (cinatra#1454) — see the binding collector. */
    producesRefs?: readonly SemanticArtifactProducesRef[] | null;
  },
): CollectArtifactMaterializeNodesResult {
  const nodes: CollectedArtifactMaterializeNode[] = [];
  const errors: string[] = [];
  const producesNames: readonly string[] | null =
    opts?.produces ??
    (opts?.producesRefs != null ? opts.producesRefs.map((r) => r.extension) : null);

  walkPassthroughApiNodes(doc, (node, refKey, path) => {
    const nodeId =
      typeof node.id === "string" && node.id.length > 0 ? node.id : refKey;
    const where = `${path} (ApiNode "${nodeId}")`;

    let data: unknown = node.data;
    if (typeof data === "string") {
      // The fleet authors object-shaped data blocks; a JSON string is
      // statically equivalent when it parses.
      try {
        const parsed: unknown = JSON.parse(data);
        if (isPlainObject(parsed)) data = parsed;
      } catch {
        // fall through — handled below
      }
      if (typeof data === "string") {
        // FAIL CLOSED on ANY string data block that does not parse to an
        // object (codex round 1): a fully-templated block (e.g.
        // "{{ passthrough_payload }}") could resolve to an
        // artifact_materialize call at run time with every static check
        // skipped. The fleet authors object-shaped blocks, so nothing
        // existing reddens.
        errors.push(
          `${where}.data: a passthrough data block must be object-shaped (or a ` +
            "parseable JSON string) so the tool selection is statically validatable " +
            `(got a non-JSON string)`,
        );
        return;
      }
    }
    if (!isPlainObject(data)) return; // no data block — cannot select a tool

    const tool = data.tool;
    if (typeof tool !== "string" || tool.length === 0 || isTemplated(tool)) {
      errors.push(
        `${where}.data.tool: passthrough tool selection must be a literal string ` +
          `(got ${JSON.stringify(tool)}) — a templated/dynamic tool cannot be compile-validated`,
      );
      return;
    }
    if (tool !== ARTIFACT_MATERIALIZE_TOOL) return;

    const input = data.input;
    if (!isPlainObject(input)) {
      errors.push(
        `${where}.data.input: required object with {extension, content, declaredMime, title, node_id}`,
      );
      return;
    }

    let valid = true;
    const fieldError = (field: string, message: string): void => {
      errors.push(`${where}.data.input.${field}: ${message}`);
      valid = false;
    };

    const extension = input.extension;
    if (typeof extension !== "string" || extension.length === 0 || isTemplated(extension)) {
      fieldError(
        "extension",
        `must be a literal artifact-extension package name (got ${JSON.stringify(extension)})`,
      );
    } else if (producesNames != null && !producesNames.includes(extension)) {
      fieldError(
        "extension",
        `"${extension}" is not declared in package.json cinatra.produces ` +
          `([${producesNames.join(", ")}]) — declared production and materialization must agree`,
      );
    }

    // OPTIONAL objectTypeId discriminator (cinatra#1454): literal, namespaced,
    // and — when the manifest declares a TYPED produces entry for this
    // extension — in AGREEMENT with it (may narrow a coarse entry, never
    // contradict a typed one). Mirrors the EndNode-binding grammar.
    const objectTypeId = input.objectTypeId;
    if (objectTypeId !== undefined) {
      if (
        typeof objectTypeId !== "string" ||
        objectTypeId.length === 0 ||
        isTemplated(objectTypeId) ||
        !BINDING_OBJECT_TYPE_ID_RE.test(objectTypeId)
      ) {
        fieldError(
          "objectTypeId",
          `when present, must be a literal namespaced object type id (@scope/package:local-id) (got ${JSON.stringify(objectTypeId)})`,
        );
      } else if (typeof extension === "string") {
        const producesType = producesObjectTypeIdForExtension(opts?.producesRefs, extension);
        if (producesType != null && producesType !== objectTypeId) {
          fieldError(
            "objectTypeId",
            `"${objectTypeId}" contradicts the typed cinatra.produces entry for "${extension}" ` +
              `(declares type "${producesType}") — narrowing a coarse entry is allowed, contradicting a typed one is not`,
          );
        }
      }
    }

    const declaredMime = input.declaredMime;
    if (
      typeof declaredMime !== "string" ||
      declaredMime.length === 0 ||
      isTemplated(declaredMime)
    ) {
      fieldError(
        "declaredMime",
        `must be a literal MIME type (got ${JSON.stringify(declaredMime)})`,
      );
    } else if (!ARTIFACT_BINDING_AUTHORABLE_MIMES.has(declaredMime)) {
      fieldError(
        "declaredMime",
        `"${declaredMime}" is not text-authorable; allowed: ` +
          `${[...ARTIFACT_BINDING_AUTHORABLE_MIMES].join(", ")} (binary artifacts ` +
          "use the upload/template paths)",
      );
    }

    for (const field of ["content", "title"] as const) {
      const value = input[field];
      if (typeof value !== "string" || value.length === 0) {
        fieldError(
          field,
          `must be a non-empty string (a flow-variable placeholder such as "{{ ${field} }}")`,
        );
      }
    }

    const declaredNodeId = input.node_id;
    if (
      typeof declaredNodeId !== "string" ||
      declaredNodeId.length === 0 ||
      isTemplated(declaredNodeId)
    ) {
      fieldError(
        "node_id",
        `must be a literal string equal to this ApiNode's id ("${nodeId}") — ` +
          `it is the idempotency-ledger output identity (got ${JSON.stringify(declaredNodeId)})`,
      );
    } else if (declaredNodeId !== nodeId) {
      fieldError(
        "node_id",
        `"${declaredNodeId}" must equal this ApiNode's id ("${nodeId}") — two ` +
          "materialize nodes sharing one ledger identity would silently collapse " +
          "same-byte outputs into one artifact",
      );
    }

    const contentJsonField = input.contentJsonField;
    if (contentJsonField !== undefined) {
      if (
        typeof contentJsonField !== "string" ||
        contentJsonField.length === 0 ||
        isTemplated(contentJsonField)
      ) {
        fieldError(
          "contentJsonField",
          `when present, must be a literal field name (got ${JSON.stringify(contentJsonField)})`,
        );
      }
    }

    if (valid) {
      nodes.push({
        nodeId,
        extension: extension as string,
        declaredMime: declaredMime as string,
        ...(typeof objectTypeId === "string" ? { objectTypeId } : {}),
      });
    }
  });

  return { nodes, errors };
}
