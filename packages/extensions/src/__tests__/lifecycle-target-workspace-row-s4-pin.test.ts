// cinatra#2694 — S4 (#2698). This file WAS the sequencing pin S3 (#2697) left
// behind: it asserted that a workspace-anchored row, though usable from every
// organization, could not be addressed by ANY lifecycle operation, because
// `resolveLifecycleScope` selected on `organizationId` equality alone.
//
// S4 closes that gap, so the pin is FLIPPED. Under the owner ruling of
// 2026-08-16 the closing rule is THE EFFECTIVE ROW: a live workspace row
// SUPERSEDES every organization row of the same package, so the workspace row
// resolves for a platform admin with NO selector at all, and the coexistence
// the earlier S4 text asked an operator to choose between is not a state the
// product presents any more.
//
// Asserted here:
//
//   1. a PLATFORM ADMIN addresses the org-NULL workspace row from an org-scoped
//      session — the session a platform admin actually installs "Workspace:
//      All" from — even when their own organization still holds a row for the
//      package. Previously `no_addressable_row`, then (pre-rework) reachable
//      only by naming a tier.
//   2. an ORGANIZATION admin resolves NOTHING for such a package: their own row
//      is superseded and the workspace row serves every organization, so acting
//      on it from one organization would reach into all the others.
//   3. an ARCHIVED organization row is not a candidate either, and a
//      non-superseded organization row is completely unaffected.
//   4. where a bundled PLATFORM anchor coexists with the WORKSPACE row at the
//      same org-NULL scope — the one genuine same-scope identity ambiguity the
//      store still permits — a SERVER-MINTED anchor-tier selector resolves
//      exactly the named row, and no selector still refuses rather than
//      guessing.

import { describe, it, expect } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";
import {
  effectiveInstallRows,
  findLiveWorkspaceRow,
  resolveLifecycleScope,
} from "../lifecycle-target-resolver";
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

  it("the WORKSPACE row supersedes the platform admin's own organization row", () => {
    // THE rework. The platform admin's own organization also holds a row for
    // this package; the live workspace row is the one in force, so it resolves
    // with no selector and the organization row is not a candidate at all.
    const own = row({});
    const ws = workspaceRow();
    const resolution = resolveLifecycleScope([own, ws], platformAdminInOrg("org-a"));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("unreachable");
    expect(resolution.row.id).toBe(ws.id);
  });

  it("an ORG admin whose row is superseded resolves NOTHING", () => {
    const own = row({});
    const resolution = resolveLifecycleScope([own, workspaceRow()], orgAdmin("org-a"));
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.code).toBe("no_addressable_row");
  });

  it("an ARCHIVED organization row beside a live workspace row is not a candidate", () => {
    const superseded = row({ status: "archived" });
    const ws = workspaceRow();
    expect(effectiveInstallRows([superseded, ws])).toEqual([ws]);
    const resolution = resolveLifecycleScope([superseded, ws], orgAdmin("org-a"));
    expect(resolution.ok).toBe(false);
  });

  it("an ARCHIVED workspace row supersedes nothing — the organization row is back", () => {
    // The read half of "no automatic revival": the organization row does not
    // come back to LIFE, but it does become addressable again, which is what
    // makes the ordinary guarded restore reach it.
    const own = row({ status: "archived" });
    const deadWs = row({
      ownerLevel: "workspace",
      ownerId: "__platform__",
      organizationId: null,
      status: "archived",
    });
    expect(findLiveWorkspaceRow([own, deadWs])).toBeNull();
    const resolution = resolveLifecycleScope([own, deadWs], orgAdmin("org-a"));
    expect(resolution.ok).toBe(true);
    if (!resolution.ok) throw new Error("unreachable");
    expect(resolution.row.id).toBe(own.id);
  });

  it("an organization row with NO workspace row is completely unaffected", () => {
    const own = row({});
    for (const actor of [orgAdmin("org-a"), platformAdminInOrg("org-a")]) {
      const resolution = resolveLifecycleScope([own], actor);
      expect(resolution.ok).toBe(true);
      if (!resolution.ok) throw new Error("unreachable");
      expect(resolution.row.id).toBe(own.id);
    }
  });

  it("a bundled PLATFORM anchor does NOT supersede an organization row", () => {
    // Supersession is a WORKSPACE-tier rule. The bundled/system tier keeps its
    // existing path, so an organization's own row still resolves for it.
    const own = row({});
    const bundled = platformBundledRow();
    expect(effectiveInstallRows([own, bundled])).toEqual([own, bundled]);
    const resolution = resolveLifecycleScope([own, bundled], orgAdmin("org-a"));
    expect(resolution.ok && resolution.row.id).toBe(own.id);
  });
});
