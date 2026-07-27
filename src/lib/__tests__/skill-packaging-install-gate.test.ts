// Store-install enforcement of the skill packaging contract (cinatra#2089,
// epic #2086 S2).
//
// Proves the THIRD enforcement point behaves exactly like the CI gate: the same
// verdict module over a materialized package, refusing at the install
// pipeline's pre-journal seam with the just-materialized dir GC'd.

import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SkillPackagingConstraintError,
  computeSkillPackagingSignals,
  enforceSkillPackagingGateInertly,
  groupPackageBundles,
  type SkillPackagingSignals,
} from "@/lib/skill-packaging-install-gate";

const FIXTURE_ALLOWLIST = {
  extensionRepoDefault: [],
  repoAllowlists: { cinatra: ["**/__tests__/fixtures/**"] },
};

const EMPTY_POLICIES = {
  allowlistPolicy: FIXTURE_ALLOWLIST,
  ledger: { exceptions: [] },
  legacyEmbeddedSkillKeys: new Set<string>(),
};

const ROUTER = (name: string, body = "Body.") =>
  `---\nname: ${name}\ndescription: Use when the task is to do the thing this skill describes.\n---\n\n${body}\n`;

function makePackage(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "skill-pkg-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

const manifest = (name: string, cinatra: Record<string, unknown>) =>
  JSON.stringify({ name, version: "0.1.0", cinatra });

describe("computeSkillPackagingSignals — kind:\"skill\"", () => {
  it("passes a conforming single-bundle `-skill` package", async () => {
    const dir = makePackage({
      "package.json": manifest("@cinatra-ai/my-skill", { kind: "skill", skillRole: "injectable" }),
      "skills/my-skill/SKILL.md": ROUTER("my-skill", "Read [more](references/guide.md)."),
      "skills/my-skill/references/guide.md": "guide",
    });
    try {
      const signals = await computeSkillPackagingSignals(dir, EMPTY_POLICIES);
      expect(signals.violations).toEqual([]);
      expect(signals.kind).toBe("skill");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses the retired plural suffix, two bundles, a name mismatch and a dangling reference", async () => {
    const dir = makePackage({
      "package.json": manifest("@cinatra-ai/my-skills", { kind: "skill" }),
      // directory name != frontmatter name, and the router dead-ends
      "skills/wrong-dir/SKILL.md": ROUTER("my-skill", "Read [more](references/missing.md)."),
      "skills/other/SKILL.md": ROUTER("other"),
    });
    try {
      const signals = await computeSkillPackagingSignals(dir, EMPTY_POLICIES);
      expect(signals.violations.map((v) => v.code).sort()).toEqual([
        "bundle-name-mismatch",
        "dangling-reference",
        "not-exactly-one-bundle",
        "package-suffix",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("WAIVES exactly what the enumerated ledger records — and nothing more", async () => {
    const dir = makePackage({
      "package.json": manifest("@cinatra-ai/legacy-skills", { kind: "skill" }),
      "skills/a/SKILL.md": ROUTER("a"),
      "skills/b/SKILL.md": ROUTER("b"),
    });
    try {
      const signals = await computeSkillPackagingSignals(dir, {
        ...EMPTY_POLICIES,
        ledger: {
          exceptions: [
            { packageName: "@cinatra-ai/legacy-skills", codes: ["package-suffix"], migratedBy: "cinatra#2090" },
          ],
        },
      });
      expect(signals.waived.map((v) => v.code)).toEqual(["package-suffix"]);
      // the multi-bundle violation is NOT waived → the install still refuses
      expect(signals.violations.map((v) => v.code)).toEqual(["not-exactly-one-bundle"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses a malformed SKILL.md instead of failing quiet", async () => {
    const dir = makePackage({
      "package.json": manifest("@cinatra-ai/my-skill", { kind: "skill" }),
      "skills/my-skill/SKILL.md": "---\nname: my-skill\ndescription: a: b unquoted\n---\n\nBody\n",
    });
    try {
      const signals = await computeSkillPackagingSignals(dir, EMPTY_POLICIES);
      expect(signals.violations.map((v) => v.code)).toContain("invalid-frontmatter");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("computeSkillPackagingSignals — non-skill kinds", () => {
  it("refuses an embedded skill in an agent package at ANY path", async () => {
    const dir = makePackage({
      "package.json": manifest("@cinatra-ai/some-agent", { kind: "agent" }),
      "skills/some-agent/SKILL.md": ROUTER("some-agent"),
      "deep/nested/SKILL.md": ROUTER("nested"),
    });
    try {
      const signals = await computeSkillPackagingSignals(dir, EMPTY_POLICIES);
      expect(signals.violations).toHaveLength(2);
      expect(signals.violations.every((v) => v.code === "skill-md-in-non-skill-package")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("waives ONLY the ratcheted (package :: path) pairs the S3 wave will remove", async () => {
    const dir = makePackage({
      "package.json": manifest("@cinatra-ai/some-agent", { kind: "agent" }),
      "skills/some-agent/SKILL.md": ROUTER("some-agent"),
      "skills/brand-new/SKILL.md": ROUTER("brand-new"),
    });
    try {
      const signals = await computeSkillPackagingSignals(dir, {
        ...EMPTY_POLICIES,
        legacyEmbeddedSkillKeys: new Set(["@cinatra-ai/some-agent :: skills/some-agent/SKILL.md"]),
      });
      expect(signals.waived.map((v) => v.path)).toEqual(["skills/some-agent/SKILL.md"]);
      expect(signals.violations.map((v) => v.path)).toEqual(["skills/brand-new/SKILL.md"]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("ignores a package that declares no cinatra.kind", async () => {
    const dir = makePackage({
      "package.json": JSON.stringify({ name: "plain-lib", version: "1.0.0" }),
      "skills/x/SKILL.md": ROUTER("x"),
    });
    try {
      const signals = await computeSkillPackagingSignals(dir, EMPTY_POLICIES);
      expect(signals.violations).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("groupPackageBundles", () => {
  it("treats only `skills/<name>/SKILL.md` as a bundle root; anything else is a stray", () => {
    const { bundles, strays } = groupPackageBundles([
      "skills/a/SKILL.md",
      "skills/a/references/x.md",
      "SKILL.md",
      "docs/SKILL.md",
      "skills/a/nested/SKILL.md",
    ]);
    expect(bundles.map((b) => b.relDir)).toEqual(["skills/a"]);
    expect(strays.sort()).toEqual(["SKILL.md", "docs/SKILL.md", "skills/a/nested/SKILL.md"]);
  });
});

describe("enforceSkillPackagingGateInertly", () => {
  const signals = (over: Partial<SkillPackagingSignals> = {}): SkillPackagingSignals => ({
    packageName: "@cinatra-ai/x-skill",
    kind: "skill",
    violations: [],
    waived: [],
    ...over,
  });

  it("is a no-op when no reader is wired (unit-test pipelines)", async () => {
    await expect(
      enforceSkillPackagingGateInertly({}, {
        storeDir: "/tmp/nope",
        packageName: "@cinatra-ai/x-skill",
        isLiveDigest: () => false,
      }),
    ).resolves.toBeUndefined();
  });

  it("passes a conforming package through without touching the store dir", async () => {
    const gcStoreDir = vi.fn(async () => {});
    await enforceSkillPackagingGateInertly(
      { readSkillPackagingSignals: async () => signals(), gcStoreDir },
      { storeDir: "/tmp/pkg", packageName: "@cinatra-ai/x-skill", isLiveDigest: () => false },
    );
    expect(gcStoreDir).not.toHaveBeenCalled();
  });

  it("REFUSES a violating package and GCs the just-materialized dir", async () => {
    const gcStoreDir = vi.fn(async () => {});
    await expect(
      enforceSkillPackagingGateInertly(
        {
          readSkillPackagingSignals: async () =>
            signals({ violations: [{ code: "package-suffix", message: "plural name" }] }),
          gcStoreDir,
        },
        { storeDir: "/tmp/pkg", packageName: "@cinatra-ai/x-skills", isLiveDigest: () => false },
      ),
    ).rejects.toThrow(SkillPackagingConstraintError);
    expect(gcStoreDir).toHaveBeenCalledWith("/tmp/pkg");
  });

  it("never GCs the LIVE install's dir on a refusal (same-digest re-install guard)", async () => {
    const gcStoreDir = vi.fn(async () => {});
    await expect(
      enforceSkillPackagingGateInertly(
        {
          readSkillPackagingSignals: async () =>
            signals({ violations: [{ code: "package-suffix", message: "plural name" }] }),
          gcStoreDir,
        },
        { storeDir: "/tmp/pkg", packageName: "@cinatra-ai/x-skills", isLiveDigest: () => true },
      ),
    ).rejects.toThrow(SkillPackagingConstraintError);
    expect(gcStoreDir).not.toHaveBeenCalled();
  });

  it("LOGS a ledger-waived violation rather than passing it silently", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await enforceSkillPackagingGateInertly(
        {
          readSkillPackagingSignals: async () =>
            signals({ waived: [{ code: "package-suffix", message: "plural name" }] }),
        },
        { storeDir: "/tmp/pkg", packageName: "@cinatra-ai/x-skills", isLiveDigest: () => false },
      );
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("WAIVED by the enumerated legacy ledger"));
    } finally {
      warn.mockRestore();
    }
  });

  it("propagates a reader failure and GCs (fail closed — never installs on an unreadable package)", async () => {
    const gcStoreDir = vi.fn(async () => {});
    await expect(
      enforceSkillPackagingGateInertly(
        {
          readSkillPackagingSignals: async () => {
            throw new Error("unreadable package.json");
          },
          gcStoreDir,
        },
        { storeDir: "/tmp/pkg", packageName: "@cinatra-ai/x-skill", isLiveDigest: () => false },
      ),
    ).rejects.toThrow("unreadable package.json");
    expect(gcStoreDir).toHaveBeenCalledWith("/tmp/pkg");
  });
});
