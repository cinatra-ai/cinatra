/**
 * Source-text contract test for the access-picker design fixture
 * (cinatra#1509 §4.1 — the flat-picker cases added for #1508, alongside the
 * pre-existing #1072 multi-select cases).
 *
 * Locks:
 *  - the fixture still mounts the REAL components (both pickers)
 *  - the original W3 multi-select cases keep their testids (conformance
 *    testids are contract — tests/e2e/design/conformance/README.md)
 *  - the four flat cases exist: default, open-with-selection (interactive,
 *    serialized live value), missing-team selection (Unknown-team synthesis),
 *    disabled rows (+ tooltip reasons, non-admin workspace lock)
 *  - the missing-team case uses an id that is genuinely absent from the seed
 *
 * Plus a static render smoke so the fixture stays SSR-renderable (the route
 * is force-dynamic; a render crash would 500 the fixture for the owner).
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AccessPickerFixture } from "../access-picker-fixture";

const SOURCE = readFileSync(
  "src/app/design-fixtures/access-picker/access-picker-fixture.tsx",
  "utf-8",
);

describe("access-picker fixture — flat-picker cases (#1508)", () => {
  it("mounts the real components for both pickers", () => {
    expect(SOURCE).toMatch(/from "@\/components\/access-combobox-hierarchical"/);
    expect(SOURCE).toMatch(/from "@\/components\/access-combobox"/);
  });

  it("keeps the original multi-select case testids stable", () => {
    for (const id of [
      "picker-live",
      "picker-live-value",
      "picker-owner",
      "picker-single-team",
      "picker-multi",
      "picker-workspace",
    ]) {
      expect(SOURCE).toContain(`"${id}"`);
    }
  });

  it("adds the four flat-picker cases", () => {
    for (const id of [
      "flat-default",
      "flat-open-with-selection",
      "flat-missing-team",
      "flat-disabled-rows",
    ]) {
      expect(SOURCE).toContain(`"${id}"`);
    }
    // The interactive case serializes its live value for Playwright.
    expect(SOURCE).toContain('data-testid="flat-live-value"');
  });

  it("missing-team case selects an id absent from the seeded teams", () => {
    const missing = SOURCE.match(/value="team:([\w-]+)"/)?.[1];
    expect(missing).toBeTruthy();
    // The id must NOT exist in the flat seed's team list.
    const flatSeed = SOURCE.match(/FLAT_SEED_SCOPES[\s\S]*?\};/)?.[0] ?? "";
    expect(flatSeed).not.toContain(`"${missing}"`);
  });

  it("disabled-rows case wires disabledScopes + disabledReasons and the non-admin lock", () => {
    expect(SOURCE).toMatch(/disabledScopes=\{\[/);
    expect(SOURCE).toMatch(/disabledReasons=\{\{/);
    expect(SOURCE).toMatch(/isAdmin=\{false\}/);
  });

  it("renders statically without crashing and shows the Unknown-team trigger fallback", () => {
    const html = renderToStaticMarkup(<AccessPickerFixture />);
    expect(html).toContain('data-testid="flat-default"');
    expect(html).toContain('data-testid="flat-open-with-selection"');
    expect(html).toContain('data-testid="flat-missing-team"');
    expect(html).toContain('data-testid="flat-disabled-rows"');
    // Unhydrated selection reads "Unknown team" on the closed trigger — never
    // the raw id or a truncated suffix (#1508).
    expect(html).toContain("Unknown team");
    expect(html).not.toContain("team-gone");
    // The selected-team case hydrates by name.
    expect(html).toContain("Revenue");
  });
});
