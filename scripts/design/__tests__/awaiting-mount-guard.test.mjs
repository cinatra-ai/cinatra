// The surfaces the conformance harness DRIVES but cannot yet MOUNT.
//
// Three surfaces of the application drawing (the Workspace sidebar entry, the
// Workspace scope page and its empty tab) and one surface of the staged
// artifacts drawing (the entity-page tablist) are declared by their manifests
// and fully driven in contract.ts, while their components are not on the
// default branch — they arrive with the per-scope surfaces change
// (cinatra#3152). Each driver is therefore wrapped in `awaitingMount()`, which
// SKIPS the battery with a named reason instead of passing on an assertion it
// never made.
//
// This file is what holds that arrangement honest. It is the successor of the
// pending-advance record retired when the application pin advanced: the
// advance-specific assertions went with the advance, and everything that
// guards the awaiting-mount arrangement itself lives on here, because none of
// it was ever about the pin.
//
// It reds if a driver for one of those surfaces disappears, if one is quietly
// absorbed by the shrink-only allowlist, if a testid-contract entry is added
// before the component file exists, or if the guard stops being fail-closed.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CONF_DIR = path.join(REPO_ROOT, "tests", "e2e", "design", "conformance");
const CONTRACT_TS = path.join(CONF_DIR, "contract.ts");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const contractSource = readFileSync(CONTRACT_TS, "utf8");

/** Every surface driven behind the guard, with the manifest that declares it. */
const AWAITING_SURFACES = [
  { id: "sidebar-workspace-entry", manifest: "app.json" },
  { id: "workspace-scope-page", manifest: "app.json" },
  { id: "workspace-scope-empty-tab", manifest: "app.json" },
  { id: "scope-dashboards-tab", manifest: "app-artifacts.json" },
];

describe("every awaiting-mount surface is declared and driven", () => {
  it.each(AWAITING_SURFACES)(
    "$id is declared by $manifest",
    ({ id, manifest }) => {
      const declared = readJson(path.join(CONF_DIR, "manifests", manifest)).surfaces.map(
        (surface) => surface.id,
      );
      expect(
        declared,
        `manifests/${manifest} no longer declares "${id}" — this record names a surface that does not exist.`,
      ).toContain(id);
    },
  );

  it.each(AWAITING_SURFACES)("$id has a driver registered in contract.ts", ({ id }) => {
    expect(
      contractSource.includes(`"${id}": `),
      `tests/e2e/design/conformance/contract.ts registers no driver for "${id}". A manifest surface with no driver and no allowlist entry is a red, and allowlist.json is shrink-only.`,
    ).toBe(true);
  });

  it.each(AWAITING_SURFACES)(
    "$id is driven behind the awaiting-mount guard, not stubbed",
    ({ id }) => {
      expect(
        contractSource.includes(`awaitingMount("${id}"`),
        `the driver for "${id}" is not wrapped in awaitingMount(). Its surface is not on the default branch, so its battery has to SKIP with a reason when the harness mounts nothing — never pass on an assertion it did not make.`,
      ).toBe(true);
    },
  );

  it("names the change the guard is waiting for", () => {
    expect(contractSource).toContain("cinatra#3152");
  });
});

describe("no awaiting-mount surface is absorbed instead of driven", () => {
  it("adds no allowlist entry for any of them", () => {
    const allowlist = readJson(path.join(CONF_DIR, "allowlist.json")).allow;
    const ids = AWAITING_SURFACES.map((surface) => surface.id);
    const absorbed = allowlist
      .map((entry) => entry.surface)
      .filter((surface) => ids.includes(surface));
    expect(
      absorbed,
      `allowlist.json exempts ${absorbed.join(", ")}, a surface driven behind the awaiting-mount guard. The coverage ratchet is shrink-only: an adopted surface is driven or it is not adopted.`,
    ).toEqual([]);
  });

  it("holds the testid contract back until the component files exist", () => {
    // check-conformance-testids.mjs reds on a `requires[].file` that is not in
    // the tree, so the contract entries for these surfaces land WITH the
    // components (cinatra#3152) and not before. Asserted rather than noted, so
    // an entry added early is caught here with the reason rather than as a bare
    // missing-file error from the checker.
    const contract = readJson(path.join(CONF_DIR, "testid-contract.json"));
    const early = AWAITING_SURFACES.map((surface) => surface.id).filter(
      (id) => contract.surfaces[id] !== undefined,
    );
    expect(
      early,
      `testid-contract.json covers ${early.join(", ")}, whose component files are not on this branch. Add the entry in the change that brings the component (cinatra#3152).`,
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The guard has to be fail-CLOSED.
//
// Everything above rests on one property: a driver whose surface is not on this
// branch SKIPS, and nothing else skips. A guard that reads absence from an
// instantaneous DOM count breaks that property twice over — it races a surface
// that mounts a tick after `domcontentloaded`, and it reports a harness that did
// not render at all as a surface awaiting the per-scope surfaces change. Either
// way a real failure would be reported as a skip, which is exactly the outcome
// this arrangement exists to prevent. These assertions hold the guard to it.
// ---------------------------------------------------------------------------

describe("the awaiting-mount guard is fail-closed", () => {
  it("proves the harness rendered before it is allowed to skip anything", () => {
    expect(
      /HARNESS_ANCHOR_SURFACE_ID[\s\S]{0,600}?toBeAttached/.test(contractSource),
      "awaitingMount() must first assert a surface the harness has mounted all along, so a blank page or a boot error FAILS instead of masquerading as a surface awaiting cinatra#3152.",
    ).toBe(true);
  });

  it("lets an asynchronously mounted surface settle before calling it absent", () => {
    expect(
      contractSource.includes("AWAITING_MOUNT_SETTLE_MS"),
      "awaitingMount() must wait for the mount before concluding absence — the suite navigates with waitUntil: \"domcontentloaded\", so an instantaneous count would skip a surface that mounts a tick later.",
    ).toBe(true);
    expect(
      /const mounted = await page\.locator\([^)]*\)\.count\(\)/.test(contractSource),
      "awaitingMount() still decides on an instantaneous locator count.",
    ).toBe(false);
  });

  it("grades the conditional Settings tab against the mount's own declaration", () => {
    expect(
      contractSource.includes("data-scope-has-settings"),
      "the strip assertion must read each mount's declared data-scope-has-settings rather than accepting either a trailing Settings tab or none — a settings-capable scope that lost its Settings tab would otherwise pass.",
    ).toBe(true);
  });

  it("requires both halves of the conditional strip to be mounted", () => {
    expect(
      /withSettings\.includes\(true\) && withSettings\.includes\(false\)/.test(contractSource),
      "the ratification is conditional, so the driver must require a scope WITH Settings and a scope without; grading one mount proves only half the rule.",
    ).toBe(true);
  });
});
