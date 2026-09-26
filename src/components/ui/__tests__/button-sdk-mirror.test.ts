// Button vs its SDK mirror — one recipe, two files (cinatra#3192, fix leg 2).
//
//   pnpm exec vitest run src/components/ui/__tests__/button-sdk-mirror.test.ts
//
// `@cinatra-ai/sdk-ui` ships a copy of the host Button so an extension screen
// draws the host's own primitive. The copy had already drifted before this leg
// — the host recipe had grown the `primary` variant the drawing names and the
// mirror had not — and a drift like that is invisible to every test that
// renders only one of the two. This asserts the thing that must never differ:
// the cva recipe itself, byte for byte. Only the import line above it may
// differ, because the two files resolve `cn` from different places.
//
// The comparison is on SOURCE TEXT rather than on the imported recipes, so it
// cannot be satisfied by two different files that happen to agree for the
// arguments a test thought to pass.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..", "..");
const HOST = join(ROOT, "src", "components", "ui", "button.tsx");
const MIRROR = join(ROOT, "packages", "sdk-ui", "src", "ui", "button.tsx");

/** Everything from the recipe's first line to the closing `)` of the cva call. */
function recipe(file: string): string {
  const source = readFileSync(file, "utf8");
  const start = source.indexOf("const buttonVariants = cva(");
  expect(start, `${file} declares no buttonVariants recipe`).toBeGreaterThan(-1);
  const end = source.indexOf("\n)\n", start);
  expect(end, `${file} has no closing paren for the recipe`).toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

describe("Button — the SDK mirror stays in lockstep with the host primitive", () => {
  it("carries a byte-identical cva recipe", () => {
    expect(recipe(MIRROR)).toBe(recipe(HOST));
  });

  it("spells every variant the drawing names in BOTH files", () => {
    const drawn = ["primary", "default", "outline", "secondary", "destructive", "ghost", "link"];
    for (const file of [HOST, MIRROR]) {
      const source = recipe(file);
      for (const variant of drawn) {
        expect(source, `${file} cannot spell ${variant}`).toMatch(
          new RegExp(`\\n\\s*(?:${variant}|"${variant}"):`),
        );
      }
    }
  });
});
