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
import {
  kindDisplayFieldDriver,
  kindDisplayFieldReading,
} from "../../../tests/e2e/design/conformance/artifact-review-display-readings.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CONF_DIR = path.join(REPO_ROOT, "tests", "e2e", "design", "conformance");
const MANIFEST_FILE = path.join(CONF_DIR, "manifests", "app-artifact-review.json");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

/** The readings a row may declare; a declaration with no reading is "open". */
const READINGS = ["open", "continued", "no-review"];

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
        `${row.surface}: the wave's recorded field bindings no longer match the drawing's — reconcile the row with the manifest before the drivers claim to assert them.`,
      ).toEqual(row.fields.map((f) => ({ name: f.name, source: f.source })));
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

  // A drawing binds a field once per reading that draws it, so one field name
  // can carry several declarations. contract.ts builds ONE driver per name from
  // all of them (kindDisplayFieldDriver, through kindDisplayFieldReading), which
  // reads a name only if every declaration binds the same non-blank source,
  // every reading is open, continued or no-review, and the field is not both
  // drawn while the review is open and drawn only once it is continued. This
  // test checks the same conditions on the rows without calling that function.
  it("declares each repeated field with one source and readings one driver can read", () => {
    const unreadable = [];
    for (const row of ARTIFACT_KIND_DISPLAY_ROWS) {
      const byName = new Map();
      for (const f of row.fields) byName.set(f.name, [...(byName.get(f.name) ?? []), f]);
      for (const [name, fields] of byName) {
        const sources = new Set(fields.map((f) => f.source));
        const readings = new Set(fields.map((f) => f.reading ?? "open"));
        if (
          fields.some((f) => typeof f.source !== "string" || f.source.trim() === "") ||
          sources.size !== 1 ||
          [...readings].some((r) => !READINGS.includes(r)) ||
          (readings.has("open") && readings.has("continued"))
        ) {
          unreadable.push(`${row.surface}.${name}`);
        }
      }
    }
    expect(
      unreadable,
      `${unreadable.join(", ")} is declared with a blank source, with two sources, with a reading other than ${READINGS.join(", ")}, or both open and continued — no one driver can read it.`,
    ).toEqual([]);
  });

  it("records the dashboard display's Open live dashboard in each reading that draws it (design@67ecd66d)", () => {
    // §XI.5 draws six readings: the review open, the review continued and no
    // review standing, each with the numbers read and with no data capability.
    // The link is drawn in four of them, in this order.
    const row = ARTIFACT_KIND_DISPLAY_ROWS.find((r) => r.surface === "dashboard-display");
    expect(
      row.fields.filter((f) => f.name === "open-live").map((f) => f.reading),
    ).toEqual(["continued", "no-review", "continued", "no-review"]);
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

// kindDisplayFieldReading returns the one reading a field's driver reads
// ("open", "continued" or "no-review"), and throws for a row no one driver can
// read. Each branch and each throw is pinned here, without a browser.
describe("the reading a kind-display field's driver reads", () => {
  const f = (reading, source = "artifact.sourceUrl") =>
    reading === undefined ? { name: "open-live", source } : { name: "open-live", source, reading };

  it("reads a field with no reading as open", () => {
    expect(kindDisplayFieldReading("s", [f(undefined)])).toBe("open");
  });

  it("reads a field declared only continued as continued", () => {
    expect(kindDisplayFieldReading("s", [f("continued")])).toBe("continued");
  });

  it("reads a field declared only where no review stands as no-review", () => {
    expect(kindDisplayFieldReading("s", [f("no-review"), f("no-review")])).toBe("no-review");
  });

  it("reads continued over no-review, in either order", () => {
    expect(kindDisplayFieldReading("s", [f("continued"), f("no-review")])).toBe("continued");
    expect(kindDisplayFieldReading("s", [f("no-review"), f("continued")])).toBe("continued");
  });

  it("reads open over no-review, in either order", () => {
    expect(kindDisplayFieldReading("s", [f(undefined), f("no-review")])).toBe("open");
    expect(kindDisplayFieldReading("s", [f("no-review"), f(undefined)])).toBe("open");
  });

  it("reads the dashboard display's open-live declarations as continued", () => {
    const row = ARTIFACT_KIND_DISPLAY_ROWS.find((r) => r.surface === "dashboard-display");
    const openLive = row.fields.filter((d) => d.name === "open-live");
    expect(kindDisplayFieldReading(row.surface, openLive)).toBe("continued");
  });

  it("throws for a field bound to two sources", () => {
    expect(() =>
      kindDisplayFieldReading("s", [f("continued"), f("continued", "artifact.url")]),
    ).toThrow(/declared with sources artifact\.sourceUrl, artifact\.url/);
  });

  it("throws for a field declared both open and continued", () => {
    expect(() => kindDisplayFieldReading("s", [f(undefined), f("continued")])).toThrow(
      /in readings open, continued/,
    );
  });

  it("throws for a reading other than open, continued and no-review", () => {
    expect(() => kindDisplayFieldReading("s", [f("archived")])).toThrow(/in readings archived/);
    expect(() => kindDisplayFieldReading("s", [f("no-review"), f("closed")])).toThrow(
      /in readings no-review, closed/,
    );
    expect(() => kindDisplayFieldReading("s", [f("open")])).not.toThrow();
  });

  it("throws for a field with no declaration", () => {
    expect(() => kindDisplayFieldReading("s", [])).toThrow(/\(no declaration\)/);
  });

  it("throws for a declaration whose source is undefined, empty or blank", () => {
    expect(() => kindDisplayFieldReading("s", [f("continued", "")])).toThrow(
      /declared with sources {2}in readings continued/,
    );
    expect(() => kindDisplayFieldReading("s", [f("continued", "   ")])).toThrow(/reconcile the row/);
    expect(() =>
      kindDisplayFieldReading("s", [{ name: "open-live", reading: "continued" }]),
    ).toThrow(/reconcile the row/);
    expect(() =>
      kindDisplayFieldReading("s", [f("continued"), { name: "open-live", source: undefined, reading: "continued" }]),
    ).toThrow(/reconcile the row/);
  });

  it("reads every row of the wave without a throw", () => {
    for (const row of ARTIFACT_KIND_DISPLAY_ROWS) {
      const byName = new Map();
      for (const d of row.fields) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
      for (const fields of byName.values()) {
        expect(() => kindDisplayFieldReading(row.surface, fields)).not.toThrow();
      }
    }
  });

});

// kindDisplayFieldDriver picks, for each field name, the one of the three
// assertions contract.ts supplies that the name's reading gets. Tagged stand-ins
// for the three assertions show which one each reading gets, with which
// binding or skip reason.
describe("the assertion a kind-display field's driver gets", () => {
  const f = (reading, source = "artifact.sourceUrl", name = "open-live") =>
    reading === undefined ? { name, source } : { name, source, reading };
  const tagged = {
    present: (binding) => ["present", binding],
    continuedOnly: (binding) => ["continuedOnly", binding],
    skip: (reason) => ["skip", reason],
  };
  const BINDING = '[data-field="open-live=artifact.sourceUrl"]';

  it("gives an open field the presence assertion on its binding", () => {
    expect(kindDisplayFieldDriver("s", [f(undefined)], tagged)).toEqual({
      source: "artifact.sourceUrl",
      assert: ["present", BINDING],
    });
  });

  it("gives a continued field the continued-only assertion on its binding", () => {
    expect(kindDisplayFieldDriver("s", [f("continued")], tagged)).toEqual({
      source: "artifact.sourceUrl",
      assert: ["continuedOnly", BINDING],
    });
  });

  it("gives a field drawn only where no review stands a skip that names the surface and the field", () => {
    expect(kindDisplayFieldDriver("dashboard-display", [f("no-review")], tagged)).toEqual({
      source: "artifact.sourceUrl",
      assert: [
        "skip",
        'dashboard-display: "open-live" is drawn only where no review stands, a reading the review harness does not mount',
      ],
    });
  });

  it("gives continued over no-review and open over no-review, as the reading does", () => {
    expect(kindDisplayFieldDriver("s", [f("no-review"), f("continued")], tagged).assert).toEqual([
      "continuedOnly",
      BINDING,
    ]);
    expect(kindDisplayFieldDriver("s", [f("no-review"), f(undefined)], tagged).assert).toEqual([
      "present",
      BINDING,
    ]);
  });

  it("binds the field by its own name and source", () => {
    expect(
      kindDisplayFieldDriver("s", [f(undefined, "representation.pinned-configuration", "layout")], tagged),
    ).toEqual({
      source: "representation.pinned-configuration",
      assert: ["present", '[data-field="layout=representation.pinned-configuration"]'],
    });
  });

  it("builds no assertion for a row the reading refuses", () => {
    const built = [];
    const counting = {
      present: (b) => built.push(b),
      continuedOnly: (b) => built.push(b),
      skip: (r) => built.push(r),
    };
    expect(() => kindDisplayFieldDriver("s", [f("continued", "")], counting)).toThrow(/reconcile the row/);
    expect(() => kindDisplayFieldDriver("s", [f(undefined), f("continued")], counting)).toThrow(
      /in readings open, continued/,
    );
    expect(built).toEqual([]);
  });

  it("gives the dashboard display's layout the presence assertion and its open-live the continued-only one", () => {
    const row = ARTIFACT_KIND_DISPLAY_ROWS.find((r) => r.surface === "dashboard-display");
    const byName = (n) => row.fields.filter((d) => d.name === n);
    expect(kindDisplayFieldDriver(row.surface, byName("layout"), tagged).assert[0]).toBe("present");
    expect(kindDisplayFieldDriver(row.surface, byName("open-live"), tagged).assert).toEqual([
      "continuedOnly",
      BINDING,
    ]);
  });

  it("is what contract.ts builds every field from, each assertion under its own name", () => {
    const contract = readFileSync(path.join(CONF_DIR, "contract.ts"), "utf8");
    expect(contract).toMatch(
      /import \{ kindDisplayFieldDriver \} from "\.\/artifact-review-display-readings";/,
    );
    expect(contract).not.toMatch(/function kindDisplayField(Reading|Driver)\b/);
    expect(contract).toMatch(
      /driver\.fields\[name\] = kindDisplayFieldDriver\(row\.surface, fields, \{/,
    );
    // The presence assertion: the binding inside this display, once and visible.
    expect(contract).toMatch(
      /present: \(binding\) => async \(_page: Page, root: Locator\) => \{\n\s+const bound = kindDisplayPanel\(root, row\.surface\)\.locator\(binding\);\n\s+await expect\(bound\)\.toHaveCount\(1\);\n\s+await expect\(bound\)\.toBeVisible\(\);/,
    );
    expect(contract).toMatch(/continuedOnly: \(binding\) => continuedOnlyField\(row\.surface, binding\),/);
    expect(contract).toMatch(/skip: \(reason\) => async \(\) => \{\n\s+test\.skip\(true, reason\);/);
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
