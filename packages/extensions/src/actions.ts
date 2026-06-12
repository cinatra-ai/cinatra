"use server";

import "./handler-bootstrap";
import { redirect } from "next/navigation";
import { getAgentPackage as _getAgentPackage } from "@cinatra-ai/registries";
// getAgentPackage import retained for deprecated agent-only call sites that
// may yet exist in this file's tail; lifecycle dispatch now uses
// resolveExtensionPackageForLifecycle.
void _getAgentPackage;
import { extensionRegistry } from "./index";
import type { Actor } from "@cinatra-ai/extension-types";
import type { DanglingReferences } from "./audit-log";
import { requireAdminSession } from "@/lib/auth-session";
import {
  deriveTypeId,
  resolveExtensionTypeId,
  resolveExtensionPackageForLifecycle,
} from "./utils";

// ---------------------------------------------------------------------------
// Extension-local server actions dispatch through the extensionRegistry
// singleton. Kept in @cinatra-ai/extensions to avoid the circular dependency
// that would result from importing extensionRegistry into @cinatra-ai/agents
// (packages/agents depends on packages/extensions would close a cycle:
// agents→extensions→agents).
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Core dispatch functions — explicit actor parameter, used by MCP handlers
// and callable from any server context that already has an actor object.
// ---------------------------------------------------------------------------

export async function installExtensionPackage(
  packageName: string,
  packageVersion: string,
  actor: Actor,
): Promise<{ success: boolean; error?: string }> {
  "use server";
  await requireAdminSession();
  try {
    // DEPENDENCY-BATCH entry (#180): authorize-once → plan (manifest-edge
    // walk, auto-installable edges only) → install missing dependencies
    // DEPENDENCIES-FIRST through this same registry → the requested root
    // LAST — with a persisted batch ledger + inverse-order compensation.
    // A depless root takes the unchanged single-install fast path inside.
    // typeId resolution happens in the planner (one packument read per
    // member, under the root grant on the gatekept path). Dynamic import:
    // @/lib is the host; same pattern utils.ts uses for gatekept-install.
    const { installExtensionWithDependencies } = await import(
      "@/lib/extension-install-batch"
    );
    await installExtensionWithDependencies({ packageName, version: packageVersion, actor });
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function updateExtensionPackage(
  packageName: string,
  packageVersion: string,
  actor: Actor,
): Promise<{ success: boolean; error?: string }> {
  "use server";
  await requireAdminSession();
  try {
    const typeId = await resolveExtensionTypeId(packageName, packageVersion);
    await extensionRegistry.update(
      typeId,
      { registryUrl: "", packageName, version: packageVersion },
      actor,
    );
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function uninstallExtensionPackage(
  packageName: string,
  packageVersion: string,
  actor: Actor,
): Promise<{ success: boolean; error?: string }> {
  "use server";
  await requireAdminSession();
  try {
    const typeId = await resolveExtensionTypeId(packageName, packageVersion);
    await extensionRegistry.uninstall(
      typeId,
      { registryUrl: "", packageName, version: packageVersion },
      actor,
    );
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// Core dispatchers for archive/restore/reinstall/forceDelete.
// ---------------------------------------------------------------------------

export async function archiveExtensionPackage(
  packageName: string,
  packageVersion: string,
  actor: Actor,
): Promise<{ success: boolean; error?: string }> {
  "use server";
  await requireAdminSession();
  try {
    const typeId = await resolveExtensionTypeId(packageName, packageVersion);
    await extensionRegistry.archive(
      typeId,
      { registryUrl: "", packageName, version: packageVersion },
      actor,
    );
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function restoreExtensionPackage(
  packageName: string,
  actor: Actor,
): Promise<{ success: boolean; error?: string }> {
  "use server";
  await requireAdminSession();
  try {
    const typeId = await resolveExtensionTypeId(packageName);
    // Version is intentionally empty — the handler reads the archived row's version.
    await extensionRegistry.restore(
      typeId,
      { registryUrl: "", packageName, version: "" },
      actor,
    );
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function reinstallLatestExtensionPackage(
  packageName: string,
  actor: Actor,
): Promise<{ success: boolean; error?: string }> {
  "use server";
  await requireAdminSession();
  try {
    // Resolve the latest version FIRST and bail out before any destructive
    // uninstall step if the registry is unreachable or returns a package
    // without a version. Otherwise this would archive
    // (or hard-delete) the existing extension and then attempt to install
    // with version: "", landing the user in a partial-state with nothing to
    // restore from.
    //
    // Kind-agnostic dispatch is required because getAgentPackage fails for
    // non-agent kinds; deriving the type ID from pkg.kind would silently
    // mis-route skills/connectors/artifacts.
    let resolution;
    try {
      resolution = await resolveExtensionPackageForLifecycle(packageName);
    } catch {
      return {
        success: false,
        error: `Could not resolve latest version for ${packageName}; reinstall not attempted (no destructive change made).`,
      };
    }
    if (!resolution.resolvedVersion) {
      return {
        success: false,
        error: `Could not resolve latest version for ${packageName}; reinstall not attempted (no destructive change made).`,
      };
    }
    const latestVersion = resolution.resolvedVersion;
    const typeId = resolution.typeId;
    // Step 1: uninstall (archive or hard-delete per predicate)
    await extensionRegistry.uninstall(
      typeId,
      { registryUrl: "", packageName, version: latestVersion },
      actor,
    );
    // Step 2: install at the latest resolved version
    try {
      await extensionRegistry.install(
        typeId,
        { registryUrl: "", packageName, version: latestVersion },
        actor,
      );
    } catch (installErr) {
      // Surface the underlying install error so the user can act on it
      // (Verdaccio unreachable, manifest validation, skill registration crash,
      // etc.). A fixed string would also incorrectly assume the prior uninstall
      // took the archive path; uninstall is predicate-driven, so for unused
      // extensions it hard-deletes and there is nothing in the Archived tab to
      // recover from.
      const detail =
        installErr instanceof Error ? installErr.message : String(installErr);
      return {
        success: false,
        error: `Reinstall failed after uninstall step: ${detail}. Try reinstalling from the marketplace.`,
      };
    }
    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function forceDeleteExtensionPackage(
  packageName: string,
  packageVersion: string,
  actor: Actor,
  reason?: string,
): Promise<{ success: boolean; error?: string; danglingReferences?: DanglingReferences }> {
  "use server";
  await requireAdminSession();
  try {
    const typeId = await resolveExtensionTypeId(packageName, packageVersion);
    const result = await extensionRegistry.forceDelete(
      typeId,
      { registryUrl: "", packageName, version: packageVersion },
      actor,
      reason,
    );
    return { success: true, danglingReferences: result.danglingReferences };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

// ---------------------------------------------------------------------------
// UI form-action wrappers — derive actor from session internally so screens
// can use .bind(null, { packageName, packageVersion }) without needing to
// pass an actor object at bind time.
// ---------------------------------------------------------------------------

export async function installExtensionPackageFormAction(input: {
  packageName: string;
  packageVersion: string;
}): Promise<void> {
  "use server";
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await installExtensionPackage(input.packageName, input.packageVersion, actor);
  if (!result.success) {
    throw new Error(result.error ?? "Installation failed");
  }
  redirect("/configuration/extensions");
}

export async function updateExtensionPackageFormAction(input: {
  packageName: string;
  packageVersion: string;
}): Promise<void> {
  "use server";
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await updateExtensionPackage(input.packageName, input.packageVersion, actor);
  if (!result.success) {
    throw new Error(result.error ?? "Update failed");
  }
  redirect("/configuration/extensions");
}

export async function uninstallExtensionPackageFormAction(input: {
  packageName: string;
  packageVersion: string;
}): Promise<void> {
  "use server";
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await uninstallExtensionPackage(input.packageName, input.packageVersion, actor);
  if (!result.success) {
    throw new Error(result.error ?? "Uninstallation failed");
  }
  redirect("/configuration/extensions");
}

// ---------------------------------------------------------------------------
// Form-action wrappers for archive/restore/reinstall/forceDelete.
// ---------------------------------------------------------------------------

export async function archiveExtensionPackageFormAction(input: {
  packageName: string;
  // Required. The MCP schema at mcp/schemas.ts requires
  // packageVersion: z.string().min(1); the form-action contract mirrors that
  // so callers can't silently pass "" and have downstream code misbehave on
  // ref.version reads.
  packageVersion: string;
}): Promise<void> {
  "use server";
  if (!input.packageVersion) {
    throw new Error("archiveExtensionPackageFormAction requires a non-empty packageVersion");
  }
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await archiveExtensionPackage(
    input.packageName,
    input.packageVersion,
    actor,
  );
  if (!result.success) {
    throw new Error(result.error ?? "Archive failed");
  }
  // revalidatePath is unnecessary because redirect re-renders the destination.
  redirect("/configuration/extensions");
}

export async function restoreExtensionPackageFormAction(input: {
  packageName: string;
}): Promise<void> {
  "use server";
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await restoreExtensionPackage(input.packageName, actor);
  if (!result.success) {
    throw new Error(result.error ?? "Restore failed");
  }
  // revalidatePath is unnecessary because redirect re-renders the destination.
  redirect("/configuration/extensions");
}

export async function reinstallLatestFormAction(input: {
  packageName: string;
}): Promise<void> {
  "use server";
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await reinstallLatestExtensionPackage(input.packageName, actor);
  if (!result.success) {
    throw new Error(result.error ?? "Reinstall failed");
  }
  // revalidatePath is unnecessary because redirect re-renders the destination.
  redirect("/configuration/extensions");
}

export async function forceDeleteExtensionPackageFormAction(input: {
  packageName: string;
  // Tighten the contract to mirror the MCP schema (mcp/schemas.ts requires
  // packageVersion.min(1), reason, and confirmDestructive: literal(true)).
  // Today no UI surface invokes this action; a lax form-action contract would
  // let a future caller land a button without thinking through the
  // destructive-acknowledgment guard. Make the safety guard mandatory at the
  // form-action boundary too.
  packageVersion: string;
  reason: string;
  confirmDestructive: true;
}): Promise<void> {
  "use server";
  if (input.confirmDestructive !== true) {
    throw new Error(
      "Force-delete requires explicit confirmDestructive: true",
    );
  }
  if (!input.packageVersion) {
    throw new Error(
      "forceDeleteExtensionPackageFormAction requires a non-empty packageVersion",
    );
  }
  if (!input.reason || input.reason.trim().length === 0) {
    throw new Error(
      "forceDeleteExtensionPackageFormAction requires a non-empty reason",
    );
  }
  const session = await requireAdminSession();
  const actor: Actor = {
    actorType: "human",
    userId: session.user.id,
    source: "ui",
    // Forward the active org so kind:"workflow" lifecycle (dashboard
    // materialization) has organization context from the UI server-action path.
    ...(session.session?.activeOrganizationId ? { orgId: session.session.activeOrganizationId } : {}),
  };
  const result = await forceDeleteExtensionPackage(
    input.packageName,
    input.packageVersion,
    actor,
    input.reason,
  );
  if (!result.success) {
    throw new Error(result.error ?? "Force-delete failed");
  }
  // revalidatePath is unnecessary because redirect re-renders the destination.
  redirect("/configuration/extensions?tab=archived");
}

// ---------------------------------------------------------------------------
// Promotion path: private → public only.
// ---------------------------------------------------------------------------

// ExtensionAlreadyPublicError moved to promotion-errors.ts because Next.js
// "use server" files may only export async functions.
import { ExtensionAlreadyPublicError } from "./promotion-errors";

type PromoteExtensionInput = {
  packageName: string;
  packageVersion: string;
};

/**
 * Promotes a private extension to the public registry.
 *
 * Only the private → public path is supported. Public → private is blocked;
 * the UI renders a visible-but-disabled "Demote to private" menu item with
 * the locked tooltip.
 *
 * Side effects (in order):
 *   1. Auth-gate via requireAdminSession
 *   2. Read existing origin row — throw if missing or already public
 *   3. Resolve public destination via resolvePublishDestination('public')
 *   4. Rebuild + republish the package to the public registry via publishAgentPackage
 *      (fetches the stored template record + latest version snapshot from DB)
 *   5. Update origin.visibility='public', clear destinationId, set registryUrl
 *   6. Fire-and-forget audit log entry; log failure does NOT roll back the
 *      promotion
 *
 * resolvePublishDestination("public") calls deployConfig.publicPublishToken;
 * this is null in the baseline fixture, so promotion throws
 * PublishDestinationNotConfiguredError in any fixture-backed environment.
 *
 * TODO: wire the live deployment-registry resolver before exercising promotion
 * in long-lived deployments. See deployment-registry-config.ts.
 */
export async function promoteExtensionToPublicAction(
  input: PromoteExtensionInput,
): Promise<void> {
  "use server";
  const session = await requireAdminSession();

  const {
    readAgentTemplateOrigin,
    readAgentTemplateByPackageName,
    readAgentVersionsByTemplate,
    updateAgentTemplateVisibility,
  } = await import("@cinatra-ai/agents/store");
  const { resolvePublishDestination } = await import("@cinatra-ai/extensions/destination-resolver");
  const { publishAgentPackage } = await import("@cinatra-ai/agents/verdaccio/client");
  const { logAuditEvent, POLICY_VERSION } = await import("@/lib/authz");
  const { derivePublishMetadataFromSnapshot } = await import("@cinatra-ai/agents/verdaccio/publish-metadata");

  const existingOrigin = await readAgentTemplateOrigin(input.packageName);
  if (!existingOrigin) {
    throw new Error(`No origin row found for package ${input.packageName}`);
  }
  if (existingOrigin.visibility === "public") {
    throw new ExtensionAlreadyPublicError(input.packageName);
  }

  const template = await readAgentTemplateByPackageName(input.packageName);
  if (!template) {
    throw new Error(`Agent template not found for package ${input.packageName}`);
  }

  const versions = await readAgentVersionsByTemplate(template.id);
  if (!versions.length) {
    throw new Error(
      `No version snapshot found for package ${input.packageName} — cannot promote without a saved version`,
    );
  }

  const version = versions[0]; // latest version (ordered by createdAt DESC)
  const publishMetadata = derivePublishMetadataFromSnapshot(version.snapshot);

  // Use the DB-stored version as the semver source of truth rather than
  // input.packageVersion. The caller (UI form) could supply any semver string
  // (e.g. "99.0.0"), which would re-publish under a fabricated version.
  // template.packageVersion mirrors the stored snapshot version.
  const semverToPublish = template.packageVersion ?? input.packageVersion;
  if (!semverToPublish) {
    throw new Error(`Cannot promote ${input.packageName} — no package version available`);
  }

  const publicConfig = await resolvePublishDestination("public");

  // Re-publish the package to the public registry by rebuilding from the stored
  // template + version snapshot. publishAgentPackage is idempotent: if this
  // version already exists in the public registry, it returns { alreadyPublished: true }.
  await publishAgentPackage(
    {
      template,
      version,
      semver: semverToPublish,
      // Pin the package name to its already-published private value. Without
      // this, publishAgentPackage rebuilds the name from `config.packageScope +
      // slug`, which would silently rescope a delegated private extension
      // (e.g. @acme-test/foo) under the instance namespace on promotion to
      // public. Stability across promotion is the right semantic here: a
      // package's name should not change when its visibility does.
      packageName: input.packageName,
      title: template.name ?? input.packageName,
      description: template.description ?? undefined,
      changelog: undefined,
      riskLevel: publishMetadata.riskLevel,
      toolAccess: publishMetadata.toolAccess,
      hasApprovalGates: publishMetadata.hasApprovalGates,
    },
    publicConfig,
  );

  // Persist the new visibility coordinates.
  await updateAgentTemplateVisibility(
    input.packageName,
    "public",
    publicConfig.registryUrl,
  );

  // Fire-and-forget audit log.
  // A failure to write the audit row MUST NOT roll back the promotion.
  // Wrapped in try/catch to swallow both sync throws and async rejections:
  // the handler.ts precedent uses `void fn()` which silently drops Promise
  // rejections, but to guard against synchronous throws from mocked/broken
  // logAuditEvent implementations, we use a try/catch wrapper instead.
  try {
    void Promise.resolve(
      logAuditEvent({
        actorPrincipalId: session.user.id,
        actorPrincipalType: "human",
        authSource: "ui",
        resourceType: "extension_registry",
        resourceId: input.packageName,
        operation: "promote",
        decision: "allowed",
        policyVersion: POLICY_VERSION,
        metadata: {
          from_visibility: "private",
          to_visibility: "public",
          package_name: input.packageName,
          package_version: input.packageVersion,
        },
      }),
    ).catch(() => {});
  } catch {
    // Audit write failure MUST NOT propagate — promotion is already persisted.
  }
}
