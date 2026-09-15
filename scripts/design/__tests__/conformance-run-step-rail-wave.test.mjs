// The W6 coverage record for the artifact-review drawing's run step-rail family
// (cinatra#3162, epic cinatra#3155).
//
// The functional-acceptance suite is a Playwright suite: the claim "every surface
// this wave lists has a real driver, and none stays unmapped" is only ever proved
// by it on a browser run, on a boot, behind a build. That is the right place for
// the ASSERTIONS. It is the wrong place for the wave's own arithmetic — whether a
// surface was forgotten, whether a row silently stopped matching the drawing it
// claims to drive, whether an aspect was dropped without a reason, whether the
// shrink-only ratchet was widened to make a wave look finished. Those are
// answerable from the committed bytes alone, and a reader should not have to boot
// anything to answer them.
//
// So this file checks the wave against the drawing, without a browser:
//
//   1. The staged manifest declares EXACTLY the surfaces this wave covers, and
//      each row records the drawing's own field sources, action outcomes and
//      state variants — one for one. A regenerated manifest that renames a
//      field's source or drops a state goes red HERE, in the wave that claimed to
//      cover it, instead of silently reducing what the drivers assert.
//   2. The factory's two axes are TOTAL: every step kind and every step state a
//      row names has an assertion of its own.
//   3. contract.ts builds its driver map FROM the row list, so being listed is
//      being mapped — there is no second place a surface could be forgotten.
//   4. Every surface the branch does not ship says what it is waiting for, and
//      every aspect a mounted surface does not assert says so out loud.
//   5. The ratchet gains nothing: no allowlist entry names one of these surfaces,
//      and this wave does not pin the manifest.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
  RUN_STEP_RAIL_ROWS,
  RUN_STEP_RAIL_SURFACES,
} from "../../../tests/e2e/design/conformance/run-step-rail-family.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CONF_DIR = path.join(REPO_ROOT, "tests", "e2e", "design", "conformance");
const MANIFEST_FILE = path.join(CONF_DIR, "manifests", "app-artifact-review.json");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const contract = () => readFileSync(path.join(CONF_DIR, "contract.ts"), "utf8");
const railData = () =>
  readFileSync(
    path.join(REPO_ROOT, "src", "app", "design-fixtures", "conformance", "run-step-rail-conformance-data.ts"),
    "utf8",
  );

/**
 * Every source file of the PRODUCT tree — `src/` and `packages/` — read once.
 *
 * This is what turns a readiness sentence from prose into a claim that can go
 * red: a row says an anchor or an action-and-outcome pair is on no element the
 * branch ships, and this reads the branch and checks. Build output, dependencies
 * and the conformance tests themselves are excluded — the tests are where the
 * claim is made, so counting them would make every claim self-satisfying.
 */
const SKIP_DIRS = new Set([
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
  "__snapshots__",
  ".turbo",
]);
const SOURCE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function collectSources(dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const full = path.join(dir, name);
    const stat = statSync(full);
    if (stat.isDirectory()) collectSources(full, out);
    else if (SOURCE_EXT.has(path.extname(name))) out.push(full);
  }
  return out;
}

let PRODUCT_TEXT;
function productText() {
  if (PRODUCT_TEXT === undefined) {
    const files = [
      ...collectSources(path.join(REPO_ROOT, "src"), []),
      ...collectSources(path.join(REPO_ROOT, "packages"), []),
    ];
    PRODUCT_TEXT = files.map((f) => readFileSync(f, "utf8")).join("\n");
  }
  return PRODUCT_TEXT;
}

describe("the wave covers the run step-rail family of the staged drawing", () => {
  it("lists exactly fourteen surfaces, with no repeat", () => {
    expect(new Set(RUN_STEP_RAIL_SURFACES).size).toBe(RUN_STEP_RAIL_SURFACES.length);
    expect(RUN_STEP_RAIL_SURFACES.length).toBe(14);
  });

  it("names only surfaces the staged manifest declares", () => {
    const declared = new Set(readJson(MANIFEST_FILE).surfaces.map((s) => s.id));
    const unknown = RUN_STEP_RAIL_SURFACES.filter((id) => !declared.has(id));
    expect(
      unknown,
      `the wave lists ${unknown.join(", ")}, which the staged app-artifact-review manifest does not declare — a driver for a surface the drawing does not have covers nothing.`,
    ).toEqual([]);
  });

  it("records each surface's declarations exactly as the drawing binds them", () => {
    const byId = new Map(readJson(MANIFEST_FILE).surfaces.map((s) => [s.id, s]));
    for (const row of RUN_STEP_RAIL_ROWS) {
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

describe("the family factory is parameterized by step kind and step state", () => {
  const source = () => contract();

  it("gives every step kind a rule of its own, exhaustively by type", () => {
    const text = source();
    expect(
      /const RUN_STEP_KIND_ASSERT: Record<RunStepKind,/.test(text),
      "the kind axis must be a TOTAL Record over RunStepKind (not Partial), so a new step kind is a compile error rather than a surface that quietly rides the family shape alone.",
    ).toBe(true);
    const block = text.slice(
      text.indexOf("const RUN_STEP_KIND_ASSERT"),
      text.indexOf("const RUN_STEP_STATE_ASSERT"),
    );
    const kinds = [...new Set(RUN_STEP_RAIL_ROWS.map((r) => r.kind))];
    const missing = kinds.filter((k) => !new RegExp(`(^|\\s)"?${k}"?: \\(row\\)`, "m").test(block));
    expect(
      missing,
      `${missing.join(", ")} has no kind rule — every step kind a row names must say what the drawing owes it.`,
    ).toEqual([]);
  });

  it("gives every step state a reading of its own, exhaustively by type", () => {
    const text = source();
    expect(
      /const RUN_STEP_STATE_ASSERT: Record<RunStepState,/.test(text),
      "the state axis must be a TOTAL Record over RunStepState (not Partial).",
    ).toBe(true);
    const block = text.slice(
      text.indexOf("const RUN_STEP_STATE_ASSERT"),
      text.indexOf("function runStepStateVariant"),
    );
    const states = [...new Set(RUN_STEP_RAIL_ROWS.map((r) => r.state))];
    const missing = states.filter(
      (s) => !new RegExp(`(^|\\s)"?${s}"?: \\(row\\)`, "m").test(block),
    );
    expect(
      missing,
      `${missing.join(", ")} has no state rule — every step state a row names must say which reading the drawing draws.`,
    ).toEqual([]);
  });
});

describe("the driver map is built from the row list", () => {
  it("imports the rows and spreads them into SURFACE_DRIVERS", () => {
    const text = contract();
    expect(
      text.includes("RUN_STEP_RAIL_ROWS"),
      "contract.ts no longer builds the run step-rail family drivers from the row list — a hand-written map is a second place a surface can be forgotten, which is the failure this wave's acceptance forbids.",
    ).toBe(true);
    expect(text).toContain("runStepRailFamilyDriver");
    expect(text).toContain("...RUN_STEP_RAIL_FAMILY_DRIVERS");
  });

  // A bare mention of the identifier survives a hand-written map (the identifier
  // can linger in an unused import or a comment). The map must be BUILT by
  // iterating the rows, and no surface may be keyed into it by hand.
  it("constructs the map by iterating the rows, not by hand", () => {
    const text = contract();
    expect(
      /const RUN_STEP_RAIL_FAMILY_DRIVERS[\s\S]{0,200}RUN_STEP_RAIL_ROWS\.map\(/.test(text),
      "RUN_STEP_RAIL_FAMILY_DRIVERS must be built by mapping RUN_STEP_RAIL_ROWS — a map whose keys are written out by hand can go out of step with the row list, which is the one thing this wave's shape exists to prevent.",
    ).toBe(true);
    const block = text.slice(
      text.indexOf("const RUN_STEP_RAIL_FAMILY_DRIVERS"),
      text.indexOf("const NOTIFICATIONS_LIST_DRIVER"),
    );
    const handKeyed = RUN_STEP_RAIL_SURFACES.filter((id) => block.includes(`"${id}":`));
    expect(
      handKeyed,
      `${handKeyed.join(", ")} is keyed into the driver map by hand — every surface must reach the map through the row list.`,
    ).toEqual([]);
  });
});

describe("nothing skips silently, and nothing stands in for a surface", () => {
  it("names, for every surface the branch does not mount, what it is waiting for", () => {
    const silent = RUN_STEP_RAIL_ROWS.filter(
      (row) =>
        !row.mounted && (typeof row.readiness !== "string" || row.readiness.trim().length < 40),
    ).map((row) => row.surface);
    expect(
      silent,
      `${silent.join(", ")} carries no readiness sentence — a driver whose surface the branch does not have must say what it is waiting for, never skip silently.`,
    ).toEqual([]);
  });

  it("names a reason for every aspect a mounted surface does not assert", () => {
    const unreasoned = RUN_STEP_RAIL_ROWS.filter(
      (row) =>
        row.unshippedAspects.length > 0 &&
        (typeof row.readiness !== "string" || row.readiness.trim().length < 40),
    ).map((row) => row.surface);
    expect(
      unreasoned,
      `${unreasoned.join(", ")} leaves a declared aspect undriven with no reason — an aspect a wave does not assert must say why, out loud, in the same row.`,
    ).toEqual([]);
  });

  it("leaves no aspect undriven on a surface the branch does not mount", () => {
    // An unmounted surface's whole battery skips with its reason, so there is no
    // per-aspect distinction to draw — an `unshippedAspects` entry there would be
    // a second, quieter way to drop an assertion.
    const confused = RUN_STEP_RAIL_ROWS.filter(
      (row) => !row.mounted && row.unshippedAspects.length > 0,
    ).map((row) => row.surface);
    expect(confused).toEqual([]);
  });

  it("mounts the rail for real and drives its drawn claims on the shipped component", () => {
    const rail = RUN_STEP_RAIL_ROWS.find((row) => row.surface === "run-step-rail");
    expect(
      rail.mounted,
      "the run step rail IS on the default branch (packages/agents/src/run-step-rail-panel.tsx) — this wave mounts it and asserts section I's rail sentences on the real component, never as an awaiting-mount skip.",
    ).toBe(true);
    const fixture = readFileSync(
      path.join(
        REPO_ROOT,
        "src",
        "app",
        "design-fixtures",
        "conformance",
        "run-step-rail-conformance-fixtures.tsx",
      ),
      "utf8",
    );
    expect(fixture).toContain('data-surface-id="run-step-rail"');
    expect(
      fixture.includes("RunStepRailPanel"),
      "the mount must be the REAL shipped rail — a harness element drawing a rail the product does not have would be a stand-in, which this epic's road forbids.",
    ).toBe(true);
  });
});

describe("the shrink-only ratchet gains nothing from this wave", () => {
  it("no allowlist entry names one of these surfaces", () => {
    const allowlist = readJson(path.join(CONF_DIR, "allowlist.json")).allow;
    const absorbed = allowlist
      .map((e) => e.surface)
      .filter((s) => RUN_STEP_RAIL_SURFACES.includes(s));
    expect(
      absorbed,
      `allowlist.json exempts ${absorbed.join(", ")} — this wave covers every one of its surfaces with a real driver and adds no exemption, whole-surface or aspect-level.`,
    ).toEqual([]);
  });

  it("does not pin the drawing", () => {
    const pins = readJson(path.join(CONF_DIR, "..", "conformance-pins.json"));
    expect(
      pins.manifests.some((m) => m.file === "app-artifact-review.json"),
      "the pin lands once EVERY wave for this drawing is green (epic cinatra#3155, independent pinning) — W6 covers fourteen of its forty surfaces, so it must not pin it.",
    ).toBe(false);
  });
});

describe("every readiness claim is checked against the shipped tree", () => {
  // A readiness sentence is prose, and prose cannot go red. Each row also
  // records the LITERALS its sentence turns on, and this reads src/ and
  // packages/ to confirm them. The day a later wave lands one of these anchors
  // or controls, the row claiming the surface cannot be driven goes red here —
  // which is the only thing standing between a readiness list and a shortcut.
  it("finds no trace of an anchor a row says the branch does not carry", () => {
    const text = productText();
    const found = [];
    for (const row of RUN_STEP_RAIL_ROWS) {
      for (const anchor of row.evidence.absentAnchors) {
        if (text.includes(`data-conformance-id="${anchor}"`)) found.push(`${row.surface} -> ${anchor}`);
      }
    }
    expect(
      found,
      `${found.join(", ")}: the branch DOES carry this anchor, so the row's readiness claim is no longer true — drive the surface for real or rewrite the claim.`,
    ).toEqual([]);
  });

  it("finds no control declaring an action-and-outcome pair a row says is missing", () => {
    const text = productText();
    const found = [];
    for (const row of RUN_STEP_RAIL_ROWS) {
      for (const action of row.evidence.absentActions) {
        if (text.includes(`data-action="${action.name} -> ${action.outcome}"`)) {
          found.push(`${row.surface} -> ${action.name} -> ${action.outcome}`);
        }
      }
    }
    expect(
      found,
      `${found.join(", ")}: a control in src/ or packages/ DOES declare this pair, so the row may no longer say nothing does — press it in the driver instead.`,
    ).toEqual([]);
  });

  it("finds every file a row names as already shipped", () => {
    const missing = [];
    for (const row of RUN_STEP_RAIL_ROWS) {
      for (const file of row.evidence.shippedFiles) {
        if (!existsSync(path.join(REPO_ROOT, file))) missing.push(`${row.surface} -> ${file}`);
      }
    }
    expect(
      missing,
      `${missing.join(", ")}: the row names a file the tree does not have — a readiness sentence may not cite a file that is not there.`,
    ).toEqual([]);
  });

  it("confirms a module a row calls unreachable really is on no package subpath", () => {
    const unreachable = [];
    for (const row of RUN_STEP_RAIL_ROWS) {
      for (const mod of row.evidence.unexportedModules) {
        const full = path.join(REPO_ROOT, mod);
        expect(existsSync(full), `${row.surface}: ${mod} does not exist`).toBe(true);
        const segments = mod.split("/");
        const pkgDir = path.join(REPO_ROOT, segments[0], segments[1]);
        const pkg = readJson(path.join(pkgDir, "package.json"));
        const rel = `./${segments.slice(2).join("/")}`;
        const exported = Object.values(pkg.exports ?? {}).some(
          (target) => (typeof target === "string" ? target : "") === rel,
        );
        if (exported) unreachable.push(`${row.surface} -> ${mod}`);
      }
    }
    expect(
      unreachable,
      `${unreachable.join(", ")}: the package NOW exports this module, so a core route can import it — the row may no longer say the harness cannot mount the surface.`,
    ).toEqual([]);
  });

  it("leaves no unmounted row resting on prose alone", () => {
    const unfalsifiable = RUN_STEP_RAIL_ROWS.filter(
      (row) =>
        !row.mounted &&
        row.evidence.absentAnchors.length === 0 &&
        row.evidence.absentActions.length === 0 &&
        row.evidence.unexportedModules.length === 0,
    ).map((row) => row.surface);
    expect(
      unfalsifiable,
      `${unfalsifiable.join(", ")} explains itself in words that nothing can contradict — every readiness claim must carry at least one literal this file can look for in the tree.`,
    ).toEqual([]);
  });
});

describe("an aspect the branch does not ship is skipped out loud, never dropped", () => {
  // An UNPINNED manifest generates no test for an aspect with no driver
  // (functional-acceptance.spec.ts, requireEveryAspect === false). So an aspect
  // quietly left out of the driver map reads as coverage that was never claimed
  // AND never skipped — the one shape this wave's acceptance forbids. Every
  // declared aspect is registered; an unshipped one skips with its reason.
  it("registers every declared aspect of a mounted surface", () => {
    const text = contract();
    expect(
      /if \(unshipped\.has\([^)]*\)\) continue;/.test(text),
      "an unshipped aspect is being dropped from the driver map with `continue` — an unpinned manifest then generates NO test for it, so the omission is invisible. Register the aspect and skip it with its reason instead.",
    ).toBe(false);
    expect(
      text.includes("function runStepAspectReadiness"),
      "contract.ts must name, per aspect, what an unasserted aspect of a mounted surface is waiting for.",
    ).toBe(true);
    const block = text.slice(
      text.indexOf("function runStepRailFamilyDriver"),
      text.indexOf("function runStepAspectReadiness"),
    );
    for (const half of ["driver.fields[", "driver.actions[", "driver.states["]) {
      expect(
        block.includes(half),
        `${half}...] is no longer assigned for every declared aspect — the loop must register the aspect either way.`,
      ).toBe(true);
    }
    expect((block.match(/runStepAspectReadiness\(row, aspect\)/g) ?? []).length).toBe(3);
  });

  it("holds a drawn state to its own treatment, not to a label", () => {
    const text = contract();
    expect(
      /const RUN_STEP_STATE_SLOT/.test(text),
      "a state variant that only proves a matching data-variant proves the harness labelled itself. The three drawn states of this system carry a slot of their own, exactly as the W0 scope drivers require.",
    ).toBe(true);
    for (const [state, slot] of [
      ["empty", "empty"],
      ["error", "alert"],
      ["loading", "skeleton"],
    ]) {
      expect(new RegExp(`${state}: "${slot}"`).test(text), `${state} must draw [data-slot="${slot}"]`).toBe(true);
    }
  });
});

describe("the mounted rail's expected reading stands on its own", () => {
  // Deriving the expected labels from the fixture entries would let the driver
  // assert its own input back: any rail echoing its input in any order passes.
  // The reading is written out beside the fixture, and reconciled with the
  // entries HERE, so the browser assertion compares the product against an
  // independent statement of intent.
  it("does not derive the expected reading from the entries it feeds the rail", () => {
    const text = railData();
    const declared = text.slice(text.indexOf("RUN_STEP_RAIL_CONFORMANCE_LABELS"));
    expect(
      /RUN_STEP_RAIL_CONFORMANCE_LABELS[^=]*=\s*RUN_STEP_RAIL_CONFORMANCE_ENTRIES/.test(text),
      "the expected labels must not be mapped out of the entry set — that asserts the fixture back against itself.",
    ).toBe(false);
    expect(declared.includes("[")).toBe(true);
  });

  it("keeps the written reading and the entry set in step", () => {
    const text = railData();
    const list = (name) => {
      const start = text.indexOf(`export const ${name}`);
      const open = text.indexOf("[", start);
      const close = text.indexOf("];", open);
      return [...text.slice(open, close).matchAll(/"([^"]*)"/g)].map((m) => m[1]);
    };
    const entryBlock = text.slice(
      text.indexOf("RUN_STEP_RAIL_CONFORMANCE_ENTRIES"),
      text.indexOf("RUN_STEP_RAIL_CONFORMANCE_LABELS"),
    );
    const entryValues = (key) =>
      [...entryBlock.matchAll(new RegExp(`${key}: "([^"]*)"`, "g"))].map((m) => m[1]);
    expect(list("RUN_STEP_RAIL_CONFORMANCE_LABELS")).toEqual(entryValues("label"));
    expect(list("RUN_STEP_RAIL_CONFORMANCE_ROW_KINDS")).toEqual(entryValues("kind"));
    expect(list("RUN_STEP_RAIL_CONFORMANCE_ROW_STATUSES")).toEqual(entryValues("status"));
  });
});
