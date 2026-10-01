// Record WHICH EXTENSION FLEET this image was built with — the image-build-time
// WRITER half of the fleet marker (the boot reader is src/lib/bundled-fleet.ts).
//
// Paired with record-bundled-digests.mjs in shape and in spirit: a tiny,
// deterministic, build-stage writer of one formatVersion=1 JSON document that
// the runtime stage copies in and exactly one boot consumer reads.
//
// WHY A FILE AT ALL. Nothing the image already carries names its fleet. The
// required-OAS seed manifest is a slug list and `.cinatra-bundled-digests.json`
// is a per-payload content-hash map: both describe the tree that ended up under
// /app/extensions, and a dev-fleet tree and a required-only tree are the same
// KIND of object to them. The Dockerfile's fleet block is the one place that
// knows, so it writes it down here.
//
// BOTH ROADS WRITE. The required-only image writes `required` — the marker is
// never the dev road's private artifact, so a missing file always means "an
// image built before this existed" (which the reader treats as `required`) and
// never "the required road skipped it".
//
// The fleet value is normalized through acquire-dev-fleet.mjs's OWN
// `parseExtensionFleet`, so the marker can never name a fleet the acquisition
// step did not take: an empty/absent value is `required`, and a typo throws and
// fails the image build rather than producing an image that lies about itself.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

import { FLEET_BUILD_ARG, parseExtensionFleet } from "./acquire-dev-fleet.mjs";

/** The marker document this writer emits. Pure — no fs, trivially testable. */
export function buildExtensionFleetMarker(fleetValue) {
  return {
    formatVersion: 1,
    generatedBy: "scripts/extensions/record-extension-fleet.mjs",
    buildArg: FLEET_BUILD_ARG,
    fleet: parseExtensionFleet(fleetValue),
  };
}

/** Write the marker to `out`. Returns the document that was written. */
export function recordExtensionFleet({ fleet, out }) {
  const doc = buildExtensionFleetMarker(fleet);
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : null;
}

function main() {
  const args = process.argv.slice(2);
  const out = argValue(args, "--out");
  if (!out) {
    console.error("usage: record-extension-fleet.mjs --fleet <required|dev> --out <file.json>");
    process.exit(2);
  }
  const doc = recordExtensionFleet({ fleet: argValue(args, "--fleet"), out });
  console.log(`[record-extension-fleet] recorded fleet "${doc.fleet}" -> ${out}`);
}

// Only run the CLI when invoked directly — importing the helpers (the shape
// tests) must NOT execute main(). Same pattern as record-bundled-digests.mjs.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}
