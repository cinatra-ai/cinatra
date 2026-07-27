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
    // All four kinds — `dependencies` carries cross-kind edges (the depended-on
    // extension's kind). cinatraExtensionKindSchema above is the narrower
    // package-self enum.
    kind: z.enum(["agent", "connector", "artifact", "skill"]).optional(),
    edgeType: z.enum(["runtime", "install-time", "peer"]),
    versionConstraint: cinatraVersionConstraintSchema,
    requirement: z.enum(["required", "optional"]),
  })
  .strict();

export const cinatraDependenciesSchema = z.array(cinatraExtensionDependencySchema);

// Structured `cinatra.consumes` declaration (engineering-spec'd consumed-
// primitive contract; SEMANTIC MIRROR of the authoritative sdk-extensions
// consumes.ts parser — the cross-package import is skipped per the
// `dependencies`/`produces` precedent above, so the zod shape must accept and
// refuse EXACTLY what `parseConsumedPrimitives` does: a primitive must be
// non-blank after trim, duplicate primitives are refused, extra entry keys are
// TOLERATED (the SDK shape-check ignores them; here they are stripped — a
// consumes entry is a claim, never trusted as the dependency itself). Optional
// for back-compat; MUST be carried here because the closed cinatra object
// strips unknown keys, and dropping it would erase a capability-binding claim
// the host enforces (the pm-work-store PM-seat gate, cinatra#1032
// deliverable 3, reads `cinatra.consumes` from the INSTALLED manifest).
export const cinatraConsumedPrimitiveSchema = z.object({
  primitive: z
    .string()
    .refine((s) => s.trim().length > 0, "primitive must be a non-empty string"),
  requirement: z.enum(["required", "optional"]),
});
export const cinatraConsumesSchema = z
  .array(cinatraConsumedPrimitiveSchema)
  .superRefine((arr, ctx) => {
    const seen = new Set<string>();
    arr.forEach((c, i) => {
      if (seen.has(c.primitive)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [i, "primitive"],
          message: `duplicate consumes entry for primitive ${c.primitive}`,
        });
      }
      seen.add(c.primitive);
    });
  });

// The `produces` array schema (cinatra#1788) — the ONLY path for typed agent
// output. Extracted so the PUBLISH path can validate a source manifest's
// `cinatra.produces` block FAIL-CLOSED with the SAME strict schema (a malformed
// entry — bad `extension`, a smuggled key, or a malformed `objectTypeId` — is
// REFUSED, never silently laundered into a coarse `{ extension }` entry).
// Byte-mirrors `packages/objects/src/semantic-manifest.ts semanticProducesSchema`
// and the `agent-produces-reader` leaf; the objectTypeId regex is pinned equal
// by the byte-mirror test.
export const agentProducesSchema = z.array(
  z
    .object({
      extension: z.string().min(1),
      objectTypeId: z
        .string()
        .regex(/^@[\w-]+\/[\w-]+:[\w-]+$/, {
          message:
            "produces objectTypeId must be a namespaced object type id (@scope/package:local-id)",
        })
        .optional(),
    })
    .strict(),
);

// The `lifecycle` block (cinatra#2038 S0 → cinatra#2047 D-1) — the agent
// manifest's LIFECYCLE declarations, compiled onto `agent_templates.lifecycle_config`
// exactly as `trigger_mode` / `gated_steps` are (epic #2037's "agent-manifest
// declarations (`metadata.cinatra` block compiled onto `agent_templates`,
// trigger-style)"). STRICT: an unknown key or a bad checkpoint name REFUSES the
// manifest at parse time rather than silently laundering a typo into an absent
// declaration — a silently-dropped `repairCapable` is exactly the D-1 failure.
export const agentLifecycleDeclarationSchema = z
  .object({
    /** Checkpoints the agent requests SKIPPED. Honored ONLY where the org is
     * silent AND the class is non-external (the lattice enforces both). */
    requestedSkips: z.array(z.enum(["recommendation", "review", "verification"])).optional(),
    /** Artifact types this agent declares it produces. */
    producedTypes: z.array(z.string().min(1)).optional(),
    /** Whether this producer implements the typed repair round-trip (S2). The
     * `changes_requested` route keys on it: true ⇒ the repair is dispatched to
     * the producer; absent/false ⇒ an org route or a human escalation. */
    repairCapable: z.boolean().optional(),
  })
  .strict();

export type AgentLifecycleDeclaration = z.infer<typeof agentLifecycleDeclarationSchema>;

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
  // Consumed cross-extension primitives/capabilities. Optional for back-compat;
  // preserved through publish (see verdaccio/client.ts) so a capability-binding
  // claim (e.g. the pm-work-store PM seat) survives the closed-object rebuild.
  consumes: cinatraConsumesSchema.optional(),
  ownerOrgId: z.string().nullable(),
  uiAdapter: z.literal("ag-ui").optional(),
  // Optional execution-provider hint in manifest.cinatra.
  // Publishers may omit for non-LangGraph templates.
  executionProvider: agentPackageExecutionProviderSchema.optional(),
  // Optional marketplace kind and API-version tags allow existing published
  // packages without these fields to continue validating.
  kind: cinatraExtensionKindSchema.optional(),
  apiVersion: z.string().optional(),
  // `produces: SemanticArtifactRef[]` declarations are the ONLY path for typed
  // agent output (cinatra#1788, epic #1785): each entry names a REQUIRED
  // artifact-kind dependency (`extension`) and OPTIONALLY the exact
  // `@scope/pkg:local-id` type it produces (`objectTypeId` — the #1452
  // discriminator, completing that direction for `produces`). The typed-
  // production contract (evaluateTypedProducesContract, wired into the publish
  // gate + install preflight) resolves every entry to a required artifact-kind
  // closure member whose manifest declares the referenced `objectTypes` claim,
  // FAIL-CLOSED before any write — runtime dynamic-type minting is retired.
  // Schema is optional and byte-mirrors
  // `packages/objects/src/semantic-manifest.ts semanticProducesSchema`; the
  // cross-package import is skipped to avoid a new agents<->objects dependency
  // edge. Equivalence (incl. the objectTypeId regex) is pinned by
  // `packages/extensions/src/__tests__/agent-produces-reader.test.ts`, which
  // parses against both schemas and asserts byte-equivalent acceptance.
  produces: agentProducesSchema.optional(),
  // The manifest LIFECYCLE declaration (cinatra#2047 D-1). Optional for
  // back-compat with every already-published package; when present it compiles
  // onto `agent_templates.lifecycle_config` at install, trigger-style.
  lifecycle: agentLifecycleDeclarationSchema.optional(),
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

// ---------------------------------------------------------------------------
// Layer 3 — typed-production closure contract (cinatra#1788, epic #1785).
//
// The MANIFEST is the ONLY path for typed agent output. An agent's
// `cinatra.produces` entry must resolve to an artifact-kind package in the
// agent's REQUIRED transitive install closure whose manifest declares the
// referenced object-type claim (the exact `objectTypeId` when the entry
// carries one). Enforced FAIL-CLOSED at BOTH seams — the publish gate
// (verdaccio/client.ts) and the install preflight (install-from-package.ts) —
// against the PLANNED closure BEFORE any template/install write, never by
// querying installed state after writing.
//
// There is no WARN phase (unlike the #924 materialization seam above): the
// epic ruling is "enforced fail-closed at publish and install, before any
// write", and runtime dynamic-type minting — the escape hatch a soft phase
// would have protected — is retired in this SAME slice (producesObjectTypes +
// the outputs[].cinatra.object_type annotation are gone), so the end state is
// BLOCK from day one.
//
// `evaluateTypedProducesContract` is PURE (no I/O, no registry). The caller
// resolves each required artifact-kind dependency's declared claim ids and
// passes them in `closureArtifactClaims`; `resolveTypedProducesContract` is the
// shared FAIL-CLOSED orchestrator that builds that map via an injected manifest
// resolver (the registry summary at publish; the same at install) so both
// seams enforce identically and stay unit-testable.
// ---------------------------------------------------------------------------

/** A produces entry as declared on the agent manifest — structural mirror of
 *  `@cinatra-ai/objects` SemanticArtifactRef (the cross-package import is
 *  skipped per the `produces` schema precedent above). */
export type TypedProducesRef = { extension: string; objectTypeId?: string };

/**
 * Evaluate the typed-production closure contract for one agent package. PURE.
 *   - `produces`: the agent's declared `cinatra.produces` entries.
 *   - `closureArtifactClaims`: extension package name → the object-type ids that
 *     REQUIRED artifact-kind closure member declares
 *     (`cinatra.artifact.objectTypes[].type`). ONLY required artifact-kind
 *     closure members are keys; an absent key means "not provided by a required
 *     artifact-kind dependency in the closure".
 *
 * Returns BLOCKER `ReviewFinding[]` (empty ⇒ conforming). Empty `produces` ⇒
 * no findings. Each finding NAMES the missing claimant/claim so the failure is
 * actionable at publish/install time — never a runtime surprise.
 */
export function evaluateTypedProducesContract(args: {
  produces: readonly TypedProducesRef[];
  closureArtifactClaims: ReadonlyMap<string, ReadonlySet<string>>;
}): ReviewFinding[] {
  const { produces, closureArtifactClaims } = args;
  const findings: ReviewFinding[] = [];
  for (const entry of produces) {
    const claims = closureArtifactClaims.get(entry.extension);
    if (claims === undefined) {
      findings.push({
        code: "ARTIFACT-CONTRACT-PRODUCES-UNCLAIMED",
        severity: "blocker",
        message:
          `cinatra.produces names artifact extension "${entry.extension}"` +
          `${entry.objectTypeId ? ` (type "${entry.objectTypeId}")` : ""} but it is not a ` +
          `REQUIRED artifact-kind dependency in the install closure — declare it as a ` +
          `required cinatra.dependencies edge (kind:"artifact") that ships the type, so ` +
          `the type exists at install time.`,
        source: "deterministic",
      });
      continue;
    }
    if (entry.objectTypeId !== undefined && !claims.has(entry.objectTypeId)) {
      const declared = [...claims].sort();
      findings.push({
        code: "ARTIFACT-CONTRACT-PRODUCES-UNCLAIMED",
        severity: "blocker",
        message:
          `cinatra.produces names type "${entry.objectTypeId}" from artifact extension ` +
          `"${entry.extension}", but that extension's manifest declares no such objectTypes ` +
          `claim (declares: ${declared.length > 0 ? declared.join(", ") : "none"}).`,
        source: "deterministic",
      });
    }
  }
  return findings;
}

/** The object-type claim ids a resolved artifact-kind package manifest declares
 *  (`cinatra.artifact.objectTypes[].type`). Defensive structural read — the
 *  artifact package's OWN publish validated the claim shape (claims.ts); here
 *  we only collect the well-formed namespaced ids. Empty for a descriptor-only
 *  pack (no claims), an unresolved manifest (`null`), or a hostile/malformed
 *  block (fail-closed: an objectTypeId entry then reads as unclaimed → BLOCK). */
export function readArtifactManifestClaimIds(manifest: unknown): Set<string> {
  try {
    const ids = new Set<string>();
    const cinatra = (manifest as { cinatra?: unknown } | null | undefined)?.cinatra;
    const artifact = (cinatra as { artifact?: unknown } | undefined)?.artifact;
    const objectTypes = (artifact as { objectTypes?: unknown } | undefined)?.objectTypes;
    if (!Array.isArray(objectTypes)) return ids;
    for (const claim of objectTypes) {
      const type = (claim as { type?: unknown } | null | undefined)?.type;
      // Count ONLY well-formed namespaced claim ids — the exact shape a real
      // objectTypes claim carries (claims.ts CLAIMED_OBJECT_TYPE_ID_RE, inlined
      // to keep this leaf import-free). A garbage `type` is not a resolvable
      // claim and must never satisfy a produces objectTypeId.
      if (typeof type === "string" && /^@[\w-]+\/[\w-]+:[\w-]+$/.test(type)) ids.add(type);
    }
    return ids;
  } catch {
    // Hostile manifest (throwing getters / Proxies) anywhere in the walk →
    // EMPTY (fail-closed): a PARTIALLY-built set must never leak, so an
    // objectTypeId entry reads as unclaimed → BLOCK.
    return new Set<string>();
  }
}

/** The raw `cinatra.dependencies` edge fields this helper reads defensively
 *  (structural mirror of `cinatraExtensionDependencySchema`). */
type RawDependencyEdge = {
  packageName?: unknown;
  kind?: unknown;
  edgeType?: unknown;
  requirement?: unknown;
  versionConstraint?: unknown;
};

/** A required artifact-kind closure member + the RAW versionConstraint its edge
 *  pins — carried so the claim check resolves the manifest at the SAME version
 *  the install closure will select (never `latest`). */
export type RequiredArtifactDependency = { packageName: string; versionConstraint: unknown };

/** The REQUIRED, install-blocking, artifact-kind edges in a raw
 *  `cinatra.dependencies` array — the closure members a `produces` entry must
 *  resolve to (a required non-peer artifact-kind edge is guaranteed present in
 *  the transitive install closure), each with the raw `versionConstraint` its
 *  edge pins. Peer/optional edges do NOT guarantee closure membership and are
 *  excluded. Mirrors the shared `isAutoInstallableEdge` predicate (requirement
 *  === "required" && edgeType !== "peer") without importing it (keeps this
 *  contract leaf import-free). */
export function requiredArtifactDependencies(
  cinatraDependencies: unknown,
): RequiredArtifactDependency[] {
  if (!Array.isArray(cinatraDependencies)) return [];
  const deps: RequiredArtifactDependency[] = [];
  for (const raw of cinatraDependencies as RawDependencyEdge[]) {
    if (
      raw &&
      typeof raw.packageName === "string" &&
      raw.packageName.length > 0 &&
      raw.kind === "artifact" &&
      raw.requirement === "required" &&
      raw.edgeType !== "peer"
    ) {
      deps.push({ packageName: raw.packageName, versionConstraint: raw.versionConstraint });
    }
  }
  return deps;
}

/** The concrete registry version lookup a raw `versionConstraint` selects so the
 *  claim check resolves the EXACT manifest version the closure installs — never
 *  `latest`:
 *   - `{ exact }` → fetch that exact version;
 *   - `{ range }` → max-satisfy against the registry (the caller FAILS CLOSED
 *      when nothing satisfies — an unsatisfiable range cannot install, so no
 *      claim is provable);
 *   - `{ unresolvable: true }` → git-ref / absent / malformed: NOT a
 *      registry-version pin, so the registry manifest cannot PROVE the claim at
 *      the pinned ref. The caller FAILS CLOSED (a typed produces entry then
 *      BLOCKS; a coarse entry still passes on required-dep membership alone) —
 *      declare a typed produces against an exact/range-pinned artifact dep.
 *  Pure — the caller performs the (impure) registry resolution + the fail-close. */
export type ArtifactDepVersionQuery =
  | { exact: string }
  | { range: string }
  | { unresolvable: true };

export function artifactDepVersionQuery(versionConstraint: unknown): ArtifactDepVersionQuery {
  const vc = versionConstraint as { kind?: unknown; version?: unknown; range?: unknown } | null | undefined;
  if (vc?.kind === "exact" && typeof vc.version === "string" && vc.version.length > 0) {
    return { exact: vc.version };
  }
  if (vc?.kind === "semver-range" && typeof vc.range === "string" && vc.range.length > 0) {
    return { range: vc.range };
  }
  return { unresolvable: true };
}

/**
 * Resolve + evaluate the typed-production closure contract for one agent
 * package — the shared FAIL-CLOSED orchestrator behind both enforcement seams.
 * Builds `closureArtifactClaims` by resolving each REQUIRED artifact-kind
 * dependency's manifest (via the injected `resolveManifest` seam — the registry
 * summary at publish, the same at install) and reading its declared claim ids,
 * then runs the pure contract. A required artifact dependency that cannot be
 * resolved contributes NO claims (an `objectTypeId` entry then reads as
 * unclaimed → BLOCK), so an unresolvable/unpublished dependency never silently
 * passes a typed entry. Returns BLOCKER findings (empty ⇒ conforming).
 *
 * `resolveManifest` receives the dependency package name AND the raw
 * `versionConstraint` its edge pins (resolve the version via
 * {@link artifactDepVersionQuery} so the claim check reads the SAME manifest
 * version the closure installs — never `latest`), and returns that version's raw
 * manifest (registry packument entry — carries `cinatra`) or `null` for a
 * not-found/unresolvable package; it MUST NOT throw (the caller maps its
 * registry seam's throw to `null`; this function additionally guards).
 */
export async function resolveTypedProducesContract(args: {
  produces: readonly TypedProducesRef[];
  cinatraDependencies: unknown;
  resolveManifest: (packageName: string, versionConstraint: unknown) => Promise<unknown | null>;
}): Promise<ReviewFinding[]> {
  const { produces, cinatraDependencies, resolveManifest } = args;
  if (produces.length === 0) return [];
  const requiredArtifactDeps = requiredArtifactDependencies(cinatraDependencies);
  const closureArtifactClaims = new Map<string, ReadonlySet<string>>();
  for (const dep of requiredArtifactDeps) {
    let manifest: unknown | null = null;
    try {
      manifest = await resolveManifest(dep.packageName, dep.versionConstraint);
    } catch {
      manifest = null;
    }
    closureArtifactClaims.set(dep.packageName, readArtifactManifestClaimIds(manifest));
  }
  return evaluateTypedProducesContract({ produces, closureArtifactClaims });
}
