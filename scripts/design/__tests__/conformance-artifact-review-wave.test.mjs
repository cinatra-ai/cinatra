// The W2 coverage record for the artifact-review drawing's artifact-kind display
// surfaces (cinatra#3158, epic cinatra#3155).
//
// The functional-acceptance suite is a Playwright suite: the claim "every surface
// this wave lists has a real driver, and none stays unmapped" is only ever proved
// by it on a browser run, on a boot, behind a build. That is the right place for
// the ASSERTIONS. It is the wrong place for the wave's own arithmetic — whether a
// surface was forgotten, whether a row silently stopped matching the drawing it
// claims to drive, whether the shrink-only ratchet was widened to make a wave look
// finished. Those are answerable from the committed bytes alone, and a reader
// should not have to boot anything to answer them.
//
// So this file checks the wave against the drawing, without a browser:
//
//   1. The staged manifest declares EXACTLY the surfaces this wave covers, and
//      each row records the drawing's own field source, action outcome and state
//      variants — one for one. A regenerated manifest that renames a field's
//      source or drops a state goes red HERE, in the wave that claimed to cover
//      it, instead of silently reducing what the drivers assert.
//   2. The three surfaces the wave rides on one shared factory are exactly the
//      three the wave names, and the other eight are not folded into it.
//   3. contract.ts builds its driver map FROM the row list, so being listed is
//      being mapped — there is no second place a surface could be forgotten.
//   4. The ratchet gains nothing: no allowlist entry names one of these surfaces,
//      and this wave does not pin the manifest.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  ARTIFACT_KIND_DISPLAY_ROWS,
  ARTIFACT_KIND_DISPLAY_SURFACES,
} from "../../../tests/e2e/design/conformance/artifact-review-displays.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CONF_DIR = path.join(REPO_ROOT, "tests", "e2e", "design", "conformance");
const MANIFEST_FILE = path.join(CONF_DIR, "manifests", "app-artifact-review.json");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** The three the wave rides on one factory (cinatra#3158's own wording). */
const FACTORY_ONLY = ["markdown-display-tabs", "binary-download-card", "chart-display-only"];

describe("the wave covers the artifact-kind display surfaces of the staged drawing", () => {
  it("lists exactly eleven surfaces, with no repeat", () => {
    expect(new Set(ARTIFACT_KIND_DISPLAY_SURFACES).size).toBe(
      ARTIFACT_KIND_DISPLAY_SURFACES.length,
    );
    expect(ARTIFACT_KIND_DISPLAY_SURFACES.length).toBe(11);
  });

  it("names only surfaces the staged manifest declares", () => {
    const declared = new Set(readJson(MANIFEST_FILE).surfaces.map((s) => s.id));
    const unknown = ARTIFACT_KIND_DISPLAY_SURFACES.filter((id) => !declared.has(id));
    expect(
      unknown,
      `the wave lists ${unknown.join(", ")}, which the staged app-artifact-review manifest does not declare — a driver for a surface the drawing does not have covers nothing.`,
    ).toEqual([]);
  });

  it("records each surface's declarations exactly as the drawing binds them", () => {
    const byId = new Map(readJson(MANIFEST_FILE).surfaces.map((s) => [s.id, s]));
    for (const row of ARTIFACT_KIND_DISPLAY_ROWS) {
      const surface = byId.get(row.surface);
      expect(
        surface.fields.map((f) => ({ name: f.field, source: f.source })),
        `${row.surface}: the wave's recorded field binding no longer matches the drawing's — reconcile the row with the manifest before the drivers claim to assert it.`,
      ).toEqual(row.field === null ? [] : [{ name: row.field.name, source: row.field.source }]);
      expect(
        surface.actions.map((a) => ({ name: a.action, outcome: a.outcome })),
        `${row.surface}: the wave's recorded action no longer matches the drawing's.`,
      ).toEqual(row.action === null ? [] : [{ name: row.action.name, outcome: row.action.outcome }]);
      expect(
        [...surface.states].sort(),
        `${row.surface}: the wave's recorded state variants no longer match the drawing's.`,
      ).toEqual([...row.states].sort());
    }
  });

  it("names, for every surface, what its display is waiting for", () => {
    const silent = ARTIFACT_KIND_DISPLAY_ROWS.filter(
      (row) => typeof row.readiness !== "string" || row.readiness.trim().length < 40,
    ).map((row) => row.surface);
    expect(
      silent,
      `${silent.join(", ")} carries no readiness sentence — a driver whose surface the branch does not have must say what it is waiting for, never skip silently.`,
    ).toEqual([]);
  });
});

describe("one factory for the three surfaces that share one shape", () => {
  it("rides exactly the three the wave names", () => {
    expect(
      ARTIFACT_KIND_DISPLAY_ROWS.filter((r) => r.factoryOnly)
        .map((r) => r.surface)
        .sort(),
      "the shared per-kind display factory must drive markdown-display-tabs, binary-download-card and chart-display-only alone — every other surface carries a drawn structure of its own on top of it.",
    ).toEqual([...FACTORY_ONLY].sort());
  });

  it("folds no other surface into it", () => {
    const folded = ARTIFACT_KIND_DISPLAY_ROWS.filter(
      (r) => r.factoryOnly && !FACTORY_ONLY.includes(r.surface),
    );
    expect(folded.map((r) => r.surface)).toEqual([]);
  });
});

describe("the driver map is built from the row list", () => {
  const contract = readFileSync(path.join(CONF_DIR, "contract.ts"), "utf8");

  it("imports the rows and spreads them into SURFACE_DRIVERS", () => {
    expect(
      contract.includes("ARTIFACT_KIND_DISPLAY_ROWS"),
      "contract.ts no longer builds the artifact-kind display drivers from the row list — a hand-written map is a second place a surface can be forgotten, which is the failure this wave's acceptance forbids.",
    ).toBe(true);
    expect(contract).toContain("artifactKindDisplayDriver");
  });

  // A bare mention of the identifier survives a hand-written map (the identifier
  // can linger in an unused import or a comment). The map must be BUILT by
  // iterating the rows, and no surface may be keyed into it by hand.
  it("constructs the map by iterating the rows, not by hand", () => {
    expect(
      /const ARTIFACT_KIND_DISPLAY_DRIVERS[\s\S]{0,200}ARTIFACT_KIND_DISPLAY_ROWS\.map\(/.test(
        contract,
      ),
      "ARTIFACT_KIND_DISPLAY_DRIVERS must be built by mapping ARTIFACT_KIND_DISPLAY_ROWS — a map whose keys are written out by hand can go out of step with the row list, which is the one thing this wave's shape exists to prevent.",
    ).toBe(true);
    const driversBlock = contract.slice(
      contract.indexOf("const ARTIFACT_KIND_DISPLAY_DRIVERS"),
      contract.indexOf("const NOTIFICATIONS_LIST_DRIVER"),
    );
    const handKeyed = ARTIFACT_KIND_DISPLAY_SURFACES.filter((id) =>
      driversBlock.includes(`"${id}":`),
    );
    expect(
      handKeyed,
      `${handKeyed.join(", ")} is keyed into the driver map by hand — every surface must reach the map through the row list.`,
    ).toEqual([]);
  });

  it("extends exactly the eight non-factory surfaces, exhaustively by type", () => {
    const extrasBlock = contract.slice(
      contract.indexOf("const ARTIFACT_KIND_DISPLAY_EXTRAS"),
      contract.indexOf("function artifactKindDisplayReadiness"),
    );
    const extended = ARTIFACT_KIND_DISPLAY_SURFACES.filter((id) =>
      extrasBlock.includes(`"${id}": (base)`),
    );
    expect(
      [...extended].sort(),
      "every surface that is not factory-only must carry its own drawn structure on top of the family shape.",
    ).toEqual(
      ARTIFACT_KIND_DISPLAY_ROWS.filter((r) => !r.factoryOnly)
        .map((r) => r.surface)
        .sort(),
    );
    expect(
      /const ARTIFACT_KIND_DISPLAY_EXTRAS: Record</.test(contract),
      "the extras map must be a total Record over the eight non-factory-only surfaces (not Partial), so dropping one is a compile error rather than a silently thinner driver.",
    ).toBe(true);
  });
});

describe("the family assertions cannot pass vacuously", () => {
  const contract = readFileSync(path.join(CONF_DIR, "contract.ts"), "utf8");

  it("proves the open reading is drawn before reading its absence of a way out", () => {
    const helper = contract.slice(
      contract.indexOf("function openLiveDashboardOnceContinued"),
      contract.indexOf("const ARTIFACT_KIND_DISPLAY_EXTRAS"),
    );
    expect(
      helper.includes('kindDisplayMount(surface, "populated")'),
      "the open reading's mount must be asserted present before its missing way-out is read as evidence — on an absent mount a zero count proves nothing.",
    ).toBe(true);
  });

  it("forbids a failure line inside any reading of the display", () => {
    const helper = contract.slice(
      contract.indexOf("function kindDisplayState"),
      contract.indexOf("function kindDisplayKindState"),
    );
    expect(
      helper.includes("[role=\"alert\"]"),
      "a failure reports through the app's toast surface, never as a line written into the panel — every reading must assert the display carries no alert of its own.",
    ).toBe(true);
    expect(
      helper.includes('variant === "empty"'),
      "an empty reading draws the named gap, never a blank plate — the empty variant must assert the panel says something.",
    ).toBe(true);
  });
});

describe("the shrink-only ratchet gains nothing from this wave", () => {
  it("no allowlist entry names one of these surfaces", () => {
    const allowlist = readJson(path.join(CONF_DIR, "allowlist.json")).allow;
    const absorbed = allowlist
      .map((e) => e.surface)
      .filter((s) => ARTIFACT_KIND_DISPLAY_SURFACES.includes(s));
    expect(
      absorbed,
      `allowlist.json exempts ${absorbed.join(", ")} — this wave covers every one of its surfaces with a real driver and adds no exemption, whole-surface or aspect-level.`,
    ).toEqual([]);
  });

  it("does not pin the drawing", () => {
    const pins = readJson(path.join(CONF_DIR, "..", "conformance-pins.json"));
    expect(
      pins.manifests.some((m) => m.file === "app-artifact-review.json"),
      "the pin lands once EVERY wave for this drawing is green (epic cinatra#3155, independent pinning) — W2 covers eleven of its forty surfaces, so it must not pin it.",
    ).toBe(false);
  });
});
