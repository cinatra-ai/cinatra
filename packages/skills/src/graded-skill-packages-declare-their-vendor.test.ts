// THE FOUR GRADED SKILL PACKAGES DECLARE THEIR OWN VENDOR IDENTITY
// (cinatra#3062, the fourth proof round's first item, closed here).
//
// The fourth round graded four pills reading "Blog Image Matcher Skill", "Blog
// Writing Skill", "Brand Voice Matcher Skill", "Web Research Skill" — the name
// alone, no vendor beside it. Its sibling file `skill-id-vendor-names.test.ts`
// pins WHY that reading was correct rather than broken: a drawn name proves the
// scan reached the package and read its manifest, so a missing vendor beside it
// is a DATA omission in the package, never a gap in the seam.
//
// This file pins the data itself, for exactly those four packages. Each one now
// declares `cinatra.vendor` in its own manifest, and the reference pinned for it
// in this repository is raised to the commit that carries the declaration — so
// the identity flows into the generated manifest, and from there both halves of
// the pill's label are joined on one id:
//
//   - the package appears in the skill-id NAME map with its declared title, and
//   - the package appears in the skill-id VENDOR map with its declared vendor.
//
// WHAT THIS FILE DOES AND DOES NOT REACH. The manifest read here is the
// COMMITTED generated one, not the packages on disk — a test that walked the
// synced checkouts would pass or fail on whether a sync had run, which is not a
// property of this repository. Read honestly, then, this file pins the DATA the
// platform ships and resolves from. What binds that data back to the pins is the
// generator's own fail-closed drift check (`generate-extension-manifest.mjs
// --check`), which CI runs against the freshly synced tree: a pin fallen back to
// a commit declaring no vendor regenerates a manifest that no longer matches the
// committed one, and that check goes red. The two together — the drift check on
// the pin, these arms on the data — are what keep the vendor from silently
// vanishing again.
//
// Run:
//   cd packages/skills && npx vitest run src/graded-skill-packages-declare-their-vendor.test.ts
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  buildSkillIdDisplayNames,
  buildSkillIdVendorNames,
  type SkillExtensionDescriptor,
} from "./extension-skill-resolver";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const GENERATED_MANIFEST = resolve(REPO_ROOT, "src/lib/generated/extensions.server.ts");

/** The vendor identity all four packages declare. */
const DECLARED_VENDOR = "Cinatra";

/** The four packages the round graded, with the skill slug each one ships. */
const GRADED = [
  { pkgName: "@cinatra-ai/blog-image-matcher-skill", slug: "blog-image-matcher" },
  { pkgName: "@cinatra-ai/blog-writing-skill", slug: "blog-writing" },
  { pkgName: "@cinatra-ai/brand-voice-matcher-skill", slug: "brand-voice-matcher" },
  { pkgName: "@cinatra-ai/web-research-skill", slug: "web-research" },
] as const;

type GeneratedRecord = {
  packageName: string;
  kind: string;
  sourceDir: string;
  displayName: string | null;
  vendor: { key: string; name: string } | null;
};

/**
 * Pull one package's record out of the committed generated manifest.
 *
 * Read as TEXT rather than imported: the generated module is `server-only` and
 * pulls the host's import guard with it, which this package cannot resolve — the
 * same read the host's own generated-manifest tests do.
 */
function generatedRecord(pkgName: string): GeneratedRecord {
  const source = readFileSync(GENERATED_MANIFEST, "utf8");
  const line = source
    .split("\n")
    .find((candidate) => candidate.trimStart().startsWith(`"${pkgName}": {`));
  expect(line, `${pkgName} is absent from the generated extension manifest`).toBeDefined();
  const json = line!.slice(line!.indexOf("{"), line!.lastIndexOf("}") + 1);
  return JSON.parse(json) as GeneratedRecord;
}

/** The descriptor the filesystem scan produces for that package. */
function descriptorFor(record: GeneratedRecord, slug: string): SkillExtensionDescriptor {
  return {
    pkgDir: resolve(REPO_ROOT, record.sourceDir),
    pkgName: record.packageName,
    pkgDirName: basename(record.sourceDir),
    kind: record.kind,
    displayName: record.displayName ?? undefined,
    vendorName: record.vendor?.name,
    author: undefined,
    dependencies: [],
    capabilities: {},
    slugs: [slug],
  };
}

describe("the four graded skill packages declare their vendor identity", () => {
  it.each(GRADED)("$pkgName declares its vendor in the generated manifest", ({ pkgName }) => {
    const record = generatedRecord(pkgName);
    expect(record.kind).toBe("skill");
    expect(record.vendor).not.toBeNull();
    expect(record.vendor?.name).toBe(DECLARED_VENDOR);
  });

  it.each(GRADED)("$pkgName is in BOTH maps, on ONE id", ({ pkgName, slug }) => {
    const record = generatedRecord(pkgName);
    const descriptor = descriptorFor(record, slug);
    const names = buildSkillIdDisplayNames([descriptor]);
    const vendors = buildSkillIdVendorNames([descriptor]);

    const skillId = `${pkgName}:${slug}`;
    expect([...names.keys()]).toEqual([skillId]);
    // ONE id carries both halves of the pill's label.
    expect([...vendors.keys()]).toEqual([...names.keys()]);
    expect(names.get(skillId)).toBe(record.displayName);
    expect(vendors.get(skillId)).toBe(DECLARED_VENDOR);
  });

  it("draws a vendor for every one of the four, and mints none from the npm scope", () => {
    const descriptors = GRADED.map(({ pkgName, slug }) =>
      descriptorFor(generatedRecord(pkgName), slug),
    );
    const vendors = buildSkillIdVendorNames(descriptors);
    expect(vendors.size).toBe(GRADED.length);
    expect([...new Set(vendors.values())]).toEqual([DECLARED_VENDOR]);
    expect([...vendors.values()]).not.toContain("cinatra-ai");
    expect([...vendors.values()]).not.toContain("@cinatra-ai");
  });
});
