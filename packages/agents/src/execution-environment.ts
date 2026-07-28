// Project-agent L1 declared-environment normalization + per-run resolution
// (exec-plane S3, cinatra#1708; epic #1705).
//
// The epic's one-internal-type invariant: a PACKAGED agent declares its
// environment in `cinatra.execution.environment` (carried RAW on
// `NormalizedExtensionRecord.executionEnvironment`); a PROJECT agent declares
// it in its agent config (carried RAW on
// `AgentTemplateRecord.executionEnvironment`). BOTH resolve through the SAME
// sdk-extensions leaf parser to the SAME `ExecutionEnvironmentSpec`, so the
// trusted builder (@cinatra-ai/execution-plane) sees one recipe language and
// two same-recipe agents share one cache entry regardless of authoring
// surface.
//
// Version-snapshot doctrine (cinatra#1708): the resolved env spec is part of
// the immutable agent-template version snapshot. A run that is PINNED to a
// version resolves its environment FROM THE SNAPSHOT — never the live
// template row — so a template update cannot swap the environment under a
// REQUIRED-pin run. New version = new recipe = new cache key.
//
// Authoring-authority doctrine (epic #1705 D8; cinatra#1708 slice B's
// `resolveAgentEnvironmentAuthority` states the same rule for the config
// surface): a PACKAGED agent's environment belongs to its MANIFEST — reviewed
// and locked through the extension review/lock choreography, and versioned by
// the INSTALLED PACKAGE VERSION, which the agent-template version pin does not
// name. So a manifest that declares a non-empty recipe WINS over both the
// template row and the template version snapshot. A manifest that declares
// nothing (absent, or an empty `{}`) leaves the recipe to the template
// config — which is exactly what makes an instance-local declaration for a
// package that asked for none possible — and that config path keeps the
// pinned-exclusive snapshot rule above.

import {
  parseExecutionEnvironment,
  isEmptyExecutionEnvironment,
  type ExecutionEnvironmentSpec,
  type ParseExecutionEnvironmentResult,
} from "@cinatra-ai/sdk-extensions";

import type { AgentTemplateVersionSnapshot } from "./store";

/**
 * Normalize a project-agent declared environment (the RAW config value) to
 * the canonical internal type — the exact parser packaged-agent manifests go
 * through (fail-closed: unknown keys / malformed entries reject the whole
 * declaration). `null`/`undefined` mean "no declared environment" and resolve
 * ok with the empty spec.
 */
export function normalizeProjectAgentEnvironment(
  raw: unknown,
): ParseExecutionEnvironmentResult {
  if (raw === null || raw === undefined) return { ok: true, spec: {} };
  return parseExecutionEnvironment(raw);
}

/**
 * The per-run environment resolution outcome. `source` records WHERE the
 * spec came from — load-bearing for audit and for the lifecycle tests
 * ("a pinned run mounts its snapshot's environment after the live spec
 * changed" is only provable when the source is explicit).
 */
export type ResolvedRunEnvironmentSource =
  | "packaged-manifest"
  | "version-snapshot"
  | "live-template";

export type ResolvedRunEnvironment =
  | { kind: "none" }
  | {
      kind: "declared";
      spec: ExecutionEnvironmentSpec;
      source: ResolvedRunEnvironmentSource;
    }
  | { kind: "invalid"; errors: string[]; source: ResolvedRunEnvironmentSource };

/**
 * Resolve the execution environment for ONE run.
 *
 *  - PACKAGED agent (`packagedManifestEnvironment` — the RAW
 *    `cinatra.execution.environment` claim carried on the package's
 *    normalized extension record): the manifest owns the recipe. A non-empty
 *    manifest declaration wins outright; a malformed one resolves `invalid`
 *    (the claim resolver's poison marker makes a present-but-malformed
 *    declaration fail loudly here rather than read as "no environment"); an
 *    absent or empty declaration leaves the recipe to the config sources
 *    below.
 *  - PINNED run (`pinnedSnapshot` present — the run's versionId resolved to
 *    an immutable snapshot): the environment comes EXCLUSIVELY from the
 *    snapshot. An absent key on the snapshot means the version was saved
 *    without a declared environment → `none` — NEVER a fallback to the live
 *    template (that would swap the environment under the pin).
 *  - DRAFT/unpinned run: the live template's declared environment.
 *
 * A declaration that fails the fail-closed parser resolves `invalid` — the
 * caller refuses to build/mount (a run must never silently proceed on a
 * recipe that dropped declared packages).
 */
export function resolveRunExecutionEnvironment(input: {
  /**
   * RAW packaged-manifest claim (`NormalizedExtensionRecord.executionEnvironment`)
   * for a run whose template ships as an extension package. Absent for project
   * agents.
   */
  packagedManifestEnvironment?: unknown;
  pinnedSnapshot?: Pick<AgentTemplateVersionSnapshot, "executionEnvironment"> | null;
  liveTemplateEnvironment?: unknown;
}): ResolvedRunEnvironment {
  const manifestRaw = input.packagedManifestEnvironment;
  if (manifestRaw !== null && manifestRaw !== undefined) {
    const parsed = parseExecutionEnvironment(manifestRaw);
    if (!parsed.ok) {
      return { kind: "invalid", errors: parsed.errors, source: "packaged-manifest" };
    }
    // A package that declares an EMPTY recipe has not claimed the agent's
    // environment — fall through so a template-config declaration still
    // applies (slice B's instance-local case). Only a NON-EMPTY manifest
    // declaration overrides the config sources.
    if (!isEmptyExecutionEnvironment(parsed.spec)) {
      return { kind: "declared", spec: parsed.spec, source: "packaged-manifest" };
    }
  }

  const pinned = input.pinnedSnapshot != null;
  const source = pinned ? ("version-snapshot" as const) : ("live-template" as const);
  const raw = pinned
    ? input.pinnedSnapshot!.executionEnvironment
    : input.liveTemplateEnvironment;
  if (raw === null || raw === undefined) return { kind: "none" };
  const parsed = parseExecutionEnvironment(raw);
  if (!parsed.ok) return { kind: "invalid", errors: parsed.errors, source };
  if (isEmptyExecutionEnvironment(parsed.spec)) return { kind: "none" };
  return { kind: "declared", spec: parsed.spec, source };
}
