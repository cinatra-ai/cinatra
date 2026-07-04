// Share-surface decision tests (cinatra#953 W3): the connector declaration →
// picker rendering fold. Pins the issue's UI contract:
//   • only:"user" (and an unreadable ceiling) → NO sharing surface,
//   • only:* → picker LOCKED at the only-value with every out-of-ceiling
//     option disabled (same ceiling predicate as the read clamp),
//   • default:* pre-selects the recommendation ONLY while the stored policy
//     is the untouched connect seed (seededDefault marker) — an explicit
//     owner save is never overridden (codex round-0 finding 1).

import { describe, it, expect } from "vitest";
import type { AgentAuthPolicy } from "@cinatra-ai/agents/auth-policy";
import {
  allPickerValues,
  decideConnectionShareSurface,
} from "@/lib/connection-share-ui";
import type { AvailableScopes } from "@/components/access-scope";

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
    runListVisibility: visibility,
    runDataVisibility: visibility,
    runExecuteVisibility: visibility,
    allowRunSharing: false,
    ...(seeded ? { seededDefault: true } : {}),
  } as AgentAuthPolicy;
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

describe("decideConnectionShareSurface — default:* pre-selection (never auto-shares)", () => {
  it("default:user pre-selects Personal (owner) on the untouched seed", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("default", "user"),
      storedPolicy: policyOf("owner", true),
      scopes,
    });
    expect(s).toMatchObject({ surface: "editable", value: "owner" });
  });

  it("default:workspace pre-selects the recommendation on the untouched seed, with the not-shared-until-save note", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("default", "workspace"),
      storedPolicy: policyOf("owner", true),
      scopes,
    });
    expect(s.surface).toBe("editable");
    if (s.surface !== "editable") return;
    expect(s.value).toBe("workspace");
    expect(s.recommendationNote).toMatch(/nothing is shared until you save/);
  });

  it("default:organization pre-selects the CONCRETE owning org", () => {
    const s = decideConnectionShareSurface({
      identity,
      declaration: decl("default", "organization"),
      storedPolicy: policyOf("owner", true),
      scopes,
    });
    expect(s).toMatchObject({ surface: "editable", value: `org:${ORG}` });
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
