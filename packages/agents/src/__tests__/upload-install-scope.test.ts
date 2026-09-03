/**
 * Install-scope configuration on the Upload screen (cinatra#3204, acceptance
 * criteria 11-16 and 32).
 *
 * The Upload screen used to ask an access question that was not the store's
 * question. The File tab rendered the agent RUN-VISIBILITY checkbox picker
 * ("who may list / read / execute runs of this agent") under the heading
 * "Access", wrote it non-fatally, and anchored the canonical row at a hardcoded
 * `claimantOrgId ? "organization" : "platform"` derivation the operator never
 * saw. The GitHub tab asked a third version of the question through its own
 * collapsed ownership editor. None of the three was the INSTALL SCOPE — who the
 * extension is installed FOR — which is what a store install asks.
 *
 * This module is the upload road's half of that one question, and this suite
 * pins two things about it:
 *
 *   - it REUSES the store's own primitives rather than reimplementing their
 *     rules (asserted by module identity, not by behavioural coincidence);
 *   - it applies the recorded decision for `agent` and `skill`: the upload road
 *     configures scope for all four live kinds, while the STORE-side
 *     `INSTALL_ACCESS_TARGET_KINDS` set is left exactly as it was.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/upload-install-scope.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  INSTALL_ACCESS_TARGET_KINDS,
  resolveInstallAccessTargetContract,
} from "@cinatra-ai/extensions/install-access-target";
import { resolveInstallRowAnchor, WORKSPACE_ANCHOR_ROW_OWNERSHIP } from "@cinatra-ai/extensions/canonical-types";
import { pickerValueToInstallTarget } from "@cinatra-ai/extensions/screens/install-picker-target";
import { resolveInstallPanelAvailability } from "@cinatra-ai/extensions/screens/install-panel-availability";

import {
  UPLOAD_INSTALL_SCOPE_PRIMITIVES,
  UPLOAD_SCOPE_CONFIGURED_KINDS,
  UploadInstallScopeError,
  resolveUploadInstallScope,
  uploadAccessResourceKindFor,
} from "../upload-install-scope";

const ORG = "org_1";

// ---------------------------------------------------------------------------
// Criterion 11 — the store's own modules, not a second implementation
// ---------------------------------------------------------------------------

describe("the Upload screen mounts the store's own picker primitives", () => {
  it("uses the very functions the marketplace install panel uses", () => {
    expect(UPLOAD_INSTALL_SCOPE_PRIMITIVES.pickerValueToInstallTarget).toBe(
      pickerValueToInstallTarget,
    );
    expect(UPLOAD_INSTALL_SCOPE_PRIMITIVES.resolveInstallPanelAvailability).toBe(
      resolveInstallPanelAvailability,
    );
    expect(UPLOAD_INSTALL_SCOPE_PRIMITIVES.resolveInstallAccessTargetContract).toBe(
      resolveInstallAccessTargetContract,
    );
    expect(UPLOAD_INSTALL_SCOPE_PRIMITIVES.resolveInstallRowAnchor).toBe(resolveInstallRowAnchor);
  });

  it("offers the store's level set, and never 'owner'", () => {
    expect(resolveUploadInstallScope({ pickerValue: "workspace", activeOrganizationId: ORG }).target.level).toBe("workspace");
    expect(resolveUploadInstallScope({ pickerValue: "admin", activeOrganizationId: ORG }).target.level).toBe("admin");
    expect(resolveUploadInstallScope({ pickerValue: `org:${ORG}`, activeOrganizationId: ORG }).target.level).toBe("organization");
    expect(resolveUploadInstallScope({ pickerValue: "team:t1", activeOrganizationId: ORG }).target.level).toBe("team");
    expect(resolveUploadInstallScope({ pickerValue: "project:p1", activeOrganizationId: ORG }).target.level).toBe("project");
    expect(() =>
      resolveUploadInstallScope({ pickerValue: "owner", activeOrganizationId: ORG }),
    ).toThrow(UploadInstallScopeError);
  });

  it("refuses an empty-tail token, so a stray value can never reach the action", () => {
    for (const value of ["org:", "team:", "project:", ""]) {
      expect(() => resolveUploadInstallScope({ pickerValue: value, activeOrganizationId: ORG })).toThrow(
        /is not an installable scope/,
      );
    }
  });

  it("refuses when the session carries no active organization", () => {
    expect(() =>
      resolveUploadInstallScope({ pickerValue: "workspace", activeOrganizationId: null }),
    ).toThrow(/active organization/);
  });

  it("re-exports the availability resolver so the Upload screen renders the same three states", () => {
    const states = [
      resolveUploadInstallScope.availability({ activeOrgId: "", installTargets: [], fallbackDefaultValue: null }),
      resolveUploadInstallScope.availability({
        activeOrgId: ORG,
        installTargets: [{ value: "workspace", label: "Workspace: All", level: "workspace", id: ORG }] as never,
        fallbackDefaultValue: null,
      }),
      resolveUploadInstallScope.availability({ activeOrgId: ORG, installTargets: [], fallbackDefaultValue: null }),
    ].map((a) => a.state);
    expect(states).toEqual(["no-active-organization", "ready", "no-installable-scope"]);
  });
});

// ---------------------------------------------------------------------------
// Criterion 12 — the recorded decision for agent and skill
// ---------------------------------------------------------------------------

describe("the recorded decision for agent and skill", () => {
  it("leaves the STORE-side target set exactly as it was", () => {
    // The decision is explicitly NOT to widen the store's own selector here —
    // extending it to agent/skill is a named follow-up, not part of this change.
    expect([...INSTALL_ACCESS_TARGET_KINDS]).toEqual(["connector", "artifact", "workflow"]);
  });

  it("configures the scope on the UPLOAD road for all four live kinds", () => {
    expect([...UPLOAD_SCOPE_CONFIGURED_KINDS]).toEqual([
      "agent",
      "connector",
      "artifact",
      "skill",
    ]);
  });

  it("names the access resource kind each uploaded kind persists against", () => {
    expect(uploadAccessResourceKindFor("agent")).toBe("agent_template");
    expect(uploadAccessResourceKindFor("skill")).toBe("skill_package");
    expect(uploadAccessResourceKindFor("connector")).toBe("connector");
    expect(uploadAccessResourceKindFor("artifact")).toBe("artifact");
  });
});

// ---------------------------------------------------------------------------
// Criterion 15 — the row anchor comes from the chosen target
// ---------------------------------------------------------------------------

describe("the canonical row anchor follows the chosen target", () => {
  it("anchors the two workspace targets at the workspace tuple", () => {
    for (const value of ["workspace", "admin"]) {
      const { rowAnchor } = resolveUploadInstallScope({ pickerValue: value, activeOrganizationId: ORG });
      expect(rowAnchor).toEqual({ ...WORKSPACE_ANCHOR_ROW_OWNERSHIP });
    }
  });

  it("leaves organization, team and project targets ORGANIZATION-anchored", () => {
    for (const value of [`org:${ORG}`, "team:t1", "project:p1"]) {
      const { rowAnchor } = resolveUploadInstallScope({ pickerValue: value, activeOrganizationId: ORG });
      expect(rowAnchor).toEqual({
        ownerLevel: "organization",
        ownerId: ORG,
        organizationId: ORG,
      });
    }
  });

  it("is byte-identical to what the store contract resolves for the same target", () => {
    const decision = resolveUploadInstallScope({ pickerValue: "team:t1", activeOrganizationId: ORG });
    const store = resolveInstallAccessTargetContract({ level: "team", id: "t1" }, ORG);
    expect(decision.rowAnchor).toEqual(resolveInstallRowAnchor(ORG, store.rowOwnership));
    expect(decision.policy).toEqual(store.policy);
  });

  it("never derives the anchor from the actor alone — the retired upload derivation is gone", () => {
    // The retired rule was `claimantOrgId ? "organization" : "platform"`: with an
    // active org it produced an organization anchor NO MATTER which scope the
    // operator picked, so a Workspace: All upload landed org-anchored.
    const workspace = resolveUploadInstallScope({ pickerValue: "workspace", activeOrganizationId: ORG });
    expect(workspace.rowAnchor.ownerLevel).not.toBe("organization");
    expect(workspace.rowAnchor.organizationId).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The audience half
// ---------------------------------------------------------------------------

describe("the audience policy the upload persists", () => {
  it("defers to the kind's install default for the organization target", () => {
    expect(
      resolveUploadInstallScope({ pickerValue: `org:${ORG}`, activeOrganizationId: ORG }).policy,
    ).toBeUndefined();
  });

  it("names an explicit audience for every narrower or wider target", () => {
    const cases: [string, string][] = [
      ["workspace", "workspace"],
      ["admin", "admin"],
      ["team:t1", "team:t1"],
      ["project:p1", "project:p1"],
    ];
    for (const [value, token] of cases) {
      const { policy } = resolveUploadInstallScope({ pickerValue: value, activeOrganizationId: ORG });
      expect(policy?.runListVisibility).toEqual([token]);
      expect(policy?.runDataVisibility).toEqual([token]);
      expect(policy?.runExecuteVisibility).toEqual([token]);
      expect(policy?.allowRunSharing).toBe(false);
    }
  });
});
