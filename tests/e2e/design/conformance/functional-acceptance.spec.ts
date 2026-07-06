/**
 * Manifest-driven functional-acceptance conformance gate (cinatra#985,
 * design-conformance L2b).
 *
 * Consumes the PINNED conformance manifests (spec-pins.json — generated from
 * the annotated design specs, published at
 * docs.cinatra.ai/references/design/conformance/) and asserts, per covered
 * surface, on the production-equivalent standalone boot:
 *
 *   - required fields render bound to the right data,
 *   - actions produce their specified outcomes,
 *   - required state variants exist.
 *
 * Gate semantics:
 *   - A manifest surface with no driver (contract.ts) and no allowlist entry
 *     (allowlist.json — shrink-only, CI-ratcheted) is a RED.
 *   - A pin/manifest hash mismatch is a distinct "PIN INTEGRITY" red; a
 *     published-manifest/pin mismatch is a distinct "UPSTREAM DRIFT" red
 *     (active once spec-pins.json flips source to "published").
 *   - Pixel-diff + axe (design-fixtures.spec.ts) remain supporting evidence,
 *     never the sole gate.
 */
import { test, expect } from "@playwright/test";

import {
  loadAllowlist,
  loadPinnedManifests,
  loadSpecPins,
  sha256Hex,
} from "./manifest-loader";
import { SURFACE_DRIVERS } from "./contract";

const pins = loadSpecPins();
const manifests = loadPinnedManifests(pins);
const allowlist = loadAllowlist();
const allowBySurface = new Map(allowlist.map((entry) => [entry.surface, entry]));

const allSurfaceIds = new Set(
  manifests.flatMap((pm) => pm.manifest.surfaces.map((s) => s.id)),
);

test.describe("conformance manifest consumption", () => {
  test("allowlist entries reference real manifest surfaces and are not double-covered", () => {
    for (const entry of allowlist) {
      expect(
        allSurfaceIds.has(entry.surface),
        `allowlist.json names "${entry.surface}", which no pinned manifest declares — remove the stale entry (the ratchet only shrinks)`,
      ).toBe(true);
      expect(
        SURFACE_DRIVERS[entry.surface] === undefined,
        `"${entry.surface}" has BOTH a driver (contract.ts) and an allowlist entry — delete it from allowlist.json (shrink the ratchet)`,
      ).toBe(true);
    }
  });
});

for (const pm of manifests) {
  test.describe(`conformance:${pm.pin.id} (${pm.manifest.spec})`, () => {
    test("spec pin integrity — committed manifest matches spec-pins.json", () => {
      expect(
        pm.repoSha256,
        `PIN INTEGRITY: manifests/${pm.pin.file} bytes do not hash to spec-pins.json manifestSha256 — the committed copy must be the VERBATIM generated artifact; re-copy it from cinatra-ai/design and update the pin in the same commit`,
      ).toBe(pm.pin.manifestSha256);
      expect(
        pm.manifest.contentHash,
        `PIN INTEGRITY: manifests/${pm.pin.file} embeds contentHash ${pm.manifest.contentHash} but spec-pins.json pins ${pm.pin.specContentHash} — the pin no longer names the spec bytes this manifest was generated from`,
      ).toBe(pm.pin.specContentHash);
      expect(pm.manifest.schemaVersion, "unsupported manifest schemaVersion").toBe("1.0.0");
    });

    test("published manifest matches the spec pin (upstream drift)", async ({ request }) => {
      test.skip(
        pm.pin.source !== "published",
        `repo-pin fallback active (source: "repo") until the docs wave publishes ${pm.publishedUrl}; flip source to "published" in spec-pins.json — no code change`,
      );
      const res = await request.get(pm.publishedUrl);
      expect(res.ok(), `could not fetch published manifest ${pm.publishedUrl} (HTTP ${res.status()})`).toBe(true);
      const body = await res.body();
      expect(
        sha256Hex(body),
        `UPSTREAM DRIFT: published manifest ${pm.publishedUrl} no longer matches the pinned artifact (spec-pins.json manifestSha256). Upstream regenerated the manifest — review the spec change, re-pin (update manifests/${pm.pin.file} + both hashes) and extend/adjust coverage in the same PR`,
      ).toBe(pm.pin.manifestSha256);
    });

    for (const surface of pm.manifest.surfaces) {
      const driver = SURFACE_DRIVERS[surface.id];
      const allowEntry = allowBySurface.get(surface.id);

      if (allowEntry && !driver) {
        test(`${surface.id} — allowlisted, not yet covered (coverage ratchet)`, () => {
          test.skip(true, `shrink-only allowlist: ${allowEntry.reason}`);
        });
        continue;
      }

      if (!driver) {
        test(`${surface.id} — UNMAPPED manifest surface`, () => {
          throw new Error(
            `Manifest surface "${surface.id}" (${pm.manifest.spec}) has no driver in tests/e2e/design/conformance/contract.ts and no allowlist entry. ` +
              `Either add functional-acceptance coverage (driver + harness mount + testid contract) — allowlist.json is shrink-only and may NOT gain entries.`,
          );
        });
        continue;
      }

      test.describe(surface.id, () => {
        test.beforeEach(async ({ page }) => {
          await page.goto(driver.path, { waitUntil: "domcontentloaded" });
        });

        test("surface renders", async ({ page }) => {
          await driver.present(page, driver.root(page));
        });

        for (const field of surface.fields) {
          test(`field "${field.field}" renders bound to ${field.source}`, async ({ page }) => {
            const fieldDriver = driver.fields[field.field];
            if (!fieldDriver) {
              throw new Error(
                `Manifest field "${field.field}" (= ${field.source}) on surface "${surface.id}" has no field driver in contract.ts — the covered surface no longer satisfies its manifest`,
              );
            }
            if (fieldDriver.source !== field.source) {
              throw new Error(
                `Driver for "${surface.id}.${field.field}" asserts source "${fieldDriver.source}" but the pinned manifest binds "${field.source}" — reconcile contract.ts with the manifest`,
              );
            }
            await fieldDriver.assert(page, driver.root(page));
          });
        }

        for (const action of surface.actions) {
          test(`action "${action.action}" -> ${action.outcome}`, async ({ page }) => {
            const actionDriver = driver.actions[action.action];
            if (!actionDriver) {
              throw new Error(
                `Manifest action "${action.action}" on surface "${surface.id}" has no action driver in contract.ts — the covered surface no longer satisfies its manifest`,
              );
            }
            if (actionDriver.outcome !== action.outcome) {
              throw new Error(
                `Driver for "${surface.id}.${action.action}" asserts outcome "${actionDriver.outcome}" but the pinned manifest specifies "${action.outcome}" — reconcile contract.ts with the manifest`,
              );
            }
            await actionDriver.run(page, driver.root(page));
          });
        }

        for (const state of surface.states) {
          test(`state variant "${state}" exists`, async ({ page }) => {
            const assertState = driver.states[state];
            if (!assertState) {
              throw new Error(
                `Manifest state "${state}" on surface "${surface.id}" has no state driver in contract.ts — the covered surface no longer satisfies its manifest`,
              );
            }
            await assertState(page, driver.root(page));
          });
        }
      });
    }
  });
}
