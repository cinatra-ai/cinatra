// SkillSource resolver + guard tests.
//
// skill-source.ts is a pure-fn leaf module (no server-only imports) so the unit
// test imports it directly. Covers: explicit-source-wins, best-effort origin
// derivation from legacy fields, the activeHead revision for derived rows, the
// runtime guard used on the payload read path, and the legacy-sourcePath
// fallback (a derived row leaves relativePath null so content readers keep
// falling back to sourcePath).

import { describe, it, expect } from "vitest";
import {
  resolveSkillSource,
  isSkillSource,
  buildSkillSourceForWrite,
  computeSkillSourceRevision,
  type SkillSource,
} from "../skill-source";

describe("resolveSkillSource — explicit source wins", () => {
  it("returns a valid stored source verbatim, ignoring legacy fields", () => {
    const stored: SkillSource = {
      origin: "extension",
      scope: "workspace",
      packageRef: "cinatra-ai/blog-connector",
      revision: { kind: "digest", value: "sha256:abc" },
      relativePath: "skills/blog/SKILL.md",
    };
    const r = resolveSkillSource({ packageId: "github:owner/repo", source: stored });
    expect(r).toEqual(stored);
  });

  it("ignores a malformed stored source and derives instead", () => {
    const r = resolveSkillSource({
      packageId: "github:owner/repo",
      // @ts-expect-error — deliberately malformed to exercise the guard
      source: { origin: "nope" },
    });
    expect(r?.origin).toBe("github");
  });
});

describe("resolveSkillSource — best-effort derivation", () => {
  it("classifies github: packageIds as github origin", () => {
    const r = resolveSkillSource({ packageId: "github:owner/repo" });
    expect(r?.origin).toBe("github");
    expect(r?.packageRef).toBe("github:owner/repo");
  });

  it("classifies verdaccio: packageIds as vendored origin", () => {
    const r = resolveSkillSource({ packageId: "verdaccio:@anthropics/skills" });
    expect(r?.origin).toBe("vendored");
  });

  it("classifies LLM-generated delta skills as custom origin", () => {
    const r = resolveSkillSource({ packageId: "x", isCustomSkill: true });
    expect(r?.origin).toBe("custom");
  });

  it("classifies a github sourceUrl / originRepo as github even without a github: id", () => {
    expect(resolveSkillSource({ packageId: "p", originRepo: "owner/repo" })?.origin).toBe("github");
    expect(
      resolveSkillSource({ packageId: "p", sourceUrl: "https://github.com/owner/repo" })?.origin,
    ).toBe("github");
  });

  it("classifies a plain packaged skill as extension origin", () => {
    const r = resolveSkillSource({ packageId: "cinatra-ai/blog-connector", packageName: "blog" });
    expect(r?.origin).toBe("extension");
  });

  it("classifies a `custom:` packageId as custom even without isCustomSkill", () => {
    // upsertSkill writes non-personal scoped custom skills (team/organization/
    // project via upsertCustomSkill or createSkillFromTemplate) with
    // packageId="custom:${packageSlug}" but WITHOUT isCustomSkill (that flag
    // is reserved for the personal/agent LLM-delta path). Without this branch
    // these classify as "extension" and get mis-tagged digest-immutable.
    const r = resolveSkillSource({ packageId: "custom:team-toolkit", packageName: "Team toolkit" });
    expect(r?.origin).toBe("custom");
  });

  it("derived rows carry an activeHead (null) revision and null relativePath", () => {
    const r = resolveSkillSource({ packageId: "cinatra-ai/blog-connector" });
    expect(r?.revision).toEqual({ kind: "activeHead", value: null });
    expect(r?.relativePath).toBeNull();
  });

  it("projects scope through, defaulting to null", () => {
    expect(resolveSkillSource({ packageId: "p", scope: "org" })?.scope).toBe("org");
    expect(resolveSkillSource({ packageId: "p" })?.scope).toBeNull();
  });

  it("returns null for a row with no usable identity", () => {
    expect(resolveSkillSource({})).toBeNull();
  });

  it("resolves an originRepo-only / sourceUrl-only row to github (no packageId required)", () => {
    expect(resolveSkillSource({ originRepo: "owner/repo" })?.origin).toBe("github");
    expect(
      resolveSkillSource({ sourceUrl: "https://github.com/owner/repo" })?.origin,
    ).toBe("github");
  });

  it("legacy fallback: a sourcePath-only row still resolves (relativePath null → readers fall back to sourcePath)", () => {
    const r = resolveSkillSource({ sourcePath: "/data/skills/workspace/x/SKILL.md" });
    expect(r).not.toBeNull();
    expect(r?.relativePath).toBeNull();
  });
});

describe("isSkillSource guard (payload read-path validation)", () => {
  it("accepts a digest-revision source", () => {
    expect(
      isSkillSource({
        origin: "extension",
        scope: null,
        packageRef: "p",
        revision: { kind: "digest", value: "sha256:x" },
        relativePath: null,
      }),
    ).toBe(true);
  });

  it("accepts an activeHead-revision source with a null value", () => {
    expect(
      isSkillSource({
        origin: "custom",
        scope: "user-1",
        packageRef: null,
        revision: { kind: "activeHead", value: null },
        relativePath: "SKILL.md",
      }),
    ).toBe(true);
  });

  it("rejects unknown origin, bad revision kind, and non-objects", () => {
    expect(isSkillSource({ origin: "nope", scope: null, packageRef: null, revision: { kind: "digest", value: "x" }, relativePath: null })).toBe(false);
    expect(isSkillSource({ origin: "extension", scope: null, packageRef: null, revision: { kind: "weird" }, relativePath: null })).toBe(false);
    expect(isSkillSource({ origin: "extension", scope: null, packageRef: null, revision: { kind: "digest", value: 1 }, relativePath: null })).toBe(false);
    expect(isSkillSource(null)).toBe(false);
    expect(isSkillSource("nope")).toBe(false);
  });
});

describe("computeSkillSourceRevision (write-side digest)", () => {
  it("is deterministic + sensitive to byte changes anywhere in content", () => {
    const a = computeSkillSourceRevision("hello world");
    expect(a).toBe(computeSkillSourceRevision("hello world"));
    expect(computeSkillSourceRevision("hello world!")).not.toBe(a);
  });

  it("uses full content (NOT the 16 KiB matching-truncated variant)", () => {
    // A 17 KiB string differing only past byte 16384 must produce a different
    // revision (whereas llm-matching/hashes' computeSkillContentDigest, by
    // design, truncates to 16 KiB and would collide here).
    const base = "x".repeat(17_000);
    const a = computeSkillSourceRevision(base + "A");
    const b = computeSkillSourceRevision(base + "B");
    expect(a).not.toBe(b);
  });

  it("hashes empty content deterministically (NOT null)", () => {
    expect(computeSkillSourceRevision("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("buildSkillSourceForWrite (write-side derivation)", () => {
  it("returns an activeHead-revision source for non-extension origins (custom/local) with the content digest as value", () => {
    const r = buildSkillSourceForWrite({
      packageId: "custom:my-pkg",
      packageName: "my-pkg",
      isCustomSkill: true,
      content: "skill body",
    });
    expect(r?.revision).toEqual({
      kind: "activeHead",
      value: computeSkillSourceRevision("skill body"),
    });
  });

  it("defaults relativePath to 'SKILL.md' (conventional skill-dir layout)", () => {
    const r = buildSkillSourceForWrite({ packageId: "p", content: "x" });
    expect(r?.relativePath).toBe("SKILL.md");
  });

  it("honors an explicit relativePath override (e.g. nested SKILL.md)", () => {
    const r = buildSkillSourceForWrite({
      packageId: "p",
      content: "x",
      relativePath: "skills/foo/SKILL.md",
    });
    expect(r?.relativePath).toBe("skills/foo/SKILL.md");
  });

  it("reuses resolveSkillSource's origin classification", () => {
    expect(buildSkillSourceForWrite({ packageId: "github:owner/repo", content: "x" })?.origin).toBe("github");
    expect(buildSkillSourceForWrite({ packageId: "verdaccio:@a/b", content: "x" })?.origin).toBe("vendored");
    expect(buildSkillSourceForWrite({ packageId: "custom:p", isCustomSkill: true, content: "x" })?.origin).toBe("custom");
    expect(buildSkillSourceForWrite({ packageId: "cinatra-ai/blog-connector", content: "x" })?.origin).toBe("extension");
  });

  it("projects packageRef + scope through", () => {
    const r = buildSkillSourceForWrite({
      packageId: "custom:p",
      packageName: "p",
      scope: "user-1",
      content: "x",
    });
    expect(r?.packageRef).toBe("custom:p");
    expect(r?.scope).toBe("user-1");
  });

  it("returns null only for a row with no usable identity (matches resolver contract)", () => {
    expect(buildSkillSourceForWrite({ content: "x" })).toBeNull();
  });

  it("revision value differs when content differs (no surprise stable hash)", () => {
    const a = buildSkillSourceForWrite({ packageId: "p", content: "v1" });
    const b = buildSkillSourceForWrite({ packageId: "p", content: "v2" });
    expect(a?.revision).not.toEqual(b?.revision);
  });
});

describe("buildSkillSourceForWrite (extension-origin → digest revision)", () => {
  it("extension origin gets revision.kind = 'digest' (immutable snapshot semantics)", () => {
    // registerExtensionSkill / registerPackageAgentSkill use packageName like
    // "@cinatra-ai/chat" / "@cinatra-ai/blog-connector" — origin classifies as
    // "extension" (no github:/verdaccio: prefix, no isCustomSkill). Extension
    // origins use digest (immutable snapshot) rather than activeHead (mutable
    // head). The VALUE stays the full-content sha256 either way.
    const r = buildSkillSourceForWrite({
      packageId: "@cinatra-ai/chat:chat-assistant",
      packageName: "@cinatra-ai/chat",
      content: "skill body",
    });
    expect(r?.origin).toBe("extension");
    expect(r?.revision).toEqual({
      kind: "digest",
      value: computeSkillSourceRevision("skill body"),
    });
  });

  it("custom origin still gets activeHead (mutable user-edited skill, both isCustomSkill and `custom:`-prefix paths)", () => {
    // Personal/agent LLM-delta (isCustomSkill: true).
    const personal = buildSkillSourceForWrite({
      packageId: "custom:user-skill",
      isCustomSkill: true,
      content: "v1",
    });
    expect(personal?.origin).toBe("custom");
    expect(personal?.revision.kind).toBe("activeHead");
    // Non-personal scoped custom (team/org/project — `custom:` packageId without
    // isCustomSkill).
    const scoped = buildSkillSourceForWrite({
      packageId: "custom:team-toolkit",
      packageName: "Team toolkit",
      content: "v1",
    });
    expect(scoped?.origin).toBe("custom");
    expect(scoped?.revision.kind).toBe("activeHead");
  });

  it("github origin stays activeHead (extension-only promotion; github/vendored deferred)", () => {
    // Only extension origin → digest. Other packaged origins (github /
    // vendored) stay activeHead — promotion is a later refinement if needed.
    expect(
      buildSkillSourceForWrite({ packageId: "github:owner/repo", content: "x" })?.revision.kind,
    ).toBe("activeHead");
    expect(
      buildSkillSourceForWrite({ packageId: "verdaccio:@a/b", content: "x" })?.revision.kind,
    ).toBe("activeHead");
  });
});
