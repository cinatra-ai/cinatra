/**
 * cinatra#2597 — the ONE scope-picker model both approval surfaces bind to.
 *
 * The inbox row dialog (src/lib/approvals/agent-decision-actions.tsx) and the
 * approvals DETAIL page (src/app/configuration/agents/approvals/[id]/
 * decision-form.tsx) each render the #1327 access-scope step. They must offer
 * the SAME rows, disable the SAME targets, and reach the SAME "you cannot grant
 * access anywhere" empty state — a divergence would mean an approve that
 * succeeds on one surface and is refused on the other. `approvalScopePickerModel`
 * is that single derivation; this pins its behaviour.
 */
import { describe, it, expect } from "vitest";

import { approvalScopePickerModel } from "@cinatra-ai/agents/auth-policy-types";

const ORG = "org-1";

function ctx(
  overrides: Partial<Parameters<typeof approvalScopePickerModel>[0]> = {},
): Parameters<typeof approvalScopePickerModel>[0] {
  return {
    activeOrgId: ORG,
    defaultValue: `org:${ORG}`,
    ownerEntityNames: {},
    installTargets: [],
    ...overrides,
  };
}

describe("approvalScopePickerModel", () => {
  it("splits the server-computed targets into the combobox's team / project rows", () => {
    const model = approvalScopePickerModel(
      ctx({
        installTargets: [
          { value: `org:${ORG}`, label: "Acme", level: "organization", id: ORG, disabled: false },
          { value: "team:t1", label: "Team One", level: "team", id: "t1", disabled: false },
          { value: "project:p1", label: "Project One", level: "project", id: "p1", disabled: false },
        ],
      }),
    );
    expect(model.availableScopes.teams).toEqual([{ id: "t1", name: "Team One" }]);
    expect(model.availableScopes.projects).toEqual([{ id: "p1", name: "Project One" }]);
    expect(model.availableScopes.orgId).toBe(ORG);
    // Install parity: owner / admin / workspace are not access targets here.
    expect(model.availableScopes.workspaceExposed).toBe(false);
  });

  it("prefers the resolved owner-entity name over the target's own label", () => {
    const model = approvalScopePickerModel(
      ctx({
        installTargets: [
          { value: "team:t1", label: "stale label", level: "team", id: "t1", disabled: false },
        ],
        ownerEntityNames: { "team:t1": "Platform Team", [`org:${ORG}`]: "Acme Inc" },
      }),
    );
    expect(model.availableScopes.teams).toEqual([{ id: "t1", name: "Platform Team" }]);
    expect(model.availableScopes.orgName).toBe("Acme Inc");
  });

  it("leaves orgName EMPTY when the org has no resolved name, so the combobox uses its own fallback", () => {
    expect(approvalScopePickerModel(ctx()).availableScopes.orgName).toBe("");
  });

  it("carries the disabled targets and their reasons, with a generic fallback reason", () => {
    const model = approvalScopePickerModel(
      ctx({
        installTargets: [
          {
            value: "team:t1",
            label: "Team One",
            level: "team",
            id: "t1",
            disabled: true,
            reason: "You are not a team admin",
          },
          { value: "project:p1", label: "P1", level: "project", id: "p1", disabled: true },
          { value: "project:p2", label: "P2", level: "project", id: "p2", disabled: false },
        ],
      }),
    );
    expect(model.disabledScopes).toEqual(["team:t1", "project:p1"]);
    expect(model.disabledReasons).toEqual({
      "team:t1": "You are not a team admin",
      "project:p1": "Not available",
    });
    // A disabled row is still RENDERED — it is offered but unselectable.
    expect(model.availableScopes.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
  });

  it("reports noInstallableScope ONLY when the server resolved no default target", () => {
    expect(approvalScopePickerModel(ctx({ defaultValue: null })).noInstallableScope).toBe(true);
    expect(approvalScopePickerModel(ctx({ defaultValue: "team:t1" })).noInstallableScope).toBe(
      false,
    );
  });
});
