import "server-only";

// Host implementation of the org-scoped dashboard-archival lifecycle hook
// (cinatra#1628, S11a — re-homing the archival step W5/#1035 dropped).
//
// Injected into `@cinatra-ai/extensions` via `setExtensionDashboardLifecycleHook`
// (wired in src/lib/extensions.ts, next to the capability-teardown hook). The
// registry dispatcher fires it AFTER a ROW-SCOPED archive/restore transition
// commits, with exact (package, org) identity — so a committed uninstall/archive
// archives that org's extension dashboards, and a restore un-archives them. The
// dashboards single-writer (`archiveExtensionDashboards`/`restoreExtensionDashboards`)
// keys on `extension_id` (== the package name), preserves user config + revisions
// (archive, not delete), and writes its own audit row.
//
// SYSTEM WRITE: like the extension materialize path, these are lifecycle-triggered
// system writes — install/uninstall authz is gated upstream, so the archival does
// NOT re-run the user-facing dashboard access resolver. A minimal system actor
// carries the acting principal id for the audit row.

import type { ExtensionDashboardLifecycleHook } from "@cinatra-ai/extensions";
import {
  archiveExtensionDashboards,
  restoreExtensionDashboards,
} from "@cinatra-ai/dashboards/extension-materialization";
// R2-allowlisted minting site (scripts/audit/org-write-boundary-gate.mjs):
// the content-only "extension-dashboard-lifecycle" purpose grounds these
// system writes on the org-write kernel (cinatra#1939 wave 1).
import { mintSystemWriteAuthority } from "@/lib/org-write/authority";

/** The `archive_reason` stamped when the committed-uninstall/archive hook archives
 *  a (package, org)'s dashboards — distinct from the migration orphan sweep's
 *  reason so provenance is unambiguous. */
export const LIFECYCLE_ARCHIVE_REASON = "extension_lifecycle_archive";

/**
 * The host hook: archive (or restore) `packageName`'s dashboards for
 * `organizationId` on the committed lifecycle transition. Idempotent + best-effort
 * (the firer awaits + swallows throws); the reader gate + migration sweep are the
 * backstop, so this is data-hygiene, not the safety mechanism.
 */
export const extensionDashboardLifecycleHook: ExtensionDashboardLifecycleHook = async (input) => {
  const actor = {
    userId: input.actorPrincipalId ?? "system:extension-dashboard-lifecycle",
    organizationId: input.organizationId,
    teamIds: [] as string[],
    orgRole: "owner" as const,
    teamRoles: {} as Record<string, "admin" | "member">,
    // Purpose-scoped system authority (content.write only): the kernel rules
    // it against the ORG lifecycle — an archived org refuses even this hook
    // (extension restore inside an archived org must not write).
    authority: mintSystemWriteAuthority(
      "extension-dashboard-lifecycle",
      input.organizationId,
    ),
  };
  if (input.transition === "archive") {
    return archiveExtensionDashboards(undefined, {
      extensionId: input.packageName,
      organizationId: input.organizationId,
      actor,
      reason: LIFECYCLE_ARCHIVE_REASON,
    });
  }
  return restoreExtensionDashboards(undefined, {
    extensionId: input.packageName,
    organizationId: input.organizationId,
    actor,
  });
};
