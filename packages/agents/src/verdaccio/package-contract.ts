import { z } from "zod";

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
