/**
 * Structured-output support for `packages/llm` — BOTH halves of the same
 * concern, deliberately co-located in one dependency-free leaf:
 *
 *   1. REQUEST side — the per-provider JSON Schema constraint policy applied to
 *      `outputSchema` before it crosses the adapter boundary (cinatra#2339).
 *   2. RESPONSE side — `parseStructuredJson`, the provider-neutral extraction of
 *      a JSON object out of whatever text the model actually returned.
 *
 * They are two ends of one round trip and share every caller (the objects
 * classifier, the artifact matcher, the skill matcher all shape a schema on the
 * way out and parse the text on the way back), so keeping them together makes
 * the contract legible in one file.
 *
 * ---------------------------------------------------------------------------
 * 1. REQUEST SIDE — per-provider JSON Schema constraint policy
 * (`outputSchema`) — the single source of truth for "which JSON Schema
 * validation keywords may this provider's structured-output surface be handed".
 *
 * WHY THIS EXISTS (cinatra#2339). Anthropic's Messages API rejects a subset of
 * JSON Schema validation keywords inside `output_config.format.schema` with a
 * hard 400 (`output_config.format.schema: For 'number' type, properties
 * maximum, minimum are not supported`). `packages/llm` and every connector
 * adapter forward `outputSchema` VERBATIM, so any consumer whose schema carries
 * one of those keywords fails outright on an Anthropic-default instance — which
 * is exactly how un-hinted object classification broke (the classifier declares
 * `confidence: { type: "number", minimum: 0, maximum: 1 }`).
 *
 * The fix is per-provider sanitization at the core→adapter seam, NOT a
 * universally-weakened schema: providers that support a constraint keep
 * enforcing it, and Anthropic-bound requests carry a schema the API accepts.
 * The constraint itself is not silently lost — it is RESTATED as prose in the
 * subschema's `description`, a keyword every provider accepts, so the model
 * still receives the guidance. Hard enforcement remains the caller's post-parse
 * validation (the classifier's Zod `confidence: z.number().min(0).max(1)`, the
 * artifact matcher's `matcherResponseSchema`, the skill matcher's
 * `matchDecisionSchema`), which was always the authoritative check — the JSON
 * Schema was only ever a request-shaping hint.
 *
 * PROVENANCE OF THE ANTHROPIC POLICY BELOW — it is not copied from prose docs,
 * it is the result of a LIVE keyword matrix run against api.anthropic.com
 * (`claude-sonnet-4-6`, the anthropic adapter's fallback default model) on
 * 2026-08-03. Anthropic's published "structured outputs" limitations list is
 * BROADER than what the API actually rejects (it names `minLength`/`maxLength`
 * as unsupported; the live API accepts them), and stripping a keyword the API
 * accepts would needlessly weaken the schema. So this leaf encodes the OBSERVED
 * rejection set, not the documented one:
 *
 *   REJECTED (400) — number/integer: minimum, maximum, exclusiveMinimum,
 *                    exclusiveMaximum, multipleOf
 *                  - array:          maxItems, uniqueItems
 *                  - object:         minProperties, maxProperties
 *                  - string:         any `format` value outside
 *                                    {@link ANTHROPIC_SUPPORTED_STRING_FORMATS}
 *   ACCEPTED (200) — minLength, maxLength, pattern, minItems, description,
 *                    title, default, examples, enum, const, anyOf, $defs/$ref,
 *                    additionalProperties:false
 *
 * Rejection is RECURSIVE on Anthropic's side: a `minimum` nested under
 * `properties.x.properties.y`, under `items`, or inside `$defs` produces the
 * same 400 — hence the schema-aware recursive visitor below.
 *
 * CAVEAT, stated honestly: the matrix was run against ONE model. Anthropic's
 * accepted set is not contractually guaranteed to be identical across every
 * model an operator may configure. If a future model starts rejecting a
 * keyword this leaf currently allows, the fix is to re-run the matrix and
 * extend the set here — one edit, one place — not to widen it speculatively.
 *
 * Kept as a tiny dependency-free leaf (no `server-only`, no imports beyond the
 * provider type) so it is trivially unit-testable and carries no runtime cost
 * for providers with no policy.
 */

import type { LlmProvider } from "@cinatra-ai/sdk-extensions/llm-provider-contract";

/**
 * The `format` values Anthropic's structured-output schema compiler accepts on
 * a `type: "string"` subschema. Probed exhaustively; anything else (`url`,
 * `regex`, `int64`, `phone`, `binary`, `byte`, `json-pointer`, `iri`,
 * `idn-email`, …) is a 400.
 */
export const ANTHROPIC_SUPPORTED_STRING_FORMATS: readonly string[] = [
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
];

/**
 * The validation keywords Anthropic's structured-output schema compiler
 * rejects. See the provenance note above — observed, not documented.
 */
export const ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS: readonly string[] = [
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
];

/**
 * A provider's structured-output schema policy. A provider with NO entry in
 * {@link OUTPUT_SCHEMA_POLICIES} is left strictly alone — the sanitizer is a
 * verbatim pass-through (same object reference), so adding a provider can never
 * silently change its request bytes.
 */
type OutputSchemaPolicy = {
  /** Validation keywords to drop wherever they appear in a schema node. */
  readonly unsupportedKeywords: readonly string[];
  /** When present, `format` values outside this allowlist are dropped. */
  readonly supportedStringFormats?: readonly string[];
};

/**
 * OpenAI keeps its constraints — the Responses API `json_schema` surface
 * accepts them, which is the "OpenAI-bound behavior unchanged" guarantee,
 * enforced structurally by returning the SAME object reference.
 *
 * Gemini is DELIBERATELY absent, and not because it ignores the field: its
 * adapter forwards `outputSchema` into `generationConfig.responseJsonSchema`.
 * It gets no policy because no equivalent live keyword matrix has been run
 * against the Gemini API — inventing a speculative one would change Gemini's
 * request bytes on a guess. If Gemini is ever observed rejecting a keyword,
 * the fix is to probe it and add an entry here; until then it keeps today's
 * exact behavior.
 */
const OUTPUT_SCHEMA_POLICIES: Partial<Record<LlmProvider, OutputSchemaPolicy>> = {
  anthropic: {
    unsupportedKeywords: ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS,
    supportedStringFormats: ANTHROPIC_SUPPORTED_STRING_FORMATS,
  },
};

// ---------------------------------------------------------------------------
// Schema-aware traversal vocabulary
// ---------------------------------------------------------------------------
//
// A JSON Schema document mixes SCHEMA-valued keywords with INSTANCE-valued
// ones. Recursing blindly over every object would corrupt instance data: a
// schema `{ enum: [{ minimum: 3 }] }` describes a literal VALUE that happens to
// have a `minimum` key, and stripping it would change the accepted value set.
// So traversal is driven by these explicit keyword lists and NOTHING else —
// `enum`, `const`, `default` and `examples` are never entered.

/** Keywords whose value is a single subschema. */
const SINGLE_SCHEMA_KEYWORDS = [
  "not",
  "if",
  "then",
  "else",
  "contains",
  "propertyNames",
  "additionalItems",
  "unevaluatedItems",
  "unevaluatedProperties",
  "contentSchema",
] as const;

/** Keywords whose value is an array of subschemas. */
const SCHEMA_ARRAY_KEYWORDS = ["allOf", "anyOf", "oneOf", "prefixItems"] as const;

/** Keywords whose value is a `{ name: subschema }` map. */
const SCHEMA_MAP_KEYWORDS = [
  "properties",
  "patternProperties",
  "$defs",
  "definitions",
  "dependentSchemas",
] as const;

/**
 * Depth ceiling. Real schemas nest a handful of levels; a pathological or
 * hostile caller-supplied schema (the llm-bridge route and agent templates both
 * accept arbitrary author-supplied schemas) must not blow the stack. Beyond the
 * ceiling the node is passed through untouched — degrade toward the provider's
 * own error, never toward a local crash.
 */
const MAX_DEPTH = 64;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Human-readable restatement of a dropped constraint. Deterministic (stable
 * key order, stable wording) so the sanitized schema — and therefore the
 * provider-side prompt/grammar cache key — is stable across identical inputs.
 */
function describeDroppedConstraint(keyword: string, value: unknown): string {
  switch (keyword) {
    case "minimum":
      return `minimum ${String(value)} (inclusive)`;
    case "maximum":
      return `maximum ${String(value)} (inclusive)`;
    case "exclusiveMinimum":
      return `greater than ${String(value)}`;
    case "exclusiveMaximum":
      return `less than ${String(value)}`;
    case "multipleOf":
      return `a multiple of ${String(value)}`;
    case "maxItems":
      return `at most ${String(value)} items`;
    case "uniqueItems":
      return value === true ? "all items unique" : `uniqueItems ${String(value)}`;
    case "minProperties":
      return `at least ${String(value)} properties`;
    case "maxProperties":
      return `at most ${String(value)} properties`;
    case "format":
      return `format "${String(value)}"`;
    default:
      return `${keyword} ${String(value)}`;
  }
}

/**
 * Append-only description merge. The restatement is explicitly labelled as
 * unenforced so a reader (human or model) is never misled into believing the
 * response format itself guarantees the constraint.
 */
function withRestatedConstraints(
  node: Record<string, unknown>,
  dropped: { keyword: string; value: unknown }[],
): void {
  if (dropped.length === 0) return;
  const restated = dropped.map((d) => describeDroppedConstraint(d.keyword, d.value)).join("; ");
  const sentence = `Constraints (not enforced by the response format — you must satisfy them): ${restated}.`;
  const existing = typeof node.description === "string" ? node.description.trim() : "";
  node.description = existing.length > 0 ? `${existing} ${sentence}` : sentence;
}

/** Per-call traversal state. */
type Traversal = {
  /**
   * Nodes on the CURRENT recursion path — the cycle guard. A JSON schema
   * cannot legally be cyclic, but `outputSchema` is a plain in-process object
   * handed to us by callers, so a cycle is reachable via a programming error.
   */
  active: WeakSet<object>;
  /**
   * Sanitized result per input node. This is what makes a SHARED subschema
   * work: a schema may legitimately reuse one object for several properties
   * (`const SCORE = {...}; properties: { a: SCORE, b: SCORE }`), and treating
   * the second sighting as a cycle would leave it UNSANITIZED — the provider
   * would still 400. Memoizing (rather than skipping) sanitizes every
   * occurrence and keeps the shared identity in the output.
   */
  memo: WeakMap<object, unknown>;
};

/**
 * Recursive worker. Returns the ORIGINAL reference when the subtree needed no
 * change, so an untouched schema is `===` its input all the way up — that is
 * what makes "provider behavior unchanged" a structural property rather than a
 * deep-equality assertion.
 */
function sanitizeNode(
  node: unknown,
  policy: OutputSchemaPolicy,
  depth: number,
  state: Traversal,
): unknown {
  // Boolean schemas (`true` / `false`) and every non-schema leaf pass through.
  if (!isPlainObject(node)) return node;
  // A fully-processed node is reused verbatim (shared-subschema support).
  if (state.memo.has(node)) return state.memo.get(node);
  // Depth cutoff is deliberately NOT memoized: the truncated pass-through must
  // never be reused for the same node reached at a shallower depth.
  if (depth > MAX_DEPTH) return node;
  if (state.active.has(node)) return node;
  state.active.add(node);

  const dropped: { keyword: string; value: unknown }[] = [];
  let next: Record<string, unknown> | null = null;
  const mutable = (): Record<string, unknown> => (next ??= { ...node });

  for (const keyword of policy.unsupportedKeywords) {
    if (Object.prototype.hasOwnProperty.call(node, keyword)) {
      dropped.push({ keyword, value: node[keyword] });
      delete mutable()[keyword];
    }
  }

  // `format` is value-gated, not keyword-gated: supported values stay.
  const formats = policy.supportedStringFormats;
  if (
    formats &&
    typeof node.format === "string" &&
    !formats.includes(node.format)
  ) {
    dropped.push({ keyword: "format", value: node.format });
    delete mutable().format;
  }

  const replaceChild = (key: string, value: unknown) => {
    mutable()[key] = value;
  };

  for (const keyword of SINGLE_SCHEMA_KEYWORDS) {
    const child = node[keyword];
    if (!isPlainObject(child)) continue;
    const sanitized = sanitizeNode(child, policy, depth + 1, state);
    if (sanitized !== child) replaceChild(keyword, sanitized);
  }

  // `items` is polymorphic: a single subschema (2020-12) or a tuple of
  // subschemas (draft-07 and earlier). `additionalProperties` is a subschema
  // when it is an object and a boolean otherwise (the `false` that every
  // structured-output surface requires).
  for (const keyword of ["items", "additionalProperties"] as const) {
    const child = node[keyword];
    if (isPlainObject(child)) {
      const sanitized = sanitizeNode(child, policy, depth + 1, state);
      if (sanitized !== child) replaceChild(keyword, sanitized);
    } else if (Array.isArray(child)) {
      const sanitized = child.map((entry) => sanitizeNode(entry, policy, depth + 1, state));
      if (sanitized.some((entry, i) => entry !== child[i])) replaceChild(keyword, sanitized);
    }
  }

  for (const keyword of SCHEMA_ARRAY_KEYWORDS) {
    const child = node[keyword];
    if (!Array.isArray(child)) continue;
    const sanitized = child.map((entry) => sanitizeNode(entry, policy, depth + 1, state));
    if (sanitized.some((entry, i) => entry !== child[i])) replaceChild(keyword, sanitized);
  }

  for (const keyword of SCHEMA_MAP_KEYWORDS) {
    const child = node[keyword];
    if (!isPlainObject(child)) continue;
    let changed = false;
    const sanitizedMap: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(child)) {
      const sanitized = sanitizeNode(value, policy, depth + 1, state);
      sanitizedMap[name] = sanitized;
      if (sanitized !== value) changed = true;
    }
    if (changed) replaceChild(keyword, sanitizedMap);
  }

  // Legacy `dependencies`: each value is EITHER a subschema (object) or a
  // required-property-name array. Only the schema form is traversed.
  const dependencies = node.dependencies;
  if (isPlainObject(dependencies)) {
    let changed = false;
    const sanitizedDeps: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(dependencies)) {
      if (isPlainObject(value)) {
        const sanitized = sanitizeNode(value, policy, depth + 1, state);
        sanitizedDeps[name] = sanitized;
        if (sanitized !== value) changed = true;
      } else {
        sanitizedDeps[name] = value;
      }
    }
    if (changed) replaceChild("dependencies", sanitizedDeps);
  }

  state.active.delete(node);
  const result = next === null ? node : next;
  if (next !== null) withRestatedConstraints(next, dropped);
  state.memo.set(node, result);
  return result;
}

/**
 * Strip the JSON Schema validation keywords `provider` rejects from
 * `outputSchema`, restating each dropped constraint in the subschema's
 * `description` so the model still receives it.
 *
 * Contract:
 *  - returns the INPUT REFERENCE unchanged when the provider has no policy
 *    (openai, gemini) or when nothing needed dropping — callers and tests can
 *    assert byte-identity with `===`;
 *  - never throws. `outputSchema` reaches this function from arbitrary
 *    caller-supplied sources (the llm-bridge route, agent templates), so a
 *    malformed or hostile schema must degrade to "forward what we were given"
 *    and let the provider's own validation speak, rather than turning a
 *    provider 400 into a local 500.
 */
export function sanitizeOutputSchemaForProvider<T>(
  provider: LlmProvider | string,
  outputSchema: T,
): T {
  if (outputSchema == null) return outputSchema;
  const policy = OUTPUT_SCHEMA_POLICIES[provider as LlmProvider];
  if (!policy) return outputSchema;
  try {
    return sanitizeNode(outputSchema, policy, 0, { active: new WeakSet(), memo: new WeakMap() }) as T;
  } catch (err) {
    // Fail OPEN toward existing behavior: forward the original schema. The
    // provider will reject it exactly as it does today — a visible, actionable
    // 400 — instead of this leaf inventing a new failure mode.
    console.warn(
      `[llm:output-schema] sanitization failed for provider "${provider}" — forwarding the schema unchanged:`,
      err instanceof Error ? err.message : err,
    );
    return outputSchema;
  }
}

// ---------------------------------------------------------------------------
// 2. RESPONSE SIDE
// ---------------------------------------------------------------------------

/**
 * Provider-neutral structured-JSON extraction for LLM text output.
 *
 * Relocated from the openai connector (cinatra#151 Stage 2, design round
 * ruling): the function is pure text parsing with no provider state and is
 * used against output from EVERY provider (openai/anthropic/gemini), so it
 * lives in this provider-neutral layer instead of coupling all structured
 * parsing to the openai connector's presence. Tries, in order: the raw text,
 * a ```json fenced block, any fenced block, and the outermost {...} slice.
 *
 * One deviation from the connector original: the fenced-block regex dropped
 * its `\s*` (`/```json\s*([\s\S]*?)```/`) — CodeQL js/polynomial-redos (the
 * adjacent `\s*` + lazy any-char group backtrack polynomially on unclosed
 * fences). Observable behavior is IDENTICAL: the captured candidate was
 * always `.trim()`ed, so leading whitespace lands in the capture and is
 * trimmed right after (pinned by structured-json.test.ts).
 */
export function parseStructuredJson<T>(rawText: string): T | null {
  const candidates = [
    rawText.trim(),
    rawText.match(/```json([\s\S]*?)```/i)?.[1]?.trim(),
    rawText.match(/```([\s\S]*?)```/i)?.[1]?.trim(),
    rawText.includes("{") && rawText.includes("}")
      ? rawText.slice(rawText.indexOf("{"), rawText.lastIndexOf("}") + 1).trim()
      : undefined,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      continue;
    }
  }

  return null;
}
