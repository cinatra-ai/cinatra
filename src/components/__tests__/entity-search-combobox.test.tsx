/**
 * Source-text contract test for EntitySearchCombobox (cinatra#1509 §4.0-b).
 * Component tests in this repo lock wiring via source-file text assertions
 * (mirrors the access-combobox-*.test.tsx family); the BEHAVIOUR of the pure
 * debounce / pagination / exclusion reducers is exercised in
 * entity-search-combobox-reducer.test.ts.
 *
 * Truths locked here (the §3.4 / §3.5 interaction + perf contract this shared
 * component must own so its adopters inherit them for free):
 *  - the presentational prop contract (onSearch / onPick / renderRow / etc.)
 *  - debounce via the pure entitySearchDebounceMs (0 ms open / 300 ms typing)
 *  - stale-result ignoring (the `cancelled` flag)
 *  - an EXPLICIT error row ("Couldn't search — try again.") DISTINCT from the
 *    empty state ("No matches.") — the panels' silent failure→empty coercion is
 *    fixed here
 *  - a loading row (Loader2 + "Searching…")
 *  - optional lazy pagination (onScroll → mergeEntityPages, limit 20 default)
 *  - the cmdk background-specificity overrides (bg-surface-strong on
 *    PopoverContent / Command / CommandList / CommandItem)
 *  - Input-anchored focus (onOpenAutoFocus prevented → focus stays in the Input)
 *  - shouldFilter={false} (server-side filtering)
 *  - module loads without throwing (import/type drift smoke)
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as Mod from "@/components/entity-search-combobox";

const SOURCE = readFileSync("src/components/entity-search-combobox.tsx", "utf-8");

describe("EntitySearchCombobox", () => {
  it("module loads and exports the component + the pure reducers", () => {
    expect(typeof Mod.EntitySearchCombobox).toBe("function");
    expect(typeof Mod.entitySearchDebounceMs).toBe("function");
    expect(typeof Mod.mergeEntityPages).toBe("function");
    expect(typeof Mod.visibleEntityResults).toBe("function");
  });

  it("exposes the presentational prop contract (onSearch / onPick / renderRow)", () => {
    expect(SOURCE).toMatch(/onSearch:\s*\(/);
    expect(SOURCE).toMatch(/onPick:\s*\(item:\s*T\)\s*=>\s*void/);
    expect(SOURCE).toMatch(/renderRow\?:\s*\(item:\s*T\)\s*=>\s*React\.ReactNode/);
    expect(SOURCE).toMatch(/excludeIds\?:\s*readonly string\[\]/);
    expect(SOURCE).toMatch(/pageSize\?:\s*number/);
  });

  it("debounces via the pure entitySearchDebounceMs (0 ms open / 300 ms typing)", () => {
    expect(Mod.entitySearchDebounceMs("")).toBe(0);
    expect(Mod.entitySearchDebounceMs("x")).toBe(300);
    expect(SOURCE).toMatch(/entitySearchDebounceMs\(query\)/);
    expect(SOURCE).toMatch(/window\.setTimeout/);
  });

  it("ignores stale / out-of-order responses via a cancelled flag (§3.4)", () => {
    expect(SOURCE).toMatch(/let cancelled = false/);
    expect(SOURCE).toMatch(/if \(cancelled\) return/);
    expect(SOURCE).toMatch(/cancelled = true/);
  });

  it("renders an EXPLICIT error row distinct from the empty state (§3.4)", () => {
    expect(SOURCE).toMatch(/Couldn&apos;t search — try again\./);
    expect(SOURCE).toMatch(/setError\(true\)/);
    // The error branch is gated separately from CommandEmpty, so a failure is
    // never coerced to "No matches.".
    expect(SOURCE).toMatch(/\{error &&/);
    expect(SOURCE).toMatch(/!error && !searching && visibleResults\.length === 0/);
    expect(SOURCE).toMatch(/<CommandEmpty>\{emptyText\}<\/CommandEmpty>/);
  });

  it("renders a loading row (Loader2 + Searching…)", () => {
    expect(SOURCE).toMatch(/import \{ Loader2 \} from "lucide-react"/);
    expect(SOURCE).toMatch(/Searching…/);
  });

  it("supports optional lazy pagination (onScroll → mergeEntityPages, limit 20)", () => {
    expect(SOURCE).toMatch(/onScroll=\{handleListScroll\}/);
    expect(SOURCE).toMatch(/mergeEntityPages\(prev,\s*result\.results\)/);
    expect(SOURCE).toMatch(/DEFAULT_PAGE_SIZE = 20/);
    expect(SOURCE).toMatch(/hasMore/);
    expect(SOURCE).toMatch(/Loading more…/);
  });

  it("applies the cmdk background-specificity overrides on every cmdk node (Pitfall 5)", () => {
    // PopoverContent + Command + CommandList + CommandItem each carry
    // bg-surface-strong; at least 3 distinct bg-surface-strong applications.
    const overrides = SOURCE.match(/bg-surface-strong/g) ?? [];
    expect(overrides.length).toBeGreaterThanOrEqual(4);
    expect(SOURCE).toMatch(/shouldFilter=\{false\}/);
  });

  it("keeps focus in the anchoring Input on open (§3.4 Input-anchored typeahead)", () => {
    expect(SOURCE).toMatch(/PopoverAnchor/);
    expect(SOURCE).toMatch(/onOpenAutoFocus=\{\(e\)\s*=>\s*e\.preventDefault\(\)\}/);
  });

  it("caps the popover width to the viewport gutter (§3.5 mobile geometry)", () => {
    expect(SOURCE).toMatch(/max-w-\[min\(28rem,calc\(100vw-2rem\)\)\]/);
  });
});
