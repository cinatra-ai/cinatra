// Scanner MANIFEST RETENTION (cinatra#2348 S3, epic #2345).
//
// `scanSkillExtensions` used to read the `cinatra` block and throw almost all
// of it away. The assignable-skills picker needs three of those fields back:
//
//   * `skillRole`   — the role filter (`injectable` only) is unimplementable
//                     without the package's own declaration;
//   * `displayName` — the picker labels a row with the OWNING EXTENSION's
//                     title, and the generated static manifest only covers
//                     image-bundled packages, so a marketplace-installed skill
//                     would otherwise be labelled with its raw npm name;
//   * the vendor inputs (`cinatra.vendor.name` + npm `author`) — the two tiers
//                     the STANDARD vendor resolver reads.
//
// These are RAW retentions: no precedence is applied here (the standard
// display-name / vendor resolvers own that), and an absent field stays
// `undefined` rather than becoming an empty label.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

vi.mock("server-only", () => ({}));

vi.mock("./register-extension-skill", () => ({
  registerExtensionSkill: vi.fn(),
}));

vi.mock("@cinatra-ai/extensions", () => ({
  readEffectiveStatusByPackageNames: vi.fn(async () => new Map()),
}));

vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => path.join(process.cwd(), "extensions"),
  resolveDevExtensionSourceRoot: () => path.join(process.cwd(), "extensions"),
}));

import { scanSkillExtensions } from "./extension-skill-resolver";

let tmpDir: string;
let origCwd: string;

async function writeExtension(input: {
  vendor: string;
  pkgDir: string;
  name: string;
  kind: string;
  cinatra?: Record<string, unknown>;
  author?: unknown;
  slugs?: string[];
}) {
  const dir = path.join(tmpDir, "extensions", input.vendor, input.pkgDir);
  await mkdir(dir, { recursive: true });
  const pkgJson: Record<string, unknown> = {
    name: input.name,
    cinatra: {
      apiVersion: "cinatra.ai/v1",
      kind: input.kind,
      ...(input.cinatra ?? {}),
    },
  };
  if (input.author !== undefined) pkgJson.author = input.author;
  await writeFile(path.join(dir, "package.json"), JSON.stringify(pkgJson));
  for (const slug of input.slugs ?? []) {
    const skillDir = path.join(dir, "skills", slug);
    await mkdir(skillDir, { recursive: true });
    await writeFile(path.join(skillDir, "SKILL.md"), `---\nname: ${slug}\n---\nbody`);
  }
}

async function scanOne(pkgDirName: string) {
  const found = (await scanSkillExtensions()).find((e) => e.pkgDirName === pkgDirName);
  expect(found).toBeDefined();
  return found!;
}

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), "ext-skill-retention-"));
  origCwd = process.cwd();
  process.chdir(tmpDir);
});

afterEach(async () => {
  process.chdir(origCwd);
  await rm(tmpDir, { recursive: true, force: true });
});

describe("scanSkillExtensions — manifest retention (cinatra#2348)", () => {
  it("RETAINS skillRole, displayName and the vendor identity name", async () => {
    await writeExtension({
      vendor: "acme",
      pkgDir: "widget-skills",
      name: "@acme/widget-skills",
      kind: "skill",
      cinatra: {
        skillRole: "injectable",
        displayName: "Widget Skills",
        vendor: { key: "acme", name: "Acme Corporation" },
      },
      author: "Acme Publishing <hello@example.invalid> (https://example.invalid)",
      slugs: ["do-thing"],
    });
    const ext = await scanOne("widget-skills");
    expect(ext.skillRole).toBe("injectable");
    expect(ext.displayName).toBe("Widget Skills");
    expect(ext.vendorName).toBe("Acme Corporation");
    // npm's shorthand author form is trimmed to its NAME segment — an email
    // address must never end up rendered as a vendor byline.
    expect(ext.author).toBe("Acme Publishing");
  });

  it("leaves every retained field UNDEFINED when the manifest declares none", async () => {
    // The undeclared case is the DEFAULT case: the role resolver reads an
    // undefined `skillRole` as the plain injectable default, and the display /
    // vendor resolvers fall through their own chains.
    await writeExtension({
      vendor: "acme",
      pkgDir: "bare-skills",
      name: "@acme/bare-skills",
      kind: "skill",
      slugs: ["do-thing"],
    });
    const ext = await scanOne("bare-skills");
    expect(ext.skillRole).toBeUndefined();
    expect(ext.displayName).toBeUndefined();
    expect(ext.vendorName).toBeUndefined();
    expect(ext.author).toBeUndefined();
  });

  it("treats BLANK declarations as absent, never as an empty label", async () => {
    await writeExtension({
      vendor: "acme",
      pkgDir: "blank-skills",
      name: "@acme/blank-skills",
      kind: "skill",
      cinatra: { displayName: "   ", vendor: { name: "" }, skillRole: "" },
      author: "   ",
      slugs: ["do-thing"],
    });
    const ext = await scanOne("blank-skills");
    expect(ext.displayName).toBeUndefined();
    expect(ext.vendorName).toBeUndefined();
    expect(ext.author).toBeUndefined();
    expect(ext.skillRole).toBeUndefined();
  });

  it("accepts npm's OBJECT author form and a bare-string vendor", async () => {
    await writeExtension({
      vendor: "acme",
      pkgDir: "object-author-skills",
      name: "@acme/object-author-skills",
      kind: "skill",
      cinatra: { vendor: "Acme (bare string form)" },
      author: { name: "Acme People", email: "hello@example.invalid" },
      slugs: ["do-thing"],
    });
    const ext = await scanOne("object-author-skills");
    expect(ext.vendorName).toBe("Acme (bare string form)");
    expect(ext.author).toBe("Acme People");
  });

  it("survives MALFORMED declarations without dropping the extension", async () => {
    // A structurally wrong manifest must degrade the LABEL, never the scan —
    // the package still owns skills that other paths need to resolve.
    await writeExtension({
      vendor: "acme",
      pkgDir: "malformed-skills",
      name: "@acme/malformed-skills",
      kind: "skill",
      cinatra: { displayName: 42, vendor: ["not", "an", "object"], skillRole: { nope: true } },
      author: 7,
      slugs: ["do-thing"],
    });
    const ext = await scanOne("malformed-skills");
    expect(ext.pkgName).toBe("@acme/malformed-skills");
    expect(ext.slugs).toEqual(["do-thing"]);
    expect(ext.displayName).toBeUndefined();
    expect(ext.vendorName).toBeUndefined();
    expect(ext.author).toBeUndefined();
    expect(ext.skillRole).toBeUndefined();
  });

  it("retains the two RESTRICTED roles verbatim (the picker filters on them)", async () => {
    await writeExtension({
      vendor: "acme",
      pkgDir: "matcher-skills",
      name: "@acme/matcher-skills",
      kind: "skill",
      cinatra: { skillRole: "matcher" },
      slugs: ["classify"],
    });
    await writeExtension({
      vendor: "acme",
      pkgDir: "internal-skills",
      name: "@acme/internal-skills",
      kind: "skill",
      cinatra: { skillRole: "internal" },
      slugs: ["drive"],
    });
    expect((await scanOne("matcher-skills")).skillRole).toBe("matcher");
    expect((await scanOne("internal-skills")).skillRole).toBe("internal");
  });
});
