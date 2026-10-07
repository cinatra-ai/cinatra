/**
 * THE KEEP'S AUTHORITY TWIN NEVER DRIFTS (cinatra#2815 S3 part 4, epic #2812).
 *
 * `src/lib/authz/assignment-authority.ts` owns the rule: whoever writes an
 * assignment must administer the scope it affects. The keep road cannot import
 * that module, because doing so adds it to four locked route graphs whose
 * reachable-module budgets may only ever shrink. So it carries a twin, and this
 * suite is what keeps the twin honest: it drives both functions over every
 * scope kind crossed with every role shape and refuses any disagreement.
 *
 * A failure here means the two have diverged, and the LOCAL copy is the one to
 * correct: the authority module is the authority.
 */
import { describe, it, expect } from "vitest";

import { resolveAssignmentWriteAuthority } from "@/lib/authz/assignment-authority";
import { WORKSPACE_SCOPE_SENTINEL, type AssignmentScope } from "@/lib/assignment-scope";
import { mayWriteAssignmentAtScope } from "../run-recommendation-core";

const ORG = "org-1";
const TEAM = "team-1";
const PROJECT = "proj-1";
const USER = "user-1";

const SCOPES: AssignmentScope[] = [
  { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL },
  { scopeKind: "organization", scopeId: ORG },
  { scopeKind: "organization", scopeId: "org-other" },
  { scopeKind: "team", scopeId: TEAM },
  { scopeKind: "team", scopeId: "team-other" },
  { scopeKind: "project", scopeId: PROJECT },
  { scopeKind: "project", scopeId: "proj-other" },
  { scopeKind: "user", scopeId: USER },
  { scopeKind: "user", scopeId: "user-other" },
  // Shapes the scope validator itself refuses.
  { scopeKind: "workspace", scopeId: "not-the-sentinel" } as AssignmentScope,
  { scopeKind: "organization", scopeId: "" } as AssignmentScope,
  { scopeKind: "galaxy", scopeId: "g-1" } as unknown as AssignmentScope,
];

const ORG_ROLES = [undefined, "member", "org_admin", "org_owner"] as const;
const TEAM_ROLES = [undefined, "member", "team_admin"] as const;
const PROJECT_ROLES = [undefined, "read", "write", "admin", "owner"] as const;
const PLATFORM_ROLES = [undefined, "member", "platform_admin"] as const;

function* actors() {
  for (const orgRole of ORG_ROLES)
    for (const teamRole of TEAM_ROLES)
      for (const projectRole of PROJECT_ROLES)
        for (const platformRole of PLATFORM_ROLES)
          for (const organizationId of [ORG, "org-other", undefined])
            yield {
              principalId: USER,
              organizationId,
              orgRole,
              platformRole,
              ...(teamRole ? { teamRoles: { [TEAM]: teamRole } } : {}),
              ...(projectRole
                ? { projectGrants: [{ projectId: PROJECT, effectiveRole: projectRole }] }
                : {}),
            };
}

describe("the keep's write-authority twin and the authority module agree", () => {
  it("on every scope crossed with every role shape", () => {
    let compared = 0;
    for (const actor of actors()) {
      for (const scope of SCOPES) {
        const owner = resolveAssignmentWriteAuthority(actor as never, scope).allowed;
        const twin = mayWriteAssignmentAtScope(actor, scope);
        expect({ scope, actor, twin }).toEqual({ scope, actor, twin: owner });
        compared += 1;
      }
    }
    // A guard on the guard: a matrix that silently shrank to nothing would pass.
    expect(compared).toBeGreaterThan(1000);
  });

  it("refuses the workspace tier for everybody, platform administrators included", () => {
    const admin = { principalId: USER, organizationId: ORG, platformRole: "platform_admin" };
    const workspace: AssignmentScope = {
      scopeKind: "workspace",
      scopeId: WORKSPACE_SCOPE_SENTINEL,
    };
    expect(mayWriteAssignmentAtScope(admin, workspace)).toBe(false);
    expect(resolveAssignmentWriteAuthority(admin as never, workspace).allowed).toBe(false);
  });
});
