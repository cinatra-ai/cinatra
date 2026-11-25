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
// A FAN-OUT binding (cinatra#3034, plan item 0.27) annotates an ARRAY output
// whose members are plain strings and materializes ONE artifact per member:
//
//   "outputs": [{ "title": "ideas", "type": "array",
//     "json_schema": { "items": { "type": "string" } },
//     "cinatra": { "artifact": {
//       "extension": "@cinatra-ai/blog-idea-artifact",
//       "contentFrom": "ideas",                        // the annotated list itself
//       "declaredMime": "text/plain",
//       "fanOut": { "mode": "member", "titleFrom": "first-line", "titlePrefix": "Title:" }
//     }}}]
//
// It carries NO run-level `titleFrom` — a set has no single title — and each
// member's title is read from that member's own first line behind the declared
// prefix. The member level must be DECLARED (`json_schema.items.type`) and must
// be a plain string: a bound list never leaves its members undeclared, and the
// first-line road never dissects an object member into a title.
//
// A MEMBER-FIELD fan-out (cinatra#3732) is the second road, for a list of
// STRUCTURED items (a feed's episodes, one JSON object per member):
//
//   "outputs": [{ "title": "episodes", "type": "array",
//     "json_schema": { "items": { "type": "object",
//       "properties": { "title": { "type": "string" }, ... } } },
//     "cinatra": { "artifact": {
//       "extension": "@cinatra-ai/podcast-artifacts",
//       "contentFrom": "episodes",
//       "declaredMime": "application/json",
//       "fanOut": { "mode": "member", "titleFrom": "member-field", "titleField": "title" }
//     }}}]
//
// Each member must be a DECLARED object (`json_schema.items.type` "object") and
// is filed unchanged as its own JSON body (the static MIME "application/json");
// its title is the value of the member field the binding names, which the list
// must declare as a string. A title is still never invented: a member without
// a non-empty string in that field fails alone. An empty list files nothing and
// fails nothing — for a feed, nothing new is a normal result.
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

/**
 * A fanned-out member takes the ledger identity `${output}[${index}]`
 * (run-artifact-materializer). An output that carries that shape in its OWN
 * name would share the ledger's (run, output, extension, content-hash)
 * identity with a member of a sibling fan-out, so the shape is RESERVED: a
 * bound output may never be named that way.
 */
export const FAN_OUT_MEMBER_IDENTITY_RE = /\[\d+\]$/;

/**
 * The fan-out block of a binding (cinatra#3034, plan item 0.27). `mode` is
 * `member` — one artifact per member of the bound array. `titleFrom` picks the
 * title source, and a title is never invented and never taken from a sibling
 * output:
 *   - `first-line` — the member's own first line, behind `titlePrefix`, IS the
 *     title (a list of plain-text members);
 *   - `member-field` (cinatra#3732) — the value of the member's own field named
 *     by `titleField` IS the title (a list of object members, each filed
 *     unchanged as its own JSON body).
 */
export const artifactFanOutSchema = z.discriminatedUnion("titleFrom", [
  z
    .object({
      mode: z.literal("member"),
      titleFrom: z.literal("first-line"),
      /** Literal marker the member's first line must open with; stripped from the title. */
      titlePrefix: z.string().min(1),
    })
    .strict(),
  z
    .object({
      mode: z.literal("member"),
      titleFrom: z.literal("member-field"),
      /** The member's own field whose string value is the title. */
      titleField: z.string().min(1),
    })
    .strict(),
]);

export type ArtifactOutputFanOut = z.infer<typeof artifactFanOutSchema>;

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
    /** EndNode output name that carries the artifact CONTENT. One of the three
     *  content sources — XOR `fileFrom` / `filePattern` (cinatra#3030). */
    contentFrom: z.string().min(1).optional(),
    /**
     * THE FILE CONTENT SOURCE (cinatra#3030, plan item 0.22): the path, relative
     * to the run's `outputs` folder, of ONE file the run emitted. XOR
     * `contentFrom` / `filePattern`.
     *
     * A file source names bytes the agent WROTE rather than a value it
     * returned, so it titles itself (the file's own name, or its first line
     * behind `titleFromFirstLine`) and never carries `titleFrom`.
     */
    fileFrom: z.string().min(1).optional(),
    /**
     * THE FILE FAN-OUT (cinatra#3030, plan item 0.27): one artifact per file of
     * the run's `outputs` folder matching this pattern. `*` matches any run of
     * characters inside one path segment, `**` crosses segments, `?` matches
     * one character. XOR `contentFrom` / `fileFrom`.
     */
    filePattern: z.string().min(1).optional(),
    /**
     * A file-sourced binding's title comes from the file's FIRST LINE rather
     * than its name (item 0.27: "a title comes from a declared member field,
     * the first line of a text member, or the file name"). Only legal on a file
     * source; a file whose first line is empty falls back to the file's name,
     * which is always something the agent itself chose.
     */
    titleFromFirstLine: z.boolean().optional(),
    /** Static MIME. XOR `mimeFrom`. Must be text-authorable (v1). */
    declaredMime: z.string().min(1).optional(),
    /** EndNode output name that carries the MIME at run time. XOR `declaredMime`. */
    mimeFrom: z.string().min(1).optional(),
    /**
     * EndNode output name that carries the artifact TITLE. Required on a
     * SCALAR binding; forbidden on a fan-out one (XOR with `fanOut`), where
     * each member supplies its own title.
     */
    titleFrom: z.string().min(1).optional(),
    /**
     * Fan-out over the members of the bound ARRAY output (cinatra#3034).
     * Present → one artifact per member; absent → the scalar binding.
     */
    fanOut: artifactFanOutSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    // ---- EXACTLY ONE CONTENT SOURCE (cinatra#3030, item 0.22) -------------
    // An output value, one named file, or a file pattern. Two sources would
    // make "what are these bytes" unanswerable, and none binds nothing.
    const contentSources = (
      [
        ["contentFrom", value.contentFrom],
        ["fileFrom", value.fileFrom],
        ["filePattern", value.filePattern],
      ] as ReadonlyArray<readonly [string, string | undefined]>
    ).filter(([, v]) => v !== undefined);
    if (contentSources.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          contentSources.length === 0
            ? "exactly one content source is required: contentFrom, fileFrom or filePattern"
            : `exactly one content source is allowed; this binding declares ${contentSources
                .map(([k]) => k)
                .join(" and ")}`,
      });
    }
    const isFileSource = value.fileFrom !== undefined || value.filePattern !== undefined;

    const hasDeclared = value.declaredMime !== undefined;
    const hasFrom = value.mimeFrom !== undefined;
    if (isFileSource) {
      // A FILE MAY LEAVE ITS FORM TO THE LADDER. `mimeFrom` names an EndNode
      // output, which a file source does not read, so it is refused outright
      // rather than silently ignored.
      if (hasFrom) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["mimeFrom"],
          message:
            "a file-sourced binding may not carry mimeFrom — declare declaredMime, or leave the form to the detection ladder",
        });
      }
    } else if (hasDeclared === hasFrom) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "exactly one of declaredMime / mimeFrom is required",
      });
    }

    const hasTitleFrom = value.titleFrom !== undefined;
    const hasFanOut = value.fanOut !== undefined;
    if (isFileSource) {
      // A FILE TITLES ITSELF (item 0.27). `titleFrom` names an output the file
      // source never reads, and `fanOut` fans a LIST out — a file pattern is
      // already the file fan-out.
      if (hasTitleFrom) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["titleFrom"],
          message:
            "a file-sourced binding must not carry titleFrom — the file's own name, or its first line behind titleFromFirstLine, is the title",
        });
      }
      if (hasFanOut) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["fanOut"],
          message:
            "a file-sourced binding must not carry fanOut — filePattern IS the file fan-out",
        });
      }
    } else {
      if (value.titleFromFirstLine !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["titleFromFirstLine"],
          message:
            "titleFromFirstLine is only meaningful on a file source (fileFrom / filePattern)",
        });
      }
      if (hasTitleFrom === hasFanOut) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: hasFanOut
            ? "a fan-out binding must not carry titleFrom — each member's title comes from its own first line"
            : "titleFrom is required (or declare fanOut, whose members title themselves)",
        });
      }
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
 * An ApiNode's `data` as an object, the ONE reading of it: the object itself,
 * or the JSON text of an object (the fleet authors objects; a JSON string is
 * statically equivalent when it parses). Anything else (text that is not JSON,
 * JSON text of an array, a string, null or a number, or no data) is not a data
 * block and reads as null. The compile collectors, the list-node reading and
 * the run materializer's reading of which node writes all use it, so that they
 * cannot disagree on what a node's data is (cinatra#3089).
 */
export function readApiNodeDataObject(raw: unknown): Record<string, unknown> | null {
  if (isPlainObject(raw)) return raw;
  if (typeof raw !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
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

      // The member-identity shape is reserved (see
      // FAN_OUT_MEMBER_IDENTITY_RE): a bound output named `x[0]` would alias a
      // fanned-out member of `x` in the materialization ledger.
      if (FAN_OUT_MEMBER_IDENTITY_RE.test(title)) {
        errors.push(
          `${where}: a bound output may not be named "${title}" — a trailing ` +
            "[index] is reserved for the members of a fanned-out list",
        );
        continue;
      }

      let referenceError = false;
      for (const [field, ref] of [
        // A FILE-SOURCED binding reads no output, so it names none to check
        // (cinatra#3030): its content source is a path in the run's outputs
        // folder, which only exists at run time.
        ...(binding.contentFrom !== undefined
          ? ([["contentFrom", binding.contentFrom]] as const)
          : []),
        ...(binding.titleFrom !== undefined
          ? ([["titleFrom", binding.titleFrom]] as const)
          : []),
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

      // ------------------------------------------------------------------
      // Fan-out member-shape disclosure (cinatra#3034, plan item 0.27). The
      // fan-out binds the ANNOTATED list itself, that list is an array, and
      // its member level is DECLARED: a plain string on the first-line road,
      // so a member is never an object the host would have to dissect; an
      // object declaring its string title field on the member-field road
      // (cinatra#3732), filed unchanged as its own JSON body.
      // ------------------------------------------------------------------
      if (binding.fanOut !== undefined) {
        if (binding.contentFrom !== title) {
          errors.push(
            `${where}.contentFrom: a fan-out binding must name its OWN output ` +
              `("${title}"), not "${binding.contentFrom}" — the annotated list IS the fanned-out list`,
          );
          continue;
        }
        if (outputRaw.type !== "array") {
          errors.push(
            `${where}: fanOut requires an output of type "array" (output "${title}" ` +
              `declares type "${String(outputRaw.type ?? "<none>")}")`,
          );
          continue;
        }
        const schema = isPlainObject(outputRaw.json_schema)
          ? (outputRaw.json_schema as Record<string, unknown>)
          : null;
        const items = schema !== null && isPlainObject(schema.items)
          ? (schema.items as Record<string, unknown>)
          : null;
        if (items === null) {
          errors.push(
            `${where}: the bound list "${title}" leaves its member level undeclared ` +
              "(json_schema.items) — a bound structured list declares its members",
          );
          continue;
        }
        if (binding.fanOut.titleFrom === "member-field") {
          // One error per violation, each naming the output.
          const memberFieldErrors: string[] = [];
          const titleField = binding.fanOut.titleField;
          if (items.type !== "object") {
            memberFieldErrors.push(
              `${where}: a member-field fanOut requires declared object members ` +
                `(json_schema.items.type "object"; "${title}" declares "${String(items.type ?? "<none>")}")`,
            );
          } else {
            const properties = isPlainObject(items.properties)
              ? (items.properties as Record<string, unknown>)
              : null;
            const field =
              properties !== null &&
              Object.prototype.hasOwnProperty.call(properties, titleField) &&
              isPlainObject(properties[titleField])
                ? (properties[titleField] as Record<string, unknown>)
                : null;
            if (field === null) {
              memberFieldErrors.push(
                `${where}.fanOut.titleField: "${titleField}" is not a declared property of the ` +
                  `members of "${title}" (json_schema.items.properties) — the title is read from a field the list declares`,
              );
            } else if (field.type !== "string") {
              memberFieldErrors.push(
                `${where}.fanOut.titleField: the title field "${titleField}" must be declared type "string" ` +
                  `("${title}" declares "${String(field.type ?? "<none>")}")`,
              );
            }
          }
          if (binding.declaredMime !== "application/json") {
            memberFieldErrors.push(
              `${where}.declaredMime: a member-field fanOut files each member as its own JSON body — ` +
                `the MIME must be the static "application/json" (${
                  binding.declaredMime === undefined
                    ? `the binding declares mimeFrom "${String(binding.mimeFrom)}"`
                    : `the binding declares "${binding.declaredMime}"`
                })`,
            );
          }
          if (memberFieldErrors.length > 0) {
            errors.push(...memberFieldErrors);
            continue;
          }
        } else if (items.type !== "string") {
          errors.push(
            `${where}: fanOut members must be declared plain string members ` +
              `(json_schema.items.type "string"; "${title}" declares "${String(items.type ?? "<none>")}")`,
          );
          continue;
        }
      }

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
// The LIST MODE (cinatra#3089) replaces `title` with two LITERALS,
// `memberContentField` and `memberTitleField`: `content` is then a JSON array
// and the call files one artifact per member, in order, under this node.
//
// The host materializes through the SAME core + idempotency ledger as the
// run-completion path (`path:'materialize_tool'`, ledger `output_id` = the
// calling node id). This collector is the compile-time validator: statics
// only (grammar + produces parity); registry checks (extension installed,
// accepts) stay at run time, exactly like the EndNode bindings above.
// ---------------------------------------------------------------------------

export const ARTIFACT_MATERIALIZE_TOOL = "artifact_materialize";

/**
 * cinatra#3089 — the LIST MODE of `artifact_materialize` and its response
 * fields, ONE definition for the compile check (this file) and the passthrough
 * route, which imports it. A call is a list call when its input names a member
 * content field or a member title field; the call files one artifact per member
 * and so has no single id to answer under the node's `result_id_field`. The
 * route refuses that pair before anything is filed; the compile check refuses
 * it so that a flow which can never run does not compile.
 */
export const MATERIALIZE_LIST_RESULT_ID_FIELD_CODE = "materialize_list_result_id_field";
export const MATERIALIZE_LIST_RESULT_ID_FIELD_MESSAGE =
  "artifact_materialize: a list call files one artifact per member and has no single id; " +
  "remove result_id_field and read artifacts (or reviewTargets) from the answer";

export const MATERIALIZE_LIST_MEMBER_FIELDS_EQUAL_CODE = "materialize_list_member_fields_equal";
export const MATERIALIZE_LIST_MEMBER_FIELDS_EQUAL_MESSAGE =
  "artifact_materialize: memberContentField and memberTitleField name the same member field; " +
  "a title that is the whole body is not a filing, name two fields; nothing was filed";

/** The refusal for a list call whose title field and content field are the SAME member field (read as written, never trimmed), or null. */
export function materializeListMemberFieldsEqualRefusal(
  input: Record<string, unknown>,
): { code: typeof MATERIALIZE_LIST_MEMBER_FIELDS_EQUAL_CODE; message: string } | null {
  const content = input.memberContentField;
  return typeof content === "string" && content === input.memberTitleField
    ? { code: MATERIALIZE_LIST_MEMBER_FIELDS_EQUAL_CODE, message: MATERIALIZE_LIST_MEMBER_FIELDS_EQUAL_MESSAGE }
    : null;
}

// THE TYPED DATA OF LIST MEMBERS (cinatra#3089). A list call may store typed
// data on every artifact it files, so that a body carries the correlation the
// steps after it read (who it is for, which campaign it belongs to) in its
// object's own data. Three literal inputs, ONE reading of them for the compile
// check, the passthrough route and the shaper, and ONE refusal code:
//   - `memberDataFields`: names of member fields, each copied into that
//     member's data (the member supplies the value);
//   - `memberData`: an object of call-wide values the HOST stamps on every
//     member (a member that carries a field of the same name is refused, so a
//     model-written member cannot set it);
//   - `memberRunIdField`: the name of a field the host fills with the CALLING
//     RUN's id, never one the caller supplies.
// Names follow the rule of the title and content fields (a non-blank string with
// no surrounding whitespace, never a template) and are refused when they are
// `__proto__`, a writer-owned field of the stored object, a title or content
// field, or used twice. At most 8 typed fields in all; a value is a non-blank
// string of at most 512 characters once trimmed (stored trimmed, as the title is
// and as the send's own body stores its contact).

export const MATERIALIZE_LIST_DATA_CODE = "materialize_list_data_declaration";
export const MATERIALIZE_LIST_DATA_MAX_FIELDS = 8;
export const MATERIALIZE_LIST_DATA_MAX_VALUE_CHARS = 512;

/** The fields the creation path writes over a caller's typed data (`artifact-creation.ts`, the object's data
 *  is `{ ...typedData, <these> }`): a caller can add to the object and never restate them. A drift test
 *  compares this list with that block. */
export const MATERIALIZE_LIST_ENVELOPE_FIELDS: readonly string[] = [
  "artifactType",
  "latestRepresentationRevisionId",
  "latestDigest",
  "mime",
  "size",
  "originKind",
  "viewerHint",
  "title",
];

export type MaterializeListDataDeclaration = {
  /** Member fields copied into each member's data. */
  fields: string[];
  /** Call-wide values stamped on every member by the host. */
  fixed: Record<string, string>;
  /** The field the host fills with the calling run's id, or null. */
  runIdField: string | null;
  /** The bound of a value, for the member values the shaper reads. */
  maxValueChars: number;
};

export type MaterializeListDataRead =
  | ({ ok: true } & MaterializeListDataDeclaration)
  | { ok: false; code: typeof MATERIALIZE_LIST_DATA_CODE; field: string; message: string };

const MATERIALIZE_LIST_DATA_INPUTS = ["memberDataFields", "memberData", "memberRunIdField"] as const;

/** Reads the typed-data inputs of an `artifact_materialize` input (as authored, or as the route receives it).
 *  A call without them reads as an empty declaration; on a call that is not a list call they are refused. */
export function readMaterializeListDataDeclaration(input: Record<string, unknown>): MaterializeListDataRead {
  const refuse = (field: string, why: string): MaterializeListDataRead => ({
    ok: false,
    code: MATERIALIZE_LIST_DATA_CODE,
    field,
    message: `artifact_materialize: ${field} is not valid (${why}); nothing was filed`,
  });
  const empty: MaterializeListDataRead = { ok: true, fields: [], fixed: {}, runIdField: null, maxValueChars: MATERIALIZE_LIST_DATA_MAX_VALUE_CHARS };
  const present = MATERIALIZE_LIST_DATA_INPUTS.filter((k) => input[k] !== undefined);
  if (present.length === 0) return empty;
  if (!isArtifactMaterializeListInput(input)) {
    return refuse(present[0]!, "only a list call (memberContentField + memberTitleField) takes typed member data");
  }
  const titleField = input.memberTitleField;
  const contentField = input.memberContentField;
  const used = new Set<string>();
  const nameProblem = (name: unknown): string | null => {
    if (typeof name !== "string" || name.trim().length === 0 || name !== name.trim() || isTemplated(name)) {
      return "a name must be a literal field name with no surrounding whitespace";
    }
    if (name === "__proto__") return "a name may not be __proto__";
    if (MATERIALIZE_LIST_ENVELOPE_FIELDS.includes(name)) return "a name may not be a field the writer owns";
    if (name === titleField || name === contentField) return "a name may not be the title field or the content field";
    if (used.has(name)) return "a name may be used once";
    used.add(name);
    return null;
  };

  const fields: string[] = [];
  const rawFields = input.memberDataFields;
  if (rawFields !== undefined) {
    if (!Array.isArray(rawFields)) return refuse("memberDataFields", "must be an array of field names");
    for (const name of rawFields) {
      const problem = nameProblem(name);
      if (problem !== null) return refuse("memberDataFields", problem);
      fields.push(name as string);
    }
  }

  const fixed: Record<string, string> = {};
  const rawFixed = input.memberData;
  if (rawFixed !== undefined) {
    if (!isPlainObject(rawFixed)) return refuse("memberData", "must be an object of field names and string values");
    for (const [name, value] of Object.entries(rawFixed)) {
      const problem = nameProblem(name);
      if (problem !== null) return refuse("memberData", problem);
      if (typeof value !== "string" || value.trim().length === 0 || value.trim().length > MATERIALIZE_LIST_DATA_MAX_VALUE_CHARS) {
        return refuse("memberData", `a value must be a non-blank string of at most ${MATERIALIZE_LIST_DATA_MAX_VALUE_CHARS} characters`);
      }
      fixed[name] = value.trim();
    }
  }

  let runIdField: string | null = null;
  if (input.memberRunIdField !== undefined) {
    const problem = nameProblem(input.memberRunIdField);
    if (problem !== null) return refuse("memberRunIdField", problem);
    runIdField = input.memberRunIdField as string;
  }

  if (used.size > MATERIALIZE_LIST_DATA_MAX_FIELDS) {
    return refuse(present[0]!, `at most ${MATERIALIZE_LIST_DATA_MAX_FIELDS} typed fields in all`);
  }
  return { ok: true, fields, fixed, runIdField, maxValueChars: MATERIALIZE_LIST_DATA_MAX_VALUE_CHARS };
}

/** Whether an `artifact_materialize` input (as authored, or as the route receives it) is a list call. */
export function isArtifactMaterializeListInput(input: Record<string, unknown>): boolean {
  return input.memberContentField !== undefined || input.memberTitleField !== undefined;
}

/** The refusal for a list call whose node also names `result_id_field` (any value: the route reads it by presence), or null. */
export function materializeListResultIdFieldRefusal(
  input: Record<string, unknown>,
  resultIdField: unknown,
): { code: typeof MATERIALIZE_LIST_RESULT_ID_FIELD_CODE; message: string } | null {
  return isArtifactMaterializeListInput(input) && resultIdField !== undefined
    ? { code: MATERIALIZE_LIST_RESULT_ID_FIELD_CODE, message: MATERIALIZE_LIST_RESULT_ID_FIELD_MESSAGE }
    : null;
}

/** The host's image tool on the passthrough route (cinatra#3032): a prompt in, a
 *  picture filed under the extension the call names. */
export const ARTIFACT_IMAGE_TOOL = "artifact_image_generate";

/** The host's page capture tool on the passthrough route (cinatra#4223): a page
 *  url in, a PNG of that page filed under the extension the call names. */
export const ARTIFACT_PAGE_CAPTURE_TOOL = "artifact_page_capture";

/** The filing tools the image-node collector recognizes, each with the string
 *  inputs that tool trims and refuses when blank. A Map, so a `data.tool` such
 *  as "constructor" never reads a prototype member. */
const FILING_TOOL_REQUIRED_TEXT = new Map<string, readonly string[]>([
  [ARTIFACT_IMAGE_TOOL, ["title", "prompt"]],
  [ARTIFACT_PAGE_CAPTURE_TOOL, ["title", "url"]],
]);

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

    const data = readApiNodeDataObject(node.data);
    if (data === null) {
      if (typeof node.data === "string") {
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
      return; // no data block — cannot select a tool
    }

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

    // THE SAME-ARTIFACT REVISION'S CALL GRAMMAR (cinatra#3030, item 0.30). A
    // call that names an existing artifact AND the revision it read APPENDS the
    // next revision instead of creating a second artifact. The pair is together
    // or not at all — an append that does not name what it read cannot be
    // checked, and a base without an artifact names nothing — and an append
    // carries no title: the artifact already has the one its creator gave it.
    // Without this the runtime accepts an append the compiler refuses, which
    // makes the road unreachable from a published package.
    const hasArtifactId = input.artifactId !== undefined;
    const hasBase = input.baseRepresentationRevisionId !== undefined;
    if (hasArtifactId !== hasBase) {
      fieldError(
        hasArtifactId ? "baseRepresentationRevisionId" : "artifactId",
        "an append names the artifact it revises AND the revision it read — " +
          "declare both (artifactId + baseRepresentationRevisionId) or neither",
      );
    }
    const isAppend = hasArtifactId && hasBase;

    // THE LIST MODE'S CALL GRAMMAR (cinatra#3089). `memberContentField` and
    // `memberTitleField` name, as LITERALS, the content and the title field of
    // each member of the JSON-array `content`; the call files one artifact per
    // member. Together or not at all, and never with an append, with
    // `contentJsonField` or with a top-level title (each member has its own).
    const hasMemberContent = input.memberContentField !== undefined;
    const hasMemberTitle = input.memberTitleField !== undefined;
    if (hasMemberContent !== hasMemberTitle) {
      fieldError(
        hasMemberContent ? "memberTitleField" : "memberContentField",
        "a list call names the content AND the title field of every member — " +
          "declare both (memberContentField + memberTitleField) or neither",
      );
    }
    const isList = isArtifactMaterializeListInput(input);
    for (const field of ["memberContentField", "memberTitleField"] as const) {
      const value = input[field];
      // The runtime reads the member property by exactly this name, so a blank
      // name (it names no property) or a padded one (it would not be the
      // property the author sees) is refused here, as the runtime refuses it.
      if (
        value !== undefined &&
        (typeof value !== "string" || value.trim().length === 0 || value !== value.trim() || isTemplated(value))
      ) {
        fieldError(
          field,
          `when present, must be a literal field name with no surrounding whitespace (got ${JSON.stringify(value)})`,
        );
      }
    }
    const equalNames = materializeListMemberFieldsEqualRefusal(input);
    if (equalNames !== null) fieldError("memberTitleField", equalNames.message);
    const typedData = readMaterializeListDataDeclaration(input);
    if (!typedData.ok) fieldError(typedData.field, typedData.message);
    if (isList) {
      for (const field of ["artifactId", "baseRepresentationRevisionId", "contentJsonField", "title"] as const) {
        if (input[field] !== undefined) {
          fieldError(
            field,
            "cannot be combined with a list call (memberContentField + memberTitleField) — " +
              "every member is a new artifact with its own title",
          );
        }
      }
    }

    // The node's response fields sit beside `input` in `data`, where the route
    // reads them; a list call answers no single id (the shared refusal above).
    const listRefusal = materializeListResultIdFieldRefusal(input, data.result_id_field);
    if (listRefusal !== null) {
      errors.push(`${where}.data.result_id_field: ${listRefusal.message}`);
      valid = false;
    }

    const requiredStrings = isAppend
      ? (["content", "artifactId", "baseRepresentationRevisionId"] as const)
      : isList
        ? (["content"] as const)
        : (["content", "title"] as const);
    for (const field of requiredStrings) {
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

/**
 * cinatra#3089: whether ONE component is an ApiNode whose `data` (an object, or
 * JSON text of one) is an `artifact_materialize` call in the LIST MODE, so that
 * one call files one artifact per member. It counts when it carries
 * `memberContentField` OR `memberTitleField` (the collector above refuses one
 * without the other; this reading fails closed on either), and whatever its
 * `url`. It reads the one component it is given, so the caller decides which
 * scope the component came from.
 */
export function isArtifactMaterializeListNode(node: unknown): boolean {
  return isPlainObject(node) && node.component_type === "ApiNode" && isArtifactMaterializeListData(node.data);
}

function isArtifactMaterializeListData(raw: unknown): boolean {
  const data = readApiNodeDataObject(raw);
  if (data === null || data.tool !== ARTIFACT_MATERIALIZE_TOOL || !isPlainObject(data.input)) return false;
  return isArtifactMaterializeListInput(data.input);
}

export type CollectedArtifactImageNode = {
  /** The calling ApiNode's component id — the ledger `output_id` identity. */
  nodeId: string;
  extension: string;
  objectTypeId?: string;
};

/**
 * cinatra#3035: collect every passthrough ApiNode that files a picture through
 * the host's image tool (`artifact_image_generate`) or, since cinatra#4223, its
 * page capture tool (`artifact_page_capture`) — the fourth
 * materialization road. Each tool refuses an extension the running package does
 * not declare in `cinatra.produces`, so a step that calls it with a literal,
 * declared extension and names itself as the ledger's node reaches that entry.
 *
 * Statics only, walked like the materialize collector (top-level components and
 * FlowNode subflows). A node counts ONLY when `data.tool` is one of the two
 * literal filing tools, `data.input` is an object, `input.extension` is a
 * literal the known produces list names (a null list skips the parity),
 * `input.node_id` is a literal equal to the node's own id, and `input.title` and
 * the tool's subject input (`input.prompt` for the image tool, `input.url` for
 * the page capture tool) are strings that are not blank once trimmed. A node that
 * does not meet them resolves nothing — there is no error list, so no package gains a finding; a
 * produces entry kept only by such a node stays refused by the existing
 * unmaterialized finding.
 */
export function collectArtifactImageNodesFromOasDocument(
  doc: Record<string, unknown>,
  opts?: { produces?: readonly string[] | null },
): { nodes: CollectedArtifactImageNode[] } {
  const nodes: CollectedArtifactImageNode[] = [];
  const producesNames: readonly string[] | null = opts?.produces ?? null;

  walkPassthroughApiNodes(doc, (node, refKey) => {
    const nodeId =
      typeof node.id === "string" && node.id.length > 0 ? node.id : refKey;

    const data = readApiNodeDataObject(node.data);
    if (data === null || typeof data.tool !== "string") return;
    const requiredText = FILING_TOOL_REQUIRED_TEXT.get(data.tool);
    if (requiredText === undefined) return;

    const input = data.input;
    if (!isPlainObject(input)) return;

    const extension = input.extension;
    if (typeof extension !== "string" || extension.length === 0 || isTemplated(extension)) {
      return;
    }
    if (producesNames != null && !producesNames.includes(extension)) return;

    const declaredNodeId = input.node_id;
    if (
      typeof declaredNodeId !== "string" ||
      isTemplated(declaredNodeId) ||
      declaredNodeId !== nodeId
    ) {
      return;
    }

    for (const field of requiredText) {
      const value = input[field];
      // The filing tool trims each one and refuses a blank one.
      if (typeof value !== "string" || value.trim().length === 0) return;
    }

    const objectTypeId = input.objectTypeId;
    nodes.push({
      nodeId,
      extension,
      ...(typeof objectTypeId === "string" &&
      objectTypeId.length > 0 &&
      !isTemplated(objectTypeId)
        ? { objectTypeId }
        : {}),
    });
  });

  return { nodes };
}

/**
 * cinatra#3035: the flow's control topology as the OAS compiler reads it — the
 * `control_flow_connections` adjacency (a repeated edge listed once) and the ids
 * reachable from `start_node`, in breadth-first order. `compileOasAgentJson`
 * numbers its approval steps from this order, so a reader that asks which nodes
 * execute, and in what order, reads the same one.
 */
export function readFlowControlTopology(doc: Record<string, unknown>): {
  adjacency: Map<string, string[]>;
  reachable: string[];
} {
  const adjacency = new Map<string, string[]>();
  const edges = Array.isArray(doc.control_flow_connections) ? doc.control_flow_connections : [];
  for (const edge of edges) {
    const e = edge as { from_node?: { $component_ref?: string }; to_node?: { $component_ref?: string } } | null;
    const fromId = e?.from_node?.$component_ref;
    const toId = e?.to_node?.$component_ref;
    if (!fromId || !toId) continue;
    if (!adjacency.has(fromId)) adjacency.set(fromId, []);
    const neighbors = adjacency.get(fromId)!;
    if (!neighbors.includes(toId)) neighbors.push(toId);
  }
  const startId = (doc.start_node as { $component_ref?: unknown } | null | undefined)?.$component_ref;
  const reachable: string[] = [];
  if (typeof startId !== "string") return { adjacency, reachable };
  const visited = new Set<string>();
  const queue: string[] = [startId];
  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    reachable.push(id);
    for (const n of adjacency.get(id) ?? []) if (!visited.has(n)) queue.push(n);
  }
  return { adjacency, reachable };
}

/**
 * The artifact-review marker exactly as the compiler puts it on an
 * InputMessageNode step (cinatra#1796): `metadata.cinatra.artifactReview.targetsInput`
 * when it is a non-empty string, otherwise undefined.
 */
export function readArtifactReviewTargetsInput(component: unknown): string | undefined {
  const raw = (component as
    | { metadata?: { cinatra?: { artifactReview?: { targetsInput?: unknown } } } }
    | null
    | undefined)?.metadata?.cinatra?.artifactReview?.targetsInput;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

// ---------------------------------------------------------------------------
// The EXECUTED artifact-binding declaration, persisted (cinatra#3208).
//
// Until #3208 the run-completion materializer re-derived a run's bindings by
// re-reading the PACKAGE REGISTRY for the run's (packageName, packageVersion)
// pair, while execution itself was bound to the immutable template-version
// snapshot installed on `agent_templates`. Two authorities, and nothing bound
// them together: when the registry's copy of a version diverged from the copy
// the template was compiled from, materialization resolved a declaration the
// run never executed and failed the run after all of the model work was done
// (the measured symptom: `titleFrom` output `ideaBatchTitle` did not resolve,
// named by a RETIRED scalar declaration, on a run whose executed declaration
// is the fan-out one).
//
// This is the serialized form of the declaration the compile that produced the
// installed template actually found — the normalized bindings plus the typed
// `cinatra.produces` refs they were validated against. It is persisted on
// `agent_templates.artifact_bindings` (JSON-as-text, the `gated_steps` /
// `lifecycle_config` convention) by every install/recompile writer, ALWAYS in
// the same write as `package_version` so the materializer's version-pin guard
// can trust the two together, and read back by the materializer INSTEAD of the
// registry.
//
// `null` (an absent column, or a value that does not survive the grammar
// below) is three-valued exactly as `has_artifact_bindings` is: unknown, fall
// through to the pre-#3208 registry read. A compile that could not see its
// sibling package.json also persists `null`, because binding-to-`produces`
// parity was then never established and the persisted set would be missing the
// typed produces refs the materializer resolves declared types through.
// ---------------------------------------------------------------------------

/** Serialized-form version tag — a grammar change bumps it and older rows read as unknown. */
export const ARTIFACT_BINDING_DECLARATION_VERSION = 1;

export const semanticArtifactProducesRefSchema = z
  .object({ extension: z.string().min(1), objectTypeId: z.string().min(1).optional() })
  .strict();

export const collectedArtifactBindingSchema = z
  .object({
    nodeId: z.string().min(1),
    outputId: z.string().min(1),
    binding: artifactOutputBindingSchema,
  })
  .strict();

export const persistedArtifactBindingDeclarationSchema = z
  .object({
    v: z.literal(ARTIFACT_BINDING_DECLARATION_VERSION),
    bindings: z.array(collectedArtifactBindingSchema),
    producesRefs: z.array(semanticArtifactProducesRefSchema),
  })
  .strict();

export type PersistedArtifactBindingDeclaration = {
  bindings: CollectedArtifactBinding[];
  producesRefs: SemanticArtifactProducesRef[];
};

/**
 * Serialize the executed declaration for the `agent_templates.artifact_bindings`
 * column. Deterministic (no wall-clock, fixed key order) so reinstalling the
 * same tarball writes a byte-identical value.
 */
export function serializeArtifactBindingDeclaration(
  declaration: PersistedArtifactBindingDeclaration,
): string {
  return JSON.stringify({
    v: ARTIFACT_BINDING_DECLARATION_VERSION,
    bindings: declaration.bindings.map((entry) => ({
      nodeId: entry.nodeId,
      outputId: entry.outputId,
      binding: entry.binding,
    })),
    producesRefs: declaration.producesRefs.map((ref) =>
      ref.objectTypeId === undefined
        ? { extension: ref.extension }
        : { extension: ref.extension, objectTypeId: ref.objectTypeId },
    ),
  });
}

/**
 * Parse a persisted declaration back. FAIL-CLOSED: anything that is not a
 * well-formed declaration of the CURRENT grammar version returns `null`
 * ("unknown"), and every caller then keeps its pre-#3208 behavior rather than
 * materializing against a half-understood declaration.
 */
export function parseArtifactBindingDeclaration(
  raw: string | null | undefined,
): PersistedArtifactBindingDeclaration | null {
  if (typeof raw !== "string" || raw.length === 0) return null;
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const parsed = persistedArtifactBindingDeclarationSchema.safeParse(json);
  if (!parsed.success) return null;
  return { bindings: parsed.data.bindings, producesRefs: parsed.data.producesRefs };
}

// ---------------------------------------------------------------------------
// THE FILE CONTENT SOURCE'S OWN HELPERS (cinatra#3030, epic #3023 W6; plan
// items 0.22 and 0.27). Pure, dependency-free, and shared by the host's pickup
// so the grammar and the road that reads it can never drift apart.
// ---------------------------------------------------------------------------

/** Every character a regular expression treats as syntax. */
const REGEX_META = /[.*+?^${}()|[\]\\]/g;

/**
 * Does one run-folder path match a binding's `filePattern`?
 *
 * The grammar is deliberately small: `**` crosses path segments, `*` matches a
 * run of characters WITHIN one segment, `?` matches exactly one such character,
 * and every other character is literal. The pattern is translated to an anchored
 * regular expression with every literal escaped first, so a pattern can never
 * smuggle regular-expression syntax of its own into the match.
 */
export function fileMatchesBindingPattern(pattern: string, relPath: string): boolean {
  if (typeof pattern !== "string" || pattern.length === 0) return false;
  if (typeof relPath !== "string" || relPath.length === 0) return false;
  let out = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        out += ".*";
        i += 2;
        continue;
      }
      out += "[^/]*";
      i += 1;
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      i += 1;
      continue;
    }
    out += ch.replace(REGEX_META, "\\$&");
    i += 1;
  }
  return new RegExp(`^${out}$`).test(relPath);
}

/**
 * A file's own name as its title — "a title comes from [...] the file name"
 * (item 0.27). The extension is kept: it is part of what the agent named the
 * file, and dropping it would make two files of the same stem one title.
 */
export function fileNameTitle(relPath: string): string {
  const segments = String(relPath).split("/");
  const name = segments[segments.length - 1] ?? "";
  return name.trim().length > 0 ? name.trim() : String(relPath);
}

/**
 * A text file's FIRST LINE as its title (item 0.27). Never invented: an empty
 * or whitespace-only first line returns the empty string and the caller falls
 * back to the file's name.
 */
export function firstLineTitle(text: string): string {
  const first = String(text).split("\n", 1)[0] ?? "";
  return first.replace(/^\uFEFF/, "").trim();
}
