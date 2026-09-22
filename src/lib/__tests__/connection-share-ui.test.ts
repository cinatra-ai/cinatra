// Share-surface decision tests (cinatra#953 W3): the connector declaration →
// picker rendering fold. Pins the issue's UI contract:
//   • only:"user" (and an unreadable ceiling) → NO sharing surface,
//   • only:* → picker LOCKED at the only-value with every out-of-ceiling
//     option disabled (same ceiling predicate as the read clamp),
//   • default:* STATES the recommendation ONLY while the stored policy is the
//     untouched connect seed (seededDefault marker) — an explicit owner save
//     is never overridden (codex round-0 finding 1). On that seed the picker
//     opens PRE-SELECTED to the recommended scope next to the drawing's line;
//     nothing is written until Save (cinatra#3408).

import { describe, it, expect } from "vitest";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
import {
  allPickerValues,
  decideConnectionShareSurface,
} from "@/lib/connection-share-ui";
import type { AvailableScopes } from "@/components/access-scope";

/**
 * The recommendation line as section II of the connectors drawing gives it,
 * word for word. The dash is U+2014, written as an escape here.
 */
const RECOMMENDATION_LINE =
  "This connector recommends sharing with your organization \u2014 nothing is shared until you save. Currently: only you.";

const ORG = "org-1";
const scopes: AvailableScopes = {
  orgs: [
    { id: ORG, name: "Org One", teams: [{ id: "team-1", name: "Team One" }] },
    { id: "org-2", name: "Org Two", teams: [] },
  ],
  projects: [{ id: "proj-1", name: "Project One" }],
  canGrantWorkspace: true,
};
const identity = { organizationId: ORG };

function decl(mode: "default" | "only", scope: string) {
  return { formatVersion: 1 as const, mode, scope, source: "declared" as const } as never;
}

function policyOf(visibility: string, seeded = false): AgentAuthPolicy {
  return {
    runListVisibility: [visibility],
    runDataVisibility: [visibility],
    runExecuteVisibility: [visibility],
    allowRunSharing: false,
    ...(seeded ? { seededDefault: true } : {}),
  } as unknown as AgentAuthPolicy;
}

describe("decideConnectionShareSurface — only:* locks", () => {
  it("only:user removes the sharing surface entirely", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("only", "user"),
      storedPolicy: policyOf("owner", true),
      scopes,
    });
    expect(s).toEqual({ surface: "hidden" });
  });

  it("an unresolvable declaration hides the surface (fail-closed)", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: null,
      unresolved: true,
      storedPolicy: policyOf("owner"),
      scopes,
    });
    expect(s).toEqual({ surface: "hidden" });
  });

  it("only:admin renders LOCKED at admin with every non-owner/non-admin option disabled", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("only", "admin"),
      storedPolicy: policyOf("workspace", true), // app-scope seed
      scopes,
    });
    expect(s.surface).toBe("locked");
    if (s.surface !== "locked") return;
    expect(s.value).toBe("admin"); // stored workspace is OUT of ceiling → canonical only-value
    expect(s.disabledScopes).toContain("workspace");
    expect(s.disabledScopes).toContain(`org:${ORG}`);
    expect(s.disabledScopes).toContain("team:team-1");
    expect(s.disabledScopes).toContain("project:proj-1");
    expect(s.disabledScopes).not.toContain("admin");
    expect(s.disabledScopes).not.toContain("owner"); // narrowing to private stays possible
    expect(s.disabledReasons["workspace"]).toMatch(/only:"admin"/);
    expect(s.note).toMatch(/Locked by this connector/);
  });

  it("only:organization admits only the OWNING org (and owner)", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("only", "organization"),
      storedPolicy: policyOf("owner"),
      scopes,
    });
    expect(s.surface).toBe("locked");
    if (s.surface !== "locked") return;
    expect(s.value).toBe("owner"); // stored owner is within every ceiling
    expect(s.disabledScopes).toContain("org:org-2"); // foreign org disabled
    expect(s.disabledScopes).not.toContain(`org:${ORG}`);
    expect(s.disabledScopes).toContain("workspace");
    expect(s.disabledScopes).toContain("admin");
  });

  it("only:team keeps team rows enabled and disables the rest", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("only", "team"),
      storedPolicy: policyOf("team:team-1"),
      scopes,
    });
    expect(s.surface).toBe("locked");
    if (s.surface !== "locked") return;
    expect(s.value).toBe("team:team-1"); // stored in-ceiling value wins
    expect(s.disabledScopes).not.toContain("team:team-1");
    expect(s.disabledScopes).toContain(`org:${ORG}`);
    expect(s.disabledScopes).toContain("workspace");
  });
});

describe("decideConnectionShareSurface — default:* recommendation (never auto-shares)", () => {
  it("default:user leaves the picker on Personal (owner) on the untouched seed", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("default", "user"),
      storedPolicy: policyOf("owner", true),
      scopes,
    });
    expect(s).toMatchObject({ surface: "editable", value: "owner" });
  });

  it("default:workspace pre-selects the recommended scope on the untouched seed and draws the drawing's line word for word", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("default", "workspace"),
      storedPolicy: policyOf("owner", true),
      scopes,
    });
    // The MCP Servers connector's own declaration (mode default, scope
    // workspace). A workspace grant on a connection of an organization reaches
    // exactly that organization, so the line names it as the drawing does
    // (cinatra#3408).
    expect(s).toEqual({
      surface: "editable",
      value: "workspace",
      recommendationNote: RECOMMENDATION_LINE,
    });
  });

  it("default:organization pre-selects the CONCRETE owning org and draws the same line", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("default", "organization"),
      storedPolicy: policyOf("owner", true),
      scopes,
    });
    expect(s).toEqual({
      surface: "editable",
      value: `org:${ORG}`,
      recommendationNote: RECOMMENDATION_LINE,
    });
  });

  it("default:workspace on a connection of NO organization recommends nothing the save would refuse", () => {
    // The write gate refuses a workspace grant on a connection without an
    // organization (the ratified rule of cinatra#3397), so a pre-selected
    // workspace scope could never be saved there, and "your organization"
    // would name nothing.
    const s = decideConnectionShareSurface({
      identity: { organizationId: null },
      declaration: decl("default", "workspace"),
      storedPolicy: policyOf("owner", true),
      scopes,
    });
    expect(s).toEqual({ surface: "editable", value: "owner" });
  });

  it("a seed that already shares is never narrowed by a recommendation, and no line claims only you", () => {
    // An app-scope row is seeded with the workspace grant. The line ends in
    // "Currently: only you.", which would be false on this row.
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("default", "organization"),
      storedPolicy: policyOf("workspace", true),
      scopes,
    });
    expect(s).toEqual({ surface: "editable", value: "workspace" });
  });

  it("a SAVED recommended scope draws as saved, with no line", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("default", "workspace"),
      storedPolicy: policyOf("workspace", false), // the first explicit save
      scopes,
    });
    expect(s).toEqual({ surface: "editable", value: "workspace" });
  });

  it("a connector with a ceiling never states a recommendation, even on the untouched seed", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("only", "workspace"),
      storedPolicy: policyOf("owner", true),
      scopes,
    });
    expect(s.surface).toBe("locked");
    expect(s).not.toHaveProperty("recommendationNote");
    if (s.surface !== "locked") return;
    expect(s.value).toBe("owner");
  });

  it("an id-less team/project recommendation stays on owner and only notes the recommendation", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("default", "team"),
      storedPolicy: policyOf("owner", true),
      scopes,
    });
    expect(s.surface).toBe("editable");
    if (s.surface !== "editable") return;
    expect(s.value).toBe("owner");
    expect(s.recommendationNote).toMatch(/recommends sharing with a team/);
  });

  it("an EXPLICITLY saved policy (marker cleared) is never overridden by the recommendation", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("default", "workspace"),
      storedPolicy: policyOf("owner", false), // explicit owner choice
      scopes,
    });
    expect(s).toEqual({ surface: "editable", value: "owner" });
  });

  it("a widened stored policy renders as stored", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("default", "user"),
      storedPolicy: policyOf("team:team-1"),
      scopes,
    });
    expect(s).toEqual({ surface: "editable", value: "team:team-1" });
  });

  it("a null declaration (pre-reader cache) renders as stored with no recommendation", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: null,
      storedPolicy: policyOf("owner", true),
      scopes,
    });
    expect(s).toEqual({ surface: "editable", value: "owner" });
  });
});

describe("allPickerValues", () => {
  it("enumerates every concrete option value the picker offers", () => {
    expect(allPickerValues(scopes)).toEqual([
      "owner",
      "project:proj-1",
      "team:team-1",
      `org:${ORG}`,
      "org:org-2",
      "workspace",
      "admin",
    ]);
  });
});
