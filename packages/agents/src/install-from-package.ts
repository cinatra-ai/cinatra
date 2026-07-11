import "server-only";
// Consumes @cinatra-ai/registries for tarball extraction and full-tree
// installs. Agent-specific schema validation is re-applied after the generic
// extract, and reinstall uses upsert semantics so install-after-bootstrap does
// not collide on the agent_templates.packageName unique index.

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  cleanupExtractedAgentPackage,
  dependencyScopePrefixesFor,
  ensureConfig,
  extractAgentPackage,
  installPackageWithDependencies,
  type DependencyTree,
  type PackumentVersionEntry,
  type PluginTypeConfig,
  type VerdaccioConfig,
} from "@cinatra-ai/registries";
// Canonical dependency-vocabulary reader (cinatra.dependencies wins; legacy
// cinatra.agentDependencies projected) + the shared auto-install predicate.
// These are pure leaf subpaths (manifest-dependencies imports only
// canonical-types; dependency-closure imports only @cinatra-ai/registries +
// canonical-types) — NOT the @cinatra-ai/extensions main entry, so the static
// agents->extensions index cycle does not apply and these can be imported
// synchronously (the resolver reads deps in a sync callback).
import { parseManifestDependencyEdges } from "@cinatra-ai/extensions/manifest-dependencies";
import { isAutoInstallableEdge } from "@cinatra-ai/extensions/dependency-closure";
import {
  parseAgentPackageManifestForInstall,
  CINATRA_AGENT_PACKAGE_TYPE,
  CINATRA_AGENT_MANIFEST_VERSION,
} from "./verdaccio/package-contract";
// seed the agent_templates row DIRECTLY from cinatra/oas.json +
// the validated package.json#cinatra block. No materialized `agent.json`
// formatVersion:2 payload is read, synthesized, or re-parsed on the install path.
import { buildAgentTemplateInstallSeed } from "./build-agent-template-seed";
// Imported here so any future spawn-side install paths (e.g. an out-of-band
// `pnpm install` invocation) can reuse the same explicit-flag construction.
// Today the install path goes through `pacote` (HTTP, see
// @cinatra-ai/registries), so no execFile spawn happens inside this file. The
// helper reference keeps install-side flag construction co-located with the
// install entry point for auditing.
import { buildRegistryAuthArgs } from "./verdaccio/cli-flags";
import { createLocalAgentTemplateVersion } from "./import-export-actions";
import {
  readAgentTemplateByPackageName,
  updateAgentTemplate,
  updateAgentTemplatePackageVersion,
  createAgentVersion,
  type CompiledStep,
  type ApprovalPolicy,
} from "./store";
import { compileOasAgentJson } from "./oas-compiler";
import { ensureDynamicObjectType } from "@cinatra-ai/objects/auto-registrar";
import { objectTypeRegistry } from "@cinatra-ai/objects/registry";
import { resolveAgentRuntimeMountDir } from "./agent-runtime-mount";
import {
  materializeAgentPackageToDisk,
  commitMaterialize,
  rollbackMaterialize,
  withInstallLock,
  withGlobalExtensionLifecycleLock,
  type MaterializeResult,
} from "./materialize-agent-package";
import {
  triggerWayflowReload,
  type ReloadResult,
} from "./wayflow-reload-client";
// PROJECT-TEMPLATE install gate (cinatra#1032 deliverable 3): an agent package
// shipping cinatra/project-template.json must satisfy the typed template
// contract + the exact-match worker-ref rule against its own
// cinatra.dependencies edges, or the install refuses in the inert window.
// Imported DYNAMICALLY at the call site (route-graph ratchet: keeps the gate
// module + its sdk contract off every locked route's static graph).

export type InstallAgentFromPackageInput = {
  packageName: string;
  packageVersion?: string;
  orgId?: string;
  /**
   * cinatra#793: the org scope for the FINALIZED store-payload resolution
   * (exact-org anchor resolution — the SAME scope the dispatcher ensured the
   * canonical row at; `null` = platform scope). OMITTED (undefined) →
   * platform-global resolution. Deliberately SEPARATE from `orgId` (the
   * template-seed creator org) so payload anchoring never shifts row ownership.
   */
  anchorOrgId?: string | null;
  /**
   * cinatra#793: when true the FINALIZED store payload is REQUIRED — a
   * resolution miss / version mismatch FAILS LOUD instead of falling back to a
   * registry extract. The dispatcher-routed ROOT install sets this (its store
   * pipeline ran first, so a miss is an invariant violation, and a silent
   * registry fallback would reintroduce the registry TOCTOU the store routing
   * closes). Saga-external transitive dependency nodes leave it unset.
   */
  requireStorePayload?: boolean;
  creatorId?: string;
  // Includes "active" so the install handler can pass status:"active" and
  // newly installed extensions appear in /agents (which filters by status
  // IN ('active','published')).
  status?: "draft" | "published" | "active";
  // Install-time owner tier. Threaded from installRegistryPackageAtScope's
  // `target.{level,id}` down to the agent_templates row INSERT. Optional for
  // back-compat with non-registry install callers (e.g., ZIP imports) that
  // have not been updated.
  ownerLevel?: "user" | "team" | "organization" | "workspace" | "project";
  ownerId?: string;
};

export type InstallAgentFromPackageResult = {
  templateId: string;
  versionId: string;
  packageName: string;
  packageVersion: string;
  /**
   * @deprecated DECLARE/WRITE surface for the legacy `cinatra.agentDependencies`
   * vocabulary. The canonical replacement is `cinatra.dependencies` (read via
   * `parseManifestDependencyEdges`). This field is kept during the deprecation
   * window for back-compat; new callers should consume the canonical dependency
   * edges instead. (Removal tracked as a follow-up milestone.)
   *
   * cinatra#1058: widened to the requirement-carrying union — an OPTIONAL
   * projected agent edge is `{ range, requirement: "optional" }`; REQUIRED /
   * legacy entries stay bare range strings.
   */
  agentDependencies: Record<string, string | { range: string; requirement: "required" | "optional" }>;
  /** Runtime files materialized to the WayFlow mount. */
  materialized?: {
    targetDir: string;
    wasReinstall: boolean;
  } | null;
  /** Explanation when materialize was skipped. */
  materializeSkippedReason?: string;
  /**
   * ADVISORY (cinatra#1059): the agent's declared `cinatra.produces` artifact
   * extensions that are NOT installed+governing for the installing org scope.
   * The `produces` edge is a SOFT cross-kind edge — this is purely
   * informational (NON-BLOCKING; the run degrades per-output if these stay
   * uninstalled). Empty when every produced-artifact extension is present (or
   * the agent declares none). The single authority the follow-on pre-install
   * "Produces" badge / post-install needs-attention UI consumes.
   */
  missingProducedArtifacts?: string[];
};

export async function installAgentFromPackage(
  input: InstallAgentFromPackageInput,
  config?: VerdaccioConfig,
): Promise<InstallAgentFromPackageResult> {
  // Acquire the GLOBAL lifecycle lock at the very top, BEFORE extraction and
  // dependency resolution, so install is strictly serialized against
  // extensions_purge across ALL packages. The re-entrant per-package
  // withInstallLock below is acquired too late to stop a dependent root being
  // staged around a concurrent purge.
  return withGlobalExtensionLifecycleLock(() =>
    _installAgentFromPackageImpl(input, config),
  );
}

// cinatra#793: STORE-FIRST payload acquisition. When the exact (package,
// version) being installed is already MATERIALIZED + FINALIZED in the unified
// content-addressed store (the dispatcher's store pipeline runs BEFORE the
// agent handler, so the root package of every dispatcher install/update is),
// consume THAT payload: copy the SRI-verified digest dir into a temp dir shaped
// exactly like a registry extract, so every downstream step (validate → seed →
// materialize-to-mount → cleanup) is unchanged and the store dir itself is
// never mutated. Falls back to the registry extract for packages with no
// finalized payload — the non-saga full-tree installer's TRANSITIVE dependency
// nodes never pass the dispatcher, so they have no store payload (yet; the
// batch saga path dispatches every member through the dispatcher and is fully
// store-backed).
async function acquireAgentPackagePayload(
  input: {
    packageName: string;
    packageVersion?: string;
    anchorOrgId?: string | null;
    requireStorePayload?: boolean;
  },
  resolvedConfig: VerdaccioConfig,
): Promise<Awaited<ReturnType<typeof extractAgentPackage>>> {
  try {
    const { resolveFinalizedStorePayload } = await import("@/lib/extension-store-payload");
    const payload = await resolveFinalizedStorePayload({
      packageName: input.packageName,
      expectedKind: "agent",
      ...(input.anchorOrgId !== undefined ? { orgId: input.anchorOrgId } : {}),
    });
    if (
      input.requireStorePayload &&
      (!payload || (input.packageVersion && payload.version !== input.packageVersion))
    ) {
      // Dispatcher-routed ROOT install: the store pipeline finalized this exact
      // (package, version) BEFORE this handler ran — a miss here means the
      // handler would install DIFFERENT bytes than the canonical row anchors.
      throw new Error(
        `[installAgentFromPackage] no FINALIZED store payload for ${input.packageName}` +
          `${input.packageVersion ? `@${input.packageVersion}` : ""}` +
          `${payload ? ` (found version ${payload.version ?? "unknown"})` : ""} — the ` +
          `dispatcher's store pipeline must finalize before the agent handler consumes it; ` +
          `refusing the registry-extract fallback.`,
      );
    }
    if (payload && (!input.packageVersion || payload.version === input.packageVersion)) {
      const { mkdtemp, cp, readFile, access } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { readAgentPayloadFromExtractedPackage } = await import("@cinatra-ai/registries");
      const tempDir = await mkdtemp(join(tmpdir(), "cinatra-agent-store-payload-"));
      await cp(payload.storeDir, tempDir, { recursive: true });
      const manifest = JSON.parse(await readFile(join(tempDir, "package.json"), "utf8")) as {
        version?: string;
      };
      // Same payload/readme resolution as extractAgentPackage (the OAS Flow
      // document from cinatra/oas.json, legacy root agent.json fallback).
      const oasPayload = await readAgentPayloadFromExtractedPackage(tempDir);
      const readmePath = join(tempDir, "README.md");
      const readme = (await access(readmePath).then(() => true).catch(() => false))
        ? await readFile(readmePath, "utf8")
        : null;
      return {
        packageName: input.packageName,
        packageVersion:
          payload.version ?? input.packageVersion ?? manifest.version ?? "0.0.0",
        manifest,
        payload: oasPayload,
        readme,
        tempDir,
      };
    }
  } catch (err) {
    if (input.requireStorePayload) throw err;
    console.warn(
      `[installAgentFromPackage] store-payload read for ${input.packageName} failed — ` +
        `falling back to the registry extract:`,
      err instanceof Error ? err.message : err,
    );
  }
  return extractAgentPackage(
    { packageName: input.packageName, packageVersion: input.packageVersion },
    resolvedConfig,
  );
}

async function _installAgentFromPackageImpl(
  input: InstallAgentFromPackageInput,
  config?: VerdaccioConfig,
): Promise<InstallAgentFromPackageResult> {
  const resolvedConfig = ensureConfig(config, "installAgentFromPackage");
  const extracted = await acquireAgentPackagePayload(
    {
      packageName: input.packageName,
      packageVersion: input.packageVersion,
      ...(input.anchorOrgId !== undefined ? { anchorOrgId: input.anchorOrgId } : {}),
      ...(input.requireStorePayload !== undefined
        ? { requireStorePayload: input.requireStorePayload }
        : {}),
    },
    resolvedConfig,
  );
  // Install transaction lock spans materialize -> DB write -> commit/rollback.
  // The lock is re-entrant via AsyncLocalStorage in materialize-agent-package,
  // so callers that hold an outer lock, such as extension-handler around its
  // skill-registration compensation flow, re-enter without deadlock.
  return withInstallLock(extracted.packageName, async () => {
  try {
    // Plugin-system returns raw manifest/payload; re-apply agent-specific
    // validation. A contract violation throws a STRUCTURED, per-package/per-field
    // AgentPackageContractViolationError (not a raw ZodError → opaque 500); on a
    // closure member the batch saga re-throws it raw and the MCP install surface
    // renders it as a structured result.
    const manifest = parseAgentPackageManifestForInstall(
      extracted.manifest,
      extracted.packageName,
    );

    if (manifest.cinatra.packageType !== CINATRA_AGENT_PACKAGE_TYPE) {
      throw new Error(`Unsupported package type: ${manifest.cinatra.packageType}`);
    }
    if (manifest.cinatra.manifestVersion !== CINATRA_AGENT_MANIFEST_VERSION) {
      throw new Error(`Unsupported manifest version: ${manifest.cinatra.manifestVersion}`);
    }

    // derive the agent_templates row seed DIRECTLY from the
    // extracted `cinatra/oas.json` + the validated `package.json#cinatra` block
    // (compiled via compileOasAgentJson — the SAME derivation the ZIP-import path
    // uses). This REPLACES the dropped `agentPackagePayloadSchema.parse`: a
    // package with no compilable OAS (or a langgraph provider that the OAS cannot
    // satisfy) THROWS HERE, in the same inert window the old parse occupied —
    // BEFORE the pin gate, the disk materialize, and any DB write — so a refusal
    // mutates nothing. The contract is NOT weakened.
    const seed = await buildAgentTemplateInstallSeed({
      extractedTempDir: extracted.tempDir,
      packageName: extracted.packageName,
      packageVersion: extracted.packageVersion,
      manifest,
    });

    // REQUIRED-PIN GATE (the host → extension half of the compatibility
    // contract) on the agent-package path: the registry-package server actions
    // and the dependency-tree installer dispatch HERE directly (not through the
    // extension-registry installer that gates the other kinds), so the pin must
    // be enforced at this single per-package writer too. `extracted.packageVersion`
    // is the CONCRETE version from the verified package's own package.json on
    // every route (direct install, update, transitive dependency node). Runs
    // with the other manifest validations, BEFORE the disk materialize and any
    // agent_templates/skill write — a refusal mutates nothing. Dynamic import:
    // @cinatra-ai/agents → @cinatra-ai/extensions is a static cycle.
    {
      const { checkRequiredExtensionVersionPin } = await import(
        "@cinatra-ai/extensions/required-in-prod"
      );
      const isUpdateRoute = (await readAgentTemplateByPackageName(extracted.packageName)) !== null;
      const pin = checkRequiredExtensionVersionPin({
        packageName: extracted.packageName,
        version: extracted.packageVersion,
        // Accurate op label for the refusal copy: an existing template row
        // means this is the upsert/update route. Read-only; the upsert branch
        // below re-reads its own snapshot after materialize as before.
        op: isUpdateRoute ? "update" : "install",
      });
      if (!pin.ok) throw new Error(pin.reason);

      // UPDATE GATE (#180 item 6) on the agent path too — the registry-package
      // server actions and the dependency-tree installer dispatch HERE
      // directly (not through the extension-registry dispatcher that gates
      // the other kinds), so the dependent-range check must run at this
      // per-package writer as well. Same inert window as the pin gate: a
      // refusal mutates nothing. The canonical store may legitimately have no
      // rows for a dispatcher-less agent install — the gate is a no-op then.
      if (isUpdateRoute) {
        const { listInstalledExtensions } = await import(
          "@cinatra-ai/extensions/canonical-store"
        );
        const { assertUpdateDoesNotBreakDependents } = await import(
          "@cinatra-ai/extensions/dependency-closure"
        );
        const allRows = await listInstalledExtensions({});
        assertUpdateDoesNotBreakDependents(
          extracted.packageName,
          extracted.packageVersion,
          allRows,
        );
      }
    }

    const legacyAgentDependencies: Record<string, string> =
      (manifest.cinatra as { agentDependencies?: Record<string, string> }).agentDependencies ?? {};

    // DEPENDENCY-EDGE DUAL-READ (#180): the agent path is a MATERIALIZING
    // install path, so its canonical row must carry the
    // manifest's real edges instead of the dispatcher's `dependencies: []`
    // seed. Read them HERE, with the other manifest validations and BEFORE
    // the disk materialize / any agent_templates write — a malformed
    // `cinatra.dependencies` entry or a canonical-vs-legacy
    // `agentDependencies` conflict throws and the refusal mutates nothing.
    // The write TARGETS (live canonical rows) are ALSO resolved here, in the
    // same inert window: the resolve is fail-loud on an unreachable canonical
    // store, and running it before `updateAgentTemplate`/`createAgentVersion`
    // means a transient store failure refuses the install while NOTHING has
    // mutated — the edges are then WRITTEN below, at the
    // finalize seams, against these pre-resolved targets.
    // Dynamic import: @cinatra-ai/agents -> @cinatra-ai/extensions is a static cycle.
    const { parseManifestDependencyEdges, resolveLiveCanonicalEdgeTargets, writeDependencyEdgesToCanonicalRows, versionConstraintToRange } = await import(
      "@cinatra-ai/extensions/manifest-dependencies"
    );
    const dependencyEdges = parseManifestDependencyEdges(extracted.manifest, {
      packageName: extracted.packageName,
    }).edges;
    const dependencyEdgeTargets = await resolveLiveCanonicalEdgeTargets({
      packageName: extracted.packageName,
    });

    // PROJECT-TEMPLATE KIND GATE (cinatra#1032 deliverable 3): a shipped
    // cinatra/project-template.json must validate against the typed template
    // contract AND every template worker ref must EXACT-MATCH a
    // cinatra.dependencies edge (the "one truth source" rule). Runs in the
    // same inert window as the other manifest validations — BEFORE the disk
    // materialize and any agent_templates write, so a refusal (a structured
    // ProjectTemplateContractViolationError) mutates nothing. Packages with no
    // template file no-op here.
    {
      const { enforceProjectTemplateInstallContract } = await import(
        "./project-template-install-gate"
      );
      await enforceProjectTemplateInstallContract({
        extractedTempDir: extracted.tempDir,
        packageName: extracted.packageName,
        dependencyEdges,
      });
    }

    // RUNTIME-GATE PROJECTION (cinatra#1056): derive the two runtime-gate
    // columns the template row carries from ONE truth source — the canonical
    // `cinatra.dependencies` edges (read alongside the legacy dual-read map):
    //   - `kind: "connector"` edges → connector_dependencies, each carrying its
    //     `requirement` so the run-enqueue connector preflight gates on the real
    //     requirement instead of a hardcoded one (the optional-skip BEHAVIOR is
    //     a later wave; W1 projects the value, both requirements still fail
    //     closed at the preflight).
    //   - `kind: "agent"` edges → merged into agent_dependencies (the
    //     orchestrator-readiness source), each carrying its `requirement`.
    //     REQUIRED edges project as a BARE range string (the legacy shape — the
    //     readiness gate hard-fails on a missing required sub-agent, unchanged);
    //     OPTIONAL edges project as `{ range, requirement: "optional" }` so the
    //     readiness gate routes a missing optional sub-agent to stop-run-hitl
    //     instead of hard-failing the run (cinatra#1058 — the wave #1056
    //     deferred: #1056 DROPPED optional agent edges entirely to avoid a wrong
    //     hard-block; this wave wires the real optional behavior).
    // Kind-LESS edges (a legacy-only manifest that projected through
    // `parseManifestDependencyEdges` with no kind) are NOT projected here — the
    // legacy `agentDependencies` map already carries those, so dual-read gating
    // is preserved for an artifact that only declares the legacy vocabulary.
    const connectorDependencies: Record<string, { range: string; requirement: "required" | "optional" }> =
      Object.fromEntries(
        dependencyEdges
          .filter((e) => e.kind === "connector")
          .map((e) => [
            e.packageName,
            { range: versionConstraintToRange(e.versionConstraint), requirement: e.requirement },
          ]),
      );
    const agentDependencies: Record<
      string,
      string | { range: string; requirement: "required" | "optional" }
    > = {
      ...legacyAgentDependencies,
      ...Object.fromEntries(
        dependencyEdges
          .filter((e) => e.kind === "agent")
          .map((e) => [
            e.packageName,
            e.requirement === "optional"
              ? { range: versionConstraintToRange(e.versionConstraint), requirement: "optional" as const }
              : versionConstraintToRange(e.versionConstraint),
          ]),
      ),
    };

    // PRODUCED-ARTIFACT ADVISORY (cinatra#1059): the agent's declared
    // `cinatra.produces` artifact extensions that are NOT installed+governing
    // for the installing org scope. `produces` is a SOFT cross-kind edge —
    // this is NON-BLOCKING (log-continue, the canonical artifact
    // optional-missing behavior); the run degrades per-output (visible
    // materialization failure) if these stay uninstalled. Computed once in the
    // shared window so both finalize branches return it consistently.
    const missingProducedArtifacts = await computeProducedArtifactAdvisory({
      agentPackageName: extracted.packageName,
      manifest: extracted.manifest,
      // Effective INSTALLING-org scope for the artifact-governance check:
      // `orgId` on direct/seed callers; the dispatcher-routed install (the
      // saga-owned fan-out) passes only `anchorOrgId` (== the actor's org, the
      // scope its canonical rows live at) and omits `orgId`, so fall back to it
      // — else an artifact active only for that org (no ambient null-org row)
      // would be falsely reported missing (codex).
      orgId: input.orgId ?? input.anchorOrgId ?? null,
    });
    if (missingProducedArtifacts.length > 0) {
      console.warn(
        `[installAgentFromPackage] ${extracted.packageName} declares produces of artifact ` +
          `extension(s) not installed for this org — typed materialization will degrade ` +
          `until installed: ${missingProducedArtifacts.join(", ")}`,
      );
    }

    // Canonical agent type for the template row. Sourced from the OAS-compile
    // result (compiled.type), falling back to manifest.cinatra.type, with the
    // same alias canonicalization the row enum requires — all done inside
    // buildAgentTemplateInstallSeed so install and ZIP-import seed identically.
    const type = seed.type;

    // lgGraph* are NOT in the OAS Flow document → null for WayFlow/OAS packages
    // (a langgraph provider was already rejected in the seed builder).
    // executionProvider sources from manifest.cinatra.executionProvider.
    const lgGraphCode: string | null = seed.lgGraphCode;
    const lgGraphId: string | null = seed.lgGraphId;
    const executionProvider: string | null = seed.executionProvider;

    // Materialize the tarball's runtime files to the WayFlow agents mount
    // BEFORE the DB write, so the file is the prerequisite for any subsequent
    // reload. On DB failure below, the materialize is rolled back
    // (rollbackMaterialize restores any prior dir and deletes the
    // freshly-written one). On DB success, the prior dir backup is committed
    // (commitMaterialize).
    //
    // Materialize throws are fatal: we propagate so the DB write never lands
    // on a half-installed extension. A documented soft-skip (e.g. tarball
    // missing cinatra/oas.json) returns `materialized: false` instead of
    // throwing.
    //
    const materializeResult = await materializeAgentPackageToDisk({
      extractedTempDir: extracted.tempDir,
      packageName: extracted.packageName,
      // cinatra#793: runtime files project into the agent RUNTIME MOUNT
      // (`<extension-data-root>/.agent-mount`) — the deploy-owned dir WayFlow
      // mounts — never a standalone install dir.
      agentInstallDir: resolveAgentRuntimeMountDir(),
    });
    if (!materializeResult.materialized) {
      console.warn(
        `[installAgentFromPackage] materialize skipped for ${extracted.packageName}: ${materializeResult.reason}`,
      );
    }

    // Upsert branch: if a template already exists for this packageName, update
    // in place instead of creating a duplicate row.
    const existing = await readAgentTemplateByPackageName(extracted.packageName);
    if (existing) {
      const snapshot = seed.snapshot;
      const contentHash = seed.contentHash;
      const versionId = randomUUID();

      try {
      // Update scalar fields on the existing template row. Field list mirrors
      // the seed passed to createLocalAgentTemplateVersion below — every seed
      // field the fresh-install branch writes must land on the upsert branch too.
      await updateAgentTemplate(existing.id, {
        name: seed.name,
        description: seed.description ?? undefined,
        sourceNl: seed.sourceNl,
        compiledPlan: seed.compiledPlan as CompiledStep[] | undefined,
        inputSchema: seed.inputSchema,
        outputSchema: seed.outputSchema ?? undefined,
        approvalPolicy: seed.approvalPolicy as ApprovalPolicy | undefined,
        type,
        taskSpec: seed.taskSpec ?? undefined,
        lgGraphCode,
        lgGraphId,
        executionProvider: (executionProvider as "openai" | "anthropic" | "gemini" | "langgraph" | "wayflow" | "default" | null) ?? undefined,
        agentDependencies:
          Object.keys(agentDependencies).length > 0 ? agentDependencies : undefined,
        connectorDependencies:
          Object.keys(connectorDependencies).length > 0 ? connectorDependencies : undefined,
        hitlScreens: seed.hitlScreens ?? undefined,
        status: input.status ?? existing.status,
        // Org + owner tier must follow the install target on re-install too.
        // Otherwise the audit row written by installRegistryPackageAtScope says
        // targetScope: { level: "team", id: "team-X" } while this DB row keeps
        // the prior owner_level / owner_id, producing an auth-vs-state divergence
        // for any downstream reader (e.g. enforceResourceAccess) that consults
        // agent_templates.owner_level / owner_id. The fresh-install branch below
        // writes these via the freshSeed; the upsert branch must do the same.
        // org_id rides the same rule (cinatra#847): the freshSeed persists
        // input.orgId, so re-installing a still-NULL-org row (e.g. a boot-seeded
        // template a user installs) must stamp org_id here or the org-scoped
        // /agents "Installed agents" card keeps excluding it. undefined leaves
        // the column unchanged (updateAgentTemplate only writes org_id when the
        // patch defines it), so callers that omit orgId are unaffected.
        orgId: input.orgId,
        ownerLevel: input.ownerLevel,
        ownerId: input.ownerId,
      });
      await updateAgentTemplatePackageVersion(existing.id, extracted.packageVersion);
      await createAgentVersion({
        id: versionId,
        templateId: existing.id,
        contentHash,
        snapshot,
      });

      // EDGE PERSISTENCE (#180): land the manifest edges on the PRE-RESOLVED
      // canonical row targets now that the template write committed — the
      // agent path's finalize seam (upsert branch). The store read already
      // happened in the inert window above; a WRITE failure here throws into
      // the catch below (materialize rollback) like any other post-write
      // failure on this path.
      await writeDependencyEdgesToCanonicalRows(dependencyEdgeTargets, dependencyEdges);

      // Register agent-declared output object types (upsert branch).
      // See registerDeclaredObjectTypes helper at the bottom of this function.
      await registerDeclaredObjectTypes({
        extractedTempDir: extracted.tempDir,
        extractedPackageName: extracted.packageName,
        creatorId: input.creatorId ?? null,
      });

      // Commit the materialize (deletes .old backup).
      if (materializeResult !== null) {
        await commitMaterialize(materializeResult);
      }
      return {
        templateId: existing.id,
        versionId,
        packageName: extracted.packageName,
        packageVersion: extracted.packageVersion,
        agentDependencies,
        missingProducedArtifacts,
        materialized: materializeResult?.materialized
          ? { targetDir: materializeResult.targetDir, wasReinstall: materializeResult.wasReinstall }
          : null,
        materializeSkippedReason:
          materializeResult && !materializeResult.materialized
            ? materializeResult.reason
            : undefined,
      };
      } catch (dbErr) {
        // DB upsert failed. Roll back the materialize so
        // the WayFlow mount doesn't end up with files that don't have a
        // matching template row. The .old dir (if any) is restored.
        if (materializeResult !== null) {
          await rollbackMaterialize(materializeResult);
        }
        throw dbErr;
      }
    }

    // Fresh-install branch. Wrapped to catch a concurrent-install race:
    // two callers can both read existing===null then race on INSERT — the loser
    // gets a unique-violation (pg code 23505) on agent_templates_package_name_idx.
    // On collision, fall through to the upsert path with the now-existing row.
    const freshSeed = {
      name: seed.name,
      description: seed.description,
      sourceNl: seed.sourceNl,
      compiledPlan: seed.compiledPlan,
      inputSchema: seed.inputSchema,
      outputSchema: seed.outputSchema,
      approvalPolicy: seed.approvalPolicy,
      type,
      taskSpec: seed.taskSpec,
      snapshot: seed.snapshot,
      creatorId: input.creatorId,
      orgId: input.orgId,
      // Owner tier flows through the seed into createAgentTemplate.
      ownerLevel: input.ownerLevel,
      ownerId: input.ownerId,
      packageName: extracted.packageName,
      packageVersion: extracted.packageVersion,
      agentDependencies:
        Object.keys(agentDependencies).length > 0 ? agentDependencies : undefined,
      connectorDependencies:
        Object.keys(connectorDependencies).length > 0 ? connectorDependencies : undefined,
      // hitlScreens flows through the seed into createAgentTemplate so a fresh
      // install seeds the SAME value the upsert/race branches write. Pass the
      // array verbatim (even when empty) so all three branches persist an
      // identical column value ("[]" for no screens) rather than NULL vs "[]".
      hitlScreens: seed.hitlScreens,
      lgGraphCode,
      lgGraphId,
      executionProvider: (executionProvider as "openai" | "anthropic" | "gemini" | "langgraph" | "wayflow" | "default" | null) ?? undefined,
      status: input.status ?? "draft",
    };
    let templateId: string;
    let versionId: string;
    try {
    try {
      const result = await createLocalAgentTemplateVersion({ seed: freshSeed });
      templateId = result.templateId;
      versionId = result.versionId;
    } catch (insertErr: unknown) {
      const pgCode = (insertErr as { code?: string })?.code;
      if (pgCode !== "23505") throw insertErr;
      // Race: another concurrent install won the INSERT — apply upsert to its row.
      const raceExisting = await readAgentTemplateByPackageName(extracted.packageName);
      if (!raceExisting) throw insertErr;
      const snapshot = seed.snapshot;
      const contentHash = seed.contentHash;
      versionId = randomUUID();
      await updateAgentTemplate(raceExisting.id, {
        name: seed.name,
        description: seed.description ?? undefined,
        sourceNl: seed.sourceNl,
        compiledPlan: seed.compiledPlan as CompiledStep[] | undefined,
        inputSchema: seed.inputSchema,
        outputSchema: seed.outputSchema ?? undefined,
        approvalPolicy: seed.approvalPolicy as ApprovalPolicy | undefined,
        type,
        taskSpec: seed.taskSpec ?? undefined,
        lgGraphCode,
        lgGraphId,
        executionProvider: (executionProvider as "openai" | "anthropic" | "gemini" | "langgraph" | "wayflow" | "default" | null) ?? undefined,
        agentDependencies:
          Object.keys(agentDependencies).length > 0 ? agentDependencies : undefined,
        connectorDependencies:
          Object.keys(connectorDependencies).length > 0 ? connectorDependencies : undefined,
        hitlScreens: seed.hitlScreens ?? undefined,
        status: input.status ?? raceExisting.status,
      });
      await updateAgentTemplatePackageVersion(raceExisting.id, extracted.packageVersion);
      await createAgentVersion({ id: versionId, templateId: raceExisting.id, contentHash, snapshot });
      templateId = raceExisting.id;
    }

    // EDGE PERSISTENCE (#180): same finalize-seam write as the upsert branch
    // above — covers both the fresh INSERT and the 23505-race upsert path.
    await writeDependencyEdgesToCanonicalRows(dependencyEdgeTargets, dependencyEdges);

    // Register agent-declared output object types (fresh-install branch).
    await registerDeclaredObjectTypes({
      extractedTempDir: extracted.tempDir,
      extractedPackageName: extracted.packageName,
      creatorId: input.creatorId ?? null,
    });

    // Commit the materialize (deletes .old backup).
    if (materializeResult !== null) {
      await commitMaterialize(materializeResult);
    }
    return {
      templateId,
      versionId,
      packageName: extracted.packageName,
      packageVersion: extracted.packageVersion,
      agentDependencies,
      missingProducedArtifacts,
      materialized: materializeResult?.materialized
        ? { targetDir: materializeResult.targetDir, wasReinstall: materializeResult.wasReinstall }
        : null,
      materializeSkippedReason:
        materializeResult && !materializeResult.materialized
          ? materializeResult.reason
          : undefined,
    };
    } catch (dbErr) {
      // DB-side failure in the fresh-install branch.
      // Roll back the materialize.
      if (materializeResult !== null) {
        await rollbackMaterialize(materializeResult);
      }
      throw dbErr;
    }
  } finally {
    await cleanupExtractedAgentPackage(extracted.tempDir);
  }
  });
}

// ---------------------------------------------------------------------------
// Produced-artifact advisory helper (cinatra#1059)
// ---------------------------------------------------------------------------

/**
 * Compute the agent's declared `cinatra.produces` artifact extensions that are
 * NOT installed+governing for the installing org scope. SOFT / best-effort:
 * the `produces` edge is advisory by construction, so a read failure degrades
 * to "no advisory" and NEVER fails the install. First production caller of the
 * cross-kind dependency graph (`resolveInstall`, SOFT mode).
 *
 * Dynamic imports keep the @cinatra-ai/agents → @cinatra-ai/extensions edge out
 * of the static graph (same posture as the manifest-dependencies import above).
 */
async function computeProducedArtifactAdvisory(input: {
  agentPackageName: string;
  manifest: unknown;
  orgId: string | null | undefined;
}): Promise<string[]> {
  try {
    const [{ readAgentProducesFromPackageManifest }, advisory, { readInstalledExtensionsByPackageNames }] =
      await Promise.all([
        import("@cinatra-ai/extensions/agent-produces-reader"),
        import("@cinatra-ai/extensions/cross-kind-dep-graph"),
        import("@cinatra-ai/extensions/canonical-store"),
      ]);
    const produces = readAgentProducesFromPackageManifest(input.manifest).map((r) => r.extension);
    if (produces.length === 0) return [];
    const rowsByPkg = await readInstalledExtensionsByPackageNames(produces);
    const rows = [...rowsByPkg.values()].flat();
    const installed = advisory.governingInstalledArtifactSet(rows, input.orgId ?? null);
    return advisory.computeMissingProducedArtifacts(input.agentPackageName, produces, installed);
  } catch (err) {
    console.warn(
      `[installAgentFromPackage] produced-artifact advisory skipped for ${input.agentPackageName}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

// ---------------------------------------------------------------------------
// Post-compile object-type registration helper
// ---------------------------------------------------------------------------

/**
 * After a package has been installed and its template row written, compile
 * the on-disk agent.json one more time and register any declared
 * `metadata.cinatra.output_object_types` entries via @cinatra-ai/objects'
 * `ensureDynamicObjectType` mutator.
 *
 * Invariants honored:
 *   - createdBy: input.creatorId is available here, unlike import-agent-core.
 *   - compiled.packageName must be non-null; never write the literal string
 *     "unknown" into originContext.
 *   - Skip type IDs already registered statically by @cinatra/* packages. Log
 *     a console.warn on category mismatch but never fail the install.
 *
 * Non-fatal: a thrown error is swallowed so the otherwise-successful install
 * does not roll back. The template row is already persisted at this point.
 */
async function registerDeclaredObjectTypes(opts: {
  extractedTempDir: string;
  extractedPackageName: string;
  creatorId: string | null;
}): Promise<void> {
  try {
    const compileResult = await compileOasAgentJson({
      packageName: opts.extractedPackageName,
      // The OAS source doc ships at <tempDir>/cinatra/oas.json (every published
      // @cinatra-ai/*-agent package declares files:["cinatra","skills"]). Prior
      // code passed <tempDir>/agent.json, which does NOT exist for
      // OAS-only tarballs — the compile silently no-op'd (the catch below
      // swallows it) and declared output_object_types were never registered.
      // Repointing to cinatra/oas.json fixes that latent bug.
      oasSourcePath: join(opts.extractedTempDir, "cinatra", "oas.json"),
    });
    if (
      compileResult.ok &&
      compileResult.value.producesObjectTypes?.length &&
      compileResult.value.packageName
    ) {
      for (const pt of compileResult.value.producesObjectTypes) {
        const staticReg = objectTypeRegistry.resolve(pt.typeId);
        if (staticReg) {
          if (staticReg.category !== pt.category) {
            console.warn(
              `[oas-install] type_id ${pt.typeId} declares category=${pt.category} but static registry has ${staticReg.category}; ignoring declaration`,
            );
          }
          continue;
        }
        await ensureDynamicObjectType({
          type: pt.typeId,
          inferredName: pt.displayName,
          inferredCategory: pt.category,
          canonicalKeys: pt.canonicalKeys ?? null,
          identityKey: pt.identityKey ?? null,
          source: "install",
          status: "active",
          createdBy: opts.creatorId, // input.creatorId is in scope here.
          originContext: { agentId: compileResult.value.packageName },
        });
      }
    }
  } catch (err) {
    // Type registration is non-fatal: install has already succeeded
    // (template row written). Log and continue.
    console.warn("[install-from-package] failed to register output_object_types:", err);
  }
}

// ---------------------------------------------------------------------------
// Canonical dependency-vocabulary reader for the shared resolver
// ---------------------------------------------------------------------------

/**
 * Read a packument version entry's transitive AGENT dependencies using the
 * SAME canonical vocabulary the batch-install saga plans with
 * (`parseManifestDependencyEdges`: `cinatra.dependencies` wins, legacy
 * `cinatra.agentDependencies` projected, BOTH-present must agree fail-loud).
 * This is the read seam injected into the shared `resolveDependencyTree` so the
 * direct full-tree agent installer and the saga planner resolve from ONE
 * source-of-truth instead of two divergent dependency keys.
 *
 * Returns the `{ packageName: semverRange }` map the resolver already consumes.
 * Only edges this direct path can actually install are projected:
 *   - auto-installable (required && non-peer) — the shared predicate the saga's
 *     dependency phase uses; peer/optional edges are never auto-installed.
 *   - AGENT-kind (or kind-undefined, the legacy `agentDependencies` shape that
 *     never declared a kind). The direct full-tree path installs each node via
 *     `installAgentFromPackage`, an AGENT-only installer; a CROSS-KIND edge
 *     (connector/skill/artifact/workflow) cannot be satisfied here, so it is
 *     fail-loud rather than handed to the agent installer. Cross-kind closures
 *     route through the kind-aware batch saga, not this direct adapter.
 *
 * Version constraints are projected to a range string: `semver-range` → range,
 * `exact` → the exact version (a valid singleton range), `git-ref` → fail-loud
 * (the registry resolver resolves semver against published versions, not refs).
 */
function readAgentPackumentDeps(entry: PackumentVersionEntry): Record<string, string> {
  // parseManifestDependencyEdges reads `manifest.cinatra.{dependencies,
  // agentDependencies}` and derives the package name from `manifest.name` for
  // its self-edge diagnostics. Shape the version entry into that manifest form.
  const { edges } = parseManifestDependencyEdges(
    { name: entry.name, cinatra: entry.cinatra },
    { packageName: entry.name },
  );
  const out: Record<string, string> = {};
  for (const edge of edges) {
    if (!isAutoInstallableEdge(edge)) continue;
    if (edge.kind !== undefined && edge.kind !== "agent") {
      throw new Error(
        `[installAgentPackageWithDependencies] ${entry.name} declares a required ${edge.kind} dependency on ${edge.packageName}; the direct agent full-tree installer can only install agent dependencies. Install cross-kind closures through the batch install saga.`,
      );
    }
    const vc = edge.versionConstraint;
    let range: string;
    if (vc.kind === "semver-range") {
      range = vc.range;
    } else if (vc.kind === "exact") {
      range = vc.version;
    } else {
      throw new Error(
        `[installAgentPackageWithDependencies] ${entry.name} declares a git-ref dependency on ${edge.packageName}; the registry resolver resolves semver against published versions, not git refs.`,
      );
    }
    out[edge.packageName] = range;
  }
  return out;
}

// ---------------------------------------------------------------------------
// installAgentPackageWithDependencies
// ---------------------------------------------------------------------------

export type InstallAgentPackageWithDependenciesInput = {
  packageName: string;
  packageVersion?: string;
  orgId?: string;
  /** cinatra#793: store-payload resolution scope for the ROOT node (see
   *  InstallAgentFromPackageInput.anchorOrgId). */
  anchorOrgId?: string | null;
  /** cinatra#793: require the ROOT node's finalized store payload (the
   *  dispatcher path); transitive dependency nodes always keep the registry
   *  extract (they never routed through the dispatcher pipeline). */
  requireStorePayloadForRoot?: boolean;
  creatorId?: string;
  // Includes "active"; mirrors InstallAgentFromPackageInput.
  status?: "draft" | "published" | "active";
  // Install-time owner tier. Forwarded to every transitive
  // installAgentFromPackage call so dependencies inherit the root install's
  // owner tuple. A team-owned root install means team-owned dependencies; the
  // team_admin who installed the root is, by extension, allowed to take the
  // dependencies into their team scope.
  ownerLevel?: "user" | "team" | "organization" | "workspace" | "project";
  ownerId?: string;
};

export type InstallAgentPackageWithDependenciesResult = {
  rootTemplateId: string;
  installedTemplateIds: string[];
  tree: DependencyTree;
  /** WayFlow reload result, fired once per tree install. */
  wayflowReload?: ReloadResult;
};

/**
 * Full-tree installer — resolves the entire agentDependencies graph of
 * `packageName` and installs each node via installAgentFromPackage (which
 * handles upsert-on-collision). Transitive installs are supported, and the
 * dependency resolver uses the "prefer-newer" conflict policy via
 * @cinatra-ai/registries.
 */
export async function installAgentPackageWithDependencies(
  input: InstallAgentPackageWithDependenciesInput,
  config?: VerdaccioConfig,
): Promise<InstallAgentPackageWithDependenciesResult> {
  // GLOBAL lifecycle lock before dependency resolution/extraction; serialized
  // against extensions_purge. Re-entrant so installAgentFromPackage -> this
  // nested call does not deadlock.
  return withGlobalExtensionLifecycleLock(() =>
    _installAgentPackageWithDependenciesImpl(input, config),
  );
}

async function _installAgentPackageWithDependenciesImpl(
  input: InstallAgentPackageWithDependenciesInput,
  config?: VerdaccioConfig,
): Promise<InstallAgentPackageWithDependenciesResult> {
  const resolvedConfig = ensureConfig(config, "installAgentPackageWithDependencies");
  // Build the explicit-flag args from the resolved config. Today the install
  // path uses pacote (HTTP) via
  // @cinatra-ai/registries.installPackageWithDependencies, so the flags are
  // not spliced into a spawn argv inside this function. Constructing them here
  // validates that the resolved config has a non-empty token early (the helper
  // throws on empty token at the install boundary, not just at the
  // publish/unpublish boundary) and keeps install-side flag construction
  // co-located with the entry point so any future out-of-band `pnpm install`
  // shell-out can splice these args directly without re-reading config.
  const _installAuthArgs = buildRegistryAuthArgs(resolvedConfig);
  void _installAuthArgs;
  // Dependency-confusion gate: confine the resolved tree to the ROOT package's
  // own vendor scope + the first-party base scope. Keying this on the root —
  // not on the installing instance's namespace (resolvedConfig.packageScope) —
  // is what lets ANY instance install first-party @cinatra-ai/* packages and
  // lets a vendor package depend on the first-party base layer (issue #103).
  // The instance namespace remains a publish-time concept only. Root
  // authorization (which packages may be installed at all) stays with the
  // marketplace/broker install grant + the callers' authz gates, which run
  // before this resolver. This also subsumes the previous dev-only
  // publish-scope-override branch: a dev-published @<override>/* root is
  // allowed via its own scope.
  const typeConfig: PluginTypeConfig = {
    type: "agent",
    scopePrefixes: dependencyScopePrefixesFor(input.packageName),
    // packumentDepKey is the legacy default; readPackumentDeps OVERRIDES it so
    // the shared resolver walks the canonical `cinatra.dependencies` vocabulary
    // (legacy `agentDependencies` projected) — the SAME source-of-truth the
    // batch-install saga plans with. ONE installer, ONE dependency vocabulary.
    // packumentDepKey is retained as the documented fallback semantics.
    packumentDepKey: "agentDependencies",
    readPackumentDeps: readAgentPackumentDeps,
  };
  const { tree, results } = await installPackageWithDependencies<string>({
    packageName: input.packageName,
    packageRange: input.packageVersion ?? "*",
    typeConfig,
    config: resolvedConfig,
    conflictPolicy: "prefer-newer",
    install: async (node) => {
      const isRootNode = node.packageName === input.packageName;
      const res = await installAgentFromPackage(
        {
          packageName: node.packageName,
          packageVersion: node.resolvedVersion,
          orgId: input.orgId,
          creatorId: input.creatorId,
          status: input.status,
          // cinatra#793: only the ROOT node is dispatcher-routed (its store
          // payload is finalized); transitive nodes keep the registry extract.
          ...(isRootNode && input.anchorOrgId !== undefined
            ? { anchorOrgId: input.anchorOrgId }
            : {}),
          ...(isRootNode && input.requireStorePayloadForRoot ? { requireStorePayload: true } : {}),
          // Transitively-installed dependencies inherit the
          // root install's owner tuple. A team-owned root install means
          // team-owned dependencies; the team_admin who installed the root
          // is, by extension, allowed to take the dependencies into their
          // team scope. The auth gate ran ONCE for the root; transitive
          // installs do not re-check.
          ownerLevel: input.ownerLevel,
          ownerId: input.ownerId,
        },
        resolvedConfig,
      );
      return res.templateId;
    },
  });
  // results[] is in the same alphabetical order installResolvedTree uses.
  const sortedNames = [...tree.all.keys()].sort();
  const rootIdx = sortedNames.indexOf(tree.root.packageName);
  if (rootIdx < 0) {
    throw new Error(`Root package ${tree.root.packageName} not present in installed results`);
  }
  const rootTemplateId = results[rootIdx];

  // Single reload trigger per full-tree install.
  // installAgentFromPackage does NOT reload on its own (to avoid N reloads
  // for an N-dep tree). This is the canonical single-shot trigger.
  // Failure is non-fatal: durable DB + disk writes have already succeeded;
  // the reload is best-effort and the caller surfaces the result.
  //
  // Log reload failures here so operators see them in container/server logs
  // even when the surrounding caller (extensionRegistry.install via
  // packages/extensions/actions.ts) discards the wayflowReload field on its
  // way to a `{ success: true }` response.
  // triggerWayflowReload is designed to return a typed { ok:false } instead of
  // throwing, but guard defensively (#157): a thrown reload (e.g. an
  // unexpected client error) must NEVER fail a completed full-tree install —
  // the durable DB + disk writes already landed. A throw is mapped to the
  // typed network-failure shape so the return contract is preserved.
  let wayflowReload: ReloadResult;
  try {
    wayflowReload = await triggerWayflowReload();
  } catch (reloadErr) {
    wayflowReload = {
      ok: false,
      reason: "network",
      detail: reloadErr instanceof Error ? reloadErr.message : String(reloadErr),
    };
  }
  if (!wayflowReload.ok) {
    console.warn(
      `[installAgentPackageWithDependencies] wayflow reload returned ok:false reason=${wayflowReload.reason} detail=${wayflowReload.detail ?? "—"} (extension ${input.packageName} is published+installed but the runtime may need a restart or another reload trigger)`,
    );
  }

  return {
    rootTemplateId,
    installedTemplateIds: results,
    tree,
    wayflowReload,
  };
}
