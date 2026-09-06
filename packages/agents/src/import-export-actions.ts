"use server";

// File-level "use server" directive so these server actions can be imported
// by client components (import-form.tsx) safely.
//
// Agent ZIP format (app upload path — import-form.tsx, the MCP import
// handler, and the startup ensure-agent-package builders all produce or
// consume this shape):
//   - agent.json    : an OAS Flow document (component_type: "Flow"). DB
//                     column values (inputSchema, approvalPolicy, prompt,
//                     packageName, ...) are DERIVED by compileOasAgentJson,
//                     never read as literal fields.
//   - manifest.json : { version: 1, ... } — importAgentTemplateCore rejects
//                     any other version.
//   - package.json  : optional sibling carrying packageName/packageVersion +
//                     cinatra.agentDependencies (and the SPDX `license` field
//                     consumed by detectSpdxLicense).
//   - LICENSE / LICENSE.md / COPYING / .spdx : optional license sidecars,
//                     staged for the SPDX detection gate. The MCP
//                     agent_export handler ships the real on-disk
//                     package.json + license files so its archives pass this
//                     gate and upsert by packageName on restore.
// The round trip is guarded by the manifest-version check plus full OAS
// compilation/validation on import. (A former exportAgentTemplate server
// action emitted a different, incompatible envelope — componentType "Agent"
// with metadata.cinatra.formatVersion 2 — that the importer could never
// parse; it had no callers and was removed. The CLI's `cinatra agent
// export/import` pair speaks its own self-consistent legacy formatVersion-1
// shape and is intentionally NOT covered by this contract.)

import { createHash, randomUUID } from "node:crypto";
import { requireAdminSession } from "@/lib/auth-session";
import {
  createAgentTemplate,
  createAgentVersion,
  readAgentTemplateById,
} from "./store";
import type { CreateAgentTemplateInput } from "./store";
import { importAgentTemplateCore } from "./import-agent-core";
import { publishAgentTemplateAndBindVersion } from "./publish-template";
import { deriveAgentTemplateIdentityClaim } from "./agent-template-identity";
import { resolveInstallRowAnchor, sameRowAnchor } from "@cinatra-ai/extensions/canonical-types";
import { verifyReceivedArchiveDigest } from "./received-package-digest";
import { authorizeUploadInstallScope } from "./upload-install-authorization";
import { uploadAccessResourceKindFor } from "./upload-install-scope";
import { logAuditEvent } from "@/lib/authz";
import { POLICY_VERSION } from "@/lib/authz/actor-context";

// ---------------------------------------------------------------------------
// createLocalAgentTemplateVersion — shared creation path for ZIP imports and
// registry installs
// ---------------------------------------------------------------------------

export type LocalAgentTemplateSeed = {
  name?: string;
  description?: string | null;
  sourceNl?: string;
  compiledPlan?: unknown;
  inputSchema?: unknown;
  outputSchema?: unknown | null;
  approvalPolicy?: unknown;
  taskSpec?: unknown;
  snapshot?: Record<string, unknown> | null;
  creatorId?: string;
  orgId?: string;
  status?: string;
  packageName?: string;
  packageVersion?: string;
  /**
   * @deprecated DECLARE/WRITE surface for the legacy `cinatra.agentDependencies`
   * vocabulary. The canonical replacement is `cinatra.dependencies` (read via
   * `parseManifestDependencyEdges`). Kept during the deprecation window for
   * back-compat with the ZIP-import / registry-install seed shape. (Removal
   * tracked as a follow-up milestone.)
   */
  // cinatra#1058: widened to the requirement-carrying union — an OPTIONAL
  // projected agent edge is `{ range, requirement: "optional" }`; REQUIRED /
  // legacy entries stay bare range strings.
  agentDependencies?: Record<string, string | { range: string; requirement: "required" | "optional" }>; // @cinatra/* dep ranges (+requirement)
  /**
   * Connector-dependency map projected from the canonical `cinatra.dependencies`
   * `kind: "connector"` edges (cinatra#1056). Each value carries the edge's
   * `requirement` so the run-enqueue connector preflight gates on the real
   * requirement. UNION value for back-compat: a bare string range (legacy
   * publish path) normalizes to `{ range, requirement: "required" }` downstream.
   */
  connectorDependencies?: Record<string, string | { range: string; requirement: "required" | "optional" }>;
  type?: "leaf" | "proxy" | "orchestrator" | "parallel" | "supervisor" | "iterative" | "flow" | "node"; // defaults to "leaf" if omitted
  // Namespaced x-renderer IDs the agent declares as HITL states. Threaded into
  // createAgentTemplate so a fresh registry install seeds hitlScreens with the
  // same value the upsert branch writes (parity across fresh / upsert / race).
  hitlScreens?: string[];
  lgGraphCode?: string | null;
  lgGraphId?: string | null;
  executionProvider?: "openai" | "anthropic" | "gemini" | "langgraph" | "wayflow" | "default";
  /** The compiled agent-manifest LIFECYCLE declaration as JSON-as-text
   * (cinatra#2047 D-1) — threaded so a FRESH registry install seeds
   * `agent_templates.lifecycle_config` with the same value the upsert / race
   * branches write (three-branch parity, exactly like hitlScreens). */
  lifecycleConfig?: string | null;
  /** Whether the compiled OAS document declares at least one
   * `outputs[].cinatra.artifact` binding (cinatra#2498) — threaded so a FRESH
   * registry install / ZIP import seeds `agent_templates.has_artifact_bindings`
   * with the same value the upsert / race branches write (three-branch
   * parity, exactly like hitlScreens / lifecycleConfig). Undefined/omitted
   * normalizes to NULL ("unknown") at the store layer. */
  hasArtifactBindings?: boolean | null;
  /** The EXECUTED artifact-binding declaration as JSON-as-text (cinatra#3208) —
   * threaded so a FRESH registry install / ZIP import seeds
   * `agent_templates.artifact_bindings` with the same value the upsert / race
   * branches write (three-branch parity, exactly like hasArtifactBindings).
   *
   * This field is load-bearing precisely BECAUSE the writer below does not
   * spread its seed: it threads an explicit field list, so a seed field absent
   * from that list is dropped silently, with no type error (the seed arrives as
   * a variable, not a fresh object literal, so excess-property checking never
   * runs). Dropping it landed `has_artifact_bindings = true` beside
   * `artifact_bindings = NULL` on every first install — a row claiming bindings
   * exist while offering no way to read the ones this version compiled — and
   * the run-completion materializer then fell back to the pre-#3208 registry
   * re-read that #3208 exists to remove. Undefined/omitted normalizes to NULL
   * ("unknown") at the store layer. */
  artifactBindings?: string | null;
  // Install-time owner tier. NULL means a row whose owner tier has not been
  // normalized yet. Threaded from installRegistryPackageAtScope's target
  // through installAgentPackageWithDependencies -> installAgentFromPackage.
  ownerLevel?: "user" | "team" | "organization" | "workspace" | "project";
  ownerId?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}


function normalizeCompiledPlan(value: unknown): CreateAgentTemplateInput["compiledPlan"] {
  return Array.isArray(value) ? (value as CreateAgentTemplateInput["compiledPlan"]) : [];
}

function normalizeRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function normalizeNullableRecord(value: unknown): Record<string, unknown> | null {
  if (value == null) return null;
  return isRecord(value) ? value : null;
}

function normalizeApprovalPolicy(value: unknown): CreateAgentTemplateInput["approvalPolicy"] {
  return isRecord(value)
    ? (value as CreateAgentTemplateInput["approvalPolicy"])
    : { steps: [] };
}

/**
 * Shared local creation path for ZIP imports and registry installs.
 * Creates an agent template + initial version from a seed payload.
 */
export async function createLocalAgentTemplateVersion(input: {
  seed: LocalAgentTemplateSeed;
  nameOverride?: string;
}): Promise<{ templateId: string; versionId: string }> {
  const snapshotInput = isRecord(input.seed.snapshot) ? input.seed.snapshot : {};
  const sourceNlValue = snapshotInput.sourceNl ?? input.seed.sourceNl;
  const compiledPlanValue = snapshotInput.compiledPlan ?? input.seed.compiledPlan;
  const inputSchemaValue = snapshotInput.inputSchema ?? input.seed.inputSchema;
  const outputSchemaValue = snapshotInput.outputSchema ?? input.seed.outputSchema;
  const approvalPolicyValue = snapshotInput.approvalPolicy ?? input.seed.approvalPolicy;
  const taskSpecValue = snapshotInput.taskSpec ?? input.seed.taskSpec;
  const sourceNl = typeof sourceNlValue === "string" ? sourceNlValue : "";
  const compiledPlan = normalizeCompiledPlan(compiledPlanValue);
  const inputSchema = normalizeRecord(inputSchemaValue);
  const outputSchema = normalizeNullableRecord(outputSchemaValue);
  const approvalPolicy = normalizeApprovalPolicy(approvalPolicyValue);
  const taskSpec = typeof taskSpecValue === "string" ? taskSpecValue : null;
  const templateId = randomUUID();
  const versionId = randomUUID();
  const name = input.nameOverride?.trim() || input.seed.name?.trim() || "Imported Agent";
  const snapshot = {
    ...snapshotInput,
    sourceNl,
    compiledPlan,
    inputSchema,
    outputSchema,
    approvalPolicy,
    taskSpec,

  };

  const template = await createAgentTemplate({
    id: templateId,
    orgId: input.seed.orgId,
    // Owner tier threaded from installRegistryPackageAtScope.
    ownerLevel: input.seed.ownerLevel,
    ownerId: input.seed.ownerId,
    creatorId: input.seed.creatorId,
    name,
    description: input.seed.description ?? undefined,
    sourceNl,
    compiledPlan,
    inputSchema,
    outputSchema: outputSchema ?? undefined,
    approvalPolicy,

    taskSpec: taskSpec ?? undefined,
    packageName: input.seed.packageName,
    packageVersion: input.seed.packageVersion,
    agentDependencies: input.seed.agentDependencies,
    connectorDependencies: input.seed.connectorDependencies,
    hitlScreens: input.seed.hitlScreens,
    type: input.seed.type, // serializer defaults to "leaf" when undefined
    lgGraphCode: input.seed.lgGraphCode ?? null,
    lgGraphId: input.seed.lgGraphId ?? null,
    executionProvider: input.seed.executionProvider ?? undefined,
    lifecycleConfig: input.seed.lifecycleConfig ?? null,
    hasArtifactBindings: input.seed.hasArtifactBindings ?? null,
    // cinatra#3208 — the executed declaration rides the SAME create as
    // packageVersion and the presence flag above. It must move with them or the
    // materializer's version-pin guard is reading a pair that never agreed.
    artifactBindings: input.seed.artifactBindings ?? null,
    status: (input.seed.status as "draft" | "published") ?? "draft",
  });

  await createAgentVersion({
    id: versionId,
    templateId: template.id,
    contentHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"),
    snapshot,
  });

  return { templateId: template.id, versionId };
}

export async function importAgentTemplate(
  zipBase64: string,
  nameOverride?: string,
  options?: {
    redirect?: boolean;
    status?: "draft" | "published";
    /** Destination chosen via PublishDestinationPicker; importAgentTemplateCore
     *  resolves the publish destination. */
    destination?: "private" | "public";
    /** Set true after user acknowledges LicenseWarningDialog for copyleft.
     *  importAgentTemplateCore re-validates the flag before registering. */
    licenseAcknowledged?: boolean;
    /** Upload-time permissions captured by PermissionsFormDraft on
     *  the ZIP upload form. The new template lands in cinatra.agent_templates
     *  and its polymorphic permission rows are seeded after registration. */
    permissions?: {
      policy?: import("./auth-policy-types").AgentAuthPolicy;
      coOwnerUserIds?: string[];
    };
    /**
     * The INSTALL SCOPE the operator configured on the Upload screen
     * (cinatra#3204) — the store's own question, asked with the store's own
     * picker: WHO IS THIS EXTENSION INSTALLED FOR.
     *
     * It is a different question from `permissions` above, which carries the
     * agent's RUN VISIBILITY (who may list / read / execute its runs). Both are
     * kept, separately labelled on the screen, because collapsing them would
     * make one control silently answer the other's question.
     *
     * When present the road changes in three ways, all of them the store road's
     * behaviour: the canonical row anchors at the chosen target instead of a
     * derivation the operator never saw; the actor's AUTHORITY to install at
     * that target is asserted server-side before anything is written; and the
     * audience policy is persisted FAIL-CLOSED — a failed write rolls a fresh
     * upload back rather than leaving it at the broader default.
     *
     * ABSENT — every programmatic caller, and the MCP import handler — keeps
     * today's behaviour byte-for-byte.
     */
    installScope?: { pickerValue: string };
    /**
     * The D2 content digest the intake computed over the delivered tree
     * (cinatra#3204). Recorded on the canonical row's `local` provenance, so the
     * row states WHICH BYTES were installed rather than only that an upload
     * happened. Absent = no attestation recorded, as before.
     */
    packageContentDigest?: string;
    /** UI upload path only (owner ruling, PR #2658): after the archive lands,
     *  flip the template live AND bind its compiled version in the ONE
     *  transactional store operation (`publishAgentTemplateAndBindVersion`) —
     *  an admin upload goes straight to /agents in its assigned scope, with
     *  no draft limbo and no approval step. Other callers (the MCP ZIP import
     *  handler, programmatic imports) keep today's explicit-status contract
     *  and land drafts unless they say otherwise. */
    publishAndBind?: boolean;
  },
): Promise<{ templateId: string; upserted: boolean; warnings: string[] }> {
  const session = await requireAdminSession();
  // Capture the import actor as the agent template's creator. This attributes
  // the template so /configuration/extensions list views can show "installed by"
  // and supports per-template access-policy gates.
  const creatorId = session.user?.id ?? undefined;
  const { permissions, publishAndBind, installScope: installScopeInput, packageContentDigest, ...coreOptions } =
    options ?? {};
  // cinatra#2616: this admin action is a package-name IDENTITY CLAIM. Thread the
  // session's active organization as the claimant so an import cannot take over
  // a name another organization already holds. A session with no active org
  // claims as the instance operator, exactly as boot seeding does.
  const claimantOrgId =
    (session as { session?: { activeOrganizationId?: string | null } }).session
      ?.activeOrganizationId ?? null;
  // cinatra#3204 (criteria 13-15) — RESOLVE AND AUTHORIZE THE INSTALL SCOPE
  // FIRST. It runs before the archive is imported, so a target the actor may
  // not install at, or a value that is not an installable scope at all, writes
  // nothing: no template, no version, no canonical row.
  const installScope = installScopeInput
    ? await authorizeUploadInstallScope(
        session as unknown as { user: { id: string; role?: string | null }; session?: { activeOrganizationId?: string | null } | null },
        installScopeInput.pickerValue,
      )
    : null;

  // The canonical row anchor. With a configured scope it comes from the CHOSEN
  // TARGET through `resolveInstallRowAnchor` — the one rule that turns an
  // install request into the tuple a row is written at. Without one it is the
  // actor-derived default, which is byte-identical to the
  // `claimantOrgId ? "organization" : "platform"` derivation this replaced, so
  // every existing caller anchors exactly where it always did.
  const rowAnchor = installScope
    ? installScope.rowAnchor
    : resolveInstallRowAnchor(claimantOrgId, null);

  // cinatra#3204 (D2) — VERIFY THE ATTESTATION, do not relay it. The digest is
  // recomputed here over the archive that actually arrived; a mismatch throws
  // BEFORE the import, so a substituted package writes nothing. `verifiedDigest`
  // is what this process computed, never what the request claimed.
  const verifiedDigest = packageContentDigest
    ? await verifyReceivedArchiveDigest(zipBase64, packageContentDigest)
    : null;

  const result = await importAgentTemplateCore(zipBase64, nameOverride, {
    ...coreOptions,
    creatorId,
    claimantOrgId,
  });

  // Record install actor + seed upload-time policy / co-owners via the generic
  // permissions backend. Same shape as the GitHub flow: best-effort, warnings
  // surfaced to the operator.
  const warnings: string[] = [];
  if (creatorId) {
    try {
      const { setExtensionInstaller } = await import("@cinatra-ai/extensions/permissions-actions");
      const setResult = await setExtensionInstaller(
        "agent_template",
        result.templateId,
        creatorId,
      );
      if (!setResult.ok) {
        warnings.push(
          `Could not record install actor as primary owner — manage access at /configuration/extensions/${result.templateId}.`,
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        "[agents/import-export-actions] setExtensionInstaller failed (non-fatal):",
        message,
      );
      warnings.push(
        `Could not record install actor as primary owner — manage access at /configuration/extensions/${result.templateId}.`,
      );
    }
  }

  // cinatra#3204 (criterion 13) — THE INSTALL-SCOPE AUDIENCE, FAIL-CLOSED.
  //
  // The upload road used to write its access policy NON-FATALLY: a failed write
  // became a toast, and the extension stayed live at the BROADER default the
  // operator had just narrowed away from. That is the one failure mode an
  // access control must not have. The store road has always compensated instead,
  // and this is the same contract: the policy goes through the sanctioned
  // uniform install-time access contract, and a failure rolls a FRESH upload
  // back rather than leaving it installed at a scope nobody chose.
  //
  // It runs BEFORE the go-live flip below, so a rolled-back upload was never
  // active and never served.
  if (installScope) {
    try {
      const { setExtensionInstallAccess } = await import(
        "@cinatra-ai/extensions/install-access-contract"
      );
      await setExtensionInstallAccess({
        kind: uploadAccessResourceKindFor("agent"),
        resourceId: result.templateId,
        ...(installScope.policy ? { policy: installScope.policy } : {}),
        installedByUserId: creatorId ?? null,
      });
    } catch (accessErr) {
      const detail = accessErr instanceof Error ? accessErr.message : String(accessErr);
      if (!result.upserted) {
        // FRESH upload — remove it. Nothing was published or bound yet, so this
        // leaves the instance exactly as it was before the upload.
        try {
          const { deleteAgentTemplate } = await import("./store");
          await deleteAgentTemplate(result.templateId);
        } catch (rollbackErr) {
          // LOUD: an upload that could not be scoped AND could not be removed is
          // a live template at the wrong audience. Say so; do not mask it behind
          // the original error.
          throw new Error(
            `The uploaded extension could not be scoped (${detail}), and removing it again also ` +
              `failed (${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}). ` +
              `Agent template ${result.templateId} needs manual removal — it is installed but its ` +
              `access was never configured.`,
          );
        }
        throw new Error(
          `The uploaded extension could not be installed at the chosen scope (${detail}). ` +
            `Nothing was installed.`,
        );
      }
      // An UPDATE of a package that was already installed: its previous access
      // stands and must not be destroyed. Surface the partial state honestly
      // rather than reporting a scope that was not applied.
      throw new Error(
        `The extension was updated, but the chosen install scope could not be applied (${detail}). ` +
          `Its previous access is unchanged — re-apply the scope from the extension's permissions page.`,
      );
    }
  }

  if (permissions) {
    const { policy, coOwnerUserIds } = permissions;
    // The RUN-VISIBILITY policy (a different question from the install scope
    // above) keeps its established non-fatal write: it is the agent's own run
    // policy, editable afterwards on the agent's permissions surface, and a
    // failure to seed it has never been a reason to refuse the upload.
    if (policy) {
      try {
        const { saveExtensionAccessPolicy } = await import("@cinatra-ai/extensions/permissions-actions");
        const policyResult = await saveExtensionAccessPolicy(
          "agent_template",
          result.templateId,
          policy,
        );
        if (!policyResult.ok) {
          warnings.push(`Could not save access policy — re-save from the agent template detail page.`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.warn(
          "[agents/import-export-actions] saveExtensionAccessPolicy failed (non-fatal):",
          message,
        );
        warnings.push(`Could not save access policy — re-save from the agent template detail page.`);
      }
    }
    if (coOwnerUserIds && coOwnerUserIds.length > 0) {
      const { addExtensionCoOwner } = await import("@cinatra-ai/extensions/permissions-actions");
      const failedUserIds: string[] = [];
      for (const targetUserId of coOwnerUserIds) {
        try {
          const addResult = await addExtensionCoOwner(
            "agent_template",
            result.templateId,
            targetUserId,
          );
          if (!addResult.ok) failedUserIds.push(targetUserId);
        } catch (err) {
          console.warn(
            `[agents/import-export-actions] addExtensionCoOwner ${targetUserId} failed (non-fatal):`,
            err instanceof Error ? err.message : err,
          );
          failedUserIds.push(targetUserId);
        }
      }
      if (failedUserIds.length > 0) {
        warnings.push(
          `Could not add ${failedUserIds.length} co-owner${failedUserIds.length === 1 ? "" : "s"} — re-add from the agent template detail page.`,
        );
      }
    }
  }

  // Owner ruling (PR #2658 review, revised): an admin upload goes LIVE. Two
  // steps, both UI-upload-path only:
  //
  //   1. REGISTER the upload in the canonical installed-extensions store
  //      through the sanctioned lifecycle primitive, so the EXISTING
  //      installed list on /configuration/extensions shows it (the ZIP
  //      upload previously wrote no installed_extension row, so the list
  //      could never surface it). Probe first: the store insert is not an
  //      upsert, and a re-upload of an already-registered package is a
  //      template upsert, not a second row. An archived row is an operator
  //      decision; it is never auto-resurrected here.
  //   2. PUBLISH-AND-BIND: the status flip and the compiled-version binding
  //      (current_version_id) commit atomically in
  //      publishAgentTemplateAndBindVersion, AFTER the scope policy above is
  //      saved, so the agent surfaces on /agents already scoped. On failure
  //      the template stays a draft and the warning names the repair
  //      (re-upload upserts by packageName; the atomic op's dedup path
  //      re-points a half-bound version, never a masked no-op). All
  //      assistant guard arms stay: a refusal (null) is surfaced, not
  //      retried around.
  if (publishAndBind) {
    // ONE read shared by the registration and the audit record below: the
    // audit must report the REAL prior status (a re-upload of an
    // already-published package repairs, it does not transition), so the
    // read happens before the go-live flip (CodeRabbit finding).
    const template = await readAgentTemplateById(result.templateId).catch(() => null);
    const priorStatus = template?.status ?? "draft";
    try {
      if (template?.packageName) {
        const { readInstalledExtensionsByPackageName } = await import(
          "@cinatra-ai/extensions/canonical-store"
        );
        const existingRows = await readInstalledExtensionsByPackageName(template.packageName);
        if (existingRows.length === 0) {
          const { installExtensionManifest } = await import(
            "@cinatra-ai/extensions/lifecycle-primitive"
          );
          await installExtensionManifest(
            {
              id: `iext_${randomUUID().slice(0, 12)}`,
              packageName: template.packageName,
              // cinatra#3204 (criterion 15): the anchor comes from the CHOSEN
              // TARGET, resolved through `resolveInstallRowAnchor`. The retired
              // derivation produced an organization anchor whenever the session
              // had an active org, whichever scope the operator had picked — so
              // a "Workspace: All" upload landed org-anchored and reached only
              // that organization.
              ownerLevel: rowAnchor.ownerLevel,
              ownerId: rowAnchor.ownerId,
              organizationId: rowAnchor.organizationId,
              kind: "agent",
              source: {
                type: "local",
                path: `agent-template:${result.templateId}`,
                resolvedCommitOrTreeHash: `upload@${template.packageVersion ?? "0.0.0"}`,
                // cinatra#3204 (D2): WHICH BYTES were installed, when the intake
                // computed a digest over the delivered tree. A revision label is
                // not an attestation; this is.
                ...(verifiedDigest ? { contentDigest: verifiedDigest } : {}),
              },
              version: template.packageVersion ?? undefined,
              requiredInProd: false,
              dependencies: [],
              manifestHash: null,
              accessDeclaration: null,
            },
            {
              actor: { source: "ui", userId: creatorId },
              reason: "cinatra#2653: an admin upload registers as installed and goes live",
            },
          );
        } else if (
          !existingRows.some((r) => r.status === "active" || r.status === "locked")
        ) {
          warnings.push(
            "This package is archived in the installed-extensions store — restore it from the Archived tab on /configuration/extensions to relist it.",
          );
        } else if (installScope) {
          // cinatra#3204: a RE-UPLOAD of an already-registered package is a
          // template upsert — the canonical row is not re-written, so it keeps
          // the anchor it was first installed at. When the operator picked a
          // different scope this time, the picker's answer did NOT move the
          // row, and saying nothing would let the screen imply that it had.
          // Re-anchoring an existing row is the lifecycle primitive's own
          // operation, with supersession rules of its own; it is named as the
          // next leg rather than improvised here.
          const live = existingRows.filter(
            (r) => r.status === "active" || r.status === "locked",
          );
          if (
            live.length > 0 &&
            !live.some((r) =>
              sameRowAnchor(
                {
                  ownerLevel: r.ownerLevel,
                  ownerId: r.ownerId ?? null,
                  organizationId: r.organizationId ?? null,
                },
                rowAnchor,
              ),
            )
          ) {
            warnings.push(
              "This package is already installed at a different scope. The upload updated the agent, " +
                "but the installed-extensions entry keeps the scope it was first installed at — change it " +
                "from /configuration/extensions.",
            );
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // Check-then-insert race classification (CodeRabbit finding): two
      // concurrent uploads (or a double submit) can both probe zero rows;
      // the store's partial-unique default index then fails the SECOND
      // insert closed. Re-probe once — a live row means the package IS
      // registered (the concurrent writer won) and that is success, not a
      // warning.
      let racedToRegistered = false;
      if (template?.packageName) {
        try {
          const { readInstalledExtensionsByPackageName } = await import(
            "@cinatra-ai/extensions/canonical-store"
          );
          const rowsAfter = await readInstalledExtensionsByPackageName(template.packageName);
          racedToRegistered = rowsAfter.some(
            (r) => r.status === "active" || r.status === "locked",
          );
        } catch {
          // fall through to the warning
        }
      }
      if (!racedToRegistered) {
        console.warn(
          "[agents/import-export-actions] installed-extension registration failed (non-fatal):",
          message,
        );
        warnings.push(
          "The agent was imported but could not be registered in the installed-extensions list — re-upload the archive to retry.",
        );
      }
    }
    try {
      const published = await publishAgentTemplateAndBindVersion(result.templateId, {
        createdBy: creatorId ?? null,
        // The session's identity claim rides the flip's WHERE (CodeRabbit
        // security finding): an org-scoped admin can never flip another
        // tenant's template; an org-less session keeps the operator arm.
        claim: deriveAgentTemplateIdentityClaim({ claimantOrgId }),
      });
      if (!published) {
        warnings.push(
          "The agent was imported but could not go live (publish refused) — it stays a draft. Re-upload the archive to retry.",
        );
      } else {
        // Fire-and-forget audit; a failed audit write must not undo the
        // publish (same contract as promoteExtensionToPublicAction).
        try {
          void logAuditEvent({
            organizationId: published.record.orgId ?? undefined,
            actorPrincipalId: creatorId,
            actorPrincipalType: "human",
            authSource: "ui",
            resourceType: "agent_template",
            resourceId: published.record.id,
            operation: "update",
            decision: "allowed",
            policyVersion: POLICY_VERSION,
            metadata: {
              // The REAL prior status (read before the flip): a re-upload of
              // an already-published package records published→published
              // (the repair path), never a transition that did not happen.
              statusTransition: { from: priorStatus, to: "published" },
              boundVersionId: published.version.id,
              via: "upload-import",
            },
          }).catch((err: unknown) => {
            console.warn(
              "[agents/import-export-actions] logAuditEvent failed (non-fatal):",
              err instanceof Error ? err.message : err,
            );
          });
        } catch {
          // best-effort
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        "[agents/import-export-actions] publishAgentTemplateAndBindVersion failed (non-fatal):",
        message,
      );
      warnings.push(
        "The agent was imported but could not go live — it stays a draft. Re-upload the archive to retry.",
      );
    }
  }

  return { ...result, warnings };
}

