import { describe, it, expect } from "vitest";

import { actorHoldsProjectGrant } from "@/lib/authz/project-read-gate";
import type { ProjectGrant } from "@/lib/authz/actor-context";

// Pure predicate contract for the sealed-room project READ gate (#1898 / #2064).
// The BEHAVIORAL end-to-end proof (real `readProjectGrantsForUser` → this gate)
// lives in `integration/project-read-gate.integration.test.ts`; this suite locks
// the pure semantics the pages depend on.

const P = "proj-1";
const grant = (projectId: string, role: ProjectGrant["effectiveRole"]): ProjectGrant => ({
  projectId,
  effectiveRole: role,
  accessSource: role === "owner" ? "owner" : "user",
});

describe("actorHoldsProjectGrant — sealed-room read gate", () => {
  it("allows when the actor holds ANY grant for the project (read is the floor)", () => {
    for (const role of ["read", "write", "admin", "owner"] as const) {
      expect(actorHoldsProjectGrant({ projectGrants: [grant(P, role)] }, P)).toBe(true);
    }
  });

  it("denies when the actor holds a grant for a DIFFERENT project only", () => {
    expect(actorHoldsProjectGrant({ projectGrants: [grant("other", "admin")] }, P)).toBe(false);
  });

  it("fails closed on an EMPTY resolved grant set (resolved, none)", () => {
    expect(actorHoldsProjectGrant({ projectGrants: [] }, P)).toBe(false);
  });

  it("fails closed on an UNRESOLVED grant axis (undefined)", () => {
    expect(actorHoldsProjectGrant({ projectGrants: undefined }, P)).toBe(false);
    expect(actorHoldsProjectGrant({}, P)).toBe(false);
  });
});
