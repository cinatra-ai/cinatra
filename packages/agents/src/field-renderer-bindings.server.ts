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
import { ARTIFACT_REVIEW_REDIRECT_RENDERER_ID } from "./agent-builder-ids";
import {
  drawnHitlRendererClaim,
  hitlClaimDrawnInContext,
  hitlClaimReadsContext,
  parkedHitlStepIsAnswerable,
} from "./orchestrator-mid-run-hitl";
import type { FieldRendererContext } from "./field-renderer-registry";
import type { DurableHitlGateArtifact } from "./store";
import { readCurrentDurableHitlGate } from "./agent-run-hitl-prompts";
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
    installDir = resolveAgentRuntimeMountDir();
  } catch {
    return [];
  }
  // SORTED traversal — first-declarer-wins among runtime duplicates must be
  // deterministic (alphabetical), never filesystem-order dependent (the
  // converged "generated-then-alphabetical" merge order).
  let scopes: string[] = [];
  try {
    scopes = readdirSync(installDir).sort();
  } catch {
    return [];
  }
  for (const scope of scopes) {
    let dirs: string[] = [];
    try {
      dirs = readdirSync(join(installDir, scope)).sort();
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

/**
 * THE DISPLAY-ONLY STEP IDS: a step parked under one of them is drawn as a card
 * with no answer of its own. The artifact-review redirect is one: the host draws
 * it inline (`register-default-renderers.ts`, cinatra#1796) with no approve
 * control, and the paused run goes on only by the review's own decision (the
 * resume delivery of that decision). A generic answer is never taken for it.
 */
const DISPLAY_ONLY_HITL_RENDERER_IDS: ReadonlySet<string> = new Set([
  ARTIFACT_REVIEW_REDIRECT_RENDERER_ID,
]);

/**
 * What claims a parked step's recorded renderer id on the server, where no
 * component registry exists: `drawnHitlRendererClaim` over every binding the
 * page registers from (the generated build bindings and the installed
 * packages, `getMergedFieldRendererBindings`) and the host's own entries, by
 * the same strict-equality rules the page's registry entries match with.
 * `null` when nothing draws the id, and for a display-only id. The claim names
 * the binding's kind, so a kind whose condition reads the reader's context is
 * known (`hitlClaimReadsContext`).
 */
export function serverHitlRendererClaim(xRenderer: string): { id: string; kind?: string } | null {
  if (DISPLAY_ONLY_HITL_RENDERER_IDS.has(xRenderer)) return null;
  return drawnHitlRendererClaim(xRenderer, getMergedFieldRendererBindings());
}

/**
 * Why a generic answer is refused for a parked step's durable record, or
 * `null` when it may be taken:
 *   - `display-only`: the step is a display-only card
 *     (`DISPLAY_ONLY_HITL_RENDERER_IDS`); only its own decision road consumes it;
 *   - `undrawn`: no screen draws the step for this reader
 *     (`parkedHitlStepIsAnswerable`). A binding whose condition reads the
 *     reader's context claims the step only when that condition matches the
 *     reader's context (`hitlClaimDrawnInContext`; a context that could not be
 *     read, `null`, never matches), as the page's registry passes it by.
 */
export function parkedHitlStepRefusalOnServer(
  step: { readonly xRenderer: string; readonly values?: unknown },
  readerContext: FieldRendererContext | null,
): "display-only" | "undrawn" | null {
  if (DISPLAY_ONLY_HITL_RENDERER_IDS.has(step.xRenderer)) return "display-only";
  // A binding whose condition does not match the reader's context does not
  // claim the step for that reader, as the page's registry passes it by.
  const bound = serverHitlRendererClaim(step.xRenderer);
  const claim = bound && hitlClaimDrawnInContext(bound, step.xRenderer, readerContext) ? bound : null;
  return parkedHitlStepIsAnswerable(step.xRenderer, claim, step.values) ? null : "undrawn";
}

/**
 * The server's reading of `parkedHitlStepIsAnswerable` for a parked step's
 * durable record (`parkedHitlStepRefusalOnServer` refuses nothing): the
 * bound-card binding asks it before it mints a ref for the step. It knows no
 * reader, so a step whose drawing depends on the reader's context gets no ref.
 */
export function parkedHitlStepIsAnswerableOnServer(step: {
  readonly xRenderer: string;
  readonly values?: unknown;
}): boolean {
  return parkedHitlStepRefusalOnServer(step, null) === null;
}

/**
 * THE READER'S FIELD-RENDERER CONTEXT, read once for both sides: the page's
 * loader (`getFieldRendererContextForAgentBuilderAction`, for the signed-in
 * reader) and the answer guard (`currentParkedHitlStepRefusal`, for the acting
 * user) call this, so a condition that reads the context
 * (`FIELD_RENDERER_KIND_CONTEXT_CONDITIONS`) sees the same facts on the server
 * as on the page. Registration-driven (cinatra#151 Stage 4): sender identities
 * resolve from the `email-sender-identities` capability; `connectedApps` lists
 * the providers' app slugs (today ["gmail"] iff aliases are synced). The host
 * connector services are published first (the side-effect import), as the
 * page's server action does, or the gmail provider's read would be swallowed
 * as "host service not registered". Both imports are dynamic so the bindings'
 * other readers do not load them. A failed read throws; each caller decides
 * what an unread context means.
 */
export async function readFieldRendererContextForUser(userId: string): Promise<{
  connectedApps: string[];
  gmailAliases: { sendAsEmail: string; displayName?: string }[];
}> {
  await import("@/lib/register-host-connector-services");
  const { listEmailSenderIdentities } = await import("@/lib/email-sender-identities");
  const contributions = await listEmailSenderIdentities(userId);
  const connectedApps = contributions.map((c) => c.app);
  const gmailAliases = (contributions.find((c) => c.app === "gmail")?.identities ?? []).map((a) => ({
    sendAsEmail: a.email,
    displayName: a.displayName,
  }));
  return { connectedApps, gmailAliases };
}

/**
 * THE ONE ANSWER GUARD of a parked run, for every generic road (the MCP resume
 * and the generic answer action). It decides on the run's CURRENT gate, its
 * newest durable row (`readCurrentDurableHitlGate`), never on the row the
 * run's task-id column names (that column can be stale). Returns that gate and
 * why an answer is refused, or `null`:
 *   - `stale`: the caller named a gate (`namedReviewTaskId`) and the run's
 *     current gate is another one;
 *   - `display-only` / `undrawn`: `parkedHitlStepRefusalOnServer` for the
 *     current gate, with the acting user's context read when the claiming
 *     binding's condition reads it (`readFieldRendererContextForUser`, the
 *     loader the page's context comes from); no acting user or a failed read
 *     is no context.
 * No durable row (`gate: null`) refuses nothing here. A row that cannot be
 * read throws; each road refuses with its own fixed text.
 */
export async function currentParkedHitlStepRefusal(input: {
  readonly runId: string;
  readonly actingUserId: string | null;
  readonly namedReviewTaskId?: string;
}): Promise<{
  gate: DurableHitlGateArtifact | null;
  refusal: "stale" | "display-only" | "undrawn" | null;
}> {
  const gate = await readCurrentDurableHitlGate(input.runId);
  if (!gate) return { gate: null, refusal: null };
  if (input.namedReviewTaskId !== undefined && gate.reviewTaskId !== input.namedReviewTaskId) {
    return { gate, refusal: "stale" };
  }
  let readerContext: FieldRendererContext | null = null;
  if (hitlClaimReadsContext(serverHitlRendererClaim(gate.xRenderer)) && input.actingUserId) {
    const userId = input.actingUserId;
    readerContext = await readFieldRendererContextForUser(userId).catch(() => null);
  }
  return { gate, refusal: parkedHitlStepRefusalOnServer(gate, readerContext) };
}
