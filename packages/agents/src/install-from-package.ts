import "server-only";
// Consumes @cinatra-ai/registries for tarball extraction. Agent-specific
// schema validation is re-applied after the generic extract, and reinstall
// uses upsert semantics so install-after-bootstrap does not collide on the
// agent_templates.packageName unique index. The FULL-TREE installer lives in
// ./install-package-with-dependencies (cinatra#1039 Phase 2: unified planner).

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  cleanupExtractedAgentPackage,
  ensureConfig,
  extractAgentPackage,
  type VerdaccioConfig,
} from "@cinatra-ai/registries";
import {
  parseAgentPackageManifestForInstall,
  resolveTypedProducesContract,
  artifactDepVersionQuery,
  CINATRA_AGENT_PACKAGE_TYPE,
  CINATRA_AGENT_MANIFEST_VERSION,
} from "./verdaccio/package-contract";
// seed the agent_templates row DIRECTLY from cinatra/oas.json +
// the validated package.json#cinatra block. No materialized `agent.json`
// formatVersion:2 payload is read, synthesized, or re-parsed on the install path.
import { buildAgentTemplateInstallSeed } from "./build-agent-template-seed";
import { createLocalAgentTemplateVersion } from "./import-export-actions";
import {
  readAgentTemplateByPackageName,
  updateAgentTemplate,
  updateAgentTemplatePackageVersion,
  createAgentVersion,
  type CompiledStep,
  type ApprovalPolicy,
} from "./store";
import { resolveAgentRuntimeMountDir } from "./agent-runtime-mount";
import {
  materializeAgentPackageToDisk,
  commitMaterialize,
  rollbackMaterialize,
  withInstallLock,
  withGlobalExtensionLifecycleLock,
  type MaterializeResult,
} from "./materialize-agent-package";
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

    // TYPED-PRODUCTION PREFLIGHT (cinatra#1788, epic #1785): the manifest
    // `cinatra.produces` contract is the ONLY path for typed agent output.
    // Every produces entry MUST resolve to a REQUIRED artifact-kind dependency
    // in the install closure whose manifest declares the referenced object-type
    // claim (exact objectTypeId when the entry carries one). Enforced
    // FAIL-CLOSED HERE, in the same inert window as the pin / dependency-edge
    // gates above — BEFORE the disk materialize and any agent_templates / skill
    // write, so a refusal mutates nothing. REPLACES the removed post-write
    // produced-artifact advisory (#1059): no mutate-then-warn path remains and
    // no dynamic type is minted. The required artifact-kind dependency's claims
    // resolve from the registry (the same PLANNED-closure manifests the batch
    // saga installs), never by querying post-write installed state.
    await enforceTypedProducesContractForInstall({
      manifest: extracted.manifest,
      packageName: extracted.packageName,
      packageVersion: extracted.packageVersion,
      config: resolvedConfig,
    });

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
// Typed-production install preflight (cinatra#1788, epic #1785)
// ---------------------------------------------------------------------------

/**
 * FAIL-CLOSED preflight for an agent's `cinatra.produces` typed-production
 * contract — the ONLY path for typed agent output. Resolves the agent's
 * REQUIRED artifact-kind dependencies from the registry (the PLANNED-closure
 * manifests, the same ones the batch saga installs) and verifies every
 * produces entry resolves to one whose manifest declares the referenced
 * object-type claim (the exact `objectTypeId` when the entry carries one).
 * THROWS a precise error NAMING the missing claimant/claim on any violation —
 * the caller (direct install or batch-saga member) aborts BEFORE any write, so
 * a refusal mutates nothing. A no-produces agent is a no-op.
 *
 * REPLACES the removed produced-artifact advisory (#1059): typed production is
 * the enforced manifest contract, not a soft post-write signal, and no dynamic
 * type is minted. Dynamic imports keep the @cinatra-ai/agents →
 * @cinatra-ai/extensions / @cinatra-ai/registries edges off the static graph
 * (same posture as the manifest-dependencies / store-payload reads above).
 */
async function enforceTypedProducesContractForInstall(input: {
  manifest: unknown;
  packageName: string;
  packageVersion: string;
  config: VerdaccioConfig;
}): Promise<void> {
  const { readAgentProducesFromPackageManifest } = await import(
    "@cinatra-ai/extensions/agent-produces-reader"
  );
  const produces = readAgentProducesFromPackageManifest(input.manifest);
  if (produces.length === 0) return;
  const cinatraDependencies = (
    input.manifest as { cinatra?: { dependencies?: unknown } } | null | undefined
  )?.cinatra?.dependencies;
  const { getPublishedExtensionSummary, resolveMaxSatisfyingVersion } = await import(
    "@cinatra-ai/registries"
  );
  const findings = await resolveTypedProducesContract({
    produces,
    cinatraDependencies,
    resolveManifest: async (dep, versionConstraint) => {
      try {
        // Resolve the manifest at the EXACT version the edge PINS — never
        // `latest`; matches the version the install closure selects. An
        // unsatisfiable range or a non-registry pin (git-ref / malformed) FAILS
        // CLOSED (return null → typed entry BLOCKS).
        const q = artifactDepVersionQuery(versionConstraint);
        let packageVersion: string;
        if ("exact" in q) {
          packageVersion = q.exact;
        } else if ("range" in q) {
          const resolved = await resolveMaxSatisfyingVersion(
            { packageName: dep, range: q.range },
            input.config,
          );
          if (!resolved) return null; // no satisfying version → fail closed
          packageVersion = resolved;
        } else {
          return null; // git-ref / malformed constraint → fail closed
        }
        const summary = await getPublishedExtensionSummary(
          { packageName: dep, packageVersion },
          input.config,
        );
        return summary.manifest;
      } catch {
        // A not-found / unresolvable required dependency contributes no claims
        // (fail-closed: a typed produces entry then reads as unclaimed → BLOCK).
        return null;
      }
    },
  });
  if (findings.length > 0) {
    throw new Error(
      `[installAgentFromPackage] typed-production contract failed for ` +
        `${input.packageName}@${input.packageVersion} (cinatra#1788): ` +
        `${findings.map((f) => f.message).join(" | ")}`,
    );
  }
}
