import { describe, it, expect } from "vitest";
import {
  classifyRemovalFailure,
  removalFailureCopy,
  type RemovalActionResult,
} from "../removal-failure";
import { DependencyClosureError, ClosureCheckUnavailableError } from "../dependency-closure";
import { SystemExtensionRemovalError } from "../system-extension-inventory";

// The legacy `ActiveDependentError` lives on the extensions MAIN entry
// (index.ts), whose import graph has boot side-effects; the classifier only
// duck-types on its stable `.name` + `.dependentName`, so we reproduce that
// exact shape here rather than pull the heavy module into a pure unit test —
// which also exercises the cross-boundary (no-instanceof) contract directly.
const activeDependentErrorShaped = (dependentName: string) => ({
  name: "ActiveDependentError",
  dependentName,
  message: `Cannot uninstall — ${dependentName} requires this extension.`,
});

// cinatra#1061 — the REMOVAL returned-refusal contract. The whole point is that
// a removal refusal RETURNS (survives Next.js prod masking) and, for a closure
// gate, NAMES the blockers. These lock the classifier ↔ error-surface mapping
// and the user-facing copy.

describe("classifyRemovalFailure", () => {
  it("maps the #1036 system-extension guard to reason=system", () => {
    const err = new SystemExtensionRemovalError("@cinatra-ai/nango-connector", "uninstall");
    expect(classifyRemovalFailure(err)).toEqual({ ok: false, reason: "system" });
  });

  it("maps a canonical closure refusal to reason=dependents, NAMING the blockers", () => {
    const err = new DependencyClosureError(
      "ARCHIVE_BREAKS_CLOSURE",
      "Cannot archive/uninstall @cinatra-ai/nango-connector — required by active dependents: a, b.",
      ["@cinatra-ai/a", "@cinatra-ai/b"],
    );
    expect(classifyRemovalFailure(err)).toEqual({
      ok: false,
      reason: "dependents",
      dependents: ["@cinatra-ai/a", "@cinatra-ai/b"],
    });
  });

  it("maps the legacy ActiveDependentError to reason=dependents with the single blocker", () => {
    const err = activeDependentErrorShaped("Orchestrator Agent");
    expect(classifyRemovalFailure(err)).toEqual({
      ok: false,
      reason: "dependents",
      dependents: ["Orchestrator Agent"],
    });
  });

  it("maps a fail-CLOSED closure-check outage to reason=error (no blockers known)", () => {
    const err = new ClosureCheckUnavailableError("@cinatra-ai/nango-connector");
    expect(classifyRemovalFailure(err)).toEqual({ ok: false, reason: "error" });
  });

  it("fails SAFE to reason=error for an unrelated error", () => {
    expect(classifyRemovalFailure(new Error("kaboom"))).toEqual({ ok: false, reason: "error" });
    expect(classifyRemovalFailure(null)).toEqual({ ok: false, reason: "error" });
    expect(classifyRemovalFailure("string error")).toEqual({ ok: false, reason: "error" });
  });

  it("does not report reason=dependents when a closure error carries no dependent names", () => {
    // Defensive: an ARCHIVE_BREAKS_CLOSURE with an empty list is not actionable
    // as "dependents" copy — fall through to the generic error.
    const err = new DependencyClosureError("ARCHIVE_BREAKS_CLOSURE", "no names", []);
    expect(classifyRemovalFailure(err)).toEqual({ ok: false, reason: "error" });
  });

  it("classifies across a duck-typed boundary (no instanceof reliance)", () => {
    // A structurally-equivalent plain object (as if reconstructed across the
    // server-action / package boundary) classifies the same way.
    const wireShaped = { code: "ARCHIVE_BREAKS_CLOSURE", dependents: ["x"], message: "m" };
    expect(classifyRemovalFailure(wireShaped)).toEqual({
      ok: false,
      reason: "dependents",
      dependents: ["x"],
    });
  });

  it("maps a PLATFORM artifact org-installs refusal to reason=org-installs, NAMING the orgs (id + name where resolvable)", () => {
    // Owner ruling 2026-07-22 (groganz). Duck-typed on the stable code +
    // .organizations (survives the server-action / package boundary).
    const err = {
      code: "PLATFORM_ARTIFACT_ORG_INSTALLS_PRESENT",
      organizations: [{ id: "org-a", name: "Acme Inc" }, { id: "org-b" }],
      message: "…",
    };
    expect(classifyRemovalFailure(err)).toEqual({
      ok: false,
      reason: "org-installs",
      organizations: [{ id: "org-a", name: "Acme Inc" }, { id: "org-b" }],
    });
  });

  it("falls SAFE to reason=error when the org-installs refusal carries no organizations", () => {
    const err = { code: "PLATFORM_ARTIFACT_ORG_INSTALLS_PRESENT", organizations: [] };
    expect(classifyRemovalFailure(err)).toEqual({ ok: false, reason: "error" });
    // Malformed org entries (no id) are dropped; an all-malformed list is not actionable.
    const malformed = { code: "PLATFORM_ARTIFACT_ORG_INSTALLS_PRESENT", organizations: [{ name: "X" }] };
    expect(classifyRemovalFailure(malformed)).toEqual({ ok: false, reason: "error" });
  });
});

describe("removalFailureCopy", () => {
  it("names a single blocker with singular grammar", () => {
    const r: RemovalActionResult = { ok: false, reason: "dependents", dependents: ["Sales Agent"] };
    const copy = removalFailureCopy(r, "uninstall", "Apollo Connector");
    expect(copy).toContain("Apollo Connector");
    expect(copy).toContain("Sales Agent");
    expect(copy).toContain("requires it");
    expect(copy).toContain("uninstall");
  });

  it("names multiple blockers with an Oxford-comma list and plural grammar", () => {
    const r: RemovalActionResult = {
      ok: false,
      reason: "dependents",
      dependents: ["A", "B", "C"],
    };
    const copy = removalFailureCopy(r, "archive", "Nango Connector");
    expect(copy).toContain("A, B, and C");
    expect(copy).toContain("require it");
    expect(copy).toContain("archive"); // operation verb
  });

  it("uses the stable #1036 system copy", () => {
    const r: RemovalActionResult = { ok: false, reason: "system" };
    expect(removalFailureCopy(r, "uninstall", "Nango Connector")).toBe(
      "System extension — can be updated but not deleted.",
    );
  });

  it("gives generic, non-technical copy for reason=error", () => {
    const r: RemovalActionResult = { ok: false, reason: "error" };
    const copy = removalFailureCopy(r, "uninstall", "Widget");
    expect(copy).toContain("Widget");
    expect(copy.toLowerCase()).toContain("try again");
    // Never leaks technical detail.
    expect(copy).not.toMatch(/store|manifest|closure|canonical|stack/i);
  });

  it("names the blocking organizations (id + name) for reason=org-installs — the migration list", () => {
    const r: RemovalActionResult = {
      ok: false,
      reason: "org-installs",
      organizations: [{ id: "org-a", name: "Acme Inc" }, { id: "org-b" }],
    };
    const copy = removalFailureCopy(r, "archive", "Kanban Board");
    expect(copy).toContain("Kanban Board");
    expect(copy).toContain("Acme Inc (org-a)");
    expect(copy).toContain("org-b"); // id-only fallback where the name is unresolved
    expect(copy).toContain("2 organizations");
    expect(copy).toContain("archive"); // operation verb
    expect(copy).toContain("archive its own copy first");
  });

  it("uses singular grammar for a single blocking organization", () => {
    const r: RemovalActionResult = {
      ok: false,
      reason: "org-installs",
      organizations: [{ id: "org-solo", name: "Solo Org" }],
    };
    const copy = removalFailureCopy(r, "archive", "Kanban Board");
    expect(copy).toContain("1 organization still has it installed");
  });
});
