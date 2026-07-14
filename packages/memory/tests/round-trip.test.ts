import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  parseMemoryConceptSource,
  serializeMemoryConcept,
} from "../src/concept.ts";
import { walkMemoryTree } from "../src/bundle.ts";

const FIXTURES = fileURLToPath(new URL("./fixtures", import.meta.url));
const VENDORED_BUNDLE = path.join(FIXTURES, "vendored", "crypto_bitcoin");

function conceptFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { recursive: true }) as string[]) {
    const basename = path.basename(entry);
    if (!basename.endsWith(".md")) continue;
    if (basename === "index.md" || basename === "log.md") continue;
    out.push(path.join(root, entry));
  }
  return out.sort();
}

/** Independent body extraction: everything after the first closing `---` line. */
function expectedBody(source: string): string {
  const close = source.indexOf("\n---\n", 3);
  expect(close).toBeGreaterThan(0);
  return source.slice(close + "\n---\n".length);
}

describe("round-trip on the vendored public OKF sample bundle", () => {
  const files = conceptFiles(VENDORED_BUNDLE);

  it("vendored fixture is present and loads with no diagnostics", () => {
    expect(files.length).toBe(5);
    const tree = walkMemoryTree(VENDORED_BUNDLE);
    expect(tree.concepts.map((c) => c.path)).toEqual([
      "datasets/crypto_bitcoin.md",
      "tables/blocks.md",
      "tables/inputs.md",
      "tables/outputs.md",
      "tables/transactions.md",
    ]);
    expect(tree.diagnostics).toEqual([]);
    expect(tree.okfVersion).toBeUndefined();
  });

  for (const file of files) {
    it(`round-trips ${path.relative(VENDORED_BUNDLE, file)} byte-for-byte`, () => {
      const source = readFileSync(file, "utf8");
      const parsed = parseMemoryConceptSource(source);
      expect(parsed.ok).toBe(true);
      if (!parsed.ok) return;

      // Body bytes are preserved exactly (checked against an independent split).
      expect(parsed.body).toBe(expectedBody(source));

      // An unmodified concept re-serializes to the EXACT original bytes
      // (frontmatter emitted verbatim from frontmatterSource).
      const serialized = serializeMemoryConcept(parsed);
      expect(serialized).toBe(source);

      const reparsed = parseMemoryConceptSource(serialized);
      expect(reparsed.ok).toBe(true);
      if (!reparsed.ok) return;
      // Unknown/producer-defined keys survive with identical values.
      expect(reparsed.frontmatter).toEqual(parsed.frontmatter);
      expect(Object.keys(reparsed.frontmatter)).toEqual(
        Object.keys(parsed.frontmatter),
      );
    });
  }
});

describe("round-trip on hand-built edge cases", () => {
  it("preserves unknown nested frontmatter keys and exact body", () => {
    const source = [
      "---",
      "type: Debugging Insight",
      "title: Weird one",
      "x_unknown:",
      "  nested:",
      "    - 1",
      "    - two",
      "x_flag: true",
      "---",
      "BODY line one",
      "",
      "  indented line, no trailing newline",
    ].join("\n");
    const parsed = parseMemoryConceptSource(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.body).toBe(
      "BODY line one\n\n  indented line, no trailing newline",
    );
    expect(parsed.frontmatter["x_unknown"]).toEqual({ nested: [1, "two"] });
    expect(parsed.frontmatter["x_flag"]).toBe(true);

    expect(serializeMemoryConcept(parsed)).toBe(source);
  });

  it("preserves comments, exotic YAML tags, and integer-like key order verbatim", () => {
    // The parsed JS mapping cannot represent these faithfully (a !!binary
    // value resolves to a Buffer; integer-like keys reorder), but the
    // frontmatter text is re-emitted verbatim, so nothing is lost on disk.
    const source = [
      "---",
      "type: Reference",
      "# a comment that must survive",
      "9: after",
      "1: before",
      "blob: !!binary Zm9v",
      "---",
      "Body.",
      "",
    ].join("\n");
    const parsed = parseMemoryConceptSource(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(serializeMemoryConcept(parsed)).toBe(source);
  });

  it("re-serializes from the mapping when frontmatter was modified", () => {
    const parsed = parseMemoryConceptSource(
      "---\ntype: X\nkeep: me\n---\nBody.\n",
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const modified = {
      frontmatter: { ...parsed.frontmatter, title: "New" },
      body: parsed.body,
    };
    const serialized = serializeMemoryConcept(modified);
    const reparsed = parseMemoryConceptSource(serialized);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(reparsed.frontmatter).toEqual({ type: "X", keep: "me", title: "New" });
    expect(reparsed.body).toBe("Body.\n");
  });

  it("round-trips CRLF delimiters and a closing delimiter at EOF byte-for-byte", () => {
    const crlf = "---\r\ntype: X\r\ntitle: CRLF\r\n---\r\nbody line\r\n";
    const parsedCrlf = parseMemoryConceptSource(crlf);
    expect(parsedCrlf.ok).toBe(true);
    if (!parsedCrlf.ok) return;
    expect(parsedCrlf.body).toBe("body line\r\n");
    expect(serializeMemoryConcept(parsedCrlf)).toBe(crlf);

    const eof = "---\ntype: X\n---";
    const parsedEof = parseMemoryConceptSource(eof);
    expect(parsedEof.ok).toBe(true);
    if (!parsedEof.ok) return;
    expect(parsedEof.body).toBe("");
    expect(serializeMemoryConcept(parsedEof)).toBe(eof);
  });

  it("treats a delimiter-like line inside the body as body bytes", () => {
    const source = "---\ntype: X\n---\nabove\n---\nbelow\n";
    const parsed = parseMemoryConceptSource(source);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.body).toBe("above\n---\nbelow\n");
  });

  it("parses an empty body", () => {
    const parsed = parseMemoryConceptSource("---\ntype: X\n---\n");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.body).toBe("");
  });
});
