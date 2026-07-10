import "server-only";

// ---------------------------------------------------------------------------
// Extension settings page (design §V "Extension settings") — data loader.
//
// Opened from an installed card's Settings action. Resolves the SAME installed
// row the card renders (loadInstalledCardRows), so displayName / vendor /
// version / status never disagree with the card, binds the lifecycle server
// actions, computes the locked / system disabled-action reasons (#1036), loads
// the marketplace vendor status + the access policy, then hands everything to
// the presentational ExtensionSettingsView. Admin-only.
// ---------------------------------------------------------------------------

import type { ReactNode } from "react";
import { notFound } from "next/navigation";
import { requireAdminSession } from "@/lib/auth-session";
import { readOrgsWithTeamsForUser, readProjectsForUser } from "@/lib/better-auth-db";
import type { AvailableScopes } from "@/components/access-scope";
import { readMarketplaceVendorStatus } from "@/app/configuration/environment/marketplace-publish-actions";
import type { AgentAuthPolicyVisibility } from "@cinatra-ai/agents/auth-policy";
import { normalizeVisibilitySelection } from "@cinatra-ai/agents/auth-policy-types";
import { loadInstalledCardRows } from "./installed-rows";
import type { ExtensionKind } from "../canonical-types";
import type { ExtensionKind as PermissionResourceKind } from "../permissions-kind-hooks";
import { readExtensionAccessPolicy } from "../permissions-store";
import { saveExtensionAccessPolicy } from "../permissions-actions";
import { DEFAULT_EXTENSION_ACCESS_POLICY } from "../enforce-extension-access";
import {
  ACCESS_POLICY_KINDS,
  VALID_SETTINGS_KINDS,
  canPublishToMarketplace,
  isRegisteredMarketplaceVendor,
  resolveSettingsAffordances,
  resolveUpdateAvailable,
} from "./extension-settings-model";
import {
  archiveExtensionPackageFormAction,
  forceDeleteExtensionPackageFormAction,
  promoteExtensionToPublicAction,
  reinstallLatestFormAction,
  restoreExtensionPackageFormAction,
  updateExtensionPackageFormAction,
} from "../actions";
import { ExtensionAccessControl } from "./extension-access-control";
import { ExtensionSettingsView } from "./extension-settings-view";

export async function ExtensionSettingsScreen({
  kind,
  packageName,
}: {
  kind: string;
  packageName: string;
}) {
  const session = await requireAdminSession();
  if (!VALID_SETTINGS_KINDS.includes(kind as ExtensionKind)) notFound();
  const extKind = kind as ExtensionKind;

  const { active, archived, availableByName } = await loadInstalledCardRows(session);
  const row = [...active, ...archived].find(
    (r) => r.kind === extKind && r.packageName === packageName,
  );
  if (!row) notFound();

  const canonical = row.canonical;
  const rawVersion = row.rawVersion;
  const versionKnown = Boolean(rawVersion);
  const packageVersion = rawVersion ?? "";
  const newestVersion = availableByName.get(packageName)?.packageVersion ?? null;
  const updateAvailable = resolveUpdateAvailable(rawVersion, newestVersion);

  const isArchived = row.status === "archived";
  const isPublic = row.visibility === "public";

  // Locked / system disabled-action reasons (#1036 mechanism) + status/version
  // fallbacks (complementary Archive/Activate; version-requiring actions).
  const { archiveDisabled, activateDisabled, reinstallDisabled, forceDeleteDisabled } =
    resolveSettingsAffordances({ canonical, isArchived, versionKnown });

  // Server actions — identity baked into the closure, each returning void so
  // they satisfy the native `<form action>` / confirm-dialog contract (the
  // underlying form-actions redirect on success and throw on failure).
  async function updateAction() {
    "use server";
    await updateExtensionPackageFormAction({ packageName, packageVersion });
  }
  async function archiveAction() {
    "use server";
    // cinatra#1061: RETURN (not await-and-drop) so the classified removal
    // refusal — which NAMES the blocking dependents — reaches the client, which
    // renders it instead of a Next.js-masked thrown error.
    return archiveExtensionPackageFormAction({ packageName, packageVersion });
  }
  async function activateAction() {
    "use server";
    await restoreExtensionPackageFormAction({ packageName });
  }
  async function reinstallAction() {
    "use server";
    await reinstallLatestFormAction({ packageName });
  }
  async function publishAction() {
    "use server";
    await promoteExtensionToPublicAction({ packageName, packageVersion });
  }
  async function forceDeleteAction(formData: FormData) {
    "use server";
    const reason = String(formData.get("reason") ?? "").trim();
    await forceDeleteExtensionPackageFormAction({
      packageName,
      packageVersion,
      reason,
      confirmDestructive: true,
    });
  }

  // cinatra#1061 req 4: pre-compute the ACTIVE dependents that would block an
  // archive/uninstall of this extension, for the pre-submit preview under the
  // Archive affordance. Uses the SAME predicate the closure gate refuses on
  // (`listArchiveClosureBlockers`) so the preview and the refusal never
  // disagree. Best-effort for the PREVIEW only — a read failure just omits the
  // hint; the server gate is still fail-closed and authoritative.
  let archiveDependents: string[] = [];
  try {
    const { listInstalledExtensions } = await import("../canonical-store");
    const { listArchiveClosureBlockers } = await import("../dependency-closure");
    const allRows = await listInstalledExtensions({});
    const target = allRows.find((r) => r.packageName === packageName);
    if (target) archiveDependents = listArchiveClosureBlockers(target, allRows);
  } catch {
    // preview omitted — the gate still refuses on the real removal.
  }

  // Marketplace vendor status (best-effort — a marketplace read failure must
  // not blank the page; the publish action stays muted behind the register
  // affordance).
  const vendorStatus = await readMarketplaceVendorStatus().catch(() => null);
  const isRegisteredVendor = isRegisteredMarketplaceVendor(vendorStatus?.state);
  const canPublish = canPublishToMarketplace({
    isPublic,
    isRegisteredVendor,
    kind: extKind,
    versionKnown,
  });

  // Permissions control (connector / artifact / workflow — the canonical-row
  // access identity). Agent / skill manage access on their own surfaces.
  let permissions: ReactNode;
  if (ACCESS_POLICY_KINDS.includes(extKind) && canonical) {
    const resourceId = canonical.id;
    const userId = session.user.id;
    const activeOrgId = session.session?.activeOrganizationId ?? null;
    const orgs = await readOrgsWithTeamsForUser(userId);
    const projects = activeOrgId ? await readProjectsForUser(userId, activeOrgId) : [];
    const scopes: AvailableScopes = {
      orgs: orgs.map((org) => ({
        id: org.id,
        name: org.name,
        teams: org.teams.map((t) => ({ id: t.id, name: t.name })),
      })),
      projects: projects.map((p) => ({ id: p.id, name: p.name })),
      canGrantWorkspace: true,
    };
    const stored = await readExtensionAccessPolicy(
      extKind as PermissionResourceKind,
      resourceId,
    );
    const effective = stored ?? DEFAULT_EXTENSION_ACCESS_POLICY;
    const allowRunSharing = effective.allowRunSharing;
    async function saveAccess(next: string[]): Promise<{ ok: boolean; error?: string }> {
      "use server";
      // Multi-scope W3 (#1069/#1072): each run-access field holds a NON-EMPTY
      // array of visibility tokens. The checkbox multi-select picker yields the
      // full token array; normalize it to the canonical form before the write.
      const selection = normalizeVisibilitySelection(next as AgentAuthPolicyVisibility[]);
      const result = await saveExtensionAccessPolicy(extKind, resourceId, {
        runListVisibility: selection,
        runDataVisibility: selection,
        runExecuteVisibility: selection,
        allowRunSharing,
      });
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    }
    permissions = (
      <ExtensionAccessControl
        initialValue={effective.runListVisibility}
        scopes={scopes}
        save={saveAccess}
      />
    );
  } else {
    const note =
      extKind === "agent"
        ? "Manage who can access this agent from the Agents page."
        : extKind === "skill"
          ? "Manage who can access this skill from the Skills configuration page."
          : "Access is managed from this extension's own configuration page.";
    permissions = (
      <div className="flex flex-col gap-1.5">
        <p className="text-sm text-foreground">Who can access this extension?</p>
        <p className="text-xs text-muted-foreground">{note}</p>
      </div>
    );
  }

  return (
    <ExtensionSettingsView
      kind={extKind}
      packageName={packageName}
      displayName={row.displayName}
      vendor={row.vendor}
      rawVersion={rawVersion}
      versionLabel={row.versionLabel}
      newestVersion={newestVersion}
      updateAvailable={updateAvailable}
      archiveDisabled={archiveDisabled}
      activateDisabled={activateDisabled}
      reinstallDisabled={reinstallDisabled}
      forceDeleteDisabled={forceDeleteDisabled}
      archiveDependents={archiveDependents}
      isPublic={isPublic}
      isRegisteredVendor={isRegisteredVendor}
      canPublish={canPublish}
      permissions={permissions}
      actions={{
        update: updateAction,
        archive: archiveAction,
        activate: activateAction,
        reinstall: reinstallAction,
        publish: publishAction,
        forceDelete: forceDeleteAction,
      }}
    />
  );
}
