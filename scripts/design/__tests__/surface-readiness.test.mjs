/**
 * THE SURFACE-READINESS LIST, MECHANICALLY TRUE (cinatra#3157, epic #3155 W1).
 *
 * Epic #3155's standing rule, written after W0's first build round was
 * withdrawn: before driving a manifest surface, ground each of its fields,
 * actions and states against the DEFAULT BRANCH's shipped behaviour; a surface
 * whose behaviour is still on an open pull request goes into that wave's
 * SURFACE-READINESS list, named with the pull request that lands it, and is
 * driven in a later wave — never stubbed, never approximated through a
 * different control.
 *
 * Prose cannot hold that rule for ten waves. A readiness list is a claim about
 * the product ("no control carries this action today"), and a claim about the
 * product goes stale the moment the product moves. So the list is DATA
 * (tests/e2e/design/conformance/surface-readiness.json) and this test re-proves
 * every claim in it against the tree on every run:
 *
 *   1. a listed surface is a REAL surface of the manifest it names;
 *   2. a listed surface is NOT also covered — a readiness entry, a driver in
 *      SURFACE_DRIVERS and an allowlist exemption are mutually exclusive
 *      readings of the same surface;
 *   3. a listed ACTION is genuinely unshipped: no first-party module carries
 *      the action-and-outcome pair the manifest declares, and the entry repeats
 *      the manifest's own outcome rather than one of its own invention. THE
 *      MOMENT A MODULE CARRIES IT, THIS TEST GOES RED and the wave that landed
 *      it has to drive the surface or restate the entry. That is the whole
 *      point: the readiness list retires itself instead of being forgotten;
 *   4. a listed non-action aspect names a reason from a closed set, and the two
 *      reasons that are decidable from the tree are DECIDED here rather than
 *      asserted: `display-not-registered` is re-proved against the generated
 *      artifact-renderer registry, `surface-not-drawn` against the conformance
 *      anchors in first-party source;
 *   5. a wave that declares its surfaces accounts for EVERY field, action and
 *      state those surfaces declare, and lists NOTHING the manifest does not
 *      declare — an aspect can be dropped neither by omission nor by invention.
 *
 * WHAT THIS GUARD DOES NOT PROVE, stated plainly so a reader does not credit it
 * with more than it does: the source scan is TEXTUAL and looks for the
 * conformance attribute exactly as the testid contract spells it (the same
 * literal scripts/design/check-conformance-testids.mjs requires), so a control
 * that carried the action through a constant, a template expression or an
 * attribute spread would not be seen. That is the convention W0 established for
 * every conformance anchor in this repository, and a control written against it
 * is caught; a control that departs from it is caught by the testid-contract
 * check instead. The `island-rendered` reason is an architectural reading that
 * no text scan can decide, and is left as prose on purpose.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CONF_DIR = path.join(REPO_ROOT, "tests", "e2e", "design", "conformance");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const readText = (p) => readFileSync(p, "utf8");

const readiness = readJson(path.join(CONF_DIR, "surface-readiness.json"));
const allowlist = readJson(path.join(CONF_DIR, "allowlist.json")).allow;
const testidContract = readJson(path.join(CONF_DIR, "testid-contract.json"));
const contractSource = readText(path.join(CONF_DIR, "contract.ts"));

/**
 * The generated registry IS the registration source of truth for an artifact
 * kind's display, and it is committed — so "this kind registers no display" is
 * a decidable claim, not an opinion.
 */
const GENERATED_RENDERERS = readText(
  path.join(REPO_ROOT, "src", "lib", "generated", "artifact-renderers.ts"),
);
const KNOWN_EXTENSIONS = readText(
  path.join(REPO_ROOT, "src", "lib", "generated", "extensions.server.ts"),
);

/** Every surface of one committed manifest, pinned or not, keyed by id. */
function manifestSurfaces(file) {
  const manifest = readJson(path.join(CONF_DIR, "manifests", file));
  const byId = new Map();
  for (const surface of manifest.surfaces) {
    if (byId.has(surface.id)) throw new Error(`${file} declares ${surface.id} twice`);
    byId.set(surface.id, surface);
  }
  return byId;
}

/**
 * First-party PRODUCT source. Tests, specs and the design fixtures are excluded
 * on purpose: the scan has to see what the product SHIPS, so a fixture, a
 * driver or a test asserting an absence can never satisfy it — and, in the
 * other direction, a fixture that legitimately spells an attribute out can
 * never turn this guard red for the product's sake.
 */
function firstPartySourceFiles() {
  const roots = [path.join(REPO_ROOT, "src")];
  const packagesDir = path.join(REPO_ROOT, "packages");
  for (const pkg of readdirSync(packagesDir)) {
    const src = path.join(packagesDir, pkg, "src");
    try {
      if (statSync(src).isDirectory()) roots.push(src);
    } catch {
      // A package without a src/ directory contributes nothing to scan.
    }
  }
  const SKIP_DIRS = new Set(["node_modules", "__tests__", "__mocks__", "design-fixtures"]);
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (
        /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(entry.name) &&
        !/\.(test|spec)\.[a-z]+$/.test(entry.name)
      ) {
        files.push(full);
      }
    }
  };
  for (const root of roots) walk(root);
  return files;
}

const SOURCE = firstPartySourceFiles().map((file) => ({
  file: path.relative(REPO_ROOT, file),
  text: readFileSync(file, "utf8"),
}));

/**
 * The reason a NON-action aspect is unreachable. Closed on purpose — a wave
 * that meets a genuinely new reason adds it here, in a commit a reader can see,
 * rather than typing a new excuse into the data file.
 */
/**
 * The aspects a manifest surface can declare, and therefore the only aspects a
 * readiness entry can be ABOUT. Closed, because each of the three manifest
 * reconciliations below selects its entries by aspect: an entry naming a fourth
 * would be reconciled against nothing at all.
 */
const ASPECTS = new Set(["action", "field", "state"]);

const REASON_TOKENS = new Set([
  // The reading is drawn by a SERVER component inside the review card's own
  // credentialed island frame, so no props-only harness mount can reach it.
  "island-rendered",
  // No display for this artifact kind is registered on the default branch.
  // Re-proved below against the generated artifact-renderer registry.
  "display-not-registered",
  // No first-party module draws a card for this surface at all: its conformance
  // anchor appears in the manifest and nowhere else in the tree.
  "surface-not-drawn",
]);

describe("surface-readiness.json is still true of this tree", () => {
  const entries = readiness.waves.flatMap((wave) =>
    wave.entries.map((entry) => ({ ...entry, wave: wave.wave, manifest: wave.manifest })),
  );

  it("lists at least one wave, and every wave names its issue and its manifest", () => {
    expect(readiness.waves.length).toBeGreaterThan(0);
    for (const wave of readiness.waves) {
      expect(typeof wave.issue).toBe("number");
      expect(wave.manifest).toMatch(/^[a-z0-9-]+\.json$/);
      expect(wave.surfaces.length).toBeGreaterThan(0);
      expect(new Set(wave.surfaces).size, `${wave.wave} lists a surface twice`).toBe(
        wave.surfaces.length,
      );
    }
  });

  it("every listed surface is a real surface of the manifest its wave names", () => {
    for (const wave of readiness.waves) {
      const surfaces = manifestSurfaces(wave.manifest);
      for (const id of wave.surfaces) expect(surfaces.has(id)).toBe(true);
      for (const entry of wave.entries) expect(surfaces.has(entry.surface)).toBe(true);
    }
  });

  it("every entry names a known aspect, and a surface its own wave declares", () => {
    for (const wave of readiness.waves) {
      const declared = new Set(wave.surfaces);
      for (const entry of wave.entries) {
        // An aspect outside the closed set would slip past all three manifest
        // reconciliations below, each of which selects entries by aspect.
        expect(
          ASPECTS.has(entry.aspect),
          `${wave.wave}: ${entry.surface} names the unknown aspect ${entry.aspect}`,
        ).toBe(true);
        // The action and field reconciliations reject an entry for a surface a
        // wave does not list, because they compare the whole listed set against
        // what the wave's OWN surfaces declare. The state reconciliation walks
        // wave.surfaces instead, so it cannot see such an entry at all. Hold
        // every entry to the wave's own surfaces here, once, for all three.
        expect(
          declared.has(entry.surface),
          `${wave.wave}: ${entry.surface} has an entry, but the wave does not list it among its surfaces`,
        ).toBe(true);
        if (entry.aspect === "state") {
          expect(
            new Set(entry.states).size,
            `${wave.wave}: ${entry.surface} repeats a state in its readings`,
          ).toBe(entry.states.length);
        }
      }
    }
  });

  it("no two entries of a wave describe the same aspect twice", () => {
    for (const wave of readiness.waves) {
      const seen = new Set();
      for (const entry of wave.entries) {
        const identity = `${entry.surface} ${entry.aspect} ${entry.field ?? entry.action ?? ""}`;
        expect(seen.has(identity), `${wave.wave} records ${identity} twice`).toBe(false);
        seen.add(identity);
      }
    }
  });

  it("a listed surface is not also covered — readiness and coverage are exclusive", () => {
    const covered = new Set(Object.keys(testidContract.surfaces));
    const allowed = new Set(allowlist.map((e) => e.surface));
    // Walk each wave's OWN surface list rather than the flattened entries: a
    // surface a wave declares but writes no entry for is still a surface the
    // wave says it could not drive, and it must not be covered, allowlisted or
    // driven either. Every entry's surface is one of these, proved above.
    const listedSurfaces = readiness.waves.flatMap((wave) =>
      wave.surfaces.map((surface) => ({ surface })),
    );
    for (const entry of listedSurfaces) {
      expect(covered.has(entry.surface), `${entry.surface} is both listed and covered`).toBe(false);
      expect(allowed.has(entry.surface), `${entry.surface} is both listed and allowlisted`).toBe(
        false,
      );
      // A driver is the thing a readiness entry says does not exist yet. The
      // driver map is keyed by the surface id, so its presence in contract.ts
      // as a key is the check — a wave cannot claim a surface is undrivable
      // while the suite drives it.
      expect(
        contractSource.includes(`"${entry.surface}":`),
        `${entry.surface} is on the readiness list, but contract.ts names it as a driver key`,
      ).toBe(false);
    }
  });

  it("every listed action is genuinely unshipped in first-party source", () => {
    for (const entry of entries.filter((e) => e.aspect === "action")) {
      const literal = `data-action="${entry.action} -> ${entry.outcome}"`;
      const shipping = SOURCE.filter((s) => s.text.includes(literal)).map((s) => s.file);
      expect(
        shipping,
        `${entry.surface}: the readiness list says ${entry.action} is not shipped, but ${shipping.join(", ")} carries it — drive the surface or restate the entry`,
      ).toEqual([]);
    }
  });

  it("an action entry says why, and names the pull request that lands it when there is one", () => {
    for (const entry of entries.filter((e) => e.aspect === "action")) {
      expect(typeof entry.why).toBe("string");
      expect(entry.why.length).toBeGreaterThan(0);
      expect("awaits" in entry, `${entry.surface} ${entry.action} omits awaits`).toBe(true);
      if (entry.awaits !== null) expect(typeof entry.awaits).toBe("number");
    }
  });

  it("a non-action entry names a reason from the closed set", () => {
    for (const entry of entries.filter((e) => e.aspect !== "action")) {
      expect(REASON_TOKENS.has(entry.reason), `${entry.surface}: unknown reason ${entry.reason}`).toBe(
        true,
      );
      expect(entry.why.length).toBeGreaterThan(0);
    }
  });

  it("a kind listed as registering no display really registers none", () => {
    const listed = entries.filter((e) => e.reason === "display-not-registered");
    expect(listed.length, "no entry claims display-not-registered").toBeGreaterThan(0);
    for (const entry of listed) {
      // The package has to be a package this tree actually knows, or the check
      // below would pass for a name nothing could ever match.
      expect(
        KNOWN_EXTENSIONS.includes(`"${entry.package}"`),
        `${entry.surface}: ${entry.package} is not an extension this tree knows`,
      ).toBe(true);
      const registered = ["detail", "preview", "listRow"].filter((slot) =>
        GENERATED_RENDERERS.includes(`"${entry.package}::${slot}"`),
      );
      expect(
        registered,
        `${entry.surface}: the readiness list says ${entry.package} registers no artifact display, but the generated registry registers ${registered.join(", ")} — drive the surface or restate the entry`,
      ).toEqual([]);
    }
  });

  it("a surface listed as not drawn has no conformance anchor in first-party source", () => {
    const listed = entries.filter((e) => e.reason === "surface-not-drawn");
    expect(listed.length, "no entry claims surface-not-drawn").toBeGreaterThan(0);
    for (const entry of listed) {
      const anchor = `data-conformance-id="${entry.surface}"`;
      const drawing = SOURCE.filter((s) => s.text.includes(anchor)).map((s) => s.file);
      expect(
        drawing,
        `${entry.surface}: the readiness list says nothing draws it, but ${drawing.join(", ")} does`,
      ).toEqual([]);
    }
  });

  it("a wave accounts for every action its listed surfaces declare, and invents none", () => {
    for (const wave of readiness.waves) {
      const surfaces = manifestSurfaces(wave.manifest);
      const declared = new Set();
      for (const id of wave.surfaces) {
        for (const action of surfaces.get(id).actions) {
          declared.add(`${id} ${action.action} -> ${action.outcome}`);
        }
      }
      const listed = new Set(
        wave.entries
          .filter((e) => e.aspect === "action")
          .map((e) => `${e.surface} ${e.action} -> ${e.outcome}`),
      );
      for (const id of declared) {
        expect(
          listed.has(id),
          `${id}: the manifest declares this action, and this wave neither drives nor lists it`,
        ).toBe(true);
      }
      for (const id of listed) {
        expect(
          declared.has(id),
          `${id}: the readiness list records this action-and-outcome pair, but the manifest does not declare it`,
        ).toBe(true);
      }
    }
  });

  it("a wave accounts for every state its listed surfaces declare, and invents none", () => {
    for (const wave of readiness.waves) {
      const surfaces = manifestSurfaces(wave.manifest);
      // The duplicate-identity test above holds a surface to ONE state entry,
      // which is what makes this safe: accumulate rather than assign anyway, so
      // that relaxing that rule later cannot silently drop a surface's states
      // the way keying a Map by surface alone would.
      const listed = new Map();
      for (const entry of wave.entries.filter((e) => e.aspect === "state")) {
        const set = listed.get(entry.surface) ?? new Set();
        for (const state of entry.states) set.add(state);
        listed.set(entry.surface, set);
      }
      for (const id of wave.surfaces) {
        const declared = new Set(surfaces.get(id).states);
        for (const state of declared) {
          expect(
            listed.get(id)?.has(state) ?? false,
            `${id} declares the state ${state}, and this wave neither drives nor lists it`,
          ).toBe(true);
        }
        for (const state of listed.get(id) ?? []) {
          expect(
            declared.has(state),
            `${id}: the readiness list records the state ${state}, but the manifest does not declare it`,
          ).toBe(true);
        }
      }
    }
  });

  it("a wave accounts for every field its listed surfaces declare, and invents none", () => {
    for (const wave of readiness.waves) {
      const surfaces = manifestSurfaces(wave.manifest);
      const declared = new Set();
      for (const id of wave.surfaces) {
        for (const field of surfaces.get(id).fields) {
          declared.add(`${id} ${field.field} <- ${field.source}`);
        }
      }
      const listed = new Set(
        wave.entries
          .filter((e) => e.aspect === "field")
          .map((e) => `${e.surface} ${e.field} <- ${e.source}`),
      );
      for (const id of declared) {
        expect(
          listed.has(id),
          `${id}: the manifest declares this field binding, and this wave neither drives nor lists it`,
        ).toBe(true);
      }
      for (const id of listed) {
        expect(
          declared.has(id),
          `${id}: the readiness list records this field binding, but the manifest does not declare it`,
        ).toBe(true);
      }
    }
  });
});
