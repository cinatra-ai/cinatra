import { z } from "zod";

import type { ReviewFinding } from "../validate-agent-json";
import {
  collectArtifactBindingsFromOasDocument,
  collectArtifactMaterializeNodesFromOasDocument,
} from "../artifact-binding";

export const CINATRA_AGENT_PACKAGE_TYPE = "agent" as const;
export const CINATRA_AGENT_MANIFEST_VERSION = 1 as const;
export const AGENT_PACKAGE_FORMAT_VERSION = 2 as const;

export const agentPackageTypeSchema = z.enum([
  "leaf", "proxy", "orchestrator", "parallel", "supervisor", "iterative", "node", "flow",
]);
export const agentPackageRiskLevelSchema = z.enum(["low", "medium", "high", "critical"]);

// Keep this list aligned with AgentTemplateRecord.executionProvider in store.ts
// and with the orchestration-layer provider enum.
export const cinatraExtensionKindSchema = z.enum([
  "agent",
  "skill",
  "connector",
  "artifact",
]);

export const agentPackageExecutionProviderSchema = z.enum([
  "openai", "anthropic", "gemini", "langgraph", "wayflow", "default",
]);

// lgGraphId must match the safe-id regex enforced in compiler.ts
// (LG_GRAPH_ID_PATTERN) and langgraph-deploy.ts (SAFE_ID_REGEX).
// Validating at the schema level means a malformed package cannot reach
// install-from-package's post-parse handling.
export const agentPackageLgGraphIdSchema = z
  .string()
  .regex(/^[a-z0-9_-]+$/u, "lgGraphId must match /^[a-z0-9_-]+$/");

export const agentDependenciesSchema = z.record(
  z.string().min(1),
  z.string().min(1),
);

// Agent packages may declare connector dependencies with the same shape as
// `agentDependencies`: a map of `<packageId>` to semver range.
// Persisted end-to-end through publish, install, and the agent_templates row.
// Publish-time validation refuses an agent whose OAS references a primitive
// owned by a connector not declared here.
export const connectorDependenciesSchema = z.record(
  z.string().min(1),
  z.string().min(1),
);

// Canonical cross-kind dependency edge. Mirrors
// `packages/extensions/src/canonical-types.ts ExtensionDependency` + the
// `inventory.mjs isValidExtensionDependency` validator; the cross-package import
// is skipped to avoid a new agents<->extensions dependency edge (same pattern as
// `produces` above). Carried end-to-end through publish so the marketplace can
// dependency-order extraction; without it the closed `cinatra` object below
// silently strips the field on publish (unknown keys are dropped).
export const cinatraVersionConstraintSchema = z.union([
  z.object({ kind: z.literal("semver-range"), range: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("exact"), version: z.string().min(1) }).strict(),
  z.object({ kind: z.literal("git-ref"), ref: z.string().min(1) }).strict(),
]);

export const cinatraExtensionDependencySchema = z
  .object({
    packageName: z.string().min(1),
    // All 5 kinds (incl. workflow) — `dependencies` carries cross-kind edges, so
    // it must accept a workflow target even though an agent PACKAGE itself is
    // never kind:"workflow" (cinatraExtensionKindSchema above is the narrower
    // package-self enum).
    kind: z.enum(["agent", "connector", "artifact", "skill", "workflow"]).optional(),
    edgeType: z.enum(["runtime", "install-time", "peer"]),
    versionConstraint: cinatraVersionConstraintSchema,
    requirement: z.enum(["required", "optional"]),
  })
  .strict();

export const cinatraDependenciesSchema = z.array(cinatraExtensionDependencySchema);

export const cinatraAgentPackageMetadataSchema = z.object({
  packageType: z.literal(CINATRA_AGENT_PACKAGE_TYPE),
  manifestVersion: z.literal(CINATRA_AGENT_MANIFEST_VERSION),
  sourceTemplateId: z.string().min(1),
  sourceVersionId: z.string().min(1),
  sourceVersionNumber: z.number().int().min(1),
  type: agentPackageTypeSchema.default("leaf"),
  riskLevel: agentPackageRiskLevelSchema,
  hasApprovalGates: z.boolean(),
  toolAccess: z.array(z.string()),
  agentDependencies: agentDependenciesSchema.optional(),
  connectorDependencies: connectorDependenciesSchema.optional(),
  // Canonical cross-kind dependency edges. Optional for back-compat with
  // already-published packages; preserved through publish (see verdaccio/client.ts)
  // so the marketplace can dependency-order extraction.
  dependencies: cinatraDependenciesSchema.optional(),
  ownerOrgId: z.string().nullable(),
  uiAdapter: z.literal("ag-ui").optional(),
  // Optional execution-provider hint in manifest.cinatra.
  // Publishers may omit for non-LangGraph templates.
  executionProvider: agentPackageExecutionProviderSchema.optional(),
  // Optional marketplace kind and API-version tags allow existing published
  // packages without these fields to continue validating.
  kind: cinatraExtensionKindSchema.optional(),
  apiVersion: z.string().optional(),
  // `produces: SemanticArtifactRef[]` declarations are honored at output time
  // as a classifier signal. Schema is optional and mirrors
  // `packages/objects/src/semantic-manifest.ts semanticProducesSchema`; the
  // cross-package import is skipped to avoid a new agents<->objects dependency
  // edge. Equivalence is pinned by
  // `packages/extensions/src/__tests__/agent-produces-reader.test.ts`, which
  // parses against both schemas and asserts byte-equivalent acceptance.
  produces: z
    .array(z.object({ extension: z.string().min(1) }).strict())
    .optional(),
});

export type CinatraAgentPackageMetadata = z.infer<typeof cinatraAgentPackageMetadataSchema>;

export const agentPackageManifestSchema = z
  .object({
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().nullable().optional(),
    keywords: z.array(z.string()).optional(),
    publishConfig: z
      .object({
        registry: z.string().min(1),
      })
      .optional(),
    cinatra: cinatraAgentPackageMetadataSchema,
  })
  .passthrough()
  .superRefine((value, ctx) => {
    if (value && typeof value === "object" && "dependencies" in value) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "Top-level 'dependencies' is not allowed on Cinatra agent packages; use cinatra.agentDependencies",
        path: ["dependencies"],
      });
    }
  });

export type AgentPackageManifest = z.infer<typeof agentPackageManifestSchema>;

export const agentPackagePayloadSchema = z
  .object({
    formatVersion: z.literal(AGENT_PACKAGE_FORMAT_VERSION),
    packageName: z.string().min(1),
    packageVersion: z.string().min(1),
    publishedAt: z.string().min(1),
    title: z.string().min(1),
    description: z.string().nullable(),
    changelog: z.string().nullable(),
    template: z.object({
      sourceTemplateId: z.string().min(1),
      ownerOrgId: z.string().nullable(),
      name: z.string().min(1),
      description: z.string().nullable(),
      sourceNl: z.string(),
      type: agentPackageTypeSchema.default("leaf"),
      compiledPlan: z.unknown(),
      inputSchema: z.record(z.string(), z.unknown()),
      outputSchema: z.record(z.string(), z.unknown()).nullable(),
      approvalPolicy: z.unknown(),
      taskSpec: z.string().nullable(),
      status: z.string(),
      // LangGraph template fields remain optional so non-LangGraph packages
      // stay compatible. The lgGraphId regex here is the single source of
      // truth for the install path (see install-from-package.ts; no extra
      // type-guard is needed after schema validation).
      lgGraphCode: z.string().nullable().optional(),
      lgGraphId: agentPackageLgGraphIdSchema.nullable().optional(),
      executionProvider: agentPackageExecutionProviderSchema.optional(),
      hitlScreens: z.array(z.string()).optional(),
    }),
    version: z.object({
      sourceVersionId: z.string().min(1),
      sourceVersionNumber: z.number().int().min(1),
      contentHash: z.string().min(1),
      snapshot: z.record(z.string(), z.unknown()),
    }),
    publish: z.object({
      riskLevel: agentPackageRiskLevelSchema,
      toolAccess: z.array(z.string()),
      hasApprovalGates: z.boolean(),
      agentDependencies: agentDependenciesSchema.optional(),
      connectorDependencies: connectorDependenciesSchema.optional(),
    }),
  })
  .passthrough();

export type AgentPackagePayload = z.infer<typeof agentPackagePayloadSchema>;

export function parseAgentPackageManifest(input: unknown): AgentPackageManifest {
  return agentPackageManifestSchema.parse(input);
}

export function parseAgentPackagePayload(input: unknown): AgentPackagePayload {
  return agentPackagePayloadSchema.parse(input);
}

export function isAgentPackageManifest(input: unknown): input is AgentPackageManifest {
  return agentPackageManifestSchema.safeParse(input).success;
}

// ---------------------------------------------------------------------------
// Install-time metadata-contract violation — a STRUCTURED, actionable error.
//
// The install path (install-from-package.ts) validates every closure member's
// `package.json#cinatra` block against the fail-closed metadata contract. A
// member missing a required field (packageType, manifestVersion, riskLevel,
// hasApprovalGates, toolAccess, ownerOrgId, and the source* fields) used to
// throw a raw ZodError that surfaced as an OPAQUE HTTP 500, forcing operators
// to read server stacks to learn which package/field was at fault. This typed
// error carries the offending package name + the exact failing contract fields
// so every surface (MCP result, CLI, operator log) can name them precisely.
//
// `code` is a STABLE string literal (mirrors the REQUIRES_REBUILD convention):
// the batch saga re-throws it RAW past its BatchMemberInstallError wrapping and
// the MCP install surface keys on it to return a structured result (not a 500)
// — both WITHOUT importing this module, so no new cross-package edge is added.
// `statusCode` (422) marks the failure as invalid PACKAGE CONTENT, not a server
// fault, for any HTTP surface that maps a thrown error's statusCode.
// ---------------------------------------------------------------------------

export const AGENT_PACKAGE_CONTRACT_VIOLATION_CODE =
  "AGENT_PACKAGE_CONTRACT_VIOLATION" as const;

export class AgentPackageContractViolationError extends Error {
  readonly code = AGENT_PACKAGE_CONTRACT_VIOLATION_CODE;
  readonly statusCode: number;
  readonly packageName: string;
  /**
   * The exact contract fields that failed, as dotted paths (e.g.
   * `cinatra.riskLevel`). Named for the dominant/observed case (the fields are
   * ABSENT), but includes any field that fails the contract — a present-but-
   * malformed value appears here too, and the message reads "missing or
   * invalid" accordingly.
   */
  readonly missingFields: readonly string[];

  constructor(opts: {
    packageName: string;
    missingFields: readonly string[];
    statusCode?: number;
  }) {
    super(
      `Agent package "${opts.packageName}" fails the metadata contract — ` +
        `missing or invalid required field(s): ` +
        `${opts.missingFields.length > 0 ? opts.missingFields.join(", ") : "(unknown)"}. ` +
        `Republish the package with these fields populated.`,
    );
    this.name = "AgentPackageContractViolationError";
    this.statusCode = opts.statusCode ?? 422;
    this.packageName = opts.packageName;
    this.missingFields = opts.missingFields;
  }
}

/**
 * Validate an extracted agent package manifest at install time. On success
 * returns the parsed manifest (identical to `agentPackageManifestSchema.parse`).
 * On failure throws a STRUCTURED {@link AgentPackageContractViolationError}
 * naming `packageName` and the EXACT failing contract fields — never a raw
 * ZodError.
 *
 * Field precision: the required `cinatra` block IS the metadata contract, so it
 * is re-validated against the raw block (or `{}` when the block is entirely
 * absent). This enumerates EVERY missing/invalid nested field — a top-level
 * parse alone would report only the bare `cinatra` path for an absent block,
 * hiding which fields are required.
 */
export function parseAgentPackageManifestForInstall(
  raw: unknown,
  packageName: string,
): AgentPackageManifest {
  const parsed = agentPackageManifestSchema.safeParse(raw);
  if (parsed.success) return parsed.data;

  const rawObj =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const blockParse = cinatraAgentPackageMetadataSchema.safeParse(rawObj.cinatra ?? {});
  const cinatraFields = blockParse.success
    ? []
    : blockParse.error.issues.map((issue) =>
        ["cinatra", ...issue.path].map(String).join("."),
      );
  // Non-`cinatra` top-level contract failures (name, version, the top-level
  // `dependencies` refusal) keep their own paths.
  const topFields = parsed.error.issues
    .filter((issue) => issue.path[0] !== "cinatra")
    .map((issue) => issue.path.map(String).join("."));
  const missingFields = [...new Set([...cinatraFields, ...topFields])].sort();
  throw new AgentPackageContractViolationError({ packageName, missingFields });
}

// ---------------------------------------------------------------------------
// Layer 2 — publish-time artifact-produces materialization contract (cinatra#924).
//
// A package that declares `cinatra.produces` must actually materialize each
// declared extension: an EndNode `outputs[].cinatra.artifact` binding or an
// `artifact_materialize` passthrough ApiNode per produced extension. This is
// the PUBLISH-CONTRACT view of the #922 epic invariant "declared production ⇒
// runnable materialization edge"; the runtime OAS-lint view is
// `scanOasForArtifactParityFindings` (validate-oas-runtime-invariants.ts).
//
// Ratchet (must NOT red un-migrated agent repos):
//   - Grammar violations (malformed `cinatra.artifact`, binding.extension ∉
//     produces) are NET-NEW shapes — no existing repo has a binding, so
//     nothing existing reddens; they are BLOCKER (already hard-blocked by the
//     compile gate — this is the defense-in-depth publish view).
//   - A produces entry with no materialization edge is a check EXISTING repos
//     trip (blog-draft-writer, blog-idea-generator), so it is WARNING day one.
//   - `ARTIFACT_PRODUCES_ENFORCEMENT` is the single WARN→BLOCK phase switch;
//     the Phase-2 flip to "block" (republish refusal) is a dedicated owner-gated
//     PR AFTER the fleet migration completes. This file ships "warn".
// The single binding-grammar source (#923 `artifact-binding.ts`) is reused —
// there is no duplicate parser.
// ---------------------------------------------------------------------------

/**
 * The WARN→BLOCK phase for the produces-materialization publish contract.
 * "warn": findings are advisory (the publish path logs them, never refuses).
 * "block": the caller refuses republish of a produces-declaring package whose
 * contract has any finding. Flipped only in a dedicated owner-gated PR once all
 * agent-repo migrations have merged and republished (cinatra#924, Phase 2).
 */
export const ARTIFACT_PRODUCES_ENFORCEMENT: "warn" | "block" = "warn";

/**
 * Evaluate the produces-materialization contract for a package at publish time.
 * Pure: no I/O, no registry. `produces` = the manifest `cinatra.produces`
 * extension ids; `oasDoc` = the parsed `cinatra/oas.json` Flow document.
 *
 * Returns `ReviewFinding[]`:
 *   - BLOCKER `ARTIFACT-CONTRACT-BINDING` — an invalid binding/materialize
 *     annotation (NET-NEW; safe — no existing repo has one).
 *   - WARNING `ARTIFACT-CONTRACT-PRODUCES-UNMATERIALIZED` — a produces entry
 *     with no valid materialization edge (existing repos trip this).
 * Empty `produces` ⇒ no findings (nothing declared, nothing to materialize).
 */
export function evaluateProducesMaterializationContract(args: {
  produces: readonly string[];
  oasDoc: Record<string, unknown>;
}): ReviewFinding[] {
  const { produces, oasDoc } = args;
  const findings: ReviewFinding[] = [];
  if (produces.length === 0) return findings;

  const bindingResult = collectArtifactBindingsFromOasDocument(oasDoc, { produces });
  const materializeResult = collectArtifactMaterializeNodesFromOasDocument(oasDoc, {
    produces,
  });

  for (const err of [...bindingResult.errors, ...materializeResult.errors]) {
    findings.push({
      code: "ARTIFACT-CONTRACT-BINDING",
      severity: "blocker",
      message: `Invalid artifact binding / artifact_materialize annotation: ${err}`,
      source: "deterministic",
    });
  }

  const covered = new Set<string>();
  for (const b of bindingResult.bindings) covered.add(b.binding.extension);
  for (const n of materializeResult.nodes) covered.add(n.extension);
  for (const ext of produces) {
    if (covered.has(ext)) continue;
    findings.push({
      code: "ARTIFACT-CONTRACT-PRODUCES-UNMATERIALIZED",
      severity: "warning",
      message:
        `cinatra.produces declares "${ext}" but no EndNode output binding ` +
        `(outputs[].cinatra.artifact) or artifact_materialize passthrough node ` +
        `materializes it — the declared artifact is never persisted at run completion. ` +
        `Add a binding/materialize node for "${ext}" before the republish BLOCK flip ` +
        `(cinatra#924).`,
      source: "deterministic",
    });
  }

  return findings;
}
