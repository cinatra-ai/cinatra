// The PENDING pin advance of the application conformance manifest
// (epic cinatra#2806, part of cinatra#3144).
//
// The ratified drawing made the entity-page tablist a five-entry strip on every
// scope, added a Workspace scope, and gave the application drawing a Workspace
// sidebar entry and a Workspace scope page. Its conformance manifest was
// regenerated and published for that revision. This repository has NOT adopted
// the regenerated manifest into tests/e2e/design/conformance-pins.json, and
// deliberately so, for two independent reasons:
//
//   1. A pin advance is a claim that the code on THIS branch satisfies the
//      drawing at the new revision. The three surfaces the amendment adds are
//      not on the default branch — they arrive with the per-scope surfaces
//      change (cinatra#3152). Advancing now would assert conformance the code
//      cannot answer for, and each of the three would immediately be an
//      UNMAPPED-surface red in the functional-acceptance suite.
//   2. scripts/ci/design-pin-drift.mjs compares every pin to the bytes the
//      documentation site actually serves, unconditionally and regardless of the
//      entry's `source`. That site still serves the pre-amendment artifact, so
//      an advance today is additionally a `drift` red.
//
// Neither reason is a licence to forget the advance, and a sentence in a pull
// request body is not a record. THIS FILE is the record: the exact values the
// pin takes, the surfaces the advance adds, and the preconditions that release
// it. It turns red if the repository drifts away from what it says here — if a
// driver for one of the new surfaces disappears, if one of them is quietly
// absorbed by the shrink-only allowlist, or if the advance lands and this
// record is not retired in the same change.
//
// TO LAND THE ADVANCE (once cinatra#3152 is on the default branch AND the
// documentation site serves the amended artifact): copy the published manifest
// verbatim over tests/e2e/design/conformance/manifests/app.json, set the two
// `to` hashes below into the "app" entry of conformance-pins.json, add the
// testid-contract.json entries for the three surfaces (they cannot be added
// before then — check-conformance-testids.mjs reds on a contract file that does
// not exist), and DELETE this file.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..", "..");
const CONF_DIR = path.join(REPO_ROOT, "tests", "e2e", "design", "conformance");
const CONTRACT_TS = path.join(CONF_DIR, "contract.ts");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const SHA256_HEX = /^[0-9a-f]{64}$/;
const PREFIXED_SHA256 = /^sha256:[0-9a-f]{64}$/;

/**
 * The advance this repository still owes the ratified drawing.
 *
 * `from` is what conformance-pins.json holds today; `to` is the published
 * artifact's byte hash and its embedded spec-source hash, read from the
 * published conformance manifest and recorded here verbatim. `addedSurfaces`
 * are the surfaces the regenerated manifest declares that the pinned one does
 * not — the ones whose drivers have to exist before the advance may be made.
 */
const PENDING_APP_ADVANCE = {
  pinId: "app",
  file: "app.json",
  from: {
    manifestSha256: "379e7673771e6f582626057201425e325cf684d578b5bfdc9e7d4e5511e6a215",
    specContentHash: "sha256:3d63418e9c8cef191a1a7a4c1ef43b842fe2ec5ef4db288fb616e4e436d5eb13",
  },
  to: {
    manifestSha256: "e3e59dfd5b832f408bcba30649234f1bd0fb4f5774531347a0c8fad19fc77ddc",
    specContentHash: "sha256:ce3effaa5b7846bc36bc92ad136721f5e278a56d5653a66f2c19fff1ff0f8168",
  },
  addedSurfaces: ["sidebar-workspace-entry", "workspace-scope-page", "workspace-scope-empty-tab"],
};

const pins = readJson(path.join(CONF_DIR, "..", "conformance-pins.json"));
const appPin = pins.manifests.find((pin) => pin.id === PENDING_APP_ADVANCE.pinId);
const contractSource = readFileSync(CONTRACT_TS, "utf8");

describe("the pending application pin advance is recorded, not lost", () => {
  it("still names the pin it moves", () => {
    expect(
      appPin,
      `conformance-pins.json no longer carries a "${PENDING_APP_ADVANCE.pinId}" pin — this record names a pin that does not exist.`,
    ).toBeDefined();
    expect(appPin.file).toBe(PENDING_APP_ADVANCE.file);
  });

  it("is still pending — or has landed and this record must go with it", () => {
    expect(
      appPin.manifestSha256,
      "conformance-pins.json no longer holds the pre-amendment application pin. If the advance has landed, DELETE this record file in the same change: a pending-advance record that outlives its advance is a false claim about what the repository still owes.",
    ).toBe(PENDING_APP_ADVANCE.from.manifestSha256);
    expect(appPin.specContentHash).toBe(PENDING_APP_ADVANCE.from.specContentHash);
  });

  it("records the target values in the exact shape the pin file accepts", () => {
    // Recorded so the advance is a copy, never a re-derivation: the pin file's
    // own structural check refuses anything else, and a value that could not be
    // pasted in is not a usable record.
    expect(PENDING_APP_ADVANCE.to.manifestSha256).toMatch(SHA256_HEX);
    expect(PENDING_APP_ADVANCE.to.specContentHash).toMatch(PREFIXED_SHA256);
    expect(PENDING_APP_ADVANCE.to.manifestSha256).not.toBe(
      PENDING_APP_ADVANCE.from.manifestSha256,
    );
    expect(PENDING_APP_ADVANCE.to.specContentHash).not.toBe(
      PENDING_APP_ADVANCE.from.specContentHash,
    );
  });
});

describe("the surfaces the advance adds are already driven", () => {
  it.each(PENDING_APP_ADVANCE.addedSurfaces)(
    "%s has a driver registered in contract.ts",
    (surfaceId) => {
      expect(
        contractSource.includes(`"${surfaceId}": `),
        `tests/e2e/design/conformance/contract.ts registers no driver for "${surfaceId}". The advance may not be made until it does — the moment the pin moves, a manifest surface with no driver and no allowlist entry is a red, and allowlist.json is shrink-only.`,
      ).toBe(true);
    },
  );

  it.each(PENDING_APP_ADVANCE.addedSurfaces)(
    "%s is driven behind the awaiting-mount guard, not stubbed",
    (surfaceId) => {
      expect(
        contractSource.includes(`awaitingMount("${surfaceId}"`),
        `the driver for "${surfaceId}" is not wrapped in awaitingMount(). Its surface is not on the default branch, so its battery has to SKIP with a reason when the harness mounts nothing — never pass on an assertion it did not make.`,
      ).toBe(true);
    },
  );

  it("names the change the guard is waiting for", () => {
    expect(contractSource).toContain("cinatra#3152");
  });
});

describe("the advance absorbs nothing it should drive", () => {
  it("adds no allowlist entry for a surface it introduces", () => {
    const allowlist = readJson(path.join(CONF_DIR, "allowlist.json")).allow;
    const absorbed = allowlist
      .map((entry) => entry.surface)
      .filter((surface) => PENDING_APP_ADVANCE.addedSurfaces.includes(surface));
    expect(
      absorbed,
      `allowlist.json exempts ${absorbed.join(", ")}, a surface this advance introduces. The coverage ratchet is shrink-only: a newly adopted surface is driven or it is not adopted.`,
    ).toEqual([]);
  });

  it("holds the testid contract back until the component files exist", () => {
    // check-conformance-testids.mjs reds on a `requires[].file` that is not in
    // the tree, so the contract entries for these three surfaces land WITH the
    // components (cinatra#3152) and not before. Asserted rather than noted, so
    // an entry added early is caught here with the reason rather than as a bare
    // missing-file error from the checker.
    const contract = readJson(path.join(CONF_DIR, "testid-contract.json"));
    const early = PENDING_APP_ADVANCE.addedSurfaces.filter(
      (surface) => contract.surfaces[surface] !== undefined,
    );
    expect(
      early,
      `testid-contract.json covers ${early.join(", ")}, whose component files are not on this branch. Add the entry in the change that brings the component (cinatra#3152) and retire this record with the pin advance.`,
    ).toEqual([]);
  });
});

describe("the committed application manifest is untouched by this record", () => {
  it("still hashes to the pinned bytes", () => {
    const file = path.join(CONF_DIR, "manifests", PENDING_APP_ADVANCE.file);
    expect(existsSync(file)).toBe(true);
    expect(readJson(file).contentHash).toBe(PENDING_APP_ADVANCE.from.specContentHash);
  });
});

// ---------------------------------------------------------------------------
// The SECOND drawing the same ratification amended.
//
// The artifacts drawing is staged, not pinned (see
// conformance-manifest-staging.test.mjs), so no pin advance is owed for it. What
// IS owed is the surface the amendment is about: the entity-page tablist, which
// the drawing now draws as the five-entry strip with Settings appended last only
// where a scope has one. Its manifest surface is `scope-dashboards-tab`.
//
// Measured against the two published artifacts: the amendment moved the drawing
// bytes (contentHash) and moved NO declared aspect of that surface — its one
// field, its three actions and its four states are identical before and after.
// So there is nothing new for a manifest-driven assertion to say about the strip
// itself; the strip is graded by the drawing check in the design source and, on
// the product side, by the visual-conformance road. What this repository owes is
// the DRIVER for the surface, which it has never had, so that the moment the
// surface exists the whole battery runs against the amended drawing.
// ---------------------------------------------------------------------------

const AMENDED_ARTIFACTS_SURFACE = "scope-dashboards-tab";

describe("the amended artifacts surface is driven, behind the same guard", () => {
  it("is declared by the staged artifacts manifest", () => {
    const manifest = readJson(
      path.join(CONF_DIR, "manifests", "app-artifacts.json"),
    );
    expect(
      manifest.surfaces.map((surface) => surface.id),
      `the staged artifacts manifest no longer declares "${AMENDED_ARTIFACTS_SURFACE}" — this record names a surface that does not exist.`,
    ).toContain(AMENDED_ARTIFACTS_SURFACE);
  });

  it("has a driver registered in contract.ts", () => {
    expect(
      contractSource.includes(`"${AMENDED_ARTIFACTS_SURFACE}": `),
      `tests/e2e/design/conformance/contract.ts registers no driver for "${AMENDED_ARTIFACTS_SURFACE}", the surface this ratification amended. A staged manifest generates no test for an undriven surface, so without the driver the amendment is adopted by nobody.`,
    ).toBe(true);
  });

  it("is driven behind the awaiting-mount guard, not stubbed", () => {
    expect(
      contractSource.includes(`awaitingMount("${AMENDED_ARTIFACTS_SURFACE}"`),
      `the driver for "${AMENDED_ARTIFACTS_SURFACE}" is not wrapped in awaitingMount(). Its surface arrives with the per-scope surfaces change, so its battery has to SKIP with a reason while the harness mounts nothing — never pass on an assertion it did not make.`,
    ).toBe(true);
  });

  it("is absorbed by no allowlist entry", () => {
    const allowlist = readJson(path.join(CONF_DIR, "allowlist.json")).allow;
    expect(
      allowlist.map((entry) => entry.surface),
      "the coverage ratchet is shrink-only: the surface this ratification amended is driven or it is not adopted.",
    ).not.toContain(AMENDED_ARTIFACTS_SURFACE);
  });

  it("holds its testid contract back until the component files exist", () => {
    const contract = readJson(path.join(CONF_DIR, "testid-contract.json"));
    expect(
      contract.surfaces[AMENDED_ARTIFACTS_SURFACE],
      `testid-contract.json covers "${AMENDED_ARTIFACTS_SURFACE}", whose component files are not on this branch — check-conformance-testids.mjs reds on a requires[].file that is not in the tree. Add the entry in the change that brings the component (cinatra#3152).`,
    ).toBeUndefined();
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
// the whole record exists to prevent. These assertions hold the guard to it.
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
