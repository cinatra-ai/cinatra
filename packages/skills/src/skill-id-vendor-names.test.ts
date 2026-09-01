// THE SKILL'S VENDOR, FROM THE OWNING PACKAGE'S OWN DECLARATIONS
// (cinatra#3047, review point 3).
//
// The run page's Skills-step pill reads "<Skill name> by <vendor>". The name
// half already comes from `buildSkillIdDisplayNames`; this is its sibling for
// the vendor half, and the whole point is that it answers the question with the
// PLATFORM'S resolver rather than a second derivation of its own — the same
// `resolveInstalledVendorName` chain the Installed page, the marketplace card
// and the assignable-skills picker use: the manifest's `cinatra.vendor.name`
// first, the npm `author` second, and NOTHING third.
//
// Run:
//   cd packages/skills && npx vitest run src/skill-id-vendor-names.test.ts
import { describe, expect, it } from "vitest";

import {
  buildSkillIdDisplayNames,
  buildSkillIdVendorNames,
  type SkillExtensionDescriptor,
} from "./extension-skill-resolver";

/**
 * A descriptor as the filesystem scan produces one, for a REAL shipped package:
 * `@cinatra-ai/blog-writing-skill`, whose real slug is `blog-writing`, so the id
 * this maps is the id the platform actually mints for it.
 */
function descriptor(over: Partial<SkillExtensionDescriptor> = {}): SkillExtensionDescriptor {
  return {
    pkgDir: "/extensions/cinatra-ai/blog-writing-skill",
    pkgName: "@cinatra-ai/blog-writing-skill",
    pkgDirName: "blog-writing-skill",
    kind: "skill",
    displayName: "Blog Writing Skill",
    vendorName: "Northstar",
    author: "Acme Publishing",
    dependencies: [],
    capabilities: {},
    slugs: ["blog-writing"],
    ...over,
  };
}

const REAL_ID = "@cinatra-ai/blog-writing-skill:blog-writing";

describe("buildSkillIdVendorNames", () => {
  it("maps a real package's skill id to its self-declared vendor identity", () => {
    const map = buildSkillIdVendorNames([descriptor()]);
    expect([...map.keys()]).toEqual([REAL_ID]);
    expect(map.get(REAL_ID)).toBe("Northstar");
  });

  it("falls to the npm author only when the manifest declares no vendor", () => {
    const map = buildSkillIdVendorNames([descriptor({ vendorName: undefined })]);
    expect(map.get(REAL_ID)).toBe("Acme Publishing");
  });

  it("reports NO vendor where the package declares neither tier — never the npm scope", () => {
    const map = buildSkillIdVendorNames([
      descriptor({ vendorName: undefined, author: undefined }),
      descriptor({ vendorName: "   ", author: "  " }),
    ]);
    expect(map.size).toBe(0);
  });

  it("is empty of a package that is not a skill", () => {
    expect(buildSkillIdVendorNames([descriptor({ kind: "agent" })]).size).toBe(0);
  });

  it("takes the FIRST declaration for a repeated id, matching the display-name sibling", () => {
    const map = buildSkillIdVendorNames([
      descriptor(),
      descriptor({ vendorName: "Second Declaration" }),
    ]);
    expect(map.get(REAL_ID)).toBe("Northstar");
  });

  it("mints the same id its display-name sibling mints, for the SAME real package", () => {
    const vendors = buildSkillIdVendorNames([descriptor()]);
    const names = buildSkillIdDisplayNames([descriptor()]);
    expect([...vendors.keys()]).toEqual([...names.keys()]);
  });

  it("registers an allowlisted chat-successor package under the id the platform mints for it", () => {
    // `@cinatra-ai/blog-content-skill` is one of the five successor packages
    // that register in the reserved `@cinatra-ai/chat:` namespace — the same
    // derivation the display-name sibling uses, so the two halves of one pill's
    // label are joined on one id.
    const map = buildSkillIdVendorNames([
      descriptor({
        pkgDir: "/extensions/cinatra-ai/blog-content-skill",
        pkgName: "@cinatra-ai/blog-content-skill",
        pkgDirName: "blog-content-skill",
        slugs: ["blog-content"],
      }),
    ]);
    expect([...map.keys()]).toEqual(["@cinatra-ai/chat:blog-content"]);
  });
});

// ---------------------------------------------------------------------------
// WHAT A NAME-ONLY PILL PROVES (cinatra#3062, the fourth proof round's first
// item).
//
// The fourth proof round graded four pills reading "Blog Image Matcher Skill",
// "Blog Writing Skill", "Brand Voice Matcher Skill", "Web Research Skill" — name
// only, with no vendor element on any of them, in either palette, in every
// state. Three of the drawing's sentences fail on that one omission:
//
//   "The label reads the skill's name and then by its vendor, on one line, the
//    vendor in the muted secondary colour — so two skills of the same name are
//    told apart in the pill itself."
//   "A pill carries a checkbox, the skill's name and its vendor, and nothing
//    else."
//   "one pill per skill · a checkbox in front of each name and vendor"
//
// THE TWO HALVES RIDE ONE DESCRIPTOR. Those four labels are not the catalog's
// SKILL.md slugs — they are the owning packages' own `cinatra.displayName`,
// which reaches the pill through `buildSkillIdDisplayNames` over exactly the
// descriptor list `buildSkillIdVendorNames` is handed in the same breath. So a
// pill that draws a declared NAME is proof the scan reached that package and
// read its manifest; if no vendor is drawn beside it, the package declared
// none. The omission is the package's, and the seam below is the diagnostic
// that says so rather than leaving the reading ambiguous.
//
// This block pins that diagnostic. It does NOT license a stand-in: a package
// that declares neither tier still gets no entry, and the npm scope segment is
// never pressed into service as a name.
describe("a drawn name locates a missing vendor in the package, not in the seam", () => {
  it("keeps the id in the name map and out of the vendor map when only the vendor is undeclared", () => {
    const undeclared = descriptor({ vendorName: undefined, author: undefined });
    const names = buildSkillIdDisplayNames([undeclared]);
    const vendors = buildSkillIdVendorNames([undeclared]);
    // The name arrives, so the scan reached the package and parsed its manifest.
    expect(names.get(REAL_ID)).toBe("Blog Writing Skill");
    // The vendor does not, because the package declares neither tier.
    expect(vendors.has(REAL_ID)).toBe(false);
  });

  it("draws both halves for the same package the moment it declares a vendor identity", () => {
    const declared = descriptor({ vendorName: "Cinatra", author: undefined });
    expect(buildSkillIdDisplayNames([declared]).get(REAL_ID)).toBe("Blog Writing Skill");
    expect(buildSkillIdVendorNames([declared]).get(REAL_ID)).toBe("Cinatra");
  });

  it("never mints a vendor out of the package's npm scope segment", () => {
    const undeclared = descriptor({ vendorName: undefined, author: undefined });
    const vendors = buildSkillIdVendorNames([undeclared]);
    expect([...vendors.values()]).not.toContain("cinatra-ai");
    expect([...vendors.values()]).not.toContain("@cinatra-ai");
    expect(vendors.size).toBe(0);
  });
});
