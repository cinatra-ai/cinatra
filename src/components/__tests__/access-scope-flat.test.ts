/**
 * The canonical flat access-option model (cinatra#2372, mkt-install S1).
 *
 * Pure unit coverage for `resolveFlatAccessOption` — the ONE resolver the
 * trigger, every dropdown row, and every single-mode consumer's submit gate
 * read a value's `{ type, name, synthetic, committable }` from. Covers:
 *
 *  - All six scope kinds (Personal / Project / Team / Organization /
 *    Workspace-All / Workspace-Admins), trigger ≡ row by construction (both
 *    read the SAME returned object — there is no second label path to drift).
 *  - Degenerate / legacy org tokens: a mismatched org id, an empty-tail
 *    `org:`, and an org token with no active org in scope — all resolve to
 *    the SAME synthetic, selected, NEVER-committable `Organization: the
 *    organization` row (c-3.11), with no cross-org lookup performed.
 *  - The nameless-active-org fallback (`Organization: Your organization`,
 *    capital Y — matching the row's own historical fallback) fires ONLY for a
 *    CONFIRMED active-org match, never for a degenerate token.
 *  - Committability edge cases across both install-dialog consumer shapes:
 *    a disabled server-offered row, a row never offered at all (installMode
 *    hides owner; installWorkspaceScopes off hides workspace/admin), a
 *    synthetic row, and the happy path.
 */
import { describe, it, expect } from "vitest";
import {
  resolveFlatAccessOption,
  flatAccessOptionLabel,
  canonicalOrgToken,
  type FlatAccessAvailableScopes,
} from "@/components/access-scope";

const ORG_ID = "org-acme";
const OTHER_ORG_ID = "org-beta";

const scopes: FlatAccessAvailableScopes = {
  projects: [{ id: "p1", name: "Atlas" }],
  teams: [{ id: "t1", name: "Revenue" }],
  orgName: "Acme Corp",
  orgId: ORG_ID,
};

const namelessOrgScopes: FlatAccessAvailableScopes = {
  ...scopes,
  orgName: "",
};

const noActiveOrgScopes: FlatAccessAvailableScopes = {
  projects: [],
  teams: [],
  orgName: "",
  orgId: undefined,
};

describe("resolveFlatAccessOption — all six scope kinds", () => {
  it("owner -> Personal: Only me", () => {
    const opt = resolveFlatAccessOption("owner", scopes);
    expect(opt).toEqual({
      value: "owner",
      type: "Personal",
      name: "Only me",
      synthetic: false,
      committable: true,
    });
  });

  it("admin -> Workspace: Admins only", () => {
    const opt = resolveFlatAccessOption("admin", scopes);
    expect(opt.type).toBe("Workspace");
    expect(opt.name).toBe("Admins only");
    expect(opt.synthetic).toBe(false);
  });

  it("workspace -> Workspace: All", () => {
    const opt = resolveFlatAccessOption("workspace", scopes);
    expect(opt.type).toBe("Workspace");
    expect(opt.name).toBe("All");
    expect(opt.synthetic).toBe(false);
  });

  it("org:<activeOrgId> -> Organization: <name>", () => {
    const opt = resolveFlatAccessOption(`org:${ORG_ID}`, scopes);
    expect(opt.type).toBe("Organization");
    expect(opt.name).toBe("Acme Corp");
    expect(opt.synthetic).toBe(false);
    expect(opt.name).not.toContain(ORG_ID);
  });

  it("bare legacy 'org' -> Organization: <name> (denotes the active org by definition)", () => {
    const opt = resolveFlatAccessOption("org", scopes);
    expect(opt).toEqual({
      value: "org",
      type: "Organization",
      name: "Acme Corp",
      synthetic: false,
      committable: true,
    });
  });

  it("nameless active org -> Organization: Your organization (capital Y, matches the row's own fallback)", () => {
    const opt = resolveFlatAccessOption(`org:${ORG_ID}`, namelessOrgScopes);
    expect(opt.type).toBe("Organization");
    expect(opt.name).toBe("Your organization");
    expect(opt.synthetic).toBe(false);
  });

  it("team:<id> -> Team: <name>, flat naming (no org prefix)", () => {
    const opt = resolveFlatAccessOption("team:t1", scopes);
    expect(opt.type).toBe("Team");
    expect(opt.name).toBe("Revenue");
    expect(opt.synthetic).toBe(false);
    expect(opt.name).not.toContain("Acme");
  });

  it("project:<id> -> Project: <name>", () => {
    const opt = resolveFlatAccessOption("project:p1", scopes);
    expect(opt.type).toBe("Project");
    expect(opt.name).toBe("Atlas");
    expect(opt.synthetic).toBe(false);
  });

  it("trigger ≡ row BY CONSTRUCTION: the same value resolves to the identical {type, name} regardless of call site", () => {
    for (const value of ["owner", "admin", "workspace", `org:${ORG_ID}`, "org", "team:t1", "project:p1"]) {
      const a = resolveFlatAccessOption(value, scopes);
      const b = resolveFlatAccessOption(value, scopes);
      expect(a.type).toBe(b.type);
      expect(a.name).toBe(b.name);
      // flatAccessOptionLabel composes the exact verbatim trigger/row text.
      expect(flatAccessOptionLabel(a)).toBe(`${a.type}: ${a.name}`);
    }
  });
});

describe("resolveFlatAccessOption — degenerate / legacy org tokens (c-3.11)", () => {
  it("a mismatched org id resolves to a selected, synthetic, non-committable neutral row — no cross-org lookup", () => {
    const opt = resolveFlatAccessOption(`org:${OTHER_ORG_ID}`, scopes);
    expect(opt).toEqual({
      value: `org:${OTHER_ORG_ID}`,
      type: "Organization",
      name: "the organization",
      synthetic: true,
      committable: false,
    });
    // Never the wrong org's name, never the raw id.
    expect(opt.name).not.toContain("Acme");
    expect(opt.name).not.toContain(OTHER_ORG_ID);
  });

  it("an empty-tail org: token resolves to the same synthetic neutral row", () => {
    const opt = resolveFlatAccessOption("org:", scopes);
    expect(opt.type).toBe("Organization");
    expect(opt.name).toBe("the organization");
    expect(opt.synthetic).toBe(true);
    expect(opt.committable).toBe(false);
    expect(opt.name).not.toBe("org:");
  });

  it("an org token with no active org in scope resolves to the same synthetic neutral row", () => {
    const opt = resolveFlatAccessOption(`org:${OTHER_ORG_ID}`, noActiveOrgScopes);
    expect(opt.type).toBe("Organization");
    expect(opt.name).toBe("the organization");
    expect(opt.synthetic).toBe(true);
    expect(opt.committable).toBe(false);
  });

  it("an unhydrated team:<id> selection synthesizes 'Unknown team' — selected, non-committable", () => {
    const opt = resolveFlatAccessOption("team:ghost", scopes);
    expect(opt).toEqual({
      value: "team:ghost",
      type: "Team",
      name: "Unknown team",
      synthetic: true,
      committable: false,
    });
    expect(opt.name).not.toContain("ghost");
  });

  it("an unhydrated project:<id> selection synthesizes 'Unknown project' — selected, non-committable", () => {
    const opt = resolveFlatAccessOption("project:ghost", scopes);
    expect(opt.type).toBe("Project");
    expect(opt.name).toBe("Unknown project");
    expect(opt.synthetic).toBe(true);
    expect(opt.committable).toBe(false);
  });

  it("an empty / non-canonical value never crashes and is never committable", () => {
    expect(resolveFlatAccessOption("", scopes)).toEqual({
      value: "",
      type: "",
      name: "",
      synthetic: true,
      committable: false,
    });
    const junk = resolveFlatAccessOption("not-a-real-token", scopes);
    expect(junk.synthetic).toBe(true);
    expect(junk.committable).toBe(false);
  });
});

describe("resolveFlatAccessOption — committability edge cases", () => {
  it("a real, offered, enabled row is committable", () => {
    expect(resolveFlatAccessOption("team:t1", scopes).committable).toBe(true);
    expect(resolveFlatAccessOption("project:p1", scopes).committable).toBe(true);
    expect(resolveFlatAccessOption(`org:${ORG_ID}`, scopes).committable).toBe(true);
  });

  it("a real row the server marked disabled is NOT committable", () => {
    expect(
      resolveFlatAccessOption("team:t1", scopes, { disabledScopes: ["team:t1"] }).committable,
    ).toBe(false);
    expect(
      resolveFlatAccessOption(`org:${ORG_ID}`, scopes, {
        disabledScopes: [canonicalOrgToken(ORG_ID)],
      }).committable,
    ).toBe(false);
  });

  it("disabledScopes keys the CANONICAL org token even when the legacy bare 'org' value is selected", () => {
    // The server always disables via the canonical org:<id> token; a bare
    // "org" selection must still read that same disabled state (never miss it
    // because the raw selected value string differs from the server's key).
    const opt = resolveFlatAccessOption("org", scopes, {
      disabledScopes: [canonicalOrgToken(ORG_ID)],
    });
    expect(opt.synthetic).toBe(false);
    expect(opt.committable).toBe(false);
  });

  it("a synthetic (degenerate/unhydrated) row is NEVER committable, even if its value happens to also appear in disabledScopes or not", () => {
    expect(resolveFlatAccessOption(`org:${OTHER_ORG_ID}`, scopes).committable).toBe(false);
    expect(resolveFlatAccessOption("org:", scopes).committable).toBe(false);
    expect(resolveFlatAccessOption("team:ghost", scopes).committable).toBe(false);
  });

  it("owner is not committable when the row is not offered at all (installMode)", () => {
    expect(resolveFlatAccessOption("owner", scopes, { ownerOffered: false }).committable).toBe(false);
    // Default (no ctx / permissions-tab shape) still offers it.
    expect(resolveFlatAccessOption("owner", scopes).committable).toBe(true);
  });

  it("workspace/admin are not committable when the picker never offered them at all (agent install-scope-dialog shape — installWorkspaceScopes never passed)", () => {
    const ctx = { ownerOffered: false, workspaceOffered: false, adminOffered: false };
    expect(resolveFlatAccessOption("workspace", scopes, ctx).committable).toBe(false);
    expect(resolveFlatAccessOption("admin", scopes, ctx).committable).toBe(false);
  });

  it("workspace/admin ARE committable when offered and not server-disabled (extension install-scope-dialog shape — installWorkspaceScopes true, platform admin)", () => {
    const ctx = { ownerOffered: false, workspaceOffered: true, adminOffered: true, disabledScopes: [] };
    expect(resolveFlatAccessOption("workspace", scopes, ctx).committable).toBe(true);
    expect(resolveFlatAccessOption("admin", scopes, ctx).committable).toBe(true);
  });

  it("workspace/admin are offered but server-disabled (non-platform-admin) -> not committable", () => {
    const ctx = {
      ownerOffered: false,
      workspaceOffered: true,
      adminOffered: true,
      disabledScopes: ["workspace", "admin"],
    };
    expect(resolveFlatAccessOption("workspace", scopes, ctx).committable).toBe(false);
    expect(resolveFlatAccessOption("admin", scopes, ctx).committable).toBe(false);
  });

  it("the agent-registry no-active-organization empty-tail defect is closed at the model level: an enabled-looking empty-tail org: default is never committable", () => {
    // Reproduces the exact reachable defect from the issue: an admin with no
    // active organization gets a default value of "org:" (empty tail) from
    // pickDefaultPickerValue-shaped upstream code. The OLD gate (bare
    // value-truthiness) would enable submit; the model marks it synthetic and
    // non-committable regardless of any disabledScopes list.
    const opt = resolveFlatAccessOption("org:", noActiveOrgScopes, {
      disabledScopes: [],
      ownerOffered: false,
    });
    expect(opt.value).toBeTruthy(); // still a non-empty string (the old gate's blind spot)
    expect(opt.committable).toBe(false);
  });
});

describe("canonicalOrgToken", () => {
  it("returns the id-carrying token when an orgId is supplied", () => {
    expect(canonicalOrgToken("abc")).toBe("org:abc");
  });

  it("degrades to the legacy bare 'org' only when no orgId is supplied at all", () => {
    expect(canonicalOrgToken(undefined)).toBe("org");
  });

  it("an empty-string orgId still yields the id-carrying (empty-tail) token — distinct from 'no org supplied'", () => {
    expect(canonicalOrgToken("")).toBe("org:");
  });
});
