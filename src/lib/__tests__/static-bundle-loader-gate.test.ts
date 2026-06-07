import { describe, it, expect } from "vitest";
import { gateRetiredStaticRecords } from "@/lib/static-bundle-loader";

// Split-brain guard — the StaticBundleLoader explicit-retired-row
// gate. A record is dropped ONLY when its package's effective canonical status
// is "archived" (has rows, none live). "No row" (absent from the map) and
// "active" both KEEP the record — bundled extensions are not necessarily
// lifecycle-tracked yet, so absence must not be read as retirement.

const recs = [
  { packageName: "@cinatra-ai/resend-connector" },
  { packageName: "@cinatra-ai/google-calendar-connector" },
  { packageName: "@cinatra-ai/some-archived-ext" },
  { packageName: "@cinatra-ai/some-active-ext" },
];

describe("gateRetiredStaticRecords", () => {
  it("keeps packages with NO canonical rows (not lifecycle-tracked OR hard-deleted → kept)", () => {
    // Empty map = the real-world case today: neither serverEntry connector has a
    // row. KNOWN LIMITATION locked in here: a HARD uninstall deletes the manifest
    // rows, so a hard-uninstalled package is also "no row" and is KEPT (would
    // re-register on boot) until connector manifests are reconciled. The gate
    // only suppresses ARCHIVED (tombstoned) rows, never absent ones.
    const { active, skipped } = gateRetiredStaticRecords(recs, new Map());
    expect(skipped).toEqual([]);
    expect(active.map((r) => r.packageName)).toEqual(recs.map((r) => r.packageName));
  });

  it("skips ONLY packages whose effective status is 'archived'", () => {
    const status = new Map<string, "active" | "archived">([
      ["@cinatra-ai/some-archived-ext", "archived"],
      ["@cinatra-ai/some-active-ext", "active"],
      // resend + gcal absent (no rows) → kept
    ]);
    const { active, skipped } = gateRetiredStaticRecords(recs, status);
    expect(skipped).toEqual(["@cinatra-ai/some-archived-ext"]);
    expect(active.map((r) => r.packageName)).toEqual([
      "@cinatra-ai/resend-connector",
      "@cinatra-ai/google-calendar-connector",
      "@cinatra-ai/some-active-ext",
    ]);
  });

  it("keeps an 'active' package (any live row → keep)", () => {
    const status = new Map<string, "active" | "archived">([
      ["@cinatra-ai/some-active-ext", "active"],
    ]);
    const { active, skipped } = gateRetiredStaticRecords(
      [{ packageName: "@cinatra-ai/some-active-ext" }],
      status,
    );
    expect(skipped).toEqual([]);
    expect(active).toHaveLength(1);
  });

  it("empty record list → empty result", () => {
    const { active, skipped } = gateRetiredStaticRecords([], new Map());
    expect(active).toEqual([]);
    expect(skipped).toEqual([]);
  });
});
