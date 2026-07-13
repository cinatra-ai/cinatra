import "server-only";

import type { HostPortName } from "@cinatra-ai/sdk-extensions";

import type { InstallPipelineDeps } from "@/lib/extension-install-pipeline";
import {
  recordRequestedGrant,
  approveGrant,
  readGrantForScope,
  restoreGrant,
} from "@/lib/extension-host-port-grants";

// ---------------------------------------------------------------------------
// Install-pipeline integration for the host-port grant store. Split OUT of
// `extension-host-port-grants.ts` (cinatra#1391 / #1283): the grant store is
// reached by the import-light approvals nav contract (the pending-grant badge
// count), so it MUST stay off the heavy decide/render + install surfaces
// (nav-registry-import-purity). This adapter references
// `InstallPipelineDeps` (whose module graph reaches the MCP/approvals registry),
// so it lives HERE — imported only by the install pipeline, never the nav graph.
// Behavior-identical: the SAME four grant-lifecycle adapters over the store's
// own functions.
// ---------------------------------------------------------------------------

/**
 * The host-port grant lifecycle hooks for `makeDefaultInstallPipelineDeps`.
 * `readGrantForScope` is the hot-UPDATE probe's EXACT-(package, org)-scoped grant
 * ROW (status + approvedPorts + requestedPortsHash), NO global fallback — the
 * SAME exact-scope resolution `resolveInstallAnchor` uses; `restoreGrant` re-pins
 * the OLD grant row on durable rollback.
 */
export function makeHostPortGrantInstallDeps(): Pick<
  InstallPipelineDeps,
  "recordRequestedGrant" | "approveGrant" | "readGrantForScope" | "restoreGrant"
> {
  return {
    recordRequestedGrant: (g) =>
      recordRequestedGrant({
        packageName: g.packageName,
        orgId: g.orgId,
        requestedPorts: g.requestedPorts as readonly HostPortName[],
      }).then(() => undefined),
    approveGrant: (g) =>
      approveGrant({
        packageName: g.packageName,
        orgId: g.orgId,
        approvedPorts: g.approvedPorts as readonly HostPortName[],
        requestedPorts: g.requestedPorts as readonly HostPortName[],
        approvedBy: g.approvedBy,
      }).then(() => undefined),
    readGrantForScope: async (packageName, orgId) => {
      const g = await readGrantForScope({ packageName, orgId });
      return g
        ? {
            orgId: g.orgId,
            status: g.status,
            approvedPorts: g.approvedPorts,
            requestedPortsHash: g.requestedPortsHash,
            approvedBy: g.approvedBy,
          }
        : null;
    },
    restoreGrant: (i) =>
      restoreGrant({
        packageName: i.packageName,
        orgId: i.orgId,
        status: i.status,
        approvedPorts: i.approvedPorts,
        requestedPortsHash: i.requestedPortsHash,
        approvedBy: i.approvedBy,
      }).then(() => undefined),
  };
}
