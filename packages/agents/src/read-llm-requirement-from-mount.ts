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
 * Same runtime-mount read + `packageName@version` cache pattern as
 * `input-schema-resolver.ts` (each worker process pays I/O at most once per
 * package version). Only in-repo `@cinatra-ai/<slug>` packages have a mounted
 * source OAS; anything else resolves to `undefined`.
 */

type CacheKey = string; // `${packageName}@${packageVersion}`
const cache = new Map<CacheKey, OasCinatraLlm | undefined>();

function inRepoSlug(packageName: string | null | undefined): string | null {
  if (typeof packageName !== "string") return null;
  const match = /^@cinatra-ai\/([a-z0-9][a-z0-9-]*)$/.exec(packageName);
  return match ? match[1] : null;
}

export async function readLlmRequirementFromMount(
  packageName: string | null | undefined,
  packageVersion: string | null | undefined,
): Promise<OasCinatraLlm | undefined> {
  const slug = inRepoSlug(packageName);
  if (!slug) return undefined;

  const key: CacheKey = `${packageName}@${packageVersion ?? ""}`;
  const cached = cache.get(key);
  if (cached !== undefined || cache.has(key)) return cached;

  let requirement: OasCinatraLlm | undefined;
  const oasPath = join(resolveAgentRuntimeMountDir(), "cinatra-ai", slug, "cinatra", "oas.json");
  if (existsSync(oasPath)) {
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
  }

  cache.set(key, requirement);
  return requirement;
}
