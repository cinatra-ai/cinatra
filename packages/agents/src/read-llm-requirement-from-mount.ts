import "server-only";

import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { resolveAgentRuntimeMountDir } from "./agent-runtime-mount";
import { OasCinatraLlmSchema, type OasCinatraLlm } from "./llm-provider-policy";

/**
 * Read an installed agent's declared LLM-provider requirement — the
 * `metadata.cinatra.llm` block (`{ preferredProvider?, preferredModel?,
 * capabilityRequired? }`) — from its source `cinatra/oas.json` in the runtime
 * mount. This is the ratified LLM-provider dependency vocabulary
 * (docs/llm-provider-dependency-vocabulary.md, cinatra#1062): the same OAS block
 * the runtime `/api/llm-bridge` dispatch consumes, surfaced upstream so the
 * run-enqueue preflight can gate on provider availability BEFORE a run starts.
 *
 * Deliberately non-fatal and best-effort — an absent, unreadable, or malformed
 * OAS returns `undefined` ("no preflight signal"), NEVER a thrown error and
 * never a false "provider missing" claim. The block is validated through the
 * canonical `OasCinatraLlmSchema` so a malformed block cannot reach the
 * preflight resolver.
 *
 * Multi-vendor (cinatra#1196): the on-disk path is derived SCOPE-DERIVED from
 * the package's OWN vendor via `resolveInstalledOasMountPath` below — any
 * installed package, first-party `@cinatra-ai/<slug>` OR operator/third-party
 * `@vendor/<slug>`, resolves its own `<mount>/<vendor>/<slug>/cinatra/oas.json`
 * identically (no literal `cinatra-ai` segment, no `@cinatra-ai`-only regex).
 *
 * Same runtime-mount read + `packageName@version` cache pattern as
 * `input-schema-resolver.ts` (each worker process pays I/O at most once per
 * package version).
 */

// Scope-derived multi-vendor mount path (cinatra#1196). Split `@vendor/slug`
// on its single `/` and validate BOTH parts as single filesystem-safe segments
// (rejects `.`/`..`/separators/backslash) BEFORE the join, so a traversal
// payload can never escape the mount; a malformed/unscoped name resolves to
// `null` (probe semantics). Kept INLINE rather than the registries-backed
// shared `resolveInstalledOasPathForRead`: this module is transitively
// reachable from run-start routes, and importing the `@cinatra-ai/registries`
// barrel here would inflate the route-graph first-party module count (the
// no-new-rot dev-perf ratchet). The SECURITY trust root (the context routes,
// slice 1) uses the full shared resolver; this is a best-effort probe over an
// already-install-validated package name. `cinatra/oas.json` only (the
// materializer requires it; no agent.json / legacy-flat fallback).
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

type CacheKey = string; // `${packageName}@${packageVersion}`
const cache = new Map<CacheKey, OasCinatraLlm | undefined>();

export async function readLlmRequirementFromMount(
  packageName: string | null | undefined,
  packageVersion: string | null | undefined,
): Promise<OasCinatraLlm | undefined> {
  if (typeof packageName !== "string") return undefined;

  const key: CacheKey = `${packageName}@${packageVersion ?? ""}`;
  const cached = cache.get(key);
  if (cached !== undefined || cache.has(key)) return cached;

  const oasPath = resolveInstalledOasMountPath(packageName);
  if (!oasPath) {
    // MISS — unscoped/malformed name, or nothing installed at this path yet.
    // Deliberately NOT cached: a later mount projection / install of the SAME
    // version must still be able to surface its requirement. Caching a miss
    // would pin `undefined` for the process lifetime and fail the LLM-provider
    // preflight OPEN (the gate would silently skip). Only a RESOLVED read
    // (below) is memoized — an installed package's OAS is stable per version.
    return undefined;
  }

  let requirement: OasCinatraLlm | undefined;
  try {
    const oas = JSON.parse(await readFile(oasPath, "utf8")) as Record<string, unknown>;
    const metadata = oas.metadata as { cinatra?: { llm?: unknown } } | undefined;
    const parsed = OasCinatraLlmSchema.safeParse(metadata?.cinatra?.llm);
    // OasCinatraLlmSchema is `.optional()`, so a missing block parses to
    // `undefined` (success) — an absent requirement is a valid "no signal".
    if (parsed.success) requirement = parsed.data;
  } catch {
    // Non-fatal: unreadable / non-JSON OAS -> no preflight signal.
    requirement = undefined;
  }

  cache.set(key, requirement);
  return requirement;
}
