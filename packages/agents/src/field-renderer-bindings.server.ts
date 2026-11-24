import "server-only";

// Installed-package field-renderer binding collector (cinatra#151 Stage 5).
//
// SOURCE B of the two-source binding registration (Source A is the generated
// build-time map src/lib/generated/agent-bindings.ts): agent packages
// installed at RUNTIME (marketplace/registry installs) are MATERIALIZED on
// disk under `resolveAgentRuntimeMountDir()` (the projected runtime mount) with their
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
  comparableFieldRendererBinding,
  // eslint-disable-next-line @typescript-eslint/ban-ts-comment
  // @ts-ignore — dependency-free .mjs data/validation module (allowJs)
} from "../../../scripts/extensions/agent-binding-kinds.mjs";
import {
  GENERATED_FIELD_RENDERER_BINDINGS,
} from "@/lib/generated/agent-bindings";
import { resolveAgentRuntimeMountDir } from "./agent-runtime-mount";
import type { FieldRendererBindingInput } from "./register-default-renderers";
import type { DeclaredHitlCard } from "./hitl-gate-submit";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore: dependency-free .mjs validation module (allowJs)
import {
  isUnsupportedKindScreen,
  validateHitlScreen,
} from "../../../scripts/extensions/agent-hitl-screen-schema.mjs";
import {
  A2UI_MID_RUN_TRANSLATOR_KINDS,
  type MidRunTranslatorResolver,
} from "@cinatra-ai/agent-ui-protocol/server";

type CollectedBinding = FieldRendererBindingInput & { declaredBy: string };

const CACHE_TTL_MS = 10_000;

/**
 * One scan of the installed agents. `complete` is false when a part of the
 * mount could not be read (cinatra#3470): the mount unreadable, or a package
 * manifest unreadable or unparsable. Such a scan does not say that an id it
 * does not name declares nothing, so every reader of an absent id answers
 * "could not be loaded", never "no screen".
 */
type InstalledScan = {
  entries: CollectedBinding[];
  refusedScreenIds: string[];
  complete: boolean;
};

let cache: ({ at: number } & InstalledScan) | null = null;

/** Test hook — drop the TTL cache. */
export function __clearInstalledFieldRendererBindingsCache(): void {
  cache = null;
}

/**
 * Enumerate `<agentInstallDir>/<scope>/<name>/package.json` and collect the
 * validated `cinatra.fieldRenderers` declarations. A missing mount directory
 * (no agents installed, build contexts, fresh trees) is a NORMAL state and
 * answers []. A mount or manifest that could not be read answers the
 * bindings that were read; the scan is then incomplete (`collectInstalled`).
 */
export function collectInstalledFieldRendererBindings(): CollectedBinding[] {
  return collectInstalled().entries;
}

/**
 * The ids of installed bindings that declared a HITL screen the validator
 * refused (cinatra#3470), apart from any id another installed binding still
 * registers. Such a gate is a declared screen the host cannot draw: the run
 * page holds its Continue instead of reading it as a gate with no screen.
 */
export function collectInstalledRefusedScreenIds(): string[] {
  return collectInstalled().refusedScreenIds;
}

/** Is the scan `collectInstalled` would answer now the cached one? */
function scanIsCached(): boolean {
  return cache !== null && Date.now() - cache.at < CACHE_TTL_MS;
}

/** The error code of a failed file-system call, if it carries one. */
function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * Is a failed read of a path only its absence (cinatra#3470)? ENOENT: nothing
 * is there. ENOTDIR: a file stands where a directory was looked for (a stray
 * file beside the package folders). Every other error (EACCES, EIO, …) is a
 * collection error: something may be declared there that was not read.
 */
function isAbsence(err: unknown): boolean {
  const code = errorCode(err);
  return code === "ENOENT" || code === "ENOTDIR";
}

function warnUnread(what: string, err: unknown): void {
  const reason = errorCode(err) ?? (err instanceof Error ? err.message : String(err));
  console.warn(`[field-renderer-bindings] could not read ${what}: ${reason}`);
}

/**
 * The installed bindings and the refused screen ids. `fresh` scans past the
 * cache: an answer that must not miss an agent installed within the TTL
 * (cinatra#3470) asks for it.
 */
function collectInstalled(opts?: { fresh?: boolean }): InstalledScan {
  if (opts?.fresh !== true && cache && scanIsCached()) return cache;
  const all: CollectedBinding[] = [];
  const refused = new Set<string>();
  let complete = true;
  const scan = (): void => {
    let installDir: string;
    try {
      installDir = resolveAgentRuntimeMountDir();
    } catch (err) {
      warnUnread("the agent runtime mount", err);
      complete = false;
      return;
    }
    // SORTED traversal — first-declarer-wins among runtime duplicates must be
    // deterministic (alphabetical), never filesystem-order dependent (the
    // converged "generated-then-alphabetical" merge order).
    let scopes: string[];
    try {
      scopes = readdirSync(installDir).sort();
    } catch (err) {
      // No mount directory: no agents are installed.
      if (errorCode(err) === "ENOENT") return;
      warnUnread("the agent runtime mount", err);
      complete = false;
      return;
    }
    for (const scope of scopes) {
      let dirs: string[];
      try {
        dirs = readdirSync(join(installDir, scope)).sort();
      } catch (err) {
        if (isAbsence(err)) continue;
        warnUnread(`the installed scope ${scope}`, err);
        complete = false;
        continue;
      }
      for (const dir of dirs) {
        let text: string;
        try {
          text = readFileSync(join(installDir, scope, dir, "package.json"), "utf8");
        } catch (err) {
          if (isAbsence(err)) continue; // not a package dir
          warnUnread(`the manifest of ${scope}/${dir}`, err);
          complete = false;
          continue;
        }
        let pkg: {
          name?: unknown;
          cinatra?: { fieldRenderers?: unknown };
        };
        try {
          pkg = JSON.parse(text);
        } catch (err) {
          warnUnread(`the manifest of ${scope}/${dir}`, err);
          complete = false;
          continue;
        }
        const packageName = typeof pkg?.name === "string" ? pkg.name : null;
        const declared = pkg?.cinatra?.fieldRenderers;
        if (!packageName || declared === undefined) continue;
        const { entries, errors, refusedScreenIds } = validateFieldRendererDeclarations(
          packageName,
          declared,
        ) as { entries: CollectedBinding[]; errors: string[]; refusedScreenIds: string[] };
        for (const err of errors) {
          console.warn(`[field-renderer-bindings] skipped invalid declaration: ${err}`);
        }
        all.push(...entries);
        for (const id of refusedScreenIds) refused.add(id);
      }
    }
  };
  scan();
  const { merged, errors: mergeErrors } = mergeFieldRendererBindings(all) as {
    merged: CollectedBinding[];
    errors: string[];
  };
  for (const err of mergeErrors) {
    console.warn(`[field-renderer-bindings] conflicting declarations (first declarer wins): ${err}`);
  }
  const registered = new Set(merged.map((b) => b.id));
  cache = {
    at: Date.now(),
    entries: merged,
    refusedScreenIds: [...refused].filter((id) => !registered.has(id)).sort(),
    complete,
  };
  return cache;
}

/** What the run page's runtime bindings fetch answers (cinatra#3470). */
export type RuntimeFieldRendererBindingsPayload = {
  bindings: FieldRendererBindingInput[];
  /** Installed ids whose declared screen was refused (`collectInstalledRefusedScreenIds`). */
  refusedScreenIds: string[];
  /**
   * Present when a part of the installed agents could not be read: the
   * answer names only what was read, and an id it does not name may still
   * declare a screen (held as "could not be loaded", never as no screen).
   */
  incomplete?: true;
};

/**
 * The runtime-only bindings the client registers, and the ids of declared
 * screens the validator refused. Generated (build-time) bindings are already
 * compiled into the client registry, so neither list names one.
 */
export function runtimeFieldRendererBindingsPayload(
  opts?: { fresh?: boolean },
): RuntimeFieldRendererBindingsPayload {
  const generatedIds = new Set(GENERATED_FIELD_RENDERER_BINDINGS.map((b) => b.id));
  const { entries, refusedScreenIds, complete } = collectInstalled({ fresh: opts?.fresh === true });
  return {
    bindings: entries
      .filter((b) => !generatedIds.has(b.id))
      .map(({ id, kind, priority, midRunHitl, a2uiTranslator, params, screen }) => ({
        id,
        kind,
        priority,
        ...(midRunHitl === true ? { midRunHitl: true } : {}),
        ...(a2uiTranslator !== undefined ? { a2uiTranslator } : {}),
        ...(params !== undefined ? { params } : {}),
        ...(screen !== undefined ? { screen } : {}),
      })),
    refusedScreenIds: refusedScreenIds.filter((id) => !generatedIds.has(id)),
    ...(complete ? {} : { incomplete: true as const }),
  };
}

/**
 * The merged binding snapshot: generated build-time bindings FIRST
 * (precedence), then installed-package bindings for ids the generated map
 * does not carry. Deterministic; used by the server action, the A2UI
 * translator resolver, and kind-based ID lookups.
 */
const warnedGeneratedDivergence = new Set<string>();

export function getMergedFieldRendererBindings(): ReadonlyArray<CollectedBinding> {
  const generatedById = new Map(
    GENERATED_FIELD_RENDERER_BINDINGS.map((b) => [b.id, b]),
  );
  const runtimeOnly: CollectedBinding[] = [];
  for (const b of collectInstalledFieldRendererBindings()) {
    const generated = generatedById.get(b.id);
    if (!generated) {
      runtimeOnly.push(b);
      continue;
    }
    // Generated precedence; a DIVERGENT runtime duplicate is named loudly
    // (once per id) so a drifted installed package is diagnosable — runtime
    // data still never breaks the host.
    if (
      comparableFieldRendererBinding(generated) !==
        comparableFieldRendererBinding(b) &&
      !warnedGeneratedDivergence.has(b.id)
    ) {
      warnedGeneratedDivergence.add(b.id);
      console.warn(
        `[field-renderer-bindings] installed package ${b.declaredBy} declares ${b.id} ` +
          `divergently from the generated binding (declared by ${generated.declaredBy}); ` +
          `the generated binding wins`,
      );
    }
  }
  return [
    ...(GENERATED_FIELD_RENDERER_BINDINGS as ReadonlyArray<CollectedBinding>),
    ...runtimeOnly,
  ];
}

/**
 * Whether a binding's declared screen is a "kind" layout naming a kind outside
 * the one supported-kind set (cinatra#3470) that the validator and the browser
 * registration read too. Such a screen is never drawn, whatever its source
 * (generated or installed), so it is refused here as there.
 */
export function isUndrawableDeclaredScreen(binding: { kind: string; screen?: unknown }): boolean {
  return isUnsupportedKindScreen(binding.kind, binding.screen) as boolean;
}

/**
 * Whether a gate's renderer names a declared screen the host cannot draw
 * (cinatra#3470): an installed binding declared a screen for this id, the
 * validator refused it, and no binding registers the id; or the binding that
 * registers it declares a "kind" screen of an unsupported kind. This is the
 * run page's rule (`useRuntimeFieldRendererBindings` holds such a gate), read
 * here for the conversation core and the bound-card resolver, so no host reads
 * a refused screen as a gate with no screen.
 */
export function isRefusedDeclaredScreen(xRenderer: string): boolean {
  const { binding, refused, unknown } = lookupFieldRendererBinding(xRenderer);
  if (binding) return isUndrawableDeclaredScreen(binding);
  return refused || unknown;
}

/**
 * The merged binding of exactly this id, or whether an installed declaration
 * of it was refused (cinatra#3470). A CACHED SCAN NEVER SAYS AN ID DECLARES
 * NOTHING: the scan is cached for a few seconds, and an agent installed within
 * them is missing from it. When the cached scan names the id neither way, the
 * installed agents are scanned again, and only that answer reads as none.
 * NOR DOES AN INCOMPLETE SCAN: when a part of the installed agents could not be
 * read, an id it does not name is `unknown` (could not be loaded), never none.
 */
export function lookupFieldRendererBinding(
  xRenderer: string,
): { binding: CollectedBinding | undefined; refused: boolean; unknown: boolean } {
  const read = () => {
    const binding = getMergedFieldRendererBindings().find((b) => b.id === xRenderer);
    const scan = collectInstalled();
    const refused = binding === undefined && scan.refusedScreenIds.includes(xRenderer);
    return { binding, refused, unknown: binding === undefined && !refused && !scan.complete };
  };
  const wasCached = scanIsCached();
  const first = read();
  if (first.binding !== undefined || first.refused || !wasCached) return first;
  cache = null;
  return read();
}

/**
 * The declared HITL CARD of a gate's renderer (cinatra#3470): the merged
 * binding with exactly this id, declared mid-run, whose screen is a "card"
 * that passes the same validation the client registration runs. The server's
 * bound-screen fill and lent-action submit read the card's answer from it,
 * never from the gate's input schema.
 *
 * `null` only for a gate that declares no screen at all. A declared screen the
 * validator refused, a declaration that does not validate again, an id an
 * incomplete scan does not name, or a failed read is "unavailable": the caller
 * lends nothing for that screen and never falls back to the gate's raw schema.
 *
 * A valid "kind" screen is `"kind-screen"`: the kind's own component draws it,
 * with its own submission logic (a grouped setup form flushes its fields and
 * validates them before it sends; a list step sends a pick). The server has no
 * faithful reading of that logic, so the caller lends no generic fill or
 * submit for it either: the person answers it on its own screen.
 */
export function readDeclaredHitlCard(
  xRenderer: string,
): DeclaredHitlCard | "kind-screen" | "unavailable" | null {
  try {
    const { binding, refused, unknown } = lookupFieldRendererBinding(xRenderer);
    if (!binding) return refused || unknown ? "unavailable" : null;
    if (binding.screen === undefined) return null;
    if (isUndrawableDeclaredScreen(binding)) return "unavailable";
    // A screen belongs to a mid-run gate only; the validator refuses any other.
    if (binding.midRunHitl !== true) return "unavailable";
    const checked = validateHitlScreen(binding.screen, `${binding.id} screen`) as {
      screen?: { layout?: string };
      errors: string[];
    };
    if (checked.errors.length > 0) return "unavailable";
    if (checked.screen?.layout === "kind") return "kind-screen";
    if (checked.screen?.layout !== "card") return "unavailable";
    return checked.screen as DeclaredHitlCard;
  } catch {
    return "unavailable";
  }
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
