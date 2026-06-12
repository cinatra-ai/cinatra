import "server-only";
// Consumes @cinatra-ai/registries for tarball extraction and full-tree
// installs. Agent-specific schema validation is re-applied after the generic
// extract, and reinstall uses upsert semantics so install-after-bootstrap does
// not collide on the agent_templates.packageName unique index.

import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  cleanupExtractedAgentPackage,
  dependencyScopePrefixesFor,
  ensureConfig,
  extractAgentPackage,
  installPackageWithDependencies,
  type DependencyTree,
  type PluginTypeConfig,
  type VerdaccioConfig,
} from "@cinatra-ai/registries";
import {
  agentPackageManifestSchema,
  agentPackagePayloadSchema,
  CINATRA_AGENT_PACKAGE_TYPE,
  CINATRA_AGENT_MANIFEST_VERSION,
} from "./verdaccio/package-contract";
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
import { resolveAgentInstallDir } from "./agent-install-path";
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

export type InstallAgentFromPackageInput = {
  packageName: string;
  packageVersion?: string;
  orgId?: string;
  creatorId?: string;
  // Includes "active" so the install handler can pass status:"active" and
  // newly installed extensions appear in /agents/run (which filters by status
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
  agentDependencies: Record<string, string>;
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

async function _installAgentFromPackageImpl(
  input: InstallAgentFromPackageInput,
  config?: VerdaccioConfig,
): Promise<InstallAgentFromPackageResult> {
  const resolvedConfig = ensureConfig(config, "installAgentFromPackage");
  const extracted = await extractAgentPackage(
    {
      packageName: input.packageName,
      packageVersion: input.packageVersion,
    },
    resolvedConfig,
  );
  // Install transaction lock spans materialize -> DB write -> commit/rollback.
  // The lock is re-entrant via AsyncLocalStorage in materialize-agent-package,
  // so callers that hold an outer lock, such as extension-handler around its
  // skill-registration compensation flow, re-enter without deadlock.
  return withInstallLock(extracted.packageName, async () => {
  try {
    // Plugin-system returns raw manifest/payload; re-apply agent-specific validation.
    const manifest = agentPackageManifestSchema.parse(extracted.manifest);
    const payload = agentPackagePayloadSchema.parse(extracted.payload);

    if (manifest.cinatra.packageType !== CINATRA_AGENT_PACKAGE_TYPE) {
      throw new Error(`Unsupported package type: ${manifest.cinatra.packageType}`);
    }
    if (manifest.cinatra.manifestVersion !== CINATRA_AGENT_MANIFEST_VERSION) {
      throw new Error(`Unsupported manifest version: ${manifest.cinatra.manifestVersion}`);
    }

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
      const pin = checkRequiredExtensionVersionPin({
        packageName: extracted.packageName,
        version: extracted.packageVersion,
        // Accurate op label for the refusal copy: an existing template row
        // means this is the upsert/update route. Read-only; the upsert branch
        // below re-reads its own snapshot after materialize as before.
        op: (await readAgentTemplateByPackageName(extracted.packageName)) ? "update" : "install",
      });
      if (!pin.ok) throw new Error(pin.reason);
    }

    const rawDeps = (manifest.cinatra as { agentDependencies?: Record<string, string> })
      .agentDependencies;
    const agentDependencies: Record<string, string> = rawDeps ?? {};

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
    const { parseManifestDependencyEdges, resolveLiveCanonicalEdgeTargets, writeDependencyEdgesToCanonicalRows } = await import(
      "@cinatra-ai/extensions/manifest-dependencies"
    );
    const dependencyEdges = parseManifestDependencyEdges(extracted.manifest, {
      packageName: extracted.packageName,
    }).edges;
    const dependencyEdgeTargets = await resolveLiveCanonicalEdgeTargets({
      packageName: extracted.packageName,
    });

    // Propagate manifest.cinatra.type into the template row.
    const rawType = (manifest.cinatra as { type?: unknown }).type;
    // Recognize OAS-aligned aliases ("node", "flow") and canonical values
    // stored on the agent_templates row ("leaf", "orchestrator"). This keeps
    // the DB representation stable while letting agent.json use OAS terms.
    // TYPE_TO_GRAPH already accepts both, but some screen/execution branches
    // still test against the stored row values, so canonicalizing here keeps
    // those branches stable.
    const type: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative" | "flow" | "node" =
      rawType === "proxy" ? "proxy"
      : rawType === "orchestrator" ? "orchestrator"
      : rawType === "flow" ? "flow"
      : rawType === "parallel" ? "parallel"
      : rawType === "supervisor" ? "supervisor"
      : rawType === "iterative" ? "iterative"
      : rawType === "node" ? "node"
      : "leaf";

    // Propagate lgGraphCode / lgGraphId from the package payload into the new row.
    const lgGraphCode: string | null = payload.template.lgGraphCode ?? null;
    const lgGraphId: string | null = payload.template.lgGraphId ?? null;
    const executionProvider: string | null =
      (payload.template as { executionProvider?: string }).executionProvider ?? null;

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
      agentInstallDir: resolveAgentInstallDir(),
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
      const snapshot = payload.version.snapshot;
      const contentHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      const versionId = randomUUID();

      try {
      // Update scalar fields on the existing template row. Field list mirrors
      // the seed passed to createLocalAgentTemplateVersion below — every seed
      // field the fresh-install branch writes must land on the upsert branch too.
      await updateAgentTemplate(existing.id, {
        name: payload.title?.trim() || payload.template.name,
        description: (payload.description ?? payload.template.description) ?? undefined,
        sourceNl: payload.template.sourceNl,
        compiledPlan: payload.template.compiledPlan as CompiledStep[] | undefined,
        inputSchema: payload.template.inputSchema,
        outputSchema: payload.template.outputSchema ?? undefined,
        approvalPolicy: payload.template.approvalPolicy as ApprovalPolicy | undefined,
        type,
        taskSpec: payload.template.taskSpec ?? undefined,
        lgGraphCode,
        lgGraphId,
        executionProvider: (executionProvider as "openai" | "anthropic" | "gemini" | "langgraph" | "wayflow" | "default" | null) ?? undefined,
        agentDependencies:
          Object.keys(agentDependencies).length > 0 ? agentDependencies : undefined,
        hitlScreens: (payload.template as { hitlScreens?: string[] }).hitlScreens ?? undefined,
        status: input.status ?? existing.status,
        // Owner tier must follow the install target on re-install too.
        // Otherwise the audit row written by installRegistryPackageAtScope says
        // targetScope: { level: "team", id: "team-X" } while this DB row keeps
        // the prior owner_level / owner_id, producing an auth-vs-state divergence
        // for any downstream reader (e.g. enforceResourceAccess) that consults
        // agent_templates.owner_level / owner_id. The fresh-install branch below
        // writes these via the freshSeed; the upsert branch must do the same.
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
      name: payload.title?.trim() || payload.template.name,
      description:
        payload.description ?? payload.template.description,
      sourceNl: payload.template.sourceNl,
      compiledPlan: payload.template.compiledPlan,
      inputSchema: payload.template.inputSchema,
      outputSchema: payload.template.outputSchema,
      approvalPolicy: payload.template.approvalPolicy,
      type,
      taskSpec: payload.template.taskSpec,
      snapshot: payload.version.snapshot,
      creatorId: input.creatorId,
      orgId: input.orgId,
      // Owner tier flows through the seed into createAgentTemplate.
      ownerLevel: input.ownerLevel,
      ownerId: input.ownerId,
      packageName: extracted.packageName,
      packageVersion: extracted.packageVersion,
      agentDependencies:
        Object.keys(agentDependencies).length > 0 ? agentDependencies : undefined,
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
      const snapshot = payload.version.snapshot;
      const contentHash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
      versionId = randomUUID();
      await updateAgentTemplate(raceExisting.id, {
        name: payload.title?.trim() || payload.template.name,
        description: (payload.description ?? payload.template.description) ?? undefined,
        sourceNl: payload.template.sourceNl,
        compiledPlan: payload.template.compiledPlan as CompiledStep[] | undefined,
        inputSchema: payload.template.inputSchema,
        outputSchema: payload.template.outputSchema ?? undefined,
        approvalPolicy: payload.template.approvalPolicy as ApprovalPolicy | undefined,
        type,
        taskSpec: payload.template.taskSpec ?? undefined,
        lgGraphCode,
        lgGraphId,
        executionProvider: (executionProvider as "openai" | "anthropic" | "gemini" | "langgraph" | "wayflow" | "default" | null) ?? undefined,
        agentDependencies:
          Object.keys(agentDependencies).length > 0 ? agentDependencies : undefined,
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
      // Tarball extracts to <tempDir>/agent.json + <tempDir>/package.json
      // (verified in @cinatra-ai/registries extractAgentPackage).
      agentJsonPath: join(opts.extractedTempDir, "agent.json"),
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
// installAgentPackageWithDependencies
// ---------------------------------------------------------------------------

export type InstallAgentPackageWithDependenciesInput = {
  packageName: string;
  packageVersion?: string;
  orgId?: string;
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
    packumentDepKey: "agentDependencies",
  };
  const { tree, results } = await installPackageWithDependencies<string>({
    packageName: input.packageName,
    packageRange: input.packageVersion ?? "*",
    typeConfig,
    config: resolvedConfig,
    conflictPolicy: "prefer-newer",
    install: async (node) => {
      const res = await installAgentFromPackage(
        {
          packageName: node.packageName,
          packageVersion: node.resolvedVersion,
          orgId: input.orgId,
          creatorId: input.creatorId,
          status: input.status,
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
  const wayflowReload = await triggerWayflowReload();
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
