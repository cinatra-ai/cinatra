import { describe, expect, it } from "vitest";

import {
  evaluateSchemaVersion,
  maxAppliedCoreSeq,
  maxShippedCoreSeq,
} from "@/lib/boot/schema-version-precondition";

// ---------------------------------------------------------------------------
// Schema-version precondition (cinatra#789 item 4). Compares the MAX applied core
// migration (from the ledger, names WITHOUT .mjs) to the MAX shipped core migration
// (on-disk filenames, WITH .mjs). A ledger BEHIND the image aborts a prod boot clearly.
// ---------------------------------------------------------------------------

describe("maxAppliedCoreSeq (ledger names have NO .mjs)", () => {
  it("parses the highest core__NNNN sequence from ledger rows", () => {
    const names = [
      "core__0001_notifications-dedupe-key",
      "core__0012_drop-gtm-normalization",
      "core__0007_agent-run-pm-links",
    ];
    expect(maxAppliedCoreSeq(names)).toBe(12);
  });

  it("ignores non-core (extension) ledger rows", () => {
    const names = ["core__0003_x", "ext_openai__0001_y", "ext_foo__0009_z"];
    expect(maxAppliedCoreSeq(names)).toBe(3);
  });

  it("returns -1 when no core rows are applied", () => {
    expect(maxAppliedCoreSeq([])).toBe(-1);
    expect(maxAppliedCoreSeq(["ext_a__0001_x"])).toBe(-1);
  });

  it("parses a real ledger name (no .mjs extension — the ledger contract)", () => {
    // Ledger rows store the filename WITHOUT .mjs; the leading core__NNNN_ is parsed.
    expect(maxAppliedCoreSeq(["core__0005_extension-install-ops-append-only"])).toBe(5);
  });
});

describe("maxShippedCoreSeq (file names WITH .mjs)", () => {
  it("parses the highest sequence from on-disk migration filenames", () => {
    const files = [
      "core__0001_notifications-dedupe-key.mjs",
      "core__0012_drop-gtm-normalization.mjs",
      "README.md",
      ".DS_Store",
    ];
    expect(maxShippedCoreSeq(files)).toBe(12);
  });

  it("returns -1 when no shipped core files parse", () => {
    expect(maxShippedCoreSeq(["README.md"])).toBe(-1);
  });
});

describe("evaluateSchemaVersion", () => {
  const shipped = [
    "core__0001_a.mjs",
    "core__0002_b.mjs",
    "core__0003_c.mjs",
  ];

  it("ok when applied == shipped (normal prod path after core-migrations ran up)", () => {
    const v = evaluateSchemaVersion(
      ["core__0001_a", "core__0002_b", "core__0003_c"],
      shipped,
    );
    expect(v.kind).toBe("ok");
  });

  it("ok when applied > shipped (image rolled back below the DB)", () => {
    // A DB ahead of the image is not a 'behind' failure for this check.
    const v = evaluateSchemaVersion(
      ["core__0001_a", "core__0002_b", "core__0003_c", "core__0004_d"],
      shipped,
    );
    expect(v.kind).toBe("ok");
  });

  it("behind (actionable message) when the ledger is behind the image", () => {
    const v = evaluateSchemaVersion(["core__0001_a"], shipped);
    expect(v.kind).toBe("behind");
    if (v.kind === "behind") {
      expect(v.appliedMax).toBe(1);
      expect(v.shippedMax).toBe(3);
      expect(v.message).toMatch(/BEHIND/);
      expect(v.message).toMatch(/core__0001/);
      expect(v.message).toMatch(/core__0003/);
      expect(v.message).toMatch(/cinatra db migrate/);
    }
  });

  it("behind with a clear label when NO core migrations are applied yet", () => {
    const v = evaluateSchemaVersion([], shipped);
    expect(v.kind).toBe("behind");
    if (v.kind === "behind") {
      expect(v.message).toMatch(/no core migrations applied/);
    }
  });

  it("no-shipped-migrations when the image has no parseable core files (nothing to assert)", () => {
    const v = evaluateSchemaVersion(["core__0001_a"], ["README.md"]);
    expect(v.kind).toBe("no-shipped-migrations");
  });
});
