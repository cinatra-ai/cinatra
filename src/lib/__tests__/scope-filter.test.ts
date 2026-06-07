import { describe, it, expect } from "vitest";
import {
  DEFAULT_SCOPE_TOKEN,
  comboboxValueToScopeToken,
  scopeSelectionMatches,
  scopeTokenToComboboxValue,
  type NormalizedResourceScope,
} from "@/lib/scope-filter";

const personal: NormalizedResourceScope = { locus: "personal" };
const personalAdmin: NormalizedResourceScope = { locus: "personal", adminOnly: true };
const orgWorkspace: NormalizedResourceScope = { locus: "organization" };
const orgAdmin: NormalizedResourceScope = { locus: "organization", adminOnly: true };
const teamBound: NormalizedResourceScope = { locus: "team", locusId: "t1" };
const projectBound: NormalizedResourceScope = { locus: "project", locusId: "p1" };

describe("scope token <-> combobox value mapping", () => {
  it("maps personal <-> owner and passes everything else through", () => {
    expect(scopeTokenToComboboxValue("personal")).toBe("owner");
    expect(comboboxValueToScopeToken("owner")).toBe("personal");
    expect(scopeTokenToComboboxValue("workspace")).toBe("workspace");
    expect(comboboxValueToScopeToken("admin")).toBe("admin");
    expect(scopeTokenToComboboxValue("org:abc")).toBe("org:abc");
    expect(comboboxValueToScopeToken("team:xyz")).toBe("team:xyz");
  });
});

describe("scopeSelectionMatches", () => {
  it("default (workspace) shows everything", () => {
    expect(DEFAULT_SCOPE_TOKEN).toBe("workspace");
    for (const r of [personal, personalAdmin, orgWorkspace, orgAdmin, teamBound, projectBound]) {
      expect(scopeSelectionMatches("workspace", r)).toBe(true);
    }
  });

  it("personal matches only personal-locus resources", () => {
    expect(scopeSelectionMatches("personal", personal)).toBe(true);
    expect(scopeSelectionMatches("personal", personalAdmin)).toBe(true);
    expect(scopeSelectionMatches("personal", orgWorkspace)).toBe(false);
    expect(scopeSelectionMatches("personal", orgAdmin)).toBe(false);
  });

  it("admin matches only admin-visibility resources, independent of locus", () => {
    expect(scopeSelectionMatches("admin", orgAdmin)).toBe(true);
    expect(scopeSelectionMatches("admin", personalAdmin)).toBe(true);
    expect(scopeSelectionMatches("admin", orgWorkspace)).toBe(false);
    expect(scopeSelectionMatches("admin", personal)).toBe(false);
  });

  it("org:<id> matches organization-locus resources (locus-level resources match any id)", () => {
    expect(scopeSelectionMatches("org:any", orgWorkspace)).toBe(true);
    expect(scopeSelectionMatches("org:any", orgAdmin)).toBe(true);
    expect(scopeSelectionMatches("org:any", personal)).toBe(false);
    expect(scopeSelectionMatches("org:any", teamBound)).toBe(false);
  });

  it("team/project tokens require a matching locusId when the resource is bound", () => {
    expect(scopeSelectionMatches("team:t1", teamBound)).toBe(true);
    expect(scopeSelectionMatches("team:other", teamBound)).toBe(false);
    expect(scopeSelectionMatches("project:p1", projectBound)).toBe(true);
    expect(scopeSelectionMatches("project:other", projectBound)).toBe(false);
  });

  it("rejects malformed / unknown tokens", () => {
    expect(scopeSelectionMatches("bogus", orgWorkspace)).toBe(false);
    expect(scopeSelectionMatches("", orgWorkspace)).toBe(false);
  });
});
