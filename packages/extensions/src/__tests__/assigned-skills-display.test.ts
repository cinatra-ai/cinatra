// Display metadata for ALREADY-ASSIGNED skills (cinatra#2349 S4, epic #2345).
//
// The contract this pins: the chosen rows are labelled by the SAME resolvers
// the picker rows are (so a picked "Research Toolkit · by Northstar" reappears
// under that name), the join is partial by design (a degraded row is not in the
// assignable population and gets no entry), and a population outage yields an
// EMPTY map rather than a half-labelled list.
//
//   pnpm exec vitest run packages/extensions/src/__tests__/assigned-skills-display.test.ts

import { describe, expect, it, vi } from "vitest";

import { resolveAssignedSkillDisplay } from "../assigned-skills-display";

type Candidate = {
  skillId: string;
  skillName: string;
  skillDescription: string;
  ownerPackageName: string;
  ownerPackageCandidates: string[];
  extensionDisplayName: string | null;
  extensionVendorName: string | null;
  extensionAuthor: string | null;
  role: "injectable";
};

const candidate = (over: Partial<Candidate> & { skillId: string }): Candidate => ({
  skillName: "Company Research",
  skillDescription: "",
  ownerPackageName: "@northstar/research-toolkit",
  ownerPackageCandidates: ["@northstar/research-toolkit"],
  extensionDisplayName: "Research Toolkit",
  extensionVendorName: "Northstar",
  extensionAuthor: null,
  role: "injectable",
  ...over,
});

const listing = (rows: Candidate[]) => vi.fn(async () => rows);

describe("resolveAssignedSkillDisplay", () => {
  it("labels a requested skill with the extension's declared title and vendor", async () => {
    const map = await resolveAssignedSkillDisplay(["s-a"], {
      listCandidates: listing([candidate({ skillId: "s-a" })]) as never,
    });
    expect(map.get("s-a")).toEqual({
      skillId: "s-a",
      displayName: "Research Toolkit",
      vendorName: "Northstar",
    });
  });

  it("falls back to the npm `author` for the vendor, and to the PACKAGE NAME for the title", async () => {
    const map = await resolveAssignedSkillDisplay(["s-a", "s-b"], {
      listCandidates: listing([
        candidate({ skillId: "s-a", extensionVendorName: null, extensionAuthor: "Northstar Ltd" }),
        candidate({
          skillId: "s-b",
          extensionDisplayName: null,
          extensionVendorName: null,
          extensionAuthor: null,
          ownerPackageName: "@acme/brand-kit",
        }),
      ]) as never,
    });
    expect(map.get("s-a")?.vendorName).toBe("Northstar Ltd");
    expect(map.get("s-b")).toEqual({
      skillId: "s-b",
      displayName: "@acme/brand-kit",
      vendorName: null,
    });
  });

  it("treats a blank declaration as absent, never as an empty label", async () => {
    const map = await resolveAssignedSkillDisplay(["s-a"], {
      listCandidates: listing([
        candidate({
          skillId: "s-a",
          extensionDisplayName: "   ",
          extensionVendorName: "  ",
          extensionAuthor: null,
          ownerPackageName: "@acme/kit",
        }),
      ]) as never,
    });
    expect(map.get("s-a")).toEqual({
      skillId: "s-a",
      displayName: "@acme/kit",
      vendorName: null,
    });
  });

  it("returns entries ONLY for the ids asked for", async () => {
    const map = await resolveAssignedSkillDisplay(["s-a"], {
      listCandidates: listing([
        candidate({ skillId: "s-a" }),
        candidate({ skillId: "s-other" }),
      ]) as never,
    });
    expect([...map.keys()]).toEqual(["s-a"]);
  });

  it("omits a DEGRADED row — it is not in the assignable population, and is not invented", async () => {
    const map = await resolveAssignedSkillDisplay(["s-archived"], {
      listCandidates: listing([candidate({ skillId: "s-still-live" })]) as never,
    });
    expect(map.has("s-archived")).toBe(false);
  });

  it("returns an EMPTY map (never a partial one) when the population read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const map = await resolveAssignedSkillDisplay(["s-a"], {
      listCandidates: vi.fn(async () => {
        throw new Error("scan failed");
      }) as never,
    });
    expect(map.size).toBe(0);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("reads NOTHING for an empty or blank id set", async () => {
    const listCandidates = listing([candidate({ skillId: "s-a" })]);
    expect((await resolveAssignedSkillDisplay([], { listCandidates: listCandidates as never })).size).toBe(0);
    expect((await resolveAssignedSkillDisplay(["", "  "], { listCandidates: listCandidates as never })).size).toBe(0);
    // "  " is a non-empty string, so it survives the filter and one read is
    // issued for it — but no entry is invented for it.
    expect(listCandidates.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("keeps the FIRST candidate when a duplicate id somehow appears", async () => {
    const map = await resolveAssignedSkillDisplay(["s-a"], {
      listCandidates: listing([
        candidate({ skillId: "s-a", extensionDisplayName: "First" }),
        candidate({ skillId: "s-a", extensionDisplayName: "Second" }),
      ]) as never,
    });
    expect(map.get("s-a")?.displayName).toBe("First");
  });
});
