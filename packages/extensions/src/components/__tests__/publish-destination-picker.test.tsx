// PublishDestinationPicker static contract tests.
//
// Strategy: source-grep assertions (same pattern as packages/agents pages.test.tsx
// and src/components/scope-badge.test.tsx). The extensions vitest config uses
// environment: "node" — RTL rendering is not available in this package sandbox.
// Static assertions verify the component behavior contract without requiring
// jsdom.
//
// Test 1: Both radios render when privateDestinationConfigured: true
//   → source contains RadioGroupItem with value="private" and value="public"
// Test 2: Private radio hidden (NOT disabled) when not configured; notice renders
//   → source branches on !privateDestinationConfigured to return notice, not disabled radio
// Test 3: Hint text "Switch to public to share with all Cinatra instances." present
//   → source contains exact copy string
// Test 4: onValueChange called when radio value changes
//   → source wires onValueChange into RadioGroup onValueChange
// Test 5: idPrefix used for aria uniqueness
//   → source generates element ids from idPrefix

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import * as path from "node:path";

const srcPath = path.resolve(
  __dirname,
  "..",
  "publish-destination-picker.tsx",
);

function readSource(): string {
  return readFileSync(srcPath, "utf8");
}

describe("PublishDestinationPicker static contract", () => {
  it("Test 1: exports PublishDestinationPicker as a named export", () => {
    expect(readSource()).toMatch(/export function PublishDestinationPicker/);
  });

  it("Test 1: renders RadioGroupItem with value='private' and value='public' when configured", () => {
    const src = readSource();
    // Both radio items must be present in the configured branch
    expect(src).toMatch(/RadioGroupItem[^>]+value="private"/);
    expect(src).toMatch(/RadioGroupItem[^>]+value="public"/);
  });

  it("Test 2: hides Private radio when privateDestinationConfigured is false (branch returns early with notice)", () => {
    const src = readSource();
    // Must branch on !privateDestinationConfigured and return before rendering RadioGroup
    expect(src).toMatch(/if\s*\(!privateDestinationConfigured\)/);
    // The notice text is the locked copy string
    expect(src).toMatch(/Private publish destination not yet configured — contact your admin\./);
    // The early-return branch must NOT have a disabled RadioGroupItem — verify the
    // if-block content (between if-check and its closing brace) has no RadioGroupItem.
    const ifBlockStart = src.indexOf("if (!privateDestinationConfigured)");
    // Extract the early-return block by finding the matching return statement content
    // (the return inside the if — before the next top-level return)
    const earlyReturn = src.slice(ifBlockStart, ifBlockStart + 500);
    expect(earlyReturn).not.toMatch(/disabled/);
    expect(earlyReturn).not.toMatch(/RadioGroupItem/);
  });

  it("Test 3: verbatim hint text 'Switch to public to share with all Cinatra instances.' is present", () => {
    expect(readSource()).toMatch(
      /Switch to public to share with all Cinatra instances\./,
    );
  });

  it("Test 3: hint text is conditional on value === 'private'", () => {
    // The hint renders only inside {value === "private" && (...)}
    expect(readSource()).toMatch(/value\s*===\s*"private"/);
  });

  it("Test 4: onValueChange is wired into the RadioGroup onValueChange prop", () => {
    const src = readSource();
    // RadioGroup must receive an onValueChange prop that calls the component's onValueChange
    expect(src).toMatch(/onValueChange/);
    // The handler must call the passed-in onValueChange
    expect(src).toMatch(/onValueChange\(v as PublishDestination\)/);
  });

  it("Test 5: idPrefix is used to generate element ids for aria uniqueness", () => {
    const src = readSource();
    // idPrefix variable used to build privateId and publicId
    expect(src).toMatch(/idPrefix/);
    expect(src).toMatch(/privateId/);
    expect(src).toMatch(/publicId/);
    expect(src).toMatch(/idPrefix.*private/);
    expect(src).toMatch(/idPrefix.*public/);
  });

  it("Test 5: aria-label or aria-labelledby present on RadioGroup", () => {
    expect(readSource()).toMatch(/aria-label/);
  });

  it("component begins with 'use client' directive", () => {
    const src = readSource();
    expect(src.trimStart().startsWith('"use client"')).toBe(true);
  });

  it("uses shadcn RadioGroup and RadioGroupItem — no raw <input type='radio'>", () => {
    const src = readSource();
    // Must import shadcn RadioGroup
    expect(src).toMatch(/from "@\/components\/ui\/radio-group"/);
    // Must NOT have a raw input type="radio"
    expect(src).not.toMatch(/<input[^>]+type=["']radio["']/);
  });

  it("uses semantic tokens only — no hardcoded color palette classes", () => {
    const src = readSource();
    // Forbidden: raw Tailwind palette like text-gray-*, bg-white, text-slate-*
    expect(src).not.toMatch(/text-gray-\d+|bg-white|text-slate-\d+|text-zinc-\d+/);
  });

  it("exports PublishDestination type", () => {
    expect(readSource()).toMatch(/export type PublishDestination\s*=/);
  });

  it("exports PublishDestinationPickerProps type", () => {
    expect(readSource()).toMatch(/export type PublishDestinationPickerProps\s*=/);
  });
});
