// Picker value → install target adapter for the in-card install panel
// (cinatra#2373). Fail-closed by construction: anything that is not a real,
// id-carrying audience resolves to null, so the panel can never invoke the
// server action with an empty or non-target selection.

import { describe, expect, it } from "vitest";
import { pickerValueToInstallTarget } from "../install-picker-target";

const ORG = "org-acme";

describe("pickerValueToInstallTarget", () => {
  it("maps the workspace AUDIENCE rows onto the active org as tenant anchor", () => {
    expect(pickerValueToInstallTarget("workspace", ORG)).toEqual({
      level: "workspace",
      id: ORG,
    });
    expect(pickerValueToInstallTarget("admin", ORG)).toEqual({
      level: "admin",
      id: ORG,
    });
  });

  it("refuses the workspace rows without an active organization", () => {
    expect(pickerValueToInstallTarget("workspace", "")).toBeNull();
    expect(pickerValueToInstallTarget("admin", "")).toBeNull();
  });

  it("maps id-carrying org / team / project tokens", () => {
    expect(pickerValueToInstallTarget(`org:${ORG}`, ORG)).toEqual({
      level: "organization",
      id: ORG,
    });
    expect(pickerValueToInstallTarget("team:t1", ORG)).toEqual({
      level: "team",
      id: "t1",
    });
    expect(pickerValueToInstallTarget("project:p1", ORG)).toEqual({
      level: "project",
      id: "p1",
    });
  });

  it("refuses EMPTY-tail tokens — a stray value never reaches the action", () => {
    expect(pickerValueToInstallTarget("org:", ORG)).toBeNull();
    expect(pickerValueToInstallTarget("team:", ORG)).toBeNull();
    expect(pickerValueToInstallTarget("project:", ORG)).toBeNull();
  });

  it("accepts the bare legacy org token only with an active organization", () => {
    expect(pickerValueToInstallTarget("org", ORG)).toEqual({
      level: "organization",
      id: ORG,
    });
    expect(pickerValueToInstallTarget("org", "")).toBeNull();
  });

  it("refuses non-targets (owner, empty, unknown)", () => {
    expect(pickerValueToInstallTarget("owner", ORG)).toBeNull();
    expect(pickerValueToInstallTarget("", ORG)).toBeNull();
    expect(pickerValueToInstallTarget("nonsense", ORG)).toBeNull();
  });
});
