// The W7 coverage record for the artifact-review drawing's review-target and
// decision-floor surfaces (cinatra#3163, epic cinatra#3155).
//
// The functional-acceptance suite is a Playwright suite: the claim "every surface
// this wave lists has a real driver, and none stays unmapped" is only ever proved
// by it on a browser run, on a boot, behind a build. That is the right place for
// the ASSERTIONS. It is the wrong place for the wave's own arithmetic — whether a
// surface was forgotten, whether a row silently stopped matching the drawing it
// claims to drive, whether a row that says it is drawn today is actually drawn by
// the harness, whether the shrink-only ratchet was widened to make a wave look
// finished. Those are answerable from the committed bytes alone, and a reader
// should not have to boot anything to answer them.
//
// So this file checks the wave against the drawing, without a browser:
//
//   1. The staged manifest declares EXACTLY the surfaces this wave covers, and
//      each row records the drawing's own field sources, action outcomes and
//      state variants — one for one. A regenerated manifest that renames a
//      field's source or drops a state goes red HERE, in the wave that claimed to
//      cover it, instead of silently reducing what the drivers assert.
//   2. The family factory's two parameters — the gate state and the provenance
//      tier — are carried by exactly the rows the drawing gives them to.
//   3. A row that says it is DRAWN TODAY is drawn by the harness page, and a row
//      that is not says in full what it is waiting for. Neither is optional: a
//      silent skip and a false claim of coverage are the two failures this wave's
//      acceptance forbids.
//   4. contract.ts builds its driver map FROM the row list, so being listed is
//      being mapped — there is no second place a surface could be forgotten.
//   5. The ratchet gains nothing: no allowlist entry names one of these surfaces,
//      and this wave does not pin the manifest.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  REVIEW_DECISION_FLOOR,
  REVIEW_DECISION_FLOOR_ROWS,
  REVIEW_DECISION_FLOOR_SURFACES,
} from "../../../tests/e2e/design/conformance/review-decision-floor.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CONF_DIR = path.join(REPO_ROOT, "tests", "e2e", "design", "conformance");
const MANIFEST_FILE = path.join(CONF_DIR, "manifests", "app-artifact-review.json");
const FIXTURES_DIR = path.join(REPO_ROOT, "src", "app", "design-fixtures", "conformance");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** The gate states §VII names, and the provenance tiers §V draws. */
const GATE_STATES = { loading: "review-gate-loading", blocked: "review-gate-blocked", disabled: "review-decision-disabled" };
const PROVENANCE = { native: "review-provenance-native", marketplace: "review-provenance-marketplace", floor: "review-target-floor" };

/** The surfaces this wave draws on the harness itself, and therefore drives for
 *  real rather than writing against a mount that does not exist yet. */
const MOUNTED = ["review-gate-loading", "review-gate-blocked"];

describe("the wave covers the review-target and decision-floor surfaces of the staged drawing", () => {
  it("lists exactly fifteen surfaces, with no repeat", () => {
    expect(new Set(REVIEW_DECISION_FLOOR_SURFACES).size).toBe(
      REVIEW_DECISION_FLOOR_SURFACES.length,
    );
    expect(REVIEW_DECISION_FLOOR_SURFACES.length).toBe(15);
  });

  it("names only surfaces the staged manifest declares", () => {
    const declared = new Set(readJson(MANIFEST_FILE).surfaces.map((s) => s.id));
    const unknown = REVIEW_DECISION_FLOOR_SURFACES.filter((id) => !declared.has(id));
    expect(
      unknown,
      `the wave lists ${unknown.join(", ")}, which the staged app-artifact-review manifest does not declare — a driver for a surface the drawing does not have covers nothing.`,
    ).toEqual([]);
  });

  it("records each surface's declarations exactly as the drawing binds them", () => {
    const byId = new Map(readJson(MANIFEST_FILE).surfaces.map((s) => [s.id, s]));
    for (const row of REVIEW_DECISION_FLOOR_ROWS) {
      const surface = byId.get(row.surface);
      expect(
        surface.fields.map((f) => ({ name: f.field, source: f.source })),
        `${row.surface}: the wave's recorded field bindings no longer match the drawing's — reconcile the row with the manifest before the drivers claim to assert them.`,
      ).toEqual(row.fields.map((f) => ({ name: f.name, source: f.source })));
      expect(
        surface.actions.map((a) => ({ name: a.action, outcome: a.outcome })),
        `${row.surface}: the wave's recorded actions no longer match the drawing's.`,
      ).toEqual(row.actions.map((a) => ({ name: a.name, outcome: a.outcome })));
      expect(
        [...surface.states].sort(),
        `${row.surface}: the wave's recorded state variants no longer match the drawing's.`,
      ).toEqual([...row.states].sort());
    }
  });
});

describe("one factory, parameterized by the gate state and the provenance tier", () => {
  it("carries a gate state on exactly the three surfaces §VII gives one", () => {
    const carried = Object.fromEntries(
      REVIEW_DECISION_FLOOR_ROWS.filter((r) => r.gateState !== null).map((r) => [r.gateState, r.surface]),
    );
    expect(
      carried,
      "the family factory is parameterized by gate state; loading, blocked and disabled are the three §VII names, and no other surface may claim one.",
    ).toEqual(GATE_STATES);
  });

  it("carries a provenance tier on exactly the three readings §V draws", () => {
    const carried = Object.fromEntries(
      REVIEW_DECISION_FLOOR_ROWS.filter((r) => r.provenance !== null).map((r) => [r.provenance, r.surface]),
    );
    expect(
      carried,
      "§V draws three readings — a build-time renderer, a runtime one and the floor — and only the floor speaks on a surface.",
    ).toEqual(PROVENANCE);
  });

  it("gives the two readings the drawing draws the same way no anchor of their own", () => {
    for (const surface of [PROVENANCE.native, PROVENANCE.marketplace]) {
      const row = REVIEW_DECISION_FLOOR_ROWS.find((r) => r.surface === surface);
      expect(
        row.anchor,
        `${surface}: §V says a build-time renderer and a runtime one "are drawn the same way, because nothing on either target says which resolved it" — a drawn anchor of its own would be the provenance line the drawing forbids.`,
      ).toBeNull();
    }
    expect(
      REVIEW_DECISION_FLOOR_ROWS.find((r) => r.surface === PROVENANCE.floor).anchor,
      "the floor is the one region that does speak, and it carries its own anchor.",
    ).toBe(PROVENANCE.floor);
  });
});

describe("what is drawn today is drawn, and what is not says what it waits for", () => {
  it("marks exactly the surfaces this wave's harness draws", () => {
    expect(
      REVIEW_DECISION_FLOOR_ROWS.filter((r) => r.mounted).map((r) => r.surface).sort(),
      "the mounted rows are the ones the harness page draws with the shipped component — a row that claims to be drawn and is not is a false claim of coverage.",
    ).toEqual([...MOUNTED].sort());
  });

  it("draws every mounted surface on the harness page, through the shipped module", () => {
    const fixture = readFileSync(path.join(FIXTURES_DIR, "review-gate-state-fixtures.tsx"), "utf8");
    const data = readFileSync(path.join(FIXTURES_DIR, "review-gate-state-fixture-data.ts"), "utf8");
    const page = readFileSync(path.join(FIXTURES_DIR, "page.tsx"), "utf8");
    expect(
      fixture.includes('from "@cinatra-ai/agents/review-gate-states"'),
      "the harness must mount the SHIPPED gate-state components, never a look-alike drawn in the fixture.",
    ).toBe(true);
    expect(
      fixture.includes('from "./review-gate-state-fixture-data"'),
      "the mount must draw the declared rows, so a surface reaches the boot the same way it reaches the driver map — through one list.",
    ).toBe(true);
    expect(
      page.includes("ReviewGateStateConformanceFixtures"),
      "the harness page must draw this wave's mount, or nothing on the boot carries these surfaces and the drivers skip.",
    ).toBe(true);
    for (const surface of MOUNTED) {
      expect(
        data.includes(`"${surface}"`),
        `${surface}: the harness does not declare a mount for this surface, so nothing on the boot carries it.`,
      ).toBe(true);
    }
  });

  it("names, for every surface it does NOT draw, what that surface is waiting for", () => {
    const silent = REVIEW_DECISION_FLOOR_ROWS.filter(
      (row) => !row.mounted && (typeof row.readiness !== "string" || row.readiness.trim().length < 40),
    ).map((row) => row.surface);
    expect(
      silent,
      `${silent.join(", ")} carries no readiness sentence — a driver whose surface the branch does not have must say what it is waiting for, never skip silently.`,
    ).toEqual([]);
  });

  it("gives a mounted surface no readiness sentence at all", () => {
    const contradictory = REVIEW_DECISION_FLOOR_ROWS.filter((r) => r.mounted && r.readiness !== null).map(
      (r) => r.surface,
    );
    expect(
      contradictory,
      `${contradictory.join(", ")} is drawn by this wave's harness AND says it is waiting for something — one of the two is untrue.`,
    ).toEqual([]);
  });

  it("names the open floor pull request on exactly the surface whose affordances it lands", () => {
    const naming = REVIEW_DECISION_FLOOR_ROWS.filter((r) => r.awaitingPullRequest !== null);
    expect(
      naming.map((r) => [r.surface, r.awaitingPullRequest]),
      "Regenerate and Continue are the two affordances the default branch does not have; the one surface that declares them names the pull request that lands them, and no other surface may borrow that excuse.",
    ).toEqual([["review-decision-bar", 3100]]);
    expect(
      naming[0].readiness.includes("3100"),
      "the readiness sentence itself must name the pull request, because that sentence is what a skipped test prints.",
    ).toBe(true);
  });
});

describe("the driver map is built from the row list", () => {
  const contract = readFileSync(path.join(CONF_DIR, "contract.ts"), "utf8");

  it("imports the rows and spreads them into SURFACE_DRIVERS", () => {
    expect(
      contract.includes("REVIEW_DECISION_FLOOR_ROWS"),
      "contract.ts no longer builds the review-decision-floor drivers from the row list — a hand-written map is a second place a surface can be forgotten, which is the failure this wave's acceptance forbids.",
    ).toBe(true);
    expect(contract).toContain("reviewDecisionFloorDriver");
  });

  // A bare mention of the identifier survives a hand-written map (the identifier
  // can linger in an unused import or a comment). The map must be BUILT by
  // iterating the rows, and no surface may be keyed into it by hand.
  it("constructs the map by iterating the rows, not by hand", () => {
    expect(
      /const REVIEW_DECISION_FLOOR_DRIVERS[\s\S]{0,240}REVIEW_DECISION_FLOOR_ROWS\.map\(/.test(contract),
      "REVIEW_DECISION_FLOOR_DRIVERS must be built by mapping REVIEW_DECISION_FLOOR_ROWS — a map whose keys are written out by hand can go out of step with the row list, which is the one thing this wave's shape exists to prevent.",
    ).toBe(true);
    const driversBlock = contract.slice(
      contract.indexOf("const REVIEW_DECISION_FLOOR_DRIVERS"),
      contract.indexOf("/** Covered manifest surfaces"),
    );
    const handKeyed = REVIEW_DECISION_FLOOR_SURFACES.filter((id) => driversBlock.includes(`"${id}":`));
    expect(
      handKeyed,
      `${handKeyed.join(", ")} is keyed into the driver map by hand — every surface must reach the map through the row list.`,
    ).toEqual([]);
  });

  it("extends every one of the fifteen, exhaustively by type", () => {
    const extrasBlock = contract.slice(
      contract.indexOf("const REVIEW_DECISION_FLOOR_EXTRAS"),
      contract.indexOf("function reviewDecisionFloorReadiness"),
    );
    const extended = REVIEW_DECISION_FLOOR_SURFACES.filter((id) => extrasBlock.includes(`"${id}": (base)`));
    expect(
      [...extended].sort(),
      "every surface in this family carries a drawn structure of its own on top of the family shape — the drawing gives each of the fifteen its own sentences.",
    ).toEqual([...REVIEW_DECISION_FLOOR_SURFACES].sort());
    expect(
      /const REVIEW_DECISION_FLOOR_EXTRAS: Record</.test(contract),
      "the extras map must be a total Record over the surface union (not Partial), so dropping one is a compile error rather than a silently thinner driver.",
    ).toBe(true);
  });

  // Building the map is only half of it: the map must also REACH the suite. A
  // built-but-unspread map leaves every one of the fifteen surfaces driverless,
  // and an unpinned manifest generates no test for a surface it cannot drive —
  // so the wave would vanish silently instead of going red.
  it("spreads the built map into SURFACE_DRIVERS", () => {
    const surfaceDrivers = contract.slice(contract.indexOf("export const SURFACE_DRIVERS"));
    expect(
      surfaceDrivers.includes("...REVIEW_DECISION_FLOOR_DRIVERS"),
      "SURFACE_DRIVERS must spread REVIEW_DECISION_FLOOR_DRIVERS — a map that is built but never spread drives nothing, and an unpinned manifest generates no test for an undriven surface, so this wave would disappear without a red.",
    ).toBe(true);
  });

  // The map is keyed by each row's OWN `surface` field. A row filed under one
  // key but carrying another surface id would collapse two entries into one and
  // leave a surface undriven, while every declaration check above still passed.
  it("files every row under its own surface id", () => {
    const misfiled = Object.entries(REVIEW_DECISION_FLOOR)
      .filter(([id, row]) => row.surface !== id)
      .map(([id, row]) => `${id} -> ${row.surface}`);
    expect(
      misfiled,
      `${misfiled.join(", ")}: a row is filed under a key that is not its own surface id — the driver map is keyed by the row's field, so a mismatch silently drops a surface out of the map.`,
    ).toEqual([]);
    expect(
      new Set(REVIEW_DECISION_FLOOR_ROWS.map((r) => r.surface)).size,
      "the rows must carry fifteen DISTINCT surface ids — the map is keyed by that field, so a repeat is a lost driver.",
    ).toBe(REVIEW_DECISION_FLOOR_SURFACES.length);
  });
});

describe("the family assertions cannot pass vacuously", () => {
  const contract = readFileSync(path.join(CONF_DIR, "contract.ts"), "utf8");

  it("reads a blocked gate's reason from the drawing's own closed set", () => {
    const helper = contract.slice(
      contract.indexOf("const REVIEW_BLOCKED_REASONS"),
      contract.indexOf("const REVIEW_DECISION_FLOOR_EXTRAS"),
    );
    for (const reason of ["no-longer-pending", "targets-mismatch", "revision-not-live"]) {
      expect(
        helper.includes(reason),
        `the blocked reading names the reason "from the closed set" — ${reason} is one of the three and must be in the set the driver reads against.`,
      ).toBe(true);
    }
  });

  // §V's two renderer tiers are read as an ABSENCE. An absence is only evidence
  // when it is read on the thing the drawing forbids: the provenance REGION,
  // whose ids the shipped surface model owns. An absence read only on attribute
  // names the product never emits would pass with a provenance strip on screen.
  it("reads the provenance absence on the regions the drawing forbids", () => {
    for (const surface of ["review-provenance-native", "review-provenance-marketplace"]) {
      const block = contract.slice(
        contract.indexOf(`"${surface}": (base)`),
        contract.indexOf(`"${surface}": (base)`) + 1400,
      );
      for (const region of ["review-provenance-native", "review-provenance-marketplace"]) {
        expect(
          block.includes(`[data-conformance-id="${region}"]`),
          `${surface} must assert the ABSENCE of the ${region} region itself — the drawing forbids the region, and the two tiers are drawn the same way, so both ids must be read as absent on both tiers.`,
        ).toBe(true);
      }
    }
  });

  it("proves the surface is drawn before reading an absence as evidence", () => {
    const helper = contract.slice(
      contract.indexOf("function reviewDecisionFloorPanel"),
      contract.indexOf("function reviewDecisionFloorState"),
    );
    expect(
      helper.length > 0 && contract.includes("REVIEW_DECISION_FLOOR_ABSENCE_GUARD"),
      "every reading that takes an absence as evidence must first assert the mount it reads it on — on a missing mount a zero count proves nothing.",
    ).toBe(true);
  });
});

describe("the shrink-only ratchet gains nothing from this wave", () => {
  it("no allowlist entry names one of these surfaces", () => {
    const allowlist = readJson(path.join(CONF_DIR, "allowlist.json")).allow;
    const absorbed = allowlist
      .map((e) => e.surface)
      .filter((s) => REVIEW_DECISION_FLOOR_SURFACES.includes(s));
    expect(
      absorbed,
      `allowlist.json exempts ${absorbed.join(", ")} — this wave covers every one of its surfaces with a real driver and adds no exemption, whole-surface or aspect-level.`,
    ).toEqual([]);
  });

  it("does not pin the drawing", () => {
    const pins = readJson(path.join(CONF_DIR, "..", "conformance-pins.json"));
    expect(
      pins.manifests.some((m) => m.file === "app-artifact-review.json"),
      "the pin lands once EVERY wave for this drawing is green (epic cinatra#3155, independent pinning) — W7 covers fifteen of its forty surfaces, so it must not pin it.",
    ).toBe(false);
  });
});
