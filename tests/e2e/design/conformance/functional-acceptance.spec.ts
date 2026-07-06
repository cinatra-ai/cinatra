/**
 * Manifest-driven functional-acceptance conformance gate (cinatra#985,
 * design-conformance L2b).
 *
 * Consumes the PINNED conformance manifests (conformance-pins.json — generated from
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
 *     (active once conformance-pins.json flips source to "published").
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
import { ensureSeeded, SURFACE_DRIVERS } from "./contract";

const pins = loadSpecPins();
const manifests = loadPinnedManifests(pins);
const allowlist = loadAllowlist();
const allowBySurface = new Map(allowlist.map((entry) => [entry.surface, entry]));

const allSurfaceIds = new Set(
  manifests.flatMap((pm) => pm.manifest.surfaces.map((s) => s.id)),
);
const surfaceById = new Map(
  manifests.flatMap((pm) => pm.manifest.surfaces.map((s) => [s.id, s] as const)),
);

/** Aspect keys a manifest surface declares ("field:x" / "action:x" / "state:x"). */
function surfaceAspects(surface: { fields: Array<{ field: string }>; actions: Array<{ action: string }>; states: string[] }): Set<string> {
  return new Set([
    ...surface.fields.map((f) => `field:${f.field}`),
    ...surface.actions.map((a) => `action:${a.action}`),
    ...surface.states.map((s) => `state:${s}`),
  ]);
}

test.describe("conformance manifest consumption", () => {
  test("allowlist entries reference real manifest surfaces/aspects and are not double-covered", () => {
    for (const entry of allowlist) {
      expect(
        allSurfaceIds.has(entry.surface),
        `allowlist.json names "${entry.surface}", which no pinned manifest declares — remove the stale entry (the ratchet only shrinks)`,
      ).toBe(true);
      const driver = SURFACE_DRIVERS[entry.surface];
      if (entry.aspects === undefined) {
        // Whole-surface exemption (pre-#986 shape): a driver means it must go.
        expect(
          driver === undefined,
          `"${entry.surface}" has BOTH a driver (contract.ts) and a whole-surface allowlist entry — delete it from allowlist.json (shrink the ratchet)`,
        ).toBe(true);
        continue;
      }
      // Aspect-level exemption (cinatra#986): the surface must be otherwise
      // covered, every aspect must exist on the manifest surface, and the
      // driver must NOT also assert an exempted aspect (double cover).
      expect(
        driver !== undefined,
        `"${entry.surface}" has an aspect-level allowlist entry but NO driver — aspect entries only narrow an otherwise-covered surface`,
      ).toBe(true);
      expect(entry.aspects.length, `"${entry.surface}" aspects[] must not be empty`).toBeGreaterThan(0);
      const declared = surfaceAspects(surfaceById.get(entry.surface)!);
      for (const aspect of entry.aspects) {
        expect(
          declared.has(aspect),
          `allowlist.json exempts "${entry.surface}" aspect "${aspect}", which the pinned manifest does not declare — remove the stale aspect (the ratchet only shrinks)`,
        ).toBe(true);
        const [kind, ...rest] = aspect.split(":");
        const name = rest.join(":");
        const covered =
          kind === "field"
            ? driver!.fields[name] !== undefined
            : kind === "action"
              ? driver!.actions[name] !== undefined
              : driver!.states[name] !== undefined;
        expect(
          covered,
          `"${entry.surface}" aspect "${aspect}" has BOTH a driver assertion (contract.ts) and an allowlist exemption — delete the aspect from allowlist.json (shrink the ratchet)`,
        ).toBe(false);
      }
    }
  });
});

for (const pm of manifests) {
  test.describe(`conformance:${pm.pin.id} (${pm.manifest.spec})`, () => {
    test("spec pin integrity — committed manifest matches conformance-pins.json", () => {
      expect(
        pm.repoSha256,
        `PIN INTEGRITY: manifests/${pm.pin.file} bytes do not hash to conformance-pins.json manifestSha256 — the committed copy must be the VERBATIM generated artifact; re-copy the generated artifact from the design-system source of truth (published under docs.cinatra.ai/references/design/conformance/) and update the pin in the same commit`,
      ).toBe(pm.pin.manifestSha256);
      expect(
        pm.manifest.contentHash,
        `PIN INTEGRITY: manifests/${pm.pin.file} embeds contentHash ${pm.manifest.contentHash} but conformance-pins.json pins ${pm.pin.specContentHash} — the pin no longer names the spec bytes this manifest was generated from`,
      ).toBe(pm.pin.specContentHash);
      expect(pm.manifest.schemaVersion, "unsupported manifest schemaVersion").toBe("1.0.0");
    });

    test("published manifest matches the spec pin (upstream drift)", async ({ request }) => {
      test.skip(
        pm.pin.source !== "published",
        `repo-pin fallback active (source: "repo") until the docs wave publishes ${pm.publishedUrl}; flip source to "published" in conformance-pins.json — no code change`,
      );
      const res = await request.get(pm.publishedUrl);
      expect(res.ok(), `could not fetch published manifest ${pm.publishedUrl} (HTTP ${res.status()})`).toBe(true);
      const body = await res.body();
      expect(
        sha256Hex(body),
        `UPSTREAM DRIFT: published manifest ${pm.publishedUrl} no longer matches the pinned artifact (conformance-pins.json manifestSha256). Upstream regenerated the manifest — review the spec change, re-pin (update manifests/${pm.pin.file} + both hashes) and extend/adjust coverage in the same PR`,
      ).toBe(pm.pin.manifestSha256);
    });

    for (const surface of pm.manifest.surfaces) {
      const driver = SURFACE_DRIVERS[surface.id];
      const allowEntry = allowBySurface.get(surface.id);
      // Aspect-level exemptions (cinatra#986): "field:x"/"action:x"/"state:x"
      // keys of an aspects[] allowlist entry skip ONLY those aspects; every
      // other annotated aspect still requires an assertion (red otherwise).
      const allowedAspects = new Set(allowEntry?.aspects ?? []);
      const wholeSurfaceAllowed = allowEntry !== undefined && allowEntry.aspects === undefined;

      if (wholeSurfaceAllowed && !driver) {
        test(`${surface.id} — allowlisted, not yet covered (coverage ratchet)`, () => {
          test.skip(true, `shrink-only allowlist: ${allowEntry!.reason}`);
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
        if (driver.seeded) {
          // Idempotent, converging provisioning of the run-namespaced seed
          // kit (cinatra#986) — memoized per worker; retries converge again.
          test.beforeAll(async () => {
            await ensureSeeded();
          });
        }

        test.beforeEach(async ({ page }) => {
          await page.goto(driver.path, { waitUntil: "domcontentloaded" });
        });

        test("surface renders", async ({ page }) => {
          await driver.present(page, driver.root(page));
        });

        for (const field of surface.fields) {
          test(`field "${field.field}" renders bound to ${field.source}`, async ({ page }) => {
            test.skip(
              allowedAspects.has(`field:${field.field}`),
              `shrink-only allowlist (aspect field:${field.field}): ${allowEntry?.reason}`,
            );
            const fieldDriver = driver.fields[field.field];
            if (!fieldDriver) {
              throw new Error(
                `Manifest field "${field.field}" (= ${field.source}) on surface "${surface.id}" has no field driver in contract.ts — an annotated field binding with no assertion counts as UNCOVERED (cinatra#986)`,
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
            test.skip(
              allowedAspects.has(`action:${action.action}`),
              `shrink-only allowlist (aspect action:${action.action}): ${allowEntry?.reason}`,
            );
            const actionDriver = driver.actions[action.action];
            if (!actionDriver) {
              throw new Error(
                `Manifest action "${action.action}" on surface "${surface.id}" has no action driver in contract.ts — an annotated action with no assertion counts as UNCOVERED (cinatra#986)`,
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
            test.skip(
              allowedAspects.has(`state:${state}`),
              `shrink-only allowlist (aspect state:${state}): ${allowEntry?.reason}`,
            );
            const assertState = driver.states[state];
            if (!assertState) {
              throw new Error(
                `Manifest state "${state}" on surface "${surface.id}" has no state driver in contract.ts — an annotated state variant with no assertion counts as UNCOVERED (cinatra#986)`,
              );
            }
            await assertState(page, driver.root(page));
          });
        }
      });
    }
  });
}
