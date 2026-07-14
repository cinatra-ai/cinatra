import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PKG_ROOT = fileURLToPath(new URL("..", import.meta.url));

/**
 * This package is a pure filesystem library: no LLM/provider clients, no
 * server-only imports, no app or workspace coupling. The only permitted
 * runtime imports are node builtins, the `yaml` parser, and package-local
 * relative modules.
 */
describe("package purity (no LLM, no server-only imports)", () => {
  const sourceFiles = readdirSync(path.join(PKG_ROOT, "src"))
    .filter((f) => f.endsWith(".ts"))
    .map((f) => path.join(PKG_ROOT, "src", f));

  it("has source files to scan", () => {
    expect(sourceFiles.length).toBeGreaterThan(5);
  });

  it("imports only node builtins, yaml, and package-local modules", () => {
    const specifierPattern = /(?:from\s+|import\s*\(\s*)["']([^"']+)["']/g;
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1] ?? "";
        const allowed =
          specifier.startsWith("node:") ||
          specifier === "yaml" ||
          specifier.startsWith("./");
        expect(
          allowed,
          `${path.relative(PKG_ROOT, file)} imports ${JSON.stringify(specifier)}`,
        ).toBe(true);
      }
    }
  });

  it("declares yaml as its only runtime dependency and vitest as its only dev dependency", () => {
    const pkg = JSON.parse(
      readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    expect(Object.keys(pkg.dependencies ?? {})).toEqual(["yaml"]);
    expect(Object.keys(pkg.devDependencies ?? {})).toEqual(["vitest"]);
  });

  it("never imports LLM/provider or server-only modules anywhere in src", () => {
    const banned = [
      "@cinatra-ai/llm",
      "@anthropic-ai/",
      "openai",
      "@google/genai",
      "server-only",
      "next/",
      "@/lib",
    ];
    const specifierPattern = /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["']([^"']+)["']/g;
    for (const file of sourceFiles) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(specifierPattern)) {
        const specifier = match[1] ?? "";
        for (const needle of banned) {
          expect(
            specifier === needle || specifier.startsWith(needle),
            `${path.relative(PKG_ROOT, file)} imports ${JSON.stringify(specifier)} (banned: ${needle})`,
          ).toBe(false);
        }
      }
    }
  });
});
