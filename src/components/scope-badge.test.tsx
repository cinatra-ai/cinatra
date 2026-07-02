import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

describe("ScopeBadge component contract", () => {
  const src = readFileSync(
    path.join(__dirname, "scope-badge.tsx"),
    "utf8",
  );

  it("exports the ScopeBadge component", () => {
    expect(src).toMatch(/export function ScopeBadge/);
  });

  it("exports the ScopeLevel type with all 5 variants", () => {
    expect(src).toMatch(/export type ScopeLevel\s*=/);
    expect(src).toMatch(/"user"/);
    expect(src).toMatch(/"team"/);
    expect(src).toMatch(/"organization"/);
    expect(src).toMatch(/"workspace"/);
    expect(src).toMatch(/"project"/);
  });

  it("uses cva from class-variance-authority", () => {
    expect(src).toMatch(/from "class-variance-authority"/);
    expect(src).toMatch(/cva\(/);
  });

  it("uses the extended cn from @cinatra-ai/sdk-ui (custom size tokens survive tailwind-merge)", () => {
    expect(src).toMatch(/from "@cinatra-ai\/sdk-ui\/lib\/utils"/);
    expect(src).toMatch(/\bcn\(/);
  });

  it("includes the user level palette (sky-200/sky-50/sky-700)", () => {
    expect(src).toMatch(/border-sky-200/);
    expect(src).toMatch(/bg-sky-50/);
    expect(src).toMatch(/text-sky-700/);
  });

  it("includes the team level palette (emerald-200/emerald-50/emerald-700)", () => {
    expect(src).toMatch(/border-emerald-200/);
    expect(src).toMatch(/bg-emerald-50/);
    expect(src).toMatch(/text-emerald-700/);
  });

  it("includes the organization level palette (violet-200/violet-50/violet-700)", () => {
    expect(src).toMatch(/border-violet-200/);
    expect(src).toMatch(/bg-violet-50/);
    expect(src).toMatch(/text-violet-700/);
  });

  it("includes the workspace level palette (amber-200/amber-50/amber-700)", () => {
    expect(src).toMatch(/border-amber-200/);
    expect(src).toMatch(/bg-amber-50/);
    expect(src).toMatch(/text-amber-700/);
  });

  it("includes the project level using semantic tokens (border-line + bg-surface-strong)", () => {
    expect(src).toMatch(/border-line/);
    expect(src).toMatch(/bg-surface-strong/);
    expect(src).toMatch(/text-foreground/);
  });

  it("uses the canonical badge wrapper classes from UI-SPEC", () => {
    // Per 202-UI-SPEC §Component Inventory — must include these exact utility classes
    expect(src).toMatch(/inline-flex/);
    expect(src).toMatch(/items-center/);
    expect(src).toMatch(/rounded-full/);
    expect(src).toMatch(/px-2\.5/);
    expect(src).toMatch(/py-0\.5/);
    expect(src).toMatch(/text-badge-xs/); // 10px badge size via the named design token
    expect(src).toMatch(/font-semibold/);
    expect(src).toMatch(/uppercase/);
    expect(src).toMatch(/tracking-\[0\.15em\]/);
  });
});
