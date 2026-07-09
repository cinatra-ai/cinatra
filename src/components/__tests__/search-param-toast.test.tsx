/**
 * SearchParamToast — one-shot URL flash-message island.
 *
 * Source-text contract test: this repo's component tests use source-file
 * assertions because @testing-library/react is not available from the root
 * package.json (vitest env is "node"). Locks the StrictMode-safe +
 * remount-safe behavior the detail-page delete-race fix depends on: a
 * server-side redirect sets ?deleted=1 (and ?saved=1), and this island shows
 * the toast exactly once, then strips the consumed param.
 *
 * The island moved into @cinatra-ai/sdk-ui (cinatra#1108) so extension packages
 * can mount it; the source-text assertions read the sdk-ui module, and the
 * `import * as` below proves the host path (`@/components/search-param-toast`)
 * still re-exports the symbol.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import * as SearchParamToastMod from "@/components/search-param-toast";

const SOURCE = readFileSync("packages/sdk-ui/src/search-param-toast.tsx", "utf-8");

describe("SearchParamToast", () => {
  it("module loads and exports the SearchParamToast component", () => {
    expect(typeof SearchParamToastMod.SearchParamToast).toBe("function");
  });

  it("is a client component", () => {
    expect(SOURCE).toMatch(/^"use client";/m);
  });

  it("reads the configured params off the URL", () => {
    expect(SOURCE).toMatch(/useSearchParams\(\)/);
    expect(SOURCE).toMatch(/searchParams\.get\(entry\.param\)/);
  });

  it("guards StrictMode's double effect invocation with a handledKey ref keyed on the param snapshot", () => {
    expect(SOURCE).toMatch(/const handledKey = useRef<string \| null>\(null\)/);
    expect(SOURCE).toMatch(/if \(handledKey\.current === key\) return/);
    expect(SOURCE).toMatch(/handledKey\.current = key/);
    // resets so the same outcome can fire again on a later navigation
    expect(SOURCE).toMatch(/handledKey\.current = null/);
  });

  it("uses a stable toast id so a remount before the URL is cleaned does not double-fire", () => {
    expect(SOURCE).toMatch(/id: `search-param-toast:/);
  });

  it("toasts the server-trusted static message, never the raw URL value (no reflection)", () => {
    expect(SOURCE).toMatch(/toast\[variant\]\(entry\.message,/);
    // The raw param value must not be passed to the toast.
    expect(SOURCE).not.toMatch(/toast\[variant\]\(raw\b/);
  });

  it("strips ONLY the consumed params and preserves the rest, without scrolling", () => {
    expect(SOURCE).toMatch(/for \(const entry of matched\) next\.delete\(entry\.param\)/);
    expect(SOURCE).toMatch(/router\.replace\([\s\S]*?\{ scroll: false \}\)/);
  });
});
