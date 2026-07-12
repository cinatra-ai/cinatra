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
    const inputItems =
      inputAny.items ??
      (inputAny.json_schema as { items?: unknown } | undefined)?.items;
    if (inputItems !== undefined) prop.items = inputItems;
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
