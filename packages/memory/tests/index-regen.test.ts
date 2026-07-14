import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { initMemoryBundle } from "../src/bundle.ts";
import { addMemoryConcept, regenerateMemoryIndex } from "../src/write.ts";

const tmp = mkdtempSync(path.join(os.tmpdir(), "memory-index-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("deterministic index.md regeneration", () => {
  const root = path.join(tmp, ".memory");

  it("init writes an empty root index declaring the format version", () => {
    initMemoryBundle(root, { name: "regen" });
    expect(readFileSync(path.join(root, "index.md"), "utf8")).toBe(
      '---\nokf_version: "0.1"\n---\n\n# Concepts\n',
    );
  });

  it("groups sections by directory, sorts entries by path, uses frontmatter descriptions", () => {
    addMemoryConcept(root, {
      type: "Convention",
      title: "Zebra rule",
      description: "Sorts after the others.",
      path: "conventions/zebra.md",
      timestamp: null,
    });
    addMemoryConcept(root, {
      type: "Convention",
      title: "Alpha rule",
      description: "Sorts first.",
      path: "conventions/alpha.md",
      timestamp: null,
    });
    addMemoryConcept(root, {
      type: "Command",
      title: "Run tests",
      path: "commands/run-tests.md",
      timestamp: null,
    });
    addMemoryConcept(root, {
      type: "Reference",
      title: "Root note",
      description: "Lives at the bundle root.",
      path: "root-note.md",
      timestamp: null,
    });

    const index = readFileSync(path.join(root, "index.md"), "utf8");
    expect(index).toBe(
      [
        "---",
        'okf_version: "0.1"',
        "---",
        "",
        "# Concepts",
        "",
        "* [Root note](/root-note.md) - Lives at the bundle root.",
        "",
        "# commands",
        "",
        "* [Run tests](/commands/run-tests.md)",
        "",
        "# conventions",
        "",
        "* [Alpha rule](/conventions/alpha.md) - Sorts first.",
        "* [Zebra rule](/conventions/zebra.md) - Sorts after the others.",
        "",
      ].join("\n"),
    );
  });

  it("regeneration is deterministic and preserves the okf_version declaration", () => {
    const first = readFileSync(path.join(root, "index.md"), "utf8");
    const regenerated = regenerateMemoryIndex(root);
    expect(regenerated).toBe(first);
    expect(readFileSync(path.join(root, "index.md"), "utf8")).toBe(first);
  });

  it("sanitizes titles and descriptions into single safe entry lines", () => {
    addMemoryConcept(root, {
      type: "Reference",
      title: "Weird ] title",
      description: "line one\nline two",
      path: "weird/entry.md",
      timestamp: null,
    });
    const index = readFileSync(path.join(root, "index.md"), "utf8");
    expect(index).toContain(
      "* [Weird \\] title](/weird/entry.md) - line one line two",
    );
    // No injected heading or extra list line from the newline.
    expect(index).not.toContain("\nline two");
  });

  it("flattens hostile directory names in section headings (no heading injection)", async () => {
    const { generateMemoryIndexMarkdown } = await import("../src/index-file.ts");
    const generated = generateMemoryIndexMarkdown([
      {
        id: "safe\n# Injected/x",
        path: "safe\n# Injected/x.md",
        type: "X",
        tags: [],
        frontmatter: { type: "X" },
        body: "",
      },
    ]);
    expect(generated).not.toContain("\n# Injected");
    expect(generated).toContain("# safe # Injected\n");
    expect(generated).toContain("(/safe%0A%23%20Injected/x.md)");
  });

  it("generated index links round-trip through the package's own link resolution", async () => {
    const { generateMemoryIndexMarkdown } = await import("../src/index-file.ts");
    const { extractMemoryLinks } = await import("../src/links.ts");
    // '#' would otherwise read as a URL-fragment delimiter and truncate the
    // resolved target; '%' must stay distinguishable from an escape sequence.
    const hostilePaths = [
      "safe\n# Injected/x.md",
      "notes/50% done.md",
      "a b/(c) <d>.md",
    ];
    const generated = generateMemoryIndexMarkdown(
      hostilePaths.map((p) => ({
        id: p.slice(0, -3),
        path: p,
        type: "X",
        tags: [],
        frontmatter: { type: "X" },
        body: "",
      })),
    );
    const resolved = extractMemoryLinks("index.md", generated)
      .map((link) => link.resolvedPath)
      .sort();
    expect(resolved).toEqual([...hostilePaths].sort());
  });

  it("percent-decodes user link targets and keeps malformed escapes raw", async () => {
    const { extractMemoryLinks } = await import("../src/links.ts");
    const links = extractMemoryLinks(
      "notes/a.md",
      "[ok](other%20file.md) [escaped](50%25.md) [malformed](100%zz.md)",
    );
    expect(links.map((link) => link.resolvedPath)).toEqual([
      "notes/other file.md",
      "notes/50%.md",
      "notes/100%zz.md",
    ]);
  });

  it("init refuses to reinitialize and never clobbers a pre-existing index.md", () => {
    expect(() => initMemoryBundle(root)).toThrow(/already initialized/);

    const dir = path.join(tmp, "pre-existing");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "index.md"), "# Hand-written index\n");
    initMemoryBundle(dir);
    expect(readFileSync(path.join(dir, "index.md"), "utf8")).toBe(
      "# Hand-written index\n",
    );
  });
});
