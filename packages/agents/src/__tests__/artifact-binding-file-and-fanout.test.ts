/**
 * cinatra#3030 (epic #3023 W6) — THE BINDING GRAMMAR gains a file source, a
 * fan-out and two new title sources.
 *
 * Plan sentences:
 *
 *   item 0.22: "bound, when a binding names it as its content source (bindings
 *   gain a file source beside the output source, so an explicit dependency
 *   covers files too)".
 *
 *   item 0.27: "a binding may declare that its output is a list whose members
 *   are each an artifact, or that its content source is a file pattern in the
 *   run folder's outputs; the materializer writes one artifact per member or per
 *   matching file [...] a title comes from a declared member field, from the
 *   first line of a text member — a new title source the binding grammar gains,
 *   since a binding names a title output today — or from the file name".
 *
 * ONE GRAMMAR: every consumer parses through this module, so the rules are
 * proved where they are written.
 */
import { describe, expect, it } from "vitest";

import {
  artifactOutputBindingSchema,
  collectArtifactBindingsFromOasDocument,
  fileMatchesBindingPattern,
  fileNameTitle,
  firstLineTitle,
  isFanOutBinding,
  isFileSourcedBinding,
} from "../artifact-binding";
import {
  RUN_FILE_LEDGER_OUTPUT_ID_PREFIX,
  isDefaultRoadLedgerOutputId,
  runFileLedgerOutputId,
  selectRunFilePickupItems,
} from "../end-node-output-pickup";

const EXT = "@cinatra-ai/blog-post-artifact";

describe("the file source (item 0.22)", () => {
  it("accepts a binding whose content source is ONE file of the run folder", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      extension: EXT,
      fileFrom: "draft.md",
      declaredMime: "text/markdown",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(isFileSourcedBinding(parsed.data)).toBe(true);
      expect(isFanOutBinding(parsed.data)).toBe(false);
    }
  });

  it("lets a file source leave the form to the ladder", () => {
    expect(
      artifactOutputBindingSchema.safeParse({ extension: EXT, fileFrom: "picture.png" }).success,
    ).toBe(true);
  });

  it("refuses two content sources", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      extension: EXT,
      contentFrom: "draft",
      fileFrom: "draft.md",
      titleFrom: "title",
      declaredMime: "text/markdown",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(" ")).toContain(
        "exactly one content source",
      );
    }
  });

  it("refuses NO content source", () => {
    expect(
      artifactOutputBindingSchema.safeParse({
        extension: EXT,
        titleFrom: "title",
        declaredMime: "text/markdown",
      }).success,
    ).toBe(false);
  });

  it("refuses titleFrom on a file source — the pickup reads no end-node output", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      extension: EXT,
      fileFrom: "draft.md",
      titleFrom: "title",
      declaredMime: "text/markdown",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.message).join(" ")).toContain("file name");
    }
  });

  it("keeps every output-sourced binding of today legal", () => {
    expect(
      artifactOutputBindingSchema.safeParse({
        extension: EXT,
        contentFrom: "draft",
        titleFrom: "title",
        declaredMime: "text/markdown",
      }).success,
    ).toBe(true);
  });
});

describe("the fan-out (item 0.27)", () => {
  it("accepts a list output whose members are each an artifact, titled by a member field", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      extension: EXT,
      contentFrom: "ideas",
      membersAreArtifacts: true,
      titleFromMemberField: "title",
      declaredMime: "application/json",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(isFanOutBinding(parsed.data)).toBe(true);
  });

  it("accepts a list output titled by the first line of each text member", () => {
    expect(
      artifactOutputBindingSchema.safeParse({
        extension: EXT,
        contentFrom: "ideas",
        membersAreArtifacts: true,
        titleFromFirstLine: true,
        declaredMime: "text/plain",
      }).success,
    ).toBe(true);
  });

  it("refuses a fan-out with no per-member title source", () => {
    expect(
      artifactOutputBindingSchema.safeParse({
        extension: EXT,
        contentFrom: "ideas",
        membersAreArtifacts: true,
        declaredMime: "text/plain",
      }).success,
    ).toBe(false);
  });

  it("refuses one output titling every member", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      extension: EXT,
      contentFrom: "ideas",
      membersAreArtifacts: true,
      titleFrom: "title",
      declaredMime: "text/plain",
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses membersAreArtifacts on a file pattern — a pattern already fans out", () => {
    expect(
      artifactOutputBindingSchema.safeParse({
        extension: EXT,
        filePattern: "pictures/*.png",
        membersAreArtifacts: true,
      }).success,
    ).toBe(false);
  });

  it("accepts a file pattern, which fans out per matching file", () => {
    const parsed = artifactOutputBindingSchema.safeParse({
      extension: EXT,
      filePattern: "pictures/*.png",
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(isFanOutBinding(parsed.data)).toBe(true);
      expect(isFileSourcedBinding(parsed.data)).toBe(true);
    }
  });
});

describe("the pattern, the titles and the reserved file ids", () => {
  it("matches within a segment with * and across segments with **", () => {
    expect(fileMatchesBindingPattern("pictures/*.png", "pictures/hero.png")).toBe(true);
    expect(fileMatchesBindingPattern("pictures/*.png", "pictures/deep/hero.png")).toBe(false);
    expect(fileMatchesBindingPattern("pictures/**", "pictures/deep/hero.png")).toBe(true);
    expect(fileMatchesBindingPattern("**/*.png", "pictures/deep/hero.png")).toBe(true);
    expect(fileMatchesBindingPattern("*.md", "draft.md")).toBe(true);
    expect(fileMatchesBindingPattern("*.md", "notes/draft.md")).toBe(false);
    // A pattern is not a shell language: a dot is a dot.
    expect(fileMatchesBindingPattern("a.md", "axmd")).toBe(false);
  });

  it("takes a title from the first line of a text member, heading marks stripped", () => {
    expect(firstLineTitle("# Why migrations are hard\n\nbody")).toBe(
      "Why migrations are hard",
    );
    expect(firstLineTitle("- an idea about pricing\nmore")).toBe("an idea about pricing");
    expect(firstLineTitle("")).toBe("");
  });

  it("takes a title from the file name", () => {
    expect(fileNameTitle("pictures/hero.png")).toBe("hero.png");
    expect(fileNameTitle("draft.md")).toBe("draft.md");
  });

  it("gives every emitted file a reserved ledger id of its own", () => {
    expect(runFileLedgerOutputId("pictures/hero.png")).toBe(
      `${RUN_FILE_LEDGER_OUTPUT_ID_PREFIX}pictures/hero.png`,
    );
    expect(isDefaultRoadLedgerOutputId(runFileLedgerOutputId("a.md"))).toBe(true);
    expect(isDefaultRoadLedgerOutputId("some-node-id")).toBe(false);
  });

  it("selects every non-empty file as an output, in a stable order", () => {
    const items = selectRunFilePickupItems([
      { relPath: "b.md", byteLength: 12 },
      { relPath: "empty.md", byteLength: 0 },
      { relPath: "a.md", byteLength: 3 },
    ]);
    expect(items.map((i) => i.relPath)).toEqual(["a.md", "b.md"]);
    expect(items[0]).toMatchObject({ source: "file", outputName: "a.md", byteLength: 3 });
  });
});

describe("the collector, over a document", () => {
  it("collects a file-sourced binding without demanding an end-node output for it", () => {
    const doc = {
      $referenced_components: {
        end: {
          component_type: "EndNode",
          outputs: [
            {
              title: "draft_file",
              cinatra: {
                artifact: { extension: EXT, fileFrom: "draft.md", declaredMime: "text/markdown" },
              },
            },
          ],
        },
      },
    };
    const result = collectArtifactBindingsFromOasDocument(doc, { produces: [EXT] });
    expect(result.errors).toEqual([]);
    expect(result.bindings).toHaveLength(1);
    expect(result.bindings[0]?.binding.fileFrom).toBe("draft.md");
  });

  it("still demands that contentFrom and titleFrom name real outputs of the same end node", () => {
    const doc = {
      $referenced_components: {
        end: {
          component_type: "EndNode",
          outputs: [
            {
              title: "draft",
              cinatra: {
                artifact: {
                  extension: EXT,
                  contentFrom: "missing",
                  titleFrom: "title",
                  declaredMime: "text/markdown",
                },
              },
            },
          ],
        },
      },
    };
    const result = collectArtifactBindingsFromOasDocument(doc, { produces: [EXT] });
    expect(result.bindings).toHaveLength(0);
    expect(result.errors.join(" ")).toContain("does not name an output");
  });
});
