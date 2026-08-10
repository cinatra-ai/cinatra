import { describe, it, expect } from "vitest";

import {
  policyFieldAdmitsScopeVantage,
  visibilityAdmitsScopeVantage,
  type AccessScopeVantage,
} from "../access-scope-vantage";
import {
  evaluateExtensionAccess,
  type ExtensionOwnerContext,
} from "../enforce-extension-access";
import type { ActorContext } from "@/lib/authz";
import type {
  AgentAuthPolicy,
  AgentAuthPolicyVisibility,
} from "@cinatra-ai/agents/auth-policy";

// ---------------------------------------------------------------------------
// The SCOPE-VANTAGE projection of an extension access policy (cinatra#2474 PR4).
//
// Two tiers of coverage:
//   1. the full token × vantage matrix, including every malformed shape;
//   2. a CONFORMANCE tier that runs the SAME tokens through the canonical
//      `evaluateExtensionAccess` for an ORDINARY MEMBER standing exactly where
//      the vantage stands, and asserts the two agree — so a semantic change to
//      `visibilityAllows` cannot drift past this module unnoticed.
// ---------------------------------------------------------------------------

const ORG = "org-1";
const OTHER_ORG = "org-2";
const TEAM = "team-a";
const OTHER_TEAM = "team-b";
const PROJECT = "proj-a";
const OTHER_PROJECT = "proj-b";

const personal: AccessScopeVantage = { kind: "personal", orgId: ORG };
const team: AccessScopeVantage = { kind: "team", orgId: ORG, scopeId: TEAM };
const organization: AccessScopeVantage = {
  kind: "organization",
  orgId: ORG,
  scopeId: ORG,
};
const project: AccessScopeVantage = {
  kind: "project",
  orgId: ORG,
  scopeId: PROJECT,
};

const SHARED_VANTAGES = [team, organization, project] as const;

describe("visibilityAdmitsScopeVantage — the token × vantage matrix", () => {
  it("org-wide tokens admit every well-formed vantage", () => {
    for (const v of [personal, ...SHARED_VANTAGES]) {
      expect(visibilityAdmitsScopeVantage("workspace", v)).toBe(true);
      expect(visibilityAdmitsScopeVantage("org", v)).toBe(true);
      expect(visibilityAdmitsScopeVantage(`org:${ORG}`, v)).toBe(true);
    }
  });

  it("an `org:<other>` token admits no vantage of THIS org", () => {
    for (const v of SHARED_VANTAGES) {
      expect(visibilityAdmitsScopeVantage(`org:${OTHER_ORG}`, v)).toBe(false);
    }
  });

  it("`team:<T>` admits ONLY team T's own vantage", () => {
    expect(visibilityAdmitsScopeVantage(`team:${TEAM}`, team)).toBe(true);
    expect(
      visibilityAdmitsScopeVantage(`team:${OTHER_TEAM}`, team),
    ).toBe(false);
    expect(visibilityAdmitsScopeVantage(`team:${TEAM}`, organization)).toBe(
      false,
    );
    expect(visibilityAdmitsScopeVantage(`team:${TEAM}`, project)).toBe(false);
  });

  it("`project:<P>` admits ONLY project P's own vantage", () => {
    expect(visibilityAdmitsScopeVantage(`project:${PROJECT}`, project)).toBe(
      true,
    );
    expect(
      visibilityAdmitsScopeVantage(`project:${OTHER_PROJECT}`, project),
    ).toBe(false);
    expect(visibilityAdmitsScopeVantage(`project:${PROJECT}`, team)).toBe(false);
    expect(
      visibilityAdmitsScopeVantage(`project:${PROJECT}`, organization),
    ).toBe(false);
  });

  it("`admin` and `owner` admit NO shared vantage — a scope holds no standing", () => {
    for (const v of SHARED_VANTAGES) {
      expect(visibilityAdmitsScopeVantage("admin", v)).toBe(false);
      expect(visibilityAdmitsScopeVantage("owner", v)).toBe(false);
    }
  });

  it("an unrecognized token admits nothing (corruption / bypassed writer)", () => {
    for (const v of SHARED_VANTAGES) {
      expect(
        visibilityAdmitsScopeVantage(
          "nonsense" as AgentAuthPolicyVisibility,
          v,
        ),
      ).toBe(false);
      expect(
        visibilityAdmitsScopeVantage(
          "team:" as AgentAuthPolicyVisibility,
          v,
        ),
      ).toBe(false);
    }
  });

  it("a structurally invalid vantage admits NOTHING, for every token", () => {
    const malformed: AccessScopeVantage[] = [
      { kind: "personal", orgId: "" },
      { kind: "team", orgId: "", scopeId: TEAM },
      { kind: "team", orgId: ORG, scopeId: "" },
      { kind: "organization", orgId: ORG, scopeId: "" },
      { kind: "project", orgId: ORG, scopeId: "" },
    ];
    const everyToken: AgentAuthPolicyVisibility[] = [
      "workspace",
      "org",
      "admin",
      "owner",
      `org:${ORG}`,
      `team:${TEAM}`,
      `project:${PROJECT}`,
    ];
    for (const v of malformed) {
      for (const t of everyToken) {
        expect(visibilityAdmitsScopeVantage(t, v)).toBe(false);
      }
    }
  });

  it("PERSONAL is admitted by every token — the scope IS the acting user", () => {
    // The deliberate asymmetry (codex convergence r0/Q3). A personal scope has
    // exactly one member, the actor the caller has already authorized, so a
    // team- or project-restricted extension is not widened by a copy landing on
    // that user's own private page. Refusing it would be a denial with no reader
    // to protect.
    for (const t of [
      "workspace",
      "org",
      "admin",
      "owner",
      `org:${OTHER_ORG}`,
      `team:${OTHER_TEAM}`,
      `project:${OTHER_PROJECT}`,
    ] as AgentAuthPolicyVisibility[]) {
      expect(visibilityAdmitsScopeVantage(t, personal)).toBe(true);
    }
  });
});

describe("policyFieldAdmitsScopeVantage — ANY-MATCH over the selection", () => {
  it("admits when SOME token admits, and denies when none does", () => {
    expect(
      policyFieldAdmitsScopeVantage([`team:${OTHER_TEAM}`, "workspace"], team),
    ).toBe(true);
    expect(
      policyFieldAdmitsScopeVantage([`team:${OTHER_TEAM}`, "admin"], team),
    ).toBe(false);
  });

  it("a mixed known/unknown selection is decided by the KNOWN tokens alone", () => {
    expect(
      policyFieldAdmitsScopeVantage(
        ["nonsense" as AgentAuthPolicyVisibility, `team:${TEAM}`],
        team,
      ),
    ).toBe(true);
    expect(
      policyFieldAdmitsScopeVantage(
        ["nonsense" as AgentAuthPolicyVisibility],
        team,
      ),
    ).toBe(false);
  });

  it("an EMPTY or non-array selection denies (unrepresentable in the type, possible in storage)", () => {
    expect(policyFieldAdmitsScopeVantage([], team)).toBe(false);
    expect(
      policyFieldAdmitsScopeVantage(
        undefined as unknown as AgentAuthPolicyVisibility[],
        team,
      ),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// CONFORMANCE — the projection vs. the canonical actor evaluator.
// ---------------------------------------------------------------------------

const owner: ExtensionOwnerContext = {
  ownerLevel: "organization",
  ownerId: ORG,
  organizationId: ORG,
};

/** An ORDINARY MEMBER standing exactly where a vantage stands: same org, the
 *  scope's own team/project membership, no admin role, no platform role, and
 *  NOT the installer or a co-owner. */
function memberAt(vantage: AccessScopeVantage): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "u-member",
    organizationId: vantage.orgId,
    orgRole: "member",
    platformRole: "member",
    teamIds: vantage.kind === "team" ? [vantage.scopeId] : [],
    projectIds: vantage.kind === "project" ? [vantage.scopeId] : [],
    authSource: "ui",
  } as unknown as ActorContext;
}

function policyWith(tokens: AgentAuthPolicyVisibility[]): AgentAuthPolicy {
  return {
    runListVisibility: tokens as AgentAuthPolicy["runListVisibility"],
    runDataVisibility: tokens as AgentAuthPolicy["runDataVisibility"],
    runExecuteVisibility: tokens as AgentAuthPolicy["runExecuteVisibility"],
    allowRunSharing: false,
  };
}

describe("conformance: the scope projection agrees with the actor evaluator", () => {
  const tokens: AgentAuthPolicyVisibility[] = [
    "workspace",
    "org",
    "admin",
    "owner",
    `org:${ORG}`,
    `org:${OTHER_ORG}`,
    `team:${TEAM}`,
    `team:${OTHER_TEAM}`,
    `project:${PROJECT}`,
    `project:${OTHER_PROJECT}`,
  ];

  it("every token yields the same verdict for a generic member of each SHARED scope", () => {
    for (const vantage of SHARED_VANTAGES) {
      for (const token of tokens) {
        const canonical = evaluateExtensionAccess({
          kind: "artifact",
          policy: policyWith([token]),
          coOwnerUserIds: [],
          installedByUserId: null,
          owner,
          actor: memberAt(vantage),
          op: "use",
        }).allowed;
        expect({
          vantage: vantage.kind,
          token,
          projected: visibilityAdmitsScopeVantage(token, vantage),
        }).toEqual({ vantage: vantage.kind, token, projected: canonical });
      }
    }
  });

  it("`use` and `read` read the SAME policy field for kind:artifact", () => {
    // The catalog evaluates its actor arm with `use` ("eligible to instantiate").
    // Pin the equivalence so choosing `use` cannot silently change meaning if the
    // op→field mapping is ever re-cut.
    for (const token of tokens) {
      const at = (op: "use" | "read") =>
        evaluateExtensionAccess({
          kind: "artifact",
          policy: policyWith([token]),
          coOwnerUserIds: [],
          installedByUserId: null,
          owner,
          actor: memberAt(team),
          op,
        }).allowed;
      expect(at("use")).toBe(at("read"));
    }
  });
});
