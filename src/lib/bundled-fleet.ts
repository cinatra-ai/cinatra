// Which EXTENSION FLEET the running image was built with — the boot-side READER
// half of the image fleet marker (the writer is
// scripts/extensions/record-extension-fleet.mjs, driven by the Dockerfile fleet
// block).
//
// The image build takes one of two roads (Dockerfile, ARG
// CINATRA_EXTENSION_FLEET): the DEFAULT `required` road acquires the prod
// bootable set and nothing else, and the `dev` road additionally materializes
// the development fleet into the SAME /app/extensions for a preview / proof
// instance. Every step after the acquisition — the OAS seed projection, the
// presence-aware manifest regeneration, the bundled-digest record — reads the
// materialized tree exactly as it is, with no knowledge of which road produced
// it. Nothing the image already carries names the fleet: neither
// `.cinatra-bundled-digests.json` (a per-payload content digest map) nor the
// required-OAS seed manifest (a slug list) can distinguish "the required set"
// from "the required set plus the dev fleet" — both are just the tree that was
// there. So the fleet block writes this marker, and this module reads it.
//
// It exists because ONE boot decision legitimately differs between the two
// roads: the static-bundle lifecycle seeder anchors the image's whole manifest
// on a dev-fleet image (so a preview instance's catalogue knows the packs it
// ships) and keeps today's serverEntry/required-in-prod seed set exactly on a
// required image. A real deployment always takes the required road, so its seed
// set is unchanged by construction.
//
// FAIL-SOFT by design, and it fails toward the DEPLOYMENT road: a boot must
// never widen its catalogue because a marker file was unreadable.
//   - absent file           → "required" (every dev boot, and every image built
//                             before the marker existed);
//   - malformed JSON / wrong shape / unknown fleet value → loud warn +
//                             "required".
//
// NO ENVIRONMENT OVERRIDE, and that is deliberate. The sibling reader
// (`bundled-digests`) takes its path from an env variable because the value it
// reads is trust-neutral provenance metadata that never reaches a decision.
// THIS value does reach one: it widens the catalogue a boot seeds and it is the
// condition under which agent rows are written. An env variable that relocated
// the marker would let a deployment's own environment turn a required image
// into a dev-fleet one without rebuilding it — a runtime fleet selector, which
// is not what "the image tells the boot which fleet it carries" means. The
// marker's location is therefore the image-baked path and nothing else; the
// optional argument below exists for this module's own unit tests, and the one
// production caller passes nothing.
//
// Pure module (fs + console only) — unit-testable without a host.

import { existsSync, readFileSync } from "node:fs";

/** Where the image build records the fleet (Dockerfile runtime stage). */
export const DEFAULT_BUNDLED_FLEET_PATH = "/app/.cinatra-extension-fleet.json";

/** The two fleets an image can carry. Mirrors acquire-dev-fleet.mjs FLEET_VALUES. */
export const BUNDLED_FLEET_REQUIRED = "required";
export const BUNDLED_FLEET_DEV = "dev";

export type BundledFleet = typeof BUNDLED_FLEET_REQUIRED | typeof BUNDLED_FLEET_DEV;

/**
 * Read the image-recorded extension fleet. Never throws; see the fail-soft
 * contract above. "required" is both the default and the fallback.
 */
export function readBundledFleet(explicitPath?: string): BundledFleet {
  const path = explicitPath ?? DEFAULT_BUNDLED_FLEET_PATH;
  try {
    if (!existsSync(path)) return BUNDLED_FLEET_REQUIRED; // dev boot / pre-marker image
    const doc: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (
      !doc ||
      typeof doc !== "object" ||
      (doc as { formatVersion?: unknown }).formatVersion !== 1
    ) {
      console.warn(
        `[bundled-fleet] ${path} is not a formatVersion=1 fleet-marker document — ` +
          `reading the image as the ${BUNDLED_FLEET_REQUIRED} fleet`,
      );
      return BUNDLED_FLEET_REQUIRED;
    }
    const fleet = (doc as { fleet?: unknown }).fleet;
    if (fleet === BUNDLED_FLEET_DEV) return BUNDLED_FLEET_DEV;
    if (fleet === BUNDLED_FLEET_REQUIRED) return BUNDLED_FLEET_REQUIRED;
    console.warn(
      `[bundled-fleet] ${path} names an unknown fleet (${String(fleet)}) — ` +
        `reading the image as the ${BUNDLED_FLEET_REQUIRED} fleet`,
    );
    return BUNDLED_FLEET_REQUIRED;
  } catch (err) {
    console.warn(
      `[bundled-fleet] failed to read ${path} — reading the image as the ` +
        `${BUNDLED_FLEET_REQUIRED} fleet:`,
      err instanceof Error ? err.message : err,
    );
    return BUNDLED_FLEET_REQUIRED;
  }
}
