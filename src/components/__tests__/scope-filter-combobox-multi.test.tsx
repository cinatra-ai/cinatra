/**
 * Source-text contract test for the multi-select scope-FILTER writers
 * (cinatra#1074, multi-scope W5 UI half): the shared <ScopeFilterCombobox>
 * (/connectors) and the <SkillsToolbar> scope picker (/skills). Mirrors the
 * sibling access-combobox-multi-*.test.tsx convention (source-text —
 * @testing-library/react is not available from the root package.json); the
 * BEHAVIOUR of the filter toggle/row-state/serializer logic is covered by
 * real unit tests in src/lib/__tests__/scope-filter.test.ts.
 *
 * Truths locked here, per writer:
 *  - the picker mounts in `multiple` mode with the FILTER-mode overrides
 *    (toggleScopeFilterComboboxValue / scopeFilterComboboxRowState), NOT the
 *    grant-mode canonicalisation
 *  - the URL write goes through the canonical serializeScopeFilterTokens and
 *    DELETES the param for the default (cleared) selection
 *  - toggles compose against an OPTIMISTIC local selection reconciled from
 *    the server-resolved prop (adjust-during-render — a second toggle fired
 *    before the navigation commits must not drop the first; codex round-1),
 *    and the optimistic update happens BEFORE the navigation push
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const COMBOBOX = readFileSync("src/components/scope-filter-combobox.tsx", "utf-8");
const TOOLBAR = readFileSync("packages/skills/src/skills-toolbar.tsx", "utf-8");

describe("ScopeFilterCombobox multi-select writer (cinatra#1074 W5)", () => {
  it("mounts the picker in multiple mode with the FILTER-mode overrides", () => {
    expect(COMBOBOX).toMatch(/<AccessCombobox[\s\S]*?selectionMode="multiple"/);
    expect(COMBOBOX).toMatch(/toggleSelection=\{toggleScopeFilterComboboxValue\}/);
    expect(COMBOBOX).toMatch(/rowState=\{scopeFilterComboboxRowState\}/);
    // No grant-mode toggle import may creep in.
    expect(COMBOBOX).not.toMatch(/toggleAccessSelection/);
  });

  it("writes the comma-joined selection via the canonical serializer, deleting the default", () => {
    expect(COMBOBOX).toMatch(/serializeScopeFilterTokens\(tokens\)/);
    expect(COMBOBOX).toMatch(/params\.delete\(paramName\)/);
    expect(COMBOBOX).toMatch(/params\.set\(paramName,\s*serialized\)/);
  });

  it("toggles compose against an optimistic local selection, updated BEFORE the push", () => {
    expect(COMBOBOX).toMatch(/const \[selection, setSelection\] = useState/);
    // reconcile-during-render on server-value change (no setState-in-effect)
    expect(COMBOBOX).toMatch(/if \(syncedKey !== serverKey\) \{\s*\n\s*setSyncedKey\(serverKey\);\s*\n\s*setSelection\(value\);/);
    const handleChange = COMBOBOX.slice(COMBOBOX.indexOf("function handleChange"));
    expect(handleChange.indexOf("setSelection(tokens)")).toBeGreaterThan(-1);
    expect(handleChange.indexOf("setSelection(tokens)")).toBeLessThan(handleChange.indexOf("router.push"));
    // the picker renders the optimistic selection, not the raw server prop
    expect(COMBOBOX).toMatch(/value=\{selection\.map\(scopeTokenToComboboxValue\)\}/);
  });
});

describe("SkillsToolbar multi-select scope writer (cinatra#1074 W5)", () => {
  it("mounts the picker in multiple mode with the FILTER-mode overrides", () => {
    expect(TOOLBAR).toMatch(/<AccessCombobox[\s\S]*?selectionMode="multiple"/);
    expect(TOOLBAR).toMatch(/toggleSelection=\{toggleScopeFilterComboboxValue\}/);
    expect(TOOLBAR).toMatch(/rowState=\{scopeFilterComboboxRowState\}/);
    expect(TOOLBAR).not.toMatch(/toggleAccessSelection/);
  });

  it("writes through pushWith + the canonical serializer (param drops on default)", () => {
    // pushWith deletes the key for a null value — the serializer returns null
    // for the default (cleared) selection.
    expect(TOOLBAR).toMatch(/pushWith\(\{ scope: serializeScopeFilterTokens\(tokens\) \}\)/);
  });

  it("toggles compose against an optimistic local selection, updated BEFORE the push", () => {
    expect(TOOLBAR).toMatch(/const \[scopeSelection, setScopeSelection\] = useState/);
    expect(TOOLBAR).toMatch(/if \(scopeSyncedKey !== scopeServerKey\) \{\s*\n\s*setScopeSyncedKey\(scopeServerKey\);\s*\n\s*setScopeSelection\(scopeValue\);/);
    const selectScope = TOOLBAR.slice(TOOLBAR.indexOf("function selectScope"));
    expect(selectScope.indexOf("setScopeSelection(tokens)")).toBeGreaterThan(-1);
    expect(selectScope.indexOf("setScopeSelection(tokens)")).toBeLessThan(selectScope.indexOf("pushWith"));
    expect(TOOLBAR).toMatch(/value=\{scopeSelection\.map\(scopeTokenToComboboxValue\)\}/);
  });
});
