// Workflow extension handler.
//
// Wires `kind:"workflow"` into the kind-agnostic extension dispatcher so that
// the canonical manifest and registry coverage checks cover all five kinds
// (agent / connector / artifact / skill / workflow).
//
// The actual workflow install/uninstall mechanics live in
// `packages/workflows/src/extension-ops.ts`, which expect a manifest object +
// consuming-org scope and dispatch to the store. The host route +
// chat-confirmation flow continue to call those directly. THIS handler's job is
// to be present in the registry so that kind-agnostic flows (canonical gate,
// deriveTypeId, registry coverage tests) succeed.
//
// Locked / required-in-prod enforcement runs UPSTREAM in
// `enforceCanonicalManifest` (canonical-gate.ts) so workflow ops inherit the
// same protection without re-implementation.
// Workflow extension handler — adapter for kind:"workflow" extensions.
//
// On install/update it parses the extension's `cinatra/workflow.bpmn` → workflow
// template, then — if the extension ships `cinatra/dashboard.json` —
// materializes its dashboard template. On archive/restore/uninstall it flips
// the extension's dashboards (rows preserved). The workflow_template ROW
// lifecycle itself stays owned by the canonical dispatcher
// (`syncCanonicalManifestTransition`).
// `actor.orgId` is forwarded by the extensions MCP registry; the adapter fails
// closed (MISSING_ORG_CONTEXT) when it is absent, BEFORE any DB / FS work.
import "server-only";

import type {
  Actor,
  ExtensionDiscoveryScope,
  ExtensionTypeHandler,
  PackageRef,
} from "@cinatra-ai/extension-types";
import { visibleManifestPackageNames } from "@cinatra-ai/extension-types";
import {
  installWorkflowExtension,
  archiveWorkflowExtensionDashboards,
  restoreWorkflowExtensionDashboards,
  type WorkflowExtensionDeps,
} from "./extension-ops";
import { getWorkflowInstallSagaHook } from "./install-saga-hook";
import { listWorkflowTemplates, listWorkflowTemplatesForOrgIds } from "./store";
import { filterReadable } from "./scope/resource-ref";

// Safety cap on the platform-admin cross-org fan-out. A batch query handles
// many orgs fine, but an admin in a pathological number of orgs is bounded here;
// excess is truncated with a loud warning rather than running unbounded.
const MAX_CROSS_ORG_FANOUT = 100;

/**
 * Resolve the org ids the reader facet should discover templates across:
 *  - active org set  → just that org (unchanged single-org behavior);
 *  - no active org + platform_admin + an injected orgListResolver → the admin's
 *    member orgs (membership-based — NOT every org in the deployment), capped;
 *  - otherwise → none (a non-admin with no active org discovers nothing).
 */
async function resolveDiscoveryOrgIds(
  scope: ExtensionDiscoveryScope,
  orgListResolver: WorkflowExtensionDeps["orgListResolver"],
): Promise<string[]> {
  if (scope.organizationId) return [scope.organizationId];
  if (scope.platformRole !== "platform_admin" || !orgListResolver || !scope.userId) return [];
  const resolved = await orgListResolver(scope.userId);
  const unique = [...new Set(resolved.filter(Boolean))];
  if (unique.length > MAX_CROSS_ORG_FANOUT) {
    console.warn(
      `[workflow-discovery] platform-admin cross-org fan-out capped at ${MAX_CROSS_ORG_FANOUT} (had ${unique.length}); some org templates omitted from discovery.`,
    );
    return unique.slice(0, MAX_CROSS_ORG_FANOUT);
  }
  return unique;
}

/**
 * Workflow lifecycle handler. Wire up at boot via:
 *   extensionRegistry.register(createWorkflowExtensionHandler(deps));
 *
 * `deps` (agent/approver re-auth probes) are app-side resolvers (`@/lib/...`) so
 * they MUST be injected by the host at registration (src/lib/extensions.ts). The
 * package-internal handler-bootstrap registration passes none — agent/approver
 * re-auth only runs where deps are supplied (the MCP boot path).
 */
export function createWorkflowExtensionHandler(deps: WorkflowExtensionDeps = {}): ExtensionTypeHandler {
  return {
    typeId: "workflow",

    async install(ref: PackageRef, actor: Actor): Promise<void> {
      // Prefer the host-injected atomic install saga (journal + preflight against
      // the integrity-verified package store + per-project instance fan-out +
      // inverse-order compensating rollback). When the host hasn't wired it (a
      // worker that never loaded `@/lib`, or a unit test), fall back to the
      // in-package install that sources sidecars from the finalized runtime-store
      // payload (dev-tree authoring fallback in dev mode only — cinatra#794).
      const saga = getWorkflowInstallSagaHook();
      if (saga) {
        await saga({ packageName: ref.packageName, version: ref.version, actor: { userId: actor.userId, orgId: actor.orgId } });
        return;
      }
      await installWorkflowExtension({ packageName: ref.packageName, version: ref.version }, { userId: actor.userId, orgId: actor.orgId }, deps);
    },

    async update(ref: PackageRef, actor: Actor): Promise<void> {
      // "install a new version of the same key" — same idempotent path as install.
      const saga = getWorkflowInstallSagaHook();
      if (saga) {
        await saga({ packageName: ref.packageName, version: ref.version, actor: { userId: actor.userId, orgId: actor.orgId } });
        return;
      }
      await installWorkflowExtension({ packageName: ref.packageName, version: ref.version }, { userId: actor.userId, orgId: actor.orgId }, deps);
    },

    async uninstall(ref: PackageRef, actor: Actor): Promise<void> {
      await archiveWorkflowExtensionDashboards({ packageName: ref.packageName }, { userId: actor.userId, orgId: actor.orgId });
    },

    async archive(ref: PackageRef, actor: Actor): Promise<void> {
      await archiveWorkflowExtensionDashboards({ packageName: ref.packageName }, { userId: actor.userId, orgId: actor.orgId });
    },

    async restore(ref: PackageRef, actor: Actor): Promise<void> {
      await restoreWorkflowExtensionDashboards({ packageName: ref.packageName }, { userId: actor.userId, orgId: actor.orgId });
    },

    // Reader facet. The native workflow_template store is the row-level
    // authority; the dispatcher's `manifests` are only a coarse lifecycle-live
    // candidate set. visibleManifestPackageNames applies the ownership-level
    // visibility gate (platform/workspace = all; org/team/user scoped) to that
    // set, and we surface a template only if its package is in the resulting
    // visible-live set — never trust `manifests` for row-level visibility beyond
    // that. Templates are tenant-scoped (org_id NOT NULL). With an active org
    // this is single-org discovery (unchanged); a platform admin with NO active
    // org discovers across their member orgs via the injected orgListResolver
    // (a non-admin with no active org still discovers nothing).
    async listActive({ scope, manifests }) {
      const orgIds = await resolveDiscoveryOrgIds(scope, deps.orgListResolver);
      if (orgIds.length === 0) return [];

      const rows =
        orgIds.length === 1
          ? await listWorkflowTemplates({ orgId: orgIds[0] })
          : await listWorkflowTemplatesForOrgIds(orgIds);

      // visibleManifestPackageNames must be evaluated with a SYNTHETIC per-org
      // scope (org substituted), or org-owned live manifests stay invisible when
      // the original scope has no active org. Cache per org.
      const liveByOrg = new Map<string, Set<string>>();
      const liveFor = (orgId: string): Set<string> => {
        let set = liveByOrg.get(orgId);
        if (!set) {
          set = visibleManifestPackageNames(manifests, { ...scope, organizationId: orgId });
          liveByOrg.set(orgId, set);
        }
        return set;
      };

      // filterReadable is the canonical row-level visibility gate; apply it
      // per-row against that row's OWN org (a platform_admin sees all; otherwise
      // ownership/team/user/project scoping is enforced within the matching org).
      const out: typeof rows = [];
      const seen = new Set<string>();
      for (const t of rows) {
        if (t.packageName == null || !liveFor(t.orgId).has(t.packageName)) continue;
        const [readable] = filterReadable([t], {
          userId: scope.userId,
          organizationId: t.orgId,
          teamIds: scope.teamIds,
          projectIds: scope.projectIds,
          platformRole: scope.platformRole,
        });
        if (!readable) continue;
        const key = `${t.orgId}::${t.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(t);
      }
      return out;
    },
  };
}
