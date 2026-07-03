import "server-only";

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { parseWorkflowTemplateManifest } from "./manifest";
import {
  materializeTemplateFromManifest,
  findWorkflowTemplate,
  isTemplateInUse,
  deleteWorkflowTemplate,
  arePackageTemplatesInUse,
} from "./store";
import { parseWorkflowBpmnSidecar } from "./bpmn";
import {
  materializeExtensionTemplate,
  archiveExtensionDashboards,
  restoreExtensionDashboards,
  validateDashboardConfigV12,
} from "@cinatra-ai/dashboards/extension-materialization";

// Workflow-template marketplace lifecycle ops. The package owns the verifiable
// lifecycle; the host wraps these in an ExtensionTypeHandler (typeId "workflow")
// and registers it in handler-bootstrap, injecting agent/approver re-auth from
// the consuming workspace.

export type WorkflowExtensionDeps = {
  /** Re-resolve + re-authorize a referenced agent in the consuming org. */
  agentExists?: (agentRef: unknown, orgId: string) => boolean | Promise<boolean>;
  /** Re-resolve an approver scope in the consuming org. */
  approverResolvable?: (scope: unknown, orgId: string) => boolean | Promise<boolean>;
  /**
   * Resolve the org ids a platform admin can discover workflow templates across,
   * for the cross-org reader facet when there is NO active org (workflow_template
   * rows are org-scoped). Membership-based (the admin's own orgs); injected by the
   * host (`@/lib` resolver the workflows package cannot import). When absent, a
   * null-active-org scope discovers nothing.
   */
  orgListResolver?: (userId: string) => string[] | Promise<string[]>;
};

export type InstallResult =
  | { ok: true; templateId: string }
  | { ok: false; errors: string[] };

/**
 * Install a kind:"workflow" template into a consuming org from its manifest:
 * validate (manifest + template-valid + trigger lint), re-authorize referenced
 * agents/approvers in THIS org, then upsert the template row (idempotent).
 */
export async function installWorkflowTemplate(
  rawManifest: unknown,
  scope: { orgId: string; createdBy?: string | null; sourcePackage?: string; ownerLevel?: string | null; ownerId?: string | null },
  deps: WorkflowExtensionDeps = {},
): Promise<InstallResult> {
  const parsed = parseWorkflowTemplateManifest(rawManifest);
  if (!parsed.ok) return { ok: false, errors: parsed.errors };
  const spec = parsed.manifest.definition;

  // Re-authorize referenced agents/approvers in the consuming workspace.
  if (deps.agentExists) {
    for (const t of spec.tasks) {
      if (t.type === "agent_task" && !(await deps.agentExists(t.agentRef, scope.orgId))) {
        return { ok: false, errors: [`Agent for task "${t.key}" is not available in this organization.`] };
      }
    }
  }
  if (deps.approverResolvable) {
    for (const t of spec.tasks) {
      if (t.type === "approval" && !(await deps.approverResolvable(t.requiredScope, scope.orgId))) {
        return { ok: false, errors: [`Approver scope for task "${t.key}" cannot be resolved in this organization.`] };
      }
    }
  }

  const row = await materializeTemplateFromManifest(parsed.manifest, {
    orgId: scope.orgId,
    createdBy: scope.createdBy,
    sourcePackage: scope.sourcePackage,
    ownerLevel: scope.ownerLevel,
    ownerId: scope.ownerId,
  });
  return { ok: true, templateId: row.id };
}

// Workflow uninstall routes through extensionRegistry.uninstall("workflow", ...)
// so syncCanonicalManifestTransition owns the canonical update. A local boundary
// helper would bypass the canonical manifest by returning an "archived" action
// label without writing the canonical row, or by hard-deleting the template row
// without updating installed_extension. Template-row deletion logic itself lives
// in deleteWorkflowTemplate.
export type UninstallResult = { action: "archived" | "deleted" | "not_found" };

// ─────────────────────────────────────────────────────────────────────────
// Workflow extension adapter — BPMN sidecar + dashboard.json
//
// Install path for kind:"workflow" extensions: locate the package root, parse
// `cinatra/workflow.bpmn` → WorkflowSpec manifest, upsert the workflow
// template, then (if the extension ships `cinatra/dashboard.json`) materialize
// its dashboard template. The two writes target SEPARATE pg pools (workflows vs
// dashboards), so they are ORDERED idempotent writes (not one tx) — both are
// idempotent on their unique keys, so a partial failure self-heals on retry.
//
// The package root resolves from the unified content-addressed runtime store
// (`<CINATRA_EXTENSION_DATA_ROOT>/workflow/<slug>/<digest>/`, cinatra#794) via
// the journal-gated finalized-payload seam; the dev extensions tree remains an
// authoring-only fallback (explicit `extensionsRoot` override, or dev mode when
// no finalized payload exists). Otherwise we fail closed.
// ─────────────────────────────────────────────────────────────────────────

export class WorkflowExtensionError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "WorkflowExtensionError";
  }
}

type WorkflowExtensionActor = { userId?: string | null; orgId?: string | null };

/** Locate `extensions/<scope>/<slug>/` whose package.json name === packageName.
 *  `extensionsRoot` defaults to `<cwd>/extensions` (the repo root at app runtime);
 *  tests inject an explicit root since vitest cwd differs from the repo root. */
async function resolveDevExtensionPackageRoot(packageName: string, extensionsRoot: string): Promise<string | null> {
  const root = extensionsRoot;
  let scopes: import("node:fs").Dirent[];
  try {
    scopes = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const scope of scopes) {
    if (!scope.isDirectory() || scope.name === "node_modules" || scope.name.startsWith(".")) continue;
    const scopeDir = join(root, scope.name);
    let slugs: import("node:fs").Dirent[];
    try {
      slugs = await readdir(scopeDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const slug of slugs) {
      if (!slug.isDirectory()) continue;
      const pkgDir = join(scopeDir, slug.name);
      try {
        const pkg = JSON.parse(await readFile(join(pkgDir, "package.json"), "utf8")) as { name?: string };
        if (pkg.name === packageName) return pkgDir;
      } catch {
        /* skip unreadable */
      }
    }
  }
  return null;
}

/**
 * Resolve the on-disk package root for a workflow-extension install (#794).
 *
 * Resolution order:
 *  1. Explicit `extensionsRoot` override → dev-tree resolution under that root
 *     ONLY (the hermetic test/tooling contract; the runtime store is never
 *     consulted). Presence-checked explicitly so an override can never fall
 *     through to the store by accident.
 *  2. The FINALIZED unified runtime store — the digest dir the journal-gated
 *     DB anchor pins under `<CINATRA_EXTENSION_DATA_ROOT>/workflow/<slug>/
 *     <digest>/`, resolved through `@/lib/extension-store-payload` (the same
 *     trust seam the skill/agent handlers consume; the writable store itself
 *     is never a trust input). This is the canonical prod source: the
 *     marketplace saga materialized + finalized the payload there. A finalized
 *     payload whose version contradicts the requested version is a stale/wrong
 *     anchor condition → VERSION_MISMATCH outside dev (this fallback path
 *     cannot acquire a version the anchor has not finalized); in dev mode it
 *     falls through to the authoring tree, which may hold the requested
 *     version.
 *  3. Dev-mode authoring fallback: the dev extensions tree (`<cwd>/extensions`)
 *     — authoring-only, never consulted outside CINATRA_RUNTIME_MODE=development.
 *
 * Anything else fails closed (PACKAGE_ROOT_UNRESOLVED).
 */
async function resolveWorkflowInstallPackageRoot(
  ref: { packageName: string; version?: string },
  orgId: string,
  opts: { extensionsRoot?: string },
): Promise<string> {
  if (opts.extensionsRoot !== undefined) {
    const root = await resolveDevExtensionPackageRoot(ref.packageName, opts.extensionsRoot);
    if (!root) {
      throw new WorkflowExtensionError(
        "PACKAGE_ROOT_UNRESOLVED",
        `No on-disk package root for "${ref.packageName}" under the explicit extensions root.`,
      );
    }
    return root;
  }

  const isDev = process.env.CINATRA_RUNTIME_MODE === "development";

  // Unified runtime store (cinatra#794). The read seam is host code, so the
  // import is dynamic (the same package→host discipline as the skill/agent
  // handlers); an import or resolution failure reads as "no finalized payload"
  // and the authoring fallback / fail-closed tail decides.
  let payload: { storeDir: string; version: string | null } | null = null;
  try {
    const { resolveFinalizedStorePayload } = await import("@/lib/extension-store-payload");
    payload = await resolveFinalizedStorePayload({
      packageName: ref.packageName,
      orgId,
      expectedKind: "workflow",
    });
  } catch {
    payload = null;
  }
  if (payload) {
    // A null payload version (legacy row) defers to the extracted-manifest
    // VERSION_MISMATCH guard in the caller.
    if (!ref.version || payload.version === null || payload.version === ref.version) {
      return payload.storeDir;
    }
    if (!isDev) {
      throw new WorkflowExtensionError(
        "VERSION_MISMATCH",
        `Requested ${ref.packageName}@${ref.version} but the finalized runtime-store payload is ${payload.version}.`,
      );
    }
  }

  if (isDev) {
    const root = await resolveDevExtensionPackageRoot(ref.packageName, join(process.cwd(), "extensions"));
    if (root) return root;
  }
  throw new WorkflowExtensionError(
    "PACKAGE_ROOT_UNRESOLVED",
    `No finalized runtime-store payload for "${ref.packageName}" (kind "workflow") — ` +
      `the dev extensions tree is a development-only authoring fallback.`,
  );
}

function actorOrgGuard(actor: WorkflowExtensionActor): { userId: string; orgId: string } {
  if (!actor.orgId || !actor.userId) {
    throw new WorkflowExtensionError("MISSING_ORG_CONTEXT", "Missing organization context.");
  }
  return { userId: actor.userId, orgId: actor.orgId };
}

function dashboardActor(userId: string, orgId: string) {
  // Install authz gates this upstream; the materializers are system writers and
  // do not run the user-facing resolver, so role hints are nominal.
  return { userId, organizationId: orgId, teamIds: [] as string[], orgRole: "admin" as const, teamRoles: {} };
}

/**
 * Install a kind:"workflow" extension from its on-disk package: BPMN → template,
 * then (optional) dashboard.json → dashboard template. Ordered idempotent writes.
 */
export async function installWorkflowExtension(
  ref: { packageName: string; version?: string },
  actor: WorkflowExtensionActor,
  deps: WorkflowExtensionDeps = {},
  opts: { extensionsRoot?: string } = {},
): Promise<{ templateId: string; dashboardMaterialized: boolean }> {
  const { userId, orgId } = actorOrgGuard(actor);

  // Resolve the package root: finalized runtime-store payload first (the
  // resolved digest path), dev extensions tree only as the authoring-only /
  // explicit-override fallback (cinatra#794).
  const root = await resolveWorkflowInstallPackageRoot(ref, orgId, opts);

  const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version?: string; cinatra?: Record<string, unknown> };
  if (ref.version && pkg.version && ref.version !== pkg.version) {
    throw new WorkflowExtensionError("VERSION_MISMATCH", `Requested ${ref.packageName}@${ref.version} but the on-disk package is ${pkg.version}.`);
  }

  // Parse + validate EVERYTHING before any write (so a deterministic config error
  // can't leave a workflow template installed with no dashboard).
  const sidecar = await parseWorkflowBpmnSidecar({ packageRoot: root, pkgCinatra: pkg.cinatra ?? {} });
  if (!sidecar.ok) {
    throw new WorkflowExtensionError("BPMN_INVALID", sidecar.errors.map((e) => `${e.code}: ${e.detail}`).join("; "));
  }

  // dashboard.json: ENOENT = the extension ships none (fine); any other read/parse
  // error (malformed JSON) fails closed. v1.2 validation runs BEFORE the writes.
  let dashboardConfig: unknown;
  try {
    dashboardConfig = JSON.parse(await readFile(join(root, "cinatra", "dashboard.json"), "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      dashboardConfig = undefined;
    } else {
      throw new WorkflowExtensionError("DASHBOARD_INVALID", `cinatra/dashboard.json could not be read/parsed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  if (dashboardConfig !== undefined) {
    const v = validateDashboardConfigV12(dashboardConfig);
    if (!v.ok) throw new WorkflowExtensionError("DASHBOARD_INVALID", v.errors.join("; "));
  }

  // Writes — ordered idempotent (separate pools; no cross-package tx). Validation
  // above guarantees only a transient (DB) failure can interrupt these, and each
  // write is idempotent on its unique key so a retry re-converges.
  const installed = await installWorkflowTemplate(
    sidecar.manifest,
    { orgId, createdBy: userId, sourcePackage: ref.packageName, ownerLevel: "organization", ownerId: orgId },
    deps,
  );
  if (!installed.ok) {
    throw new WorkflowExtensionError("TEMPLATE_INSTALL_FAILED", installed.errors.join("; "));
  }

  let dashboardMaterialized = false;
  if (dashboardConfig !== undefined) {
    await materializeExtensionTemplate(undefined, {
      extensionId: ref.packageName,
      organizationId: orgId,
      config: dashboardConfig,
      scope: { ownerLevel: "organization", ownerId: orgId },
      actor: dashboardActor(userId, orgId),
    });
    // Reinstall reactivates a previously-archived template + per-project instances
    // (extensionRegistry.install reactivates the canonical row; keep dashboards in sync).
    await restoreExtensionDashboards(undefined, { extensionId: ref.packageName, organizationId: orgId, actor: dashboardActor(userId, orgId) });
    dashboardMaterialized = true;
  }

  return { templateId: installed.templateId, dashboardMaterialized };
}

/**
 * Pure archive-block predicate: a workflow extension archive is BLOCKED while
 * any live (draft/active) instance of its templates exists. Mirrors the
 * hard-delete guard in `deleteWorkflowTemplate` (which refuses an in-use
 * template) — so archive and hard-delete enforce the same in-use invariant.
 * Isolated as a pure function so the decision is unit-testable without a DB.
 */
export function workflowExtensionArchiveBlocked(templatesInUse: boolean): boolean {
  return templatesInUse === true;
}

/** Archive the extension's dashboards (template + per-project instances).
 *  REFUSES (throws WORKFLOW_TEMPLATE_IN_USE) while any draft/active workflow
 *  instance built from this package's templates exists — archiving would strand
 *  a live workflow whose source template lifecycle just flipped. The same
 *  in-use invariant the hard-delete path enforces in `deleteWorkflowTemplate`. */
export async function archiveWorkflowExtensionDashboards(
  ref: { packageName: string },
  actor: WorkflowExtensionActor,
): Promise<number> {
  const { userId, orgId } = actorOrgGuard(actor);
  const inUse = await arePackageTemplatesInUse(orgId, ref.packageName);
  if (workflowExtensionArchiveBlocked(inUse)) {
    throw new WorkflowExtensionError(
      "WORKFLOW_TEMPLATE_IN_USE",
      `Cannot archive — a live workflow built from ${ref.packageName} still exists. Complete or cancel it first.`,
    );
  }
  return archiveExtensionDashboards(undefined, { extensionId: ref.packageName, organizationId: orgId, actor: dashboardActor(userId, orgId) });
}

/** Restore the extension's dashboards (template + per-project instances). */
export async function restoreWorkflowExtensionDashboards(
  ref: { packageName: string },
  actor: WorkflowExtensionActor,
): Promise<number> {
  const { userId, orgId } = actorOrgGuard(actor);
  return restoreExtensionDashboards(undefined, { extensionId: ref.packageName, organizationId: orgId, actor: dashboardActor(userId, orgId) });
}
