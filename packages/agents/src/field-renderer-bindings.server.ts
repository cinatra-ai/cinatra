import "server-only";

// Installed-package field-renderer binding collector (cinatra#151 Stage 5).
//
// SOURCE B of the two-source binding registration (Source A is the generated
// build-time map src/lib/generated/agent-bindings.ts): agent packages
// installed at RUNTIME (marketplace/registry installs) are MATERIALIZED on
// disk under `resolveAgentInstallDir()` (default `extensions/`) with their
// package.json manifest — this module enumerates those manifests, validates
// `cinatra.fieldRenderers` with the SAME shared validator the generator uses
// (scripts/extensions/agent-binding-kinds.mjs) and returns normalized
// entries. Posture: SKIP-WARN — runtime data can never break the host
// (generation-time data is fail-closed instead).
//
// Sync on purpose: the A2UI adapter's translator resolution happens inside
// synchronous adapter construction/dispatch, and the registry merge wants a
// deterministic snapshot. The scan is a bounded readdir over
// extensions/<scope>/<name>/package.json with a short TTL cache.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  validateFieldRendererDeclarations,
  mergeFieldRendererBindings,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — dependency-free .mjs data/validation module (allowJs)
} from "../../../scripts/extensions/agent-binding-kinds.mjs";
import {
  GENERATED_FIELD_RENDERER_BINDINGS,
} from "@/lib/generated/agent-bindings";
import { resolveAgentInstallDir } from "./agent-install-path";
import type { FieldRendererBindingInput } from "./register-default-renderers";
import {
  A2UI_MID_RUN_TRANSLATOR_KINDS,
  type MidRunTranslatorResolver,
} from "@cinatra-ai/agent-ui-protocol/server";

type CollectedBinding = FieldRendererBindingInput & { declaredBy: string };

const CACHE_TTL_MS = 10_000;
let cache: { at: number; entries: CollectedBinding[] } | null = null;

/** Test hook — drop the TTL cache. */
export function __clearInstalledFieldRendererBindingsCache(): void {
  cache = null;
}

/**
 * Enumerate `<agentInstallDir>/<scope>/<name>/package.json` and collect the
 * validated `cinatra.fieldRenderers` declarations. Returns [] on any
 * environment where the install dir is unreadable (build contexts, fresh
 * trees) — absence of runtime bindings is a NORMAL state.
 */
export function collectInstalledFieldRendererBindings(): CollectedBinding[] {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.entries;
  const all: CollectedBinding[] = [];
  let installDir: string;
  try {
    installDir = resolveAgentInstallDir();
  } catch {
    return [];
  }
  let scopes: string[] = [];
  try {
    scopes = readdirSync(installDir);
  } catch {
    return [];
  }
  for (const scope of scopes) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(join(installDir, scope));
    } catch {
      continue;
    }
    for (const dir of dirs) {
      let pkg: {
        name?: unknown;
        cinatra?: { fieldRenderers?: unknown };
      };
      try {
        pkg = JSON.parse(
          readFileSync(join(installDir, scope, dir, "package.json"), "utf8"),
        );
      } catch {
        continue; // not a package dir
      }
      const packageName = typeof pkg.name === "string" ? pkg.name : null;
      const declared = pkg.cinatra?.fieldRenderers;
      if (!packageName || declared === undefined) continue;
      const { entries, errors } = validateFieldRendererDeclarations(
        packageName,
        declared,
      ) as { entries: CollectedBinding[]; errors: string[] };
      for (const err of errors) {
        console.warn(`[field-renderer-bindings] skipped invalid declaration: ${err}`);
      }
      all.push(...entries);
    }
  }
  const { merged, errors: mergeErrors } = mergeFieldRendererBindings(all) as {
    merged: CollectedBinding[];
    errors: string[];
  };
  for (const err of mergeErrors) {
    console.warn(`[field-renderer-bindings] conflicting declarations (first declarer wins): ${err}`);
  }
  cache = { at: Date.now(), entries: merged };
  return merged;
}

/**
 * The merged binding snapshot: generated build-time bindings FIRST
 * (precedence), then installed-package bindings for ids the generated map
 * does not carry. Deterministic; used by the server action, the A2UI
 * translator resolver, and kind-based ID lookups.
 */
export function getMergedFieldRendererBindings(): ReadonlyArray<CollectedBinding> {
  const generatedIds = new Set(
    GENERATED_FIELD_RENDERER_BINDINGS.map((b) => b.id),
  );
  const runtimeOnly = collectInstalledFieldRendererBindings().filter(
    (b) => !generatedIds.has(b.id),
  );
  return [
    ...(GENERATED_FIELD_RENDERER_BINDINGS as ReadonlyArray<CollectedBinding>),
    ...runtimeOnly,
  ];
}

/**
 * Resolve the canonical renderer ID bound to a KIND (e.g. the reviewer
 * output-envelope check in execution.ts). `undefined` when no present/
 * installed package binds the kind — callers treat that as "gate class not
 * present", the established degraded state.
 */
export function resolveRendererIdForKind(kind: string): string | undefined {
  return getMergedFieldRendererBindings().find((b) => b.kind === kind)?.id;
}

/**
 * Build the A2UI mid-run translator resolver the host injects into
 * A2UiAdapter: full xRenderer ID -> the manifest-declared translator KIND ->
 * the neutral translator primitive owned by agent-ui-protocol.
 */
export function buildA2UiMidRunTranslatorResolver(): MidRunTranslatorResolver {
  return (xRenderer) => {
    const binding = getMergedFieldRendererBindings().find(
      (b) => b.id === xRenderer && b.a2uiTranslator !== undefined,
    );
    if (!binding?.a2uiTranslator) return undefined;
    return A2UI_MID_RUN_TRANSLATOR_KINDS[binding.a2uiTranslator];
  };
}
