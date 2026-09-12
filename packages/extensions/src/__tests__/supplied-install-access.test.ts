import { describe, expect, it } from "vitest";

import {
  SUPPLIED_INSTALL_ACCESS_TARGET_KINDS,
  assertSuppliedInstallAccessTarget,
  isSuppliedInstallAccessTargetKind,
  resolveSuppliedInstallAccessResource,
} from "../supplied-install-access";
import { INSTALL_ACCESS_TARGET_KINDS } from "../install-access-target";

// ---------------------------------------------------------------------------
// cinatra#3204 criterion 12 — the recorded decision, asserted by test.
//
// The supplied road configures the scope for ALL FOUR live kinds; the STORE
// road's own set is left exactly as it was. Both halves are pinned here,
// because the decision is only meaningful if the second half is also true.
// ---------------------------------------------------------------------------

describe("the supplied road's install-access decision (criterion 12)", () => {
  it("requires an install scope for all four live kinds", () => {
    expect([...SUPPLIED_INSTALL_ACCESS_TARGET_KINDS].sort()).toEqual([
      "agent",
      "artifact",
      "connector",
      "skill",
    ]);
  });

  it("leaves the store road's own kind set untouched", () => {
    expect([...INSTALL_ACCESS_TARGET_KINDS]).toEqual([
      "connector",
      "artifact",
      "workflow",
    ]);
  });

  it("does not admit the retired workflow kind", () => {
    expect(isSuppliedInstallAccessTargetKind("workflow")).toBe(false);
    expect(isSuppliedInstallAccessTargetKind("agent")).toBe(true);
  });
});

describe("where the chosen scope is recorded, per kind (criterion 16)", () => {
  it("records connector and artifact access on the canonical row", () => {
    expect(resolveSuppliedInstallAccessResource("connector")).toEqual({
      accessKind: "connector",
      carrier: "canonical-row",
    });
    expect(resolveSuppliedInstallAccessResource("artifact")).toEqual({
      accessKind: "artifact",
      carrier: "canonical-row",
    });
  });

  it("records agent and skill access on their own native row", () => {
    expect(resolveSuppliedInstallAccessResource("agent")).toEqual({
      accessKind: "agent_template",
      carrier: "native-row",
    });
    expect(resolveSuppliedInstallAccessResource("skill")).toEqual({
      accessKind: "skill_package",
      carrier: "native-row",
    });
  });
});

describe("the fail-closed precondition (criterion 13)", () => {
  it("refuses an absent target for every one of the four kinds", () => {
    for (const kind of SUPPLIED_INSTALL_ACCESS_TARGET_KINDS) {
      expect(() => assertSuppliedInstallAccessTarget(kind, undefined)).toThrow(
        /requires an explicit install scope/,
      );
    }
  });

  it("refuses a kind this road does not install", () => {
    expect(() =>
      assertSuppliedInstallAccessTarget("workflow", {
        level: "workspace",
        id: "org_1",
      }),
    ).toThrow(/is not a kind this product installs from a supplied package/);
  });

  it("admits a present target", () => {
    expect(() =>
      assertSuppliedInstallAccessTarget("agent", { level: "team", id: "team_1" }),
    ).not.toThrow();
  });
});
