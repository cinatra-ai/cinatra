// cinatra#2694 — S4 (#2698) SEQUENCING PIN, left by S3 (#2697).
//
// S3 makes a workspace-anchored connector RESOLVABLE and USABLE from every
// organization. It deliberately does NOT touch lifecycle operations: the epic
// assigns "update/archive/restore/reinstall target the full row identity" to
// S4, and widening the lifecycle target resolver here would be a scope
// deviation, not a completion.
//
// So the gap is pinned rather than claimed — exactly as S2 pinned the connector
// refusal for S3 to flip. `resolveLifecycleScope` selects rows whose
// `organizationId` EQUALS the actor's active org, so:
//   - an ORG-scoped actor cannot address the org-NULL workspace row at all
//     (`no_addressable_row`), even though that row now serves their org;
//   - a NULL-org (platform) actor hits `ambiguous_target` where a platform
//     bundled anchor coexists with the workspace row — the DB permits that
//     coexistence because the org-NULL identity index keys on `owner_level`.
//
// When S4 lands, these expectations flip. Until then they are the live record
// that a workspace-anchored row is USABLE but not yet LIFECYCLE-MANAGEABLE.

import { describe, it, expect } from "vitest";
import { resolveLifecycleScope } from "../lifecycle-target-resolver";
import type { InstalledExtension } from "../canonical-types";

const PKG = "@acme/widgets-connector";

function row(over: Partial<InstalledExtension>): InstalledExtension {
  return {
    id: "row-" + Math.random().toString(36).slice(2),
    packageName: PKG,
    ownerLevel: "organization",
    ownerId: "org-a",
    organizationId: "org-a",
    kind: "connector",
    status: "active",
    source: {} as InstalledExtension["source"],
    requiredInProd: false,
    dependencies: [],
    ...over,
  } as InstalledExtension;
}

const workspaceRow = () =>
  row({ ownerLevel: "workspace", ownerId: "__platform__", organizationId: null });
const platformBundledRow = () =>
  row({ ownerLevel: "platform", ownerId: "__platform__", organizationId: null });

describe("S4 pin — the org-pinned lifecycle resolver cannot address a workspace row", () => {
  it("an ORG actor gets no_addressable_row for a workspace-anchored row it can otherwise USE", () => {
    const resolution = resolveLifecycleScope([workspaceRow()], {
      orgId: "org-a",
      roles: ["org_admin"],
    } as never);
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.code).toBe("no_addressable_row");
  });

  it("a NULL-org actor hits ambiguous_target where a bundled platform anchor coexists", () => {
    const resolution = resolveLifecycleScope(
      [platformBundledRow(), workspaceRow()],
      { orgId: null, roles: ["platform_admin"] } as never,
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.code).toBe("ambiguous_target");
  });

  it("an ORG-anchored row is unaffected — S3 changed nothing on this path", () => {
    const own = row({});
    const resolution = resolveLifecycleScope([own], {
      orgId: "org-a",
      roles: ["org_admin"],
    } as never);
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("unreachable");
    expect(resolution.row.id).toBe(own.id);
  });
});
