/**
 * Regression coverage for plugin page skill level filters.
 *
 * Asserts the SkillsScreen level-filter array source contains an "agent" entry.
 *
 * Source-text assertion (rather than RSC render) because:
 *   1. plugin-pages.tsx is a server component with `cookies()` + DB calls in
 *      transitive paths — full render would require ~200 lines of mocks.
 *   2. The contract under test is "the array literal contains 'agent'" —
 *      the array is static at module load time and trivially observable from
 *      the source text. Once the array entry exists, the URL filter already
 *      evaluates `skill.level === levelFilter` automatically.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

vi.mock("server-only", () => ({}));

describe("plugin-pages levelFilterOptions contains Agent entry", () => {
  it("source text contains an array entry with value:\"agent\" and label:\"Agents\"", () => {
    const src = readFileSync(
      path.join(__dirname, "plugin-pages.tsx"),
      "utf8",
    );
    expect(src).toMatch(/value:\s*"agent"/);
    expect(src).toMatch(/label:\s*"Agents"/);
  });

  it("levelFilterOptions array still contains the legacy entries (regression)", () => {
    const src = readFileSync(
      path.join(__dirname, "plugin-pages.tsx"),
      "utf8",
    );
    // Sanity — make sure the new entry was added without deleting an old one.
    expect(src).toMatch(/value:\s*"personal"/);
    // GitHub-installed extensions surface under their own level + the isCustom
    // flag, so the remaining canonical entries still need direct coverage.
    expect(src).toMatch(/value:\s*"organization"/);
    expect(src).toMatch(/value:\s*"team"/);
  });
});

describe("Workspace + Project filter options", () => {
  const src = readFileSync(
    path.join(__dirname, "plugin-pages.tsx"),
    "utf8",
  );

  it("levelFilterOptions contains workspace entry", () => {
    expect(src).toMatch(/value:\s*"workspace"/);
    expect(src).toMatch(/label:\s*"Workspace"/);
  });

  it("levelFilterOptions contains project entry", () => {
    expect(src).toMatch(/value:\s*"project"/);
    expect(src).toMatch(/label:\s*"Projects"/);
  });

  it("plugin-pages imports ScopeBadge from @/components/scope-badge", () => {
    expect(src).toMatch(/from\s+["']@\/components\/scope-badge["']/);
    expect(src).toMatch(/\bScopeBadge\b/);
  });

  it("inline level-badge span with hardcoded violet palette has been replaced", () => {
    // The inline `border-violet-200 bg-violet-50 text-violet-700` literal must
    // not appear in plugin-pages.tsx anymore; palette ownership lives in ScopeBadge.
    // Strip JS comments first so a stray comment can't hide a regression.
    const codeOnly = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(codeOnly).not.toMatch(/border-violet-200/);
  });
});
