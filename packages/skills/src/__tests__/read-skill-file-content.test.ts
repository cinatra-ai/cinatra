// Contract tests for `readSkillFileContent` containment.
//
// Catalog-only resolution; there is no `allowedRoots` override. Callers that
// widen the containment (the llm-bridge auto-discovery for extension SKILL.md)
// register the SKILL.md into the catalog via `registerExtensionSkill`, which
// mirrors it into `data/skills/...` so subsequent reads stay inside the default
// root.

import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  getSkillStoreRootPath,
  getSkillsDataRootPath,
  readSkillContent,
  readSkillFileContent,
} from "../skills-store";

describe("readSkillFileContent — default-root containment", () => {
  it("rejects an absolute path outside the default skills data root", async () => {
    // Path-traversal containment: any path outside `getSkillsDataRootPath()`
    // must be rejected, regardless of whether the file exists. We exercise
    // /tmp here because it is always outside the configured skills root.
    const outsidePath = path.resolve("/tmp", "definitely-not-a-skill.md");
    await expect(readSkillFileContent(outsidePath)).rejects.toThrow(
      /allowed skill roots/i,
    );
  });

  it("rejects a sibling-prefix path (same string prefix, different directory)", async () => {
    // The containment check uses `root + path.sep`, so a `<root>foo` sibling
    // (which shares the root's string prefix) CANNOT satisfy containment.
    // We can't easily compute the real root from outside, but any path that
    // starts at "/" with the right characters won't satisfy `startsWith(root + sep)`.
    const siblingPrefix = path.resolve("/tmp", "skillsfoo.md");
    await expect(readSkillFileContent(siblingPrefix)).rejects.toThrow(
      /allowed skill roots/i,
    );
  });
});

describe("readSkillContent — SkillSource-aware entry-point", () => {
  it("rejects a stored sourcePath outside the allowed skill root (closes the MCP-handler containment-bypass hole)", async () => {
    // The pre-cutover handler did `existsSync + readFileSync(skill.sourcePath)`
    // with NO containment check — a payload-injected traversal `sourcePath`
    // could read arbitrary files. The cutover routes through readSkillContent,
    // which delegates to readSkillFileContent's strict-containment check.
    await expect(
      readSkillContent({ sourcePath: path.resolve("/tmp", "traversal-attempt.md") }),
    ).rejects.toThrow(/allowed skill roots/i);
  });

  it("fails loud when the row has no resolvable physical anchor (digest/relativePath-only is not yet wired)", async () => {
    // A row may carry a populated `source`, but content is still physically
    // anchored on `sourcePath`. A source-only row (digest/relativePath
    // with no sourcePath) MUST fail loud — never guess at a path.
    await expect(
      readSkillContent({
        source: {
          origin: "extension",
          scope: null,
          packageRef: "x",
          revision: { kind: "digest", value: "sha256:abc" },
          relativePath: "SKILL.md",
        },
      }),
    ).rejects.toThrow(/digest\/relativePath-only resolution is not yet wired|origin=extension/i);
  });

  it("rejects a malformed-stored-source row with NO sourcePath too (still fails loud, doesn't guess)", async () => {
    // The resolver discards a malformed `source` and tries to derive from
    // legacy fields — but without a sourcePath there's no physical anchor.
    await expect(
      // @ts-expect-error — deliberately malformed `source` to exercise the loud failure
      readSkillContent({ source: { origin: "nope" }, packageId: "p" }),
    ).rejects.toThrow(/no sourcePath/i);
  });
});

describe("getSkillStoreRootPath — new canonical store root", () => {
  it("returns the new store root (default `data/skill-store`), distinct from the legacy `data/skills` root", () => {
    const store = getSkillStoreRootPath();
    const legacy = getSkillsDataRootPath();
    expect(store).not.toBe(legacy);
    // The defaults end with the expected directory names; absolute-path
    // resolution against process.cwd() means the prefix is the same but the
    // basename differs.
    expect(path.basename(store)).toBe("skill-store");
    expect(path.basename(legacy)).toBe("skills");
  });
});

describe("assertSkillFilePathInsideRoot — broadened to accept BOTH roots", () => {
  it("accepts a path under the new store root (canonical for new writes)", async () => {
    // readSkillFileContent will fail with ENOENT (the file doesn't actually
    // exist on disk in this unit test) — but it MUST get past the
    // containment check first. ENOENT ≠ "outside allowed roots".
    const inStore = path.join(getSkillStoreRootPath(), "workspace", "x", "SKILL.md");
    await expect(readSkillFileContent(inStore)).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("accepts a path under the legacy `data/skills` root (compat fallback for legacy rows)", async () => {
    // Legacy rows whose sourcePath still points inside `data/skills` keep
    // reading until a later migration moves them. Containment passes; ENOENT
    // means the file isn't there, NOT a containment rejection.
    const inLegacy = path.join(getSkillsDataRootPath(), "workspace", "x", "SKILL.md");
    await expect(readSkillFileContent(inLegacy)).rejects.toThrow(/ENOENT|no such file/i);
  });

  it("still rejects a path outside BOTH roots (e.g. /tmp/...) — same security guarantee", async () => {
    const outsideBoth = path.resolve("/tmp", "definitely-not-a-skill.md");
    await expect(readSkillFileContent(outsideBoth)).rejects.toThrow(
      /allowed skill roots/i,
    );
  });

  it("still rejects a sibling-prefix path against either root (no string-prefix-only bypass)", async () => {
    // `<root>foo` shares the root's string prefix but is a different directory
    // — the `+ path.sep` containment check correctly rejects.
    const storeSibling = getSkillStoreRootPath() + "foo";
    await expect(readSkillFileContent(storeSibling)).rejects.toThrow(
      /allowed skill roots/i,
    );
    const legacySibling = getSkillsDataRootPath() + "foo";
    await expect(readSkillFileContent(legacySibling)).rejects.toThrow(
      /allowed skill roots/i,
    );
  });
});
