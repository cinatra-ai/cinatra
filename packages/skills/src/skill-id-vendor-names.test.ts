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
