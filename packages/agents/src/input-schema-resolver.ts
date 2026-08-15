import "server-only";

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentRuntimeMountDir } from "./agent-runtime-mount";

/**
 * Runtime resolver for agent_templates.inputSchema.
 *
 * Background: `cinatra agents install` can derive inputSchema from
 * cinatra/oas.json when the published tarball lacks a compiled
 * agent.json. Some existing `agent_templates` rows still carry
 * `input_schema: {}` empty, which makes the setup loop short-circuit
 * (`requiredFields = []`), dispatch the run with empty inputs, and
 * WayFlow rejects with `Cannot start conversation because of missing
 * inputs "url"`.
 *
 * Fix shape: when the DB row's inputSchema is empty AND the package has a
 * mounted source OAS, derive the full inputSchema from the StartNode
 * component in its `cinatra/oas.json` at runtime. Multi-vendor (cinatra#1196):
 * the on-disk path is derived SCOPE-DERIVED from the package's OWN vendor via
 * `resolveInstalledOasMountPath` below, so a first-party `@cinatra-ai/<slug>`
 * and an operator/third-party `@vendor/<slug>` agent both derive from their
 * own `<mount>/<vendor>/<slug>/cinatra/oas.json` identically (no literal
 * `cinatra-ai` segment, no `@cinatra-ai`-only regex). Cache by
 * packageName@packageVersion so each worker process pays I/O at most once
 * per stale row.
 *
 * The resolver derives the full schema (properties + required + hidden
 * flag + renderer hints), not just required[]. The setup loop downstream
 * needs all of them.
 *
 * The resolver intentionally does not repair DB rows after derivation;
 * write semantics should be reviewed in isolation before adding
 * persistence here.
 *
 * This module ALSO owns the declared-type guard for setup values
 * (`assertValuesMatchDeclaredObjectTypes`, cinatra#2484 — see its own docblock
 * at the bottom of this file). That is deliberate co-location, not a grab bag:
 * the guard asserts values against the `properties` map THIS module resolves,
 * and its only two callers (`execution.ts` setup loop, `review-task-actions.ts`
 * setup-resume) already import `resolveTemplateInputSchema` from here to obtain
 * that very map. A separate leaf module would be one more first-party module in
 * the reachable graph of all five LOCKED dev-perf routes for zero new
 * capability — the same route-graph no-new-rot ratchet already called out on
 * `resolveInstalledOasMountPath` below. Folding it in keeps the "shared leaf
 * both chokepoints call" property (the point of the guard: neither server
 * chokepoint imports the other) at no graph cost.
 */

export type ResolvedInputSchema = {
  type: "object";
  required: string[];
  properties: Record<string, Record<string, unknown>>;
  /** Hidden fields per the source OAS — never shown to the user; flowed via DFE. */
  hidden?: string[];
};

type CacheKey = string; // `${packageName}@${packageVersion}`
const cache = new Map<CacheKey, ResolvedInputSchema>();

// Scope-derived multi-vendor mount path (cinatra#1196). Split `@vendor/slug`
// on its single `/` and validate BOTH parts as single filesystem-safe segments
// (rejects `.`/`..`/separators/backslash) BEFORE the join, so a traversal
// payload can never escape the mount; a malformed/unscoped name resolves to
// `null`. Kept INLINE rather than the registries-backed shared
// `resolveInstalledOasPathForRead`: this module is transitively reachable from
// run-start routes (the setup loop), and importing the `@cinatra-ai/registries`
// barrel here would inflate the route-graph first-party module count (the
// no-new-rot dev-perf ratchet). The security trust root (the context routes,
// slice 1) uses the full shared resolver; this is a best-effort derivation
// over an already-install-validated package name.
function resolveInstalledOasMountPath(packageName: string): string | null {
  const m = /^@([^/]+)\/([^/]+)$/.exec(packageName);
  if (!m) return null;
  const vendor = m[1];
  const slug = m[2];
  if (!isSafeMountSegment(vendor) || !isSafeMountSegment(slug)) return null;
  const oasPath = join(
    resolveAgentRuntimeMountDir(),
    vendor,
    slug,
    "cinatra",
    "oas.json",
  );
  return existsSync(oasPath) ? oasPath : null;
}

function isSafeMountSegment(s: string): boolean {
  return (
    s !== "." &&
    s !== ".." &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9-])?$/.test(s)
  );
}

async function readInstalledOasAsync(
  packageName: string,
): Promise<Record<string, unknown> | null> {
  const oasPath = resolveInstalledOasMountPath(packageName);
  if (!oasPath) return null;
  try {
    const raw = (await readFile(oasPath, "utf8")) as string;
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function deriveFullSchemaFromOas(
  oas: Record<string, unknown>,
): ResolvedInputSchema | null {
  if (oas.component_type !== "Flow") return null;
  const startRef =
    (oas.start_node as { $component_ref?: string } | undefined)?.$component_ref;
  const refs = oas.$referenced_components as Record<string, unknown> | undefined;
  if (!startRef || !refs) return null;
  const startNode = refs[startRef] as Record<string, unknown> | undefined;
  if (!startNode || startNode.component_type !== "StartNode") return null;

  const inputs = Array.isArray(startNode.inputs)
    ? (startNode.inputs as Array<Record<string, unknown>>)
    : [];
  const meta = (startNode.metadata as { cinatra?: Record<string, unknown> } | undefined)?.cinatra;
  const required = Array.isArray(meta?.required)
    ? (meta!.required as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  const hidden = Array.isArray(meta?.hidden)
    ? (meta!.hidden as unknown[]).filter((s): s is string => typeof s === "string")
    : [];

  const properties: Record<string, Record<string, unknown>> = {};
  for (const input of inputs) {
    if (typeof input.title !== "string") continue;
    const prop: Record<string, unknown> = {
      type: typeof input.type === "string" ? input.type : "string",
    };
    if (typeof input.format === "string") prop.format = input.format;
    if (typeof input.description === "string") prop.description = input.description;
    if ("default" in input) prop.default = input.default;
    // `items` may live at the top level OR nested under `json_schema.items`
    // (agentspec 26.1.0 convention). Without this fallback, the resolved
    // input schema for an array-typed input is `{type: "array"}` with no
    // `items` — OpenAI structured-output then rejects it as
    // `400 array schema missing items` and the chat extractor falls back
    // to empty `{}` inputs. See `oas-compiler.ts` line ~1490 for the matching
    // fix on the persisted compiled inputSchema path.
    const inputAny = input as Record<string, unknown>;
    const inputJsonSchema = inputAny.json_schema as
      | { items?: unknown; properties?: unknown; required?: unknown }
      | undefined;
    const inputItems = inputAny.items ?? inputJsonSchema?.items;
    if (inputItems !== undefined) prop.items = inputItems;
    // Object sub-shape (cinatra#2484). Mirrors the `items` lift above: an
    // OBJECT-typed input declares `{title, summary, outline}` under
    // `json_schema.properties` (+ `json_schema.required`). Without the lift the
    // resolved schema is a bare `{type:"object"}` and the Setup form renders one
    // free-text box for it — which accepts a bare string and sends a
    // type-violating `input_params` downstream.
    const inputProperties = inputAny.properties ?? inputJsonSchema?.properties;
    const inputRequired = inputAny.required ?? inputJsonSchema?.required;
    // `!Array.isArray` matters: `typeof [] === "object"`, and lifting an array
    // as `properties` would produce a schema whose sub-fields are index keys.
    if (
      prop.type === "object" &&
      inputProperties &&
      typeof inputProperties === "object" &&
      !Array.isArray(inputProperties)
    ) {
      prop.properties = inputProperties;
      if (Array.isArray(inputRequired)) prop.required = inputRequired;
    }
    // PRESENTATION HINTS (`x-…`) authored on the input's own `json_schema` ride
    // through verbatim, exactly as `oas-compiler.ts` step 7 does for the
    // persisted compiled inputSchema. The two pipelines must agree: a row with
    // an empty DB inputSchema resolves through HERE, and a hint that survived
    // only one of the paths would render one form on a freshly compiled
    // template and a different one on a derived template.
    if (inputJsonSchema && typeof inputJsonSchema === "object" && !Array.isArray(inputJsonSchema)) {
      for (const [hintKey, hintValue] of Object.entries(
        inputJsonSchema as Record<string, unknown>,
      )) {
        if (hintKey.startsWith("x-")) prop[hintKey] = hintValue;
      }
    }
    properties[input.title] = prop;
  }

  return {
    type: "object",
    required,
    properties,
    ...(hidden.length > 0 ? { hidden } : {}),
  };
}

function inputSchemaIsEmpty(schema: unknown): boolean {
  if (!schema || typeof schema !== "object") return true;
  const s = schema as { required?: unknown; properties?: unknown };
  const requiredCount = Array.isArray(s.required) ? s.required.length : 0;
  const propertyCount =
    s.properties && typeof s.properties === "object"
      ? Object.keys(s.properties).length
      : 0;
  return requiredCount === 0 && propertyCount === 0;
}

/**
 * Resolve the effective inputSchema for a template.
 *
 * Always returns a usable schema (never null). When the DB row carries
 * a non-empty inputSchema, it's returned verbatim. When empty AND the
 * package has a mounted source OAS (any vendor — resolved scope-derived via
 * the shared multi-vendor resolver), derives from the on-disk OAS StartNode.
 * Memoized per `${packageName}@${packageVersion}`.
 *
 * Callers: `execution.ts` setup-loop, `instance-screens.tsx` initial-
 * inputs form, `review-task-actions.ts` validation.
 */
export async function resolveTemplateInputSchema(
  template: {
    packageName?: string | null;
    packageVersion?: string | null;
    inputSchema?: unknown;
  },
): Promise<ResolvedInputSchema> {
  // Use DB schema when present and non-empty.
  if (!inputSchemaIsEmpty(template.inputSchema)) {
    const dbSchema = template.inputSchema as ResolvedInputSchema;
    return {
      type: "object",
      required: Array.isArray(dbSchema.required) ? dbSchema.required : [],
      properties:
        dbSchema.properties && typeof dbSchema.properties === "object"
          ? (dbSchema.properties as Record<string, Record<string, unknown>>)
          : {},
      ...(Array.isArray(dbSchema.hidden) ? { hidden: dbSchema.hidden } : {}),
    };
  }

  if (typeof template.packageName !== "string") {
    // No package identity — empty schema stays empty.
    return { type: "object", required: [], properties: {} };
  }

  const cacheKey = `${template.packageName}@${template.packageVersion ?? "unknown"}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const oas = await readInstalledOasAsync(template.packageName);
  if (!oas) {
    return { type: "object", required: [], properties: {} };
  }
  const derived = deriveFullSchemaFromOas(oas);
  if (!derived) {
    return { type: "object", required: [], properties: {} };
  }
  cache.set(cacheKey, derived);
  // eslint-disable-next-line no-console
  console.info(
    `[input-schema-resolver] derived inputSchema from disk OAS for ${template.packageName}@${template.packageVersion} (cache=${cache.size})`,
  );
  return derived;
}

/** Test-only: reset cache between tests. */
export function __resetInputSchemaResolverCache(): void {
  cache.clear();
}

/** Test-only export of the synchronous derivation helper. */
export const __testOnly = {
  deriveFullSchemaFromOas,
  inputSchemaIsEmpty,
};

// ---------------------------------------------------------------------------
// Declared-type guard for setup inputs (cinatra#2484).
//
// The defect: an agent StartNode input declared `type: "object"` was satisfiable
// by a bare string. The Setup form rendered it as one free-text field, the run
// started with `inputParams.idea = "<a sentence>"`, and the step downstream got
// a string where its contract required an object — failing far from the cause
// (`titleFrom output "title" did not resolve to a non-empty string`).
//
// The renderer now makes that unsubmittable, but the renderer is only ONE entry
// point. `inputParams` is also populated at run CREATION (the `agent_run` MCP
// tool, chat extraction, the API) — and the setup loop's pending-field filter
// tests key PRESENCE only, so a pre-supplied `{"idea": "bare text"}` skips the
// gate entirely and dispatches. These are the shared assertion both server
// chokepoints call, so the invariant does not depend on which door the value
// came through:
//
//   - `execution.ts` setup loop — before dispatch, over the whole inputParams.
//   - `review-task-actions.ts` setup-resume — before the inputParams merge.
//
// PURITY CONTRACT: the guard itself is pure — no React, no `"use client"`, no
// DB, no host `@/` imports — so a shared leaf is what keeps those two callers
// from importing each other. It rides this module (which is `server-only` and
// already imported by BOTH callers for the schema it validates against) rather
// than a file of its own, per the route-graph note in the module docblock.
// Mirrors the constraints documented in `hitl-gate-submit.ts` and
// `agent-builder-ids.ts`.
// ---------------------------------------------------------------------------

/** Human-readable JSON type, for the rejection message. */
export function describeJsonType(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return "a string";
  if (typeof value === "object") {
    const name = (value as object).constructor?.name;
    // Name the class so a rejected `Date` does not read as "an object".
    return name && name !== "Object" ? `a ${name}` : "an object";
  }
  return `a ${typeof value}`;
}

/**
 * A JSON OBJECT — not merely `typeof x === "object"` (codex round 1).
 *
 * `typeof`+`!Array.isArray` admits CLASS INSTANCES, and a class instance is not
 * interchangeable with a JSON object at the boundary this guard protects. A
 * `Date` is the concrete bypass: server-action deserialization revives real
 * `Date` instances, so `{idea: <Date>}` would clear a `typeof` check and then
 * `JSON.stringify` it to `"2026-08-07T…"` — landing a STRING in an
 * object-typed input, which is exactly the defect this guard exists to stop.
 * `Map`/`Set` are the same class of problem one step quieter: they stringify to
 * `{}`, silently emptying the input.
 *
 * Accepts only a plain object literal or a null-prototype object (what
 * `JSON.parse` and the DB's `jsonb` round-trip actually produce).
 */
function isPlainJsonObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

export type DeclaredProperties = Record<string, Record<string, unknown>>;

/**
 * Throw when a value violates its input's DECLARED `object` type.
 *
 * Deliberately narrow in TYPE: only `object`-typed inputs are checked, because
 * that is the class that silently degraded. A string input receiving a number
 * is left alone, so no existing agent's setup changes behaviour beyond the
 * defect being fixed. Undeclared keys are also left alone — the grouped
 * setup-resume path's own allowlist owns that check.
 *
 * Deliberately DEEP in shape: recursion follows declared sub-`properties`, so
 * `{details: {metadata: "bare text"}}` is caught when both are declared
 * objects. A one-level check would only move the hole down a level.
 *
 * `undefined` is ABSENCE, not a violation: a grouped form leaves an untouched
 * optional object field `undefined` and `JSON.stringify` drops the key on the
 * way to the merge. Requiredness is the setup loop's own concern — it re-emits
 * the gate for a still-missing required field — so rejecting absence here would
 * break every blank optional object input.
 *
 * @param errorPrefix prepended to the thrown message so each call site reads in
 *   its own terms ("Setup approval rejected" vs "Run cannot start").
 */
export function assertValuesMatchDeclaredObjectTypes(
  properties: DeclaredProperties,
  values: Record<string, unknown>,
  errorPrefix: string,
  path: string[] = [],
): void {
  for (const [key, value] of Object.entries(values)) {
    const declared = properties[key] as
      | { type?: string; properties?: DeclaredProperties }
      | undefined;
    if (declared?.type !== "object") continue;
    if (value === undefined) continue;
    const label = [...path, key].join(".");
    if (!isPlainJsonObject(value)) {
      throw new Error(
        `${errorPrefix}: input "${label}" is declared type "object" but received ` +
          `${describeJsonType(value)}. Submit a JSON object for this input.`,
      );
    }
    if (declared.properties && typeof declared.properties === "object") {
      assertValuesMatchDeclaredObjectTypes(
        declared.properties,
        value as Record<string, unknown>,
        errorPrefix,
        [...path, key],
      );
    }
  }
}
