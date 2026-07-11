import { describe, it, expect } from "vitest";
import {
  DEFAULT_SCOPE_TOKEN,
  comboboxValueToScopeToken,
  isDefaultScopeSelection,
  parseScopeFilterParam,
  scopeSelectionMatches,
  scopeSelectionMatchesAny,
  scopeTokenToComboboxValue,
  serializeScopeFilterTokens,
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

  it("org:<id> matches ONLY resources bound to that concrete id — an unbound locus-level resource matches NOTHING (fail-closed, cinatra#953)", () => {
    const orgBound: NormalizedResourceScope = { locus: "organization", locusId: "o1" };
    expect(scopeSelectionMatches("org:o1", orgBound)).toBe(true);
    expect(scopeSelectionMatches("org:other", orgBound)).toBe(false);
    // The killed overmatch: undefined locusId used to match ANY org selection.
    expect(scopeSelectionMatches("org:any", orgWorkspace)).toBe(false);
    expect(scopeSelectionMatches("org:any", orgAdmin)).toBe(false);
    expect(scopeSelectionMatches("org:any", personal)).toBe(false);
    expect(scopeSelectionMatches("org:any", teamBound)).toBe(false);
  });

  it("team/project tokens require a matching CONCRETE locusId", () => {
    expect(scopeSelectionMatches("team:t1", teamBound)).toBe(true);
    expect(scopeSelectionMatches("team:other", teamBound)).toBe(false);
    expect(scopeSelectionMatches("project:p1", projectBound)).toBe(true);
    expect(scopeSelectionMatches("project:other", projectBound)).toBe(false);
    // Fail-closed: an unbound team/project-locus resource matches nothing.
    expect(scopeSelectionMatches("team:t1", { locus: "team" })).toBe(false);
    expect(scopeSelectionMatches("project:p1", { locus: "project" })).toBe(false);
  });

  it("rejects malformed / unknown / bare locus tokens", () => {
    expect(scopeSelectionMatches("bogus", orgWorkspace)).toBe(false);
    expect(scopeSelectionMatches("", orgWorkspace)).toBe(false);
    // Bare id-less locus tokens match nothing (fail-closed).
    expect(scopeSelectionMatches("team", teamBound)).toBe(false);
    expect(scopeSelectionMatches("org", { locus: "organization", locusId: "o1" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Multi-scope OR-filtering (cinatra#1074, multi-scope W5).
// ---------------------------------------------------------------------------

const accessible = new Set([
  "personal",
  "workspace",
  "admin",
  "org:o1",
  "team:t1",
  "team:t2",
  "project:p1",
]);

describe("parseScopeFilterParam", () => {
  it("parses a single valid token (single-scope URLs keep working)", () => {
    expect(parseScopeFilterParam("team:t1", accessible)).toEqual(["team:t1"]);
    expect(parseScopeFilterParam("personal", accessible)).toEqual(["personal"]);
  });

  it("parses a comma-separated multi-token selection, order-preserving", () => {
    expect(parseScopeFilterParam("team:t1,project:p1", accessible)).toEqual([
      "team:t1",
      "project:p1",
    ]);
    expect(parseScopeFilterParam("project:p1,team:t1,org:o1", accessible)).toEqual([
      "project:p1",
      "team:t1",
      "org:o1",
    ]);
  });

  it("trims whitespace and drops empty segments", () => {
    expect(parseScopeFilterParam(" team:t1 , project:p1 ,, ", accessible)).toEqual([
      "team:t1",
      "project:p1",
    ]);
  });

  it("dedupes repeated tokens (order-preserving)", () => {
    expect(parseScopeFilterParam("team:t1,project:p1,team:t1", accessible)).toEqual([
      "team:t1",
      "project:p1",
    ]);
  });

  it("drops invalid / inaccessible tokens, keeping the valid remainder", () => {
    expect(parseScopeFilterParam("team:t1,team:evil,bogus", accessible)).toEqual(["team:t1"]);
    // A non-admin's accessible set omits "admin" — the stale token drops.
    const nonAdmin = new Set(["personal", "workspace", "team:t1"]);
    expect(parseScopeFilterParam("admin,team:t1", nonAdmin)).toEqual(["team:t1"]);
  });

  it("defaults when empty, missing, or nothing valid survives", () => {
    expect(parseScopeFilterParam(undefined, accessible)).toEqual([DEFAULT_SCOPE_TOKEN]);
    expect(parseScopeFilterParam("", accessible)).toEqual([DEFAULT_SCOPE_TOKEN]);
    expect(parseScopeFilterParam(" , ,", accessible)).toEqual([DEFAULT_SCOPE_TOKEN]);
    expect(parseScopeFilterParam("bogus,team:evil", accessible)).toEqual([DEFAULT_SCOPE_TOKEN]);
  });

  it("workspace mixed with other tokens collapses to the default all-scopes selection", () => {
    expect(parseScopeFilterParam("workspace,team:t1", accessible)).toEqual([DEFAULT_SCOPE_TOKEN]);
    expect(parseScopeFilterParam("team:t1,workspace,project:p1", accessible)).toEqual([
      DEFAULT_SCOPE_TOKEN,
    ]);
    expect(parseScopeFilterParam("workspace", accessible)).toEqual([DEFAULT_SCOPE_TOKEN]);
  });

  it("collapses a repeated ?scope= param to its FIRST value (matching the previous readers)", () => {
    expect(parseScopeFilterParam(["team:t1,project:p1", "org:o1"], accessible)).toEqual([
      "team:t1",
      "project:p1",
    ]);
    expect(parseScopeFilterParam([], accessible)).toEqual([DEFAULT_SCOPE_TOKEN]);
  });

  it("personal is mixable in a filter union (no grant-style owner-strip)", () => {
    expect(parseScopeFilterParam("personal,team:t1", accessible)).toEqual([
      "personal",
      "team:t1",
    ]);
  });
});

describe("isDefaultScopeSelection", () => {
  it("recognizes exactly the canonical default", () => {
    expect(isDefaultScopeSelection([DEFAULT_SCOPE_TOKEN])).toBe(true);
    expect(isDefaultScopeSelection(["team:t1"])).toBe(false);
    expect(isDefaultScopeSelection([DEFAULT_SCOPE_TOKEN, "team:t1"])).toBe(false);
    expect(isDefaultScopeSelection([])).toBe(false);
  });
});

describe("serializeScopeFilterTokens", () => {
  it("omits the param (null) for the default / empty / workspace-containing selection", () => {
    expect(serializeScopeFilterTokens([DEFAULT_SCOPE_TOKEN])).toBeNull();
    expect(serializeScopeFilterTokens([])).toBeNull();
    expect(serializeScopeFilterTokens(["team:t1", DEFAULT_SCOPE_TOKEN])).toBeNull();
  });

  it("serializes single- and multi-token selections comma-joined, deduped", () => {
    expect(serializeScopeFilterTokens(["team:t1"])).toBe("team:t1");
    expect(serializeScopeFilterTokens(["team:t1", "project:p1"])).toBe("team:t1,project:p1");
    expect(serializeScopeFilterTokens(["team:t1", "team:t1", "project:p1"])).toBe(
      "team:t1,project:p1",
    );
  });

  it("round-trips through the canonical parser", () => {
    for (const selection of [["team:t1"], ["team:t1", "project:p1"], ["personal", "org:o1"]]) {
      const serialized = serializeScopeFilterTokens(selection);
      expect(serialized).not.toBeNull();
      expect(parseScopeFilterParam(serialized!, accessible)).toEqual(selection);
    }
    // The default round-trips via omission.
    expect(parseScopeFilterParam(undefined, accessible)).toEqual([DEFAULT_SCOPE_TOKEN]);
  });
});

describe("scopeSelectionMatchesAny (the OR-predicate)", () => {
  const orgBound: NormalizedResourceScope = { locus: "organization", locusId: "o1" };

  it("matches when ANY token matches (OR, not AND)", () => {
    expect(scopeSelectionMatchesAny(["team:t1", "project:p1"], teamBound)).toBe(true);
    expect(scopeSelectionMatchesAny(["team:t1", "project:p1"], projectBound)).toBe(true);
    expect(scopeSelectionMatchesAny(["personal", "org:o1"], orgBound)).toBe(true);
    expect(scopeSelectionMatchesAny(["personal", "org:o1"], personal)).toBe(true);
  });

  it("rejects when NO token matches", () => {
    expect(scopeSelectionMatchesAny(["team:t1", "project:p1"], orgBound)).toBe(false);
    expect(scopeSelectionMatchesAny(["personal", "admin"], teamBound)).toBe(false);
  });

  it("is single-token equivalent to scopeSelectionMatches", () => {
    for (const token of ["personal", "admin", "workspace", "team:t1", "org:o1", "bogus"]) {
      for (const r of [personal, personalAdmin, orgWorkspace, orgAdmin, teamBound, projectBound]) {
        expect(scopeSelectionMatchesAny([token], r)).toBe(scopeSelectionMatches(token, r));
      }
    }
  });

  it("the default selection matches everything; the empty selection matches NOTHING (fail-closed)", () => {
    for (const r of [personal, personalAdmin, orgWorkspace, orgAdmin, teamBound, projectBound]) {
      expect(scopeSelectionMatchesAny([DEFAULT_SCOPE_TOKEN], r)).toBe(true);
      expect(scopeSelectionMatchesAny([], r)).toBe(false);
    }
  });

  it("end-to-end: a multi-scope URL filters a resource list like the pages do", () => {
    // Mirrors the page pipeline: accessible-set gate -> canonical parse ->
    // any-match filter over normalized resource scopes.
    const rows: Array<[string, NormalizedResourceScope]> = [
      ["mine", personal],
      ["team-1", teamBound],
      ["team-2", { locus: "team", locusId: "t2" }],
      ["proj-1", projectBound],
      ["org-1", orgBound],
      ["ws", orgWorkspace],
      ["admin-only", orgAdmin],
    ];
    const filterBy = (url: string) => {
      const tokens = parseScopeFilterParam(url, accessible);
      return rows.filter(([, r]) => scopeSelectionMatchesAny(tokens, r)).map(([id]) => id);
    };
    // Multi-scope OR across parents of different kinds.
    expect(filterBy("team:t1,project:p1")).toEqual(["team-1", "proj-1"]);
    expect(filterBy("personal,team:t2,org:o1")).toEqual(["mine", "team-2", "org-1"]);
    // Single-scope URLs keep working.
    expect(filterBy("team:t1")).toEqual(["team-1"]);
    // Invalid tokens drop, the valid remainder still filters.
    expect(filterBy("team:t1,bogus")).toEqual(["team-1"]);
    // workspace-containing / all-invalid / absent -> default -> everything.
    for (const url of ["workspace,team:t1", "bogus", ""]) {
      expect(filterBy(url)).toEqual(rows.map(([id]) => id));
    }
  });
});
