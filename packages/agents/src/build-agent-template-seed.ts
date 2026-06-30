import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { compileOasAgentJson } from "./oas-compiler";
import type { AgentPackageManifest } from "./verdaccio/package-contract";
import { agentPackageLgGraphIdSchema } from "./verdaccio/package-contract";

// ---------------------------------------------------------------------------
// build-agent-template-seed
// ---------------------------------------------------------------------------
//
// seed the agent_templates row DIRECTLY from the package's
// `cinatra/oas.json` (the OAS Flow document) + the already-validated
// `package.json#cinatra` block. There is NO intermediary `agent.json`
// materialized `formatVersion:2` payload — the legacy `agentPackagePayloadSchema`
// object is not synthesized, not read, and not re-parsed on the install path.
//
// The modern source of truth is the OAS doc; the same derivation the ZIP-import
// path uses (importAgentTemplateCore -> compileOasAgentJson) is applied here so
// a registry install and a ZIP import seed identical row fields from the same
// OAS bytes.
//
// Contract preservation (replaces the dropped agentPackagePayloadSchema.parse):
//   1. The caller has ALREADY parsed agentPackageManifestSchema (the cinatra
//      block) — a missing/invalid cinatra block still fails the install before
//      this builder runs.
//   2. compileOasAgentJson MUST return ok:true. A missing / unreadable /
//      malformed / structurally-invalid `cinatra/oas.json` THROWS here, BEFORE
//      any DB write or disk materialize — a package with no compilable OAS still
//      fails install. Same failure taxonomy as before.
//   3. Row-field validators (lgGraphId regex, the langgraph-source rule, the
//      snapshot schema) fail HERE with a precise error rather than at a
//      half-applied consumer.
//
// Determinism: the snapshot and contentHash are derived purely
// from the compiled-OAS bytes + manifest — NO wall-clock / Date.now. Reinstalling
// the same tarball yields a byte-identical seed.

/**
 * The fully-derived agent_templates row seed. Mirrors the field set the install
 * path used to read off `payload.template.*` / `payload.version.*`, sourced
 * instead from the OAS compile result + manifest.
 *
 * NOTE: tenant ownership (orgId / ownerLevel / ownerId) is NOT part of this
 * seed. Ownership is install-target provenance and comes from the
 * installAgentFromPackage input, exactly as before — never from the package.
 */
export type AgentTemplateInstallSeed = {
  /** OAS top-level `name` (trimmed) → fallback packageName. Never empty. */
  name: string;
  /** manifest.description (trimmed) → OAS description → null. */
  description: string | null;
  /** compiled.prompt is the Agent.system_prompt; sourceNl mirrors OAS sourceNl. */
  sourceNl: string;
  /** Canonicalized agent type (matches install-from-package's row enum). */
  type:
    | "leaf"
    | "proxy"
    | "orchestrator"
    | "parallel"
    | "supervisor"
    | "iterative"
    | "flow"
    | "node";
  /** Always [] for OAS flows (compiled.compiledPlan). */
  compiledPlan: [];
  inputSchema: Record<string, unknown>;
  outputSchema: Record<string, unknown> | null;
  approvalPolicy: unknown;
  taskSpec: string | null;
  hitlScreens: string[];
  /** Not present in OAS → null for WayFlow/OAS packages. */
  lgGraphCode: string | null;
  /** Not present in OAS → null for WayFlow/OAS packages. */
  lgGraphId: string | null;
  /** manifest.cinatra.executionProvider → null. */
  executionProvider:
    | "openai"
    | "anthropic"
    | "gemini"
    | "langgraph"
    | "wayflow"
    | "default"
    | null;
  /** Deterministic snapshot persisted to the agent_versions row. */
  snapshot: Record<string, unknown>;
  /** sha256(JSON.stringify(snapshot)) — full hex, matches the prior install flow. */
  contentHash: string;
};

type OasDoc = {
  name?: unknown;
  description?: unknown;
  sourceNl?: unknown;
};

function canonicalizeType(raw: unknown): AgentTemplateInstallSeed["type"] {
  // Mirror the canonicalization install-from-package.ts already applies to
  // manifest.cinatra.type so the DB row enum stays stable. OAS-aligned aliases
  // ("node", "flow") and canonical values pass through; anything else is "leaf".
  return raw === "proxy"
    ? "proxy"
    : raw === "orchestrator"
      ? "orchestrator"
      : raw === "flow"
        ? "flow"
        : raw === "parallel"
          ? "parallel"
          : raw === "supervisor"
            ? "supervisor"
            : raw === "iterative"
              ? "iterative"
              : raw === "node"
                ? "node"
                : "leaf";
}

/**
 * Seed an agent_templates row straight from the extracted tarball's
 * `cinatra/oas.json` + the validated `package.json#cinatra` block. No
 * `agent.json` payload is read or synthesized.
 *
 * Throws (failing the install before any mutation) when:
 *   - `cinatra/oas.json` is absent / unreadable / malformed / structurally
 *     invalid (surfaced by compileOasAgentJson returning ok:false);
 *   - the manifest declares `executionProvider: "langgraph"` — the OAS Flow
 *     document cannot supply the LangGraph graph code/id, so a LangGraph agent
 *     would be silently nulled. We fail loudly instead of seeding a broken row
 *     (per codex review);
 *   - a derived `lgGraphId` does not satisfy the safe-id regex.
 */
export async function buildAgentTemplateInstallSeed(input: {
  extractedTempDir: string;
  packageName: string;
  packageVersion: string;
  /** Already parsed via agentPackageManifestSchema at the call site. */
  manifest: AgentPackageManifest;
  /** Optional registry override forwarded to the OAS compiler. */
  registryPath?: string;
}): Promise<AgentTemplateInstallSeed> {
  const oasPath = join(input.extractedTempDir, "cinatra", "oas.json");

  // executionProvider hint from the manifest. Passed INTO the compile only as a
  // runtime classification fallback (deriveTriggerMode), and persisted onto the
  // row. Defaulted to DB/WayFlow behavior (null here → store defaults to wayflow).
  const manifestProvider: AgentTemplateInstallSeed["executionProvider"] =
    input.manifest.cinatra.executionProvider ?? null;

  // (1) langgraph guard — the OAS Flow document is a WayFlow artifact and cannot
  // carry the LangGraph StateGraph code/id. Seeding a langgraph-provider row
  // with null graph fields would produce a non-runnable agent. Fail loud.
  if (manifestProvider === "langgraph") {
    throw new Error(
      `[buildAgentTemplateInstallSeed] ${input.packageName} declares executionProvider:"langgraph" but ships only cinatra/oas.json; the OAS Flow document cannot supply the LangGraph graph code/id. A LangGraph agent must publish its graph through an explicit source — refusing to seed a broken row.`,
    );
  }

  // (2) Compile the OAS Flow doc. ok:false (missing / unreadable / malformed /
  // structurally-invalid) THROWS before any DB write or disk materialize.
  const compileResult = await compileOasAgentJson({
    packageName: input.packageName,
    oasSourcePath: oasPath,
    executionProvider: manifestProvider ?? undefined,
    registryPath: input.registryPath,
  });
  if (!compileResult.ok) {
    throw new Error(
      `[buildAgentTemplateInstallSeed] failed to compile cinatra/oas.json for ${input.packageName}@${input.packageVersion}: ${compileResult.error}`,
    );
  }
  const compiled = compileResult.value;

  // (3) Read the OAS doc top-level name/description/sourceNl. compileOasAgentJson
  // already validated the doc is well-formed JSON + structurally valid, so this
  // re-read is parse-safe. The OAS name is the human title; the compiler does not
  // surface it on CompiledAgentOas.
  let oasDoc: OasDoc = {};
  try {
    oasDoc = JSON.parse(await readFile(oasPath, "utf8")) as OasDoc;
  } catch {
    // Unreachable in practice — the compiler already read+parsed this file.
    // Fall through with empty doc; name falls back to packageName below.
  }

  const oasName = typeof oasDoc.name === "string" ? oasDoc.name.trim() : "";
  const name = oasName || input.packageName;
  const oasDescription =
    typeof oasDoc.description === "string" ? oasDoc.description : null;
  const manifestDescription =
    typeof input.manifest.description === "string"
      ? input.manifest.description.trim()
      : "";
  const description = manifestDescription || oasDescription || null;
  const sourceNl = typeof oasDoc.sourceNl === "string" ? oasDoc.sourceNl : "";

  // type: compiled.type (from OAS metadata.cinatra.type) wins; fall back to the
  // manifest declaration; canonicalize aliases the same way the install path does.
  const type = canonicalizeType(compiled.type ?? input.manifest.cinatra.type);

  const compiledPlan: [] = compiled.compiledPlan;
  const inputSchema = compiled.inputSchema;
  const outputSchema = compiled.outputSchema ?? null;
  const approvalPolicy = compiled.approvalPolicy;
  // taskSpec sources from compiled.prompt (Agent.system_prompt). null when absent.
  const taskSpec = compiled.prompt;
  const hitlScreens = compiled.hitlScreens;

  // lgGraph* are NOT in the OAS Flow document. WayFlow/OAS packages get null.
  // (The langgraph provider was already rejected above.)
  const lgGraphCode: string | null = null;
  const lgGraphId: string | null = null;
  if (lgGraphId !== null) {
    // Defensive: should never trip given the constant above, but preserve the
    // schema-level regex guard the dropped payload schema enforced.
    agentPackageLgGraphIdSchema.parse(lgGraphId);
  }

  // Deterministic snapshot. Includes outputSchema + lgGraph* (codex review,
  // codex B) so rollback/version-diff does not drift. No wall-clock fields.
  //
  // KEY ORDER MATTERS for branch parity (codex finding 1): the fresh-install
  // branch routes this snapshot through createLocalAgentTemplateVersion, which
  // rebuilds it as `{ ...snapshot, sourceNl, compiledPlan, inputSchema,
  // outputSchema, approvalPolicy, taskSpec }` (re-applying those six keys in
  // that order) and re-hashes. By laying out the snapshot with `name, type,
  // lgGraph*` FIRST and exactly those six override keys LAST in the SAME order,
  // that rebuild is a byte-identical identity transform — so the fresh INSERT,
  // the upsert, and the 23505-race upsert all persist the SAME snapshot and the
  // SAME contentHash. Reinstalling the same tarball is byte-stable end to end.
  const snapshot: Record<string, unknown> = {
    name,
    type,
    lgGraphCode,
    lgGraphId,
    sourceNl,
    compiledPlan,
    inputSchema,
    outputSchema,
    approvalPolicy,
    taskSpec,
  };
  const contentHash = createHash("sha256")
    .update(JSON.stringify(snapshot))
    .digest("hex");

  return {
    name,
    description,
    sourceNl,
    type,
    compiledPlan,
    inputSchema,
    outputSchema,
    approvalPolicy,
    taskSpec,
    hitlScreens,
    lgGraphCode,
    lgGraphId,
    executionProvider: manifestProvider,
    snapshot,
    contentHash,
  };
}
