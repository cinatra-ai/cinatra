// THE LIST ROW'S TYPE-SPECIFIC REGION (cinatra#3319, acceptance 5).
//
// "The list row: the uniform row shell may stay core chrome, but its
//  type-specific `listRow` region never falls to a core icon; extension or base
//  coverage is required, or an explicit maintainer exception is recorded for
//  generic row glyphs."
//
// Measured over the WHOLE pinned fleet, not over a sample: for every artifact
// type an installed pack declares, the region is either covered by a `listRow`
// display this build can mount, or admitted by the recorded exception. A type
// that is neither is the state this gate exists to refuse — core drawing a
// type's glyph with nothing written down to say why.
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { GENERATED_ARTIFACT_RENDERERS } from "@/lib/generated/artifact-renderers";

import {
  GENERIC_ROW_GLYPH_EXCEPTION,
  listRowGlyphCoverage,
} from "../list-row-glyph-coverage";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const FLEET = join(REPO_ROOT, "extensions", "cinatra-ai");

/** Every (objectType, declaring pack) the materialized fleet declares. */
function fleetTypes(): Array<{ type: string; packageName: string }> {
  const rows: Array<{ type: string; packageName: string }> = [];
  if (!existsSync(FLEET)) return rows;
  for (const dir of readdirSync(FLEET)) {
    const manifest = join(FLEET, dir, "package.json");
    if (!existsSync(manifest)) continue;
    let pkg: {
      name?: string;
      cinatra?: { kind?: string; artifact?: { objectTypes?: Array<{ type?: string }> } };
    };
    try {
      pkg = JSON.parse(readFileSync(manifest, "utf8"));
    } catch {
      continue;
    }
    if (pkg.cinatra?.kind !== "artifact" || !pkg.name) continue;
    for (const t of pkg.cinatra.artifact?.objectTypes ?? []) {
      if (t?.type) rows.push({ type: t.type, packageName: pkg.name });
    }
  }
  return rows;
}

const TYPES = fleetTypes();

describe("acceptance 5 — every fleet type's glyph region is covered or recorded", () => {
  it("the fleet is materialized (an empty fleet would prove nothing)", () => {
    expect(TYPES.length).toBeGreaterThan(0);
  });

  it("no type falls to a core icon with nothing recorded", () => {
    const uncovered = TYPES.filter(
      ({ type, packageName }) =>
        listRowGlyphCoverage({
          objectType: type,
          hasMountableListRowDisplay: `${packageName}::listRow` in GENERATED_ARTIFACT_RENDERERS,
        }) === "uncovered",
    ).map((t) => t.type);
    expect(uncovered).toEqual([]);
  });

  it("a type whose pack ships a mountable listRow display is covered BY THE DISPLAY, not by the exception", () => {
    expect(
      listRowGlyphCoverage({ objectType: "@example/pack:thing", hasMountableListRowDisplay: true }),
    ).toBe("extension");
  });

  it("the exception is explicit and carries its reason", () => {
    expect(GENERIC_ROW_GLYPH_EXCEPTION.appliesToEveryInstalledType).toBe(true);
    expect(GENERIC_ROW_GLYPH_EXCEPTION.reason.length).toBeGreaterThan(20);
  });
});

describe("acceptance 5 — the row component draws the generic glyph UNDER the record", () => {
  it("the glyph cell reads its coverage from the record rather than defaulting silently", () => {
    const component = readFileSync(join(REPO_ROOT, "src/components/artifacts/library-row-glyph.tsx"), "utf8");
    expect(component).toMatch(/listRowGlyphCoverage\(/);
    expect(component).toMatch(/from "\.\/list-row-glyph-coverage"/);
  });
});
