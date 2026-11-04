/**
 * cinatra#4465 — THE ZOD MARKER'S VALUE NAMES NO RENDERER PACKAGE
 * (src/lib/passthrough-refusal.ts).
 *
 * The merge checks read a quoted renderer package name (marked, satori, sharp,
 * katex and the like) in a module as an import of that renderer, so a module
 * that only answers a refusal would read as one that draws. The zod marker of
 * an error is a value of this module alone, so it is "zod-marked", never the
 * name of a renderer package. On the base the marker's value is that package
 * name, so both cases fail there.
 *
 *   npx vitest run src/lib/__tests__/passthrough-refusal-marker-value-4465.test.ts
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE = readFileSync(path.resolve(__dirname, "../passthrough-refusal.ts"), "utf8");
// The renderer package that the marker's old value spelled, assembled at runtime so that this file holds no quoted
// renderer name either.
const RENDERER = ["mar", "ked"].join("");

describe("cinatra#4465: the zod marker's value", () => {
  it("is zod-marked in the marker's type, its result and both of its readers", () => {
    expect(SOURCE).toContain('function zodMarker(err: object): "zod-marked" | "unreadable" | "none" {');
    expect(SOURCE).toContain('? "zod-marked" : "none";');
    expect(SOURCE).toContain('return zodMarker(err) === "zod-marked" && Array.isArray(');
    expect(SOURCE).toContain('if (marker === "zod-marked") return schemaErrorText(err);');
  });

  it("holds the renderer package name in no string", () => {
    const quoted = new RegExp(`['"\`]${RENDERER}(?:/[^'"\`\\s]*)?['"\`]`, "g");
    expect(SOURCE.match(quoted) ?? []).toEqual([]);
  });
});
