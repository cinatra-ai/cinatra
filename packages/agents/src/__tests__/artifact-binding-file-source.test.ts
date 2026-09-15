/**
 * cinatra#3030 (epic #3023, lifecycle-c W6) — THE BINDING GRAMMAR'S FILE
 * CONTENT SOURCE (plan item 0.22) and the FILE FAN-OUT (item 0.27).
 *
 *   0.22: "bindings gain a file source beside the output source, so an explicit
 *   dependency covers files too"
 *   0.27: "one artifact per member or per matching file [...] a title comes
 *   from a declared member field, the first line of a text member, or the file
 *   name"
 *
 * FAIL-CLOSED is the point: exactly one content source, and a file source never
 * borrows the output source's title and form machinery.
 */
import { describe, expect, it } from "vitest";
import {
  artifactOutputBindingSchema,
  fileMatchesBindingPattern,
  fileNameTitle,
  firstLineTitle,
} from "../artifact-binding";

const ok = (raw: unknown) => artifactOutputBindingSchema.safeParse(raw);
const messages = (raw: unknown) => {
  const parsed = ok(raw);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
};

describe("item 0.22 — a binding may name a FILE as its content source", () => {
  it("accepts a file source that declares its form", () => {
    const parsed = ok({
      extension: "@cinatra-ai/markdown",
      fileFrom: "report.md",
      declaredMime: "text/markdown",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.fileFrom).toBe("report.md");
  });

  it("accepts a file source that leaves the form to the detection ladder", () => {
    expect(ok({ extension: "@cinatra-ai/markdown", fileFrom: "report.md" }).success).toBe(true);
  });

  it("accepts a file source titled from its first line", () => {
    expect(
      ok({
        extension: "@cinatra-ai/markdown",
        fileFrom: "report.md",
        titleFromFirstLine: true,
      }).success,
    ).toBe(true);
  });

  it("keeps every existing output-sourced binding valid", () => {
    expect(
      ok({
        extension: "@cinatra-ai/markdown",
        contentFrom: "draft",
        declaredMime: "text/markdown",
        titleFrom: "heading",
      }).success,
    ).toBe(true);
  });
});

describe("item 0.27 — a file PATTERN is the file fan-out", () => {
  it("accepts a pattern source", () => {
    expect(
      ok({ extension: "@cinatra-ai/markdown", filePattern: "chapters/*.md" }).success,
    ).toBe(true);
  });

  it("matches inside one segment with * and across segments with **", () => {
    expect(fileMatchesBindingPattern("chapters/*.md", "chapters/one.md")).toBe(true);
    expect(fileMatchesBindingPattern("chapters/*.md", "chapters/deep/one.md")).toBe(false);
    expect(fileMatchesBindingPattern("chapters/**.md", "chapters/deep/one.md")).toBe(true);
    expect(fileMatchesBindingPattern("*.md", "report.md")).toBe(true);
    expect(fileMatchesBindingPattern("*.md", "report.txt")).toBe(false);
    expect(fileMatchesBindingPattern("report?.md", "report1.md")).toBe(true);
    expect(fileMatchesBindingPattern("report?.md", "report12.md")).toBe(false);
  });

  it("treats every other character as a literal — a pattern smuggles no regular expression in", () => {
    expect(fileMatchesBindingPattern("a.md", "aXmd")).toBe(false);
    expect(fileMatchesBindingPattern("re(port).md", "re(port).md")).toBe(true);
    expect(fileMatchesBindingPattern("a+.md", "aa.md")).toBe(false);
  });
});

describe("fail-closed: exactly one content source", () => {
  it("refuses a binding that declares none", () => {
    expect(messages({ extension: "@cinatra-ai/markdown", declaredMime: "text/markdown" })).toContain(
      "exactly one content source is required: contentFrom, fileFrom or filePattern",
    );
  });

  it("refuses a binding that declares an output source AND a file source", () => {
    expect(
      messages({
        extension: "@cinatra-ai/markdown",
        contentFrom: "draft",
        fileFrom: "report.md",
        declaredMime: "text/markdown",
        titleFrom: "heading",
      }).join(" "),
    ).toMatch(/exactly one content source is allowed/);
  });

  it("refuses a binding that declares both file sources", () => {
    expect(
      messages({
        extension: "@cinatra-ai/markdown",
        fileFrom: "report.md",
        filePattern: "*.md",
      }).join(" "),
    ).toMatch(/exactly one content source is allowed/);
  });
});

describe("fail-closed: a file source titles itself and never borrows the output machinery", () => {
  it("refuses titleFrom on a file source", () => {
    expect(messages({ extension: "@cinatra-ai/markdown", fileFrom: "r.md", titleFrom: "heading" }).join(" ")).toMatch(
      /must not carry titleFrom/,
    );
  });

  it("refuses mimeFrom on a file source", () => {
    expect(messages({ extension: "@cinatra-ai/markdown", fileFrom: "r.md", mimeFrom: "form" }).join(" ")).toMatch(
      /may not carry mimeFrom/,
    );
  });

  it("refuses fanOut on a file source — filePattern IS the file fan-out", () => {
    expect(
      messages({
        extension: "@cinatra-ai/markdown",
        filePattern: "*.md",
        fanOut: { mode: "member", titleFrom: "first-line", titlePrefix: "# " },
      }).join(" "),
    ).toMatch(/must not carry fanOut/);
  });

  it("refuses titleFromFirstLine on an OUTPUT source", () => {
    expect(
      messages({
        extension: "@cinatra-ai/markdown",
        contentFrom: "draft",
        declaredMime: "text/markdown",
        titleFrom: "heading",
        titleFromFirstLine: true,
      }).join(" "),
    ).toMatch(/only meaningful on a file source/);
  });
});

describe("item 0.27 — the titles a file carries", () => {
  it("names a file by its own name, extension kept", () => {
    expect(fileNameTitle("chapters/one.md")).toBe("one.md");
    expect(fileNameTitle("report.md")).toBe("report.md");
  });

  it("takes the first line when there is one, and never invents one", () => {
    expect(firstLineTitle("# Chapter one\nbody\n")).toBe("# Chapter one");
    expect(firstLineTitle("\nbody\n")).toBe("");
    expect(firstLineTitle("   \nbody")).toBe("");
  });
});
