// cinatra#2694 — S4 (#2698). This file WAS the sequencing pin S3 (#2697) left
// behind: it asserted that a workspace-anchored row, though usable from every
// organization, could not be addressed by ANY lifecycle operation, because
// `resolveLifecycleScope` selected on `organizationId` equality alone.
//
// S4 closes that gap, so the pin is FLIPPED — the same three situations, now
// asserted POSITIVELY:
//
//   1. a PLATFORM ADMIN addresses the org-NULL workspace row, from an
//      org-scoped session (the session a platform admin actually installs
//      "Workspace: All" from). Previously `no_addressable_row`.
//   2. where a bundled PLATFORM anchor coexists with the WORKSPACE row at the
//      same org-NULL scope, the operator's row selector (`owner_level` — the
//      identity's discriminator) resolves EXACTLY the named row. Previously
//      `ambiguous_target` with no way out.
//   3. an ORG-anchored row is untouched by any of it.
//
// Two refusals are asserted here too, because they are the RULE and not a gap:
// an org-scoped actor without platform standing still cannot address the
// workspace row (it serves every organization — one org's admin must never
// archive or update it), and a coexistence with NO selector still refuses
// rather than guessing which row the operator meant.

import { describe, it, expect } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";
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

const platformAdminInOrg = (orgId: string | null): Actor =>
  ({ orgId, platformRole: "platform_admin", actorType: "human", source: "ui" }) as Actor;
const orgAdmin = (orgId: string): Actor =>
  ({ orgId, orgRole: "org_admin", actorType: "human", source: "ui" }) as Actor;

describe("cinatra#2698 — lifecycle operations address the full row identity", () => {
  it("a PLATFORM ADMIN in an org-scoped session addresses the workspace-anchored row", () => {
    const ws = workspaceRow();
    const resolution = resolveLifecycleScope([ws], platformAdminInOrg("org-a"));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("unreachable");
    expect(resolution.row.id).toBe(ws.id);
    // The row it resolved is the app-wide one — NOT re-anchored to the session's org.
    expect(resolution.row.organizationId).toBeNull();
    expect(resolution.row.ownerLevel).toBe("workspace");
  });

  it("the selector picks EXACTLY the workspace row where a bundled platform anchor coexists", () => {
    const bundled = platformBundledRow();
    const ws = workspaceRow();
    const resolution = resolveLifecycleScope([bundled, ws], platformAdminInOrg(null), {
      ownerLevel: "workspace",
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("unreachable");
    expect(resolution.row.id).toBe(ws.id);
  });

  it("the selector picks EXACTLY the bundled platform anchor when that is the named tier", () => {
    const bundled = platformBundledRow();
    const ws = workspaceRow();
    const resolution = resolveLifecycleScope([bundled, ws], platformAdminInOrg(null), {
      ownerLevel: "platform",
    });
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("unreachable");
    expect(resolution.row.id).toBe(bundled.id);
  });

  it("coexisting rows with NO selector still refuse — the operator picks, nothing is guessed", () => {
    const resolution = resolveLifecycleScope(
      [platformBundledRow(), workspaceRow()],
      platformAdminInOrg(null),
    );
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.code).toBe("ambiguous_target");
  });

  it("an ORG-SCOPED actor without platform standing still cannot address the workspace row", () => {
    // Deliberate, not a gap: the workspace row serves EVERY organization, so
    // one org's admin acting on it would reach into all the others.
    const resolution = resolveLifecycleScope([workspaceRow()], orgAdmin("org-a"));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.code).toBe("no_addressable_row");
  });

  it("the selector reaches the workspace row from a session whose org ALSO has one", () => {
    // The coexistence case: no selector resolves the platform admin's OWN org
    // row (unchanged); naming the tier reaches across to the app-wide row.
    const own = row({});
    const ws = workspaceRow();
    const admin = platformAdminInOrg("org-a");
    const bare = resolveLifecycleScope([own, ws], admin);
    expect(bare.ok && bare.row.id).toBe(own.id);
    const named = resolveLifecycleScope([own, ws], admin, { ownerLevel: "workspace" });
    expect(named.ok && named.row.id).toBe(ws.id);
    const namedOrg = resolveLifecycleScope([own, ws], admin, { ownerLevel: "organization" });
    expect(namedOrg.ok && namedOrg.row.id).toBe(own.id);
  });

  it("an ORG actor's selector cannot reach the workspace row — the arm is not theirs", () => {
    const own = row({});
    const resolution = resolveLifecycleScope([own, workspaceRow()], orgAdmin("org-a"), {
      ownerLevel: "workspace",
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.code).toBe("no_addressable_row");
  });

  it("an ORG-anchored row is unaffected — the actor's own scope always wins", () => {
    const own = row({});
    for (const actor of [orgAdmin("org-a"), platformAdminInOrg("org-a")]) {
      const resolution = resolveLifecycleScope([own, workspaceRow()], actor);
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) throw new Error("unreachable");
      expect(resolution.row.id).toBe(own.id);
    }
  });

  it("a platform admin's own-scope row is NEVER displaced by the org-NULL fallback", () => {
    // The fallback arm is reached ONLY when the actor's own scope is empty, so
    // no row an actor resolves today can be replaced by an org-NULL one.
    const own = row({});
    const resolution = resolveLifecycleScope(
      [own, workspaceRow(), platformBundledRow()],
      platformAdminInOrg("org-a"),
    );
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("unreachable");
    expect(resolution.row.id).toBe(own.id);
  });
});
