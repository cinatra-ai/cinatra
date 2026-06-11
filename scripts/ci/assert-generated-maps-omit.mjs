#!/usr/bin/env node
// Presence assertions for the presence-degraded build check
// (cinatra#7), over the generator-emitted file set (the shared
// GENERATED_MANIFEST_FILES list — the explicit set, never a directory glob).
//
// Two modes, so the check can never go green VACUOUSLY:
//
//   --expect-present @scope/pkg   (run BEFORE the probe removal)
//     Asserts the maps DO reference the probe package. If the probe ever
//     loses its loader entries upstream, this step fails instead of the
//     whole job silently degenerating into "assert nothing, build anything".
//
//   (default omission mode)       (run AFTER removal + regeneration)
//     Asserts EVERY emitted file contains ZERO references to the absent
//     package — neither the full package name (record keys, literal import
//     specifiers) nor the bare slug as a quoted map key. A leftover
//     reference means the regeneration did not presence-filter the entry —
//     exactly the #109/#110 fresh-clone build-failure class this check pins.
//     PLUS survivor assertions (anti-vacuity — an empty or gutted emission
//     must fail, not pass):
//       * every root `cinatra.systemExtensions` package still appears in
//         extensions.server.ts (the never-absent required set);
//       * at least one guardedOptional loader (guardedExtensionImport(…))
//         survived in extensions.server.ts;
//       * the generated classification test still pins at least one entry.
//
// Usage:
//   node scripts/ci/assert-generated-maps-omit.mjs --expect-present @scope/pkg
//   node scripts/ci/assert-generated-maps-omit.mjs @scope/pkg
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_MANIFEST_FILES } from "../extensions/generated-manifest-files.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const args = process.argv.slice(2);
const expectPresent = args.includes("--expect-present");
const pkg = args.find((a) => !a.startsWith("--"));
if (!pkg || !/^@[^/]+\/[^/]+$/.test(pkg)) {
  console.error(
    "[assert-generated-maps-omit] FAIL: pass exactly one scoped package name (e.g. @cinatra-ai/media-feeds-connector).",
  );
  process.exit(1);
}
const slug = pkg.split("/")[1];
// Quoted-slug form catches slug-keyed map entries ("<slug>": …) without
// false-positiving on an unrelated substring.
const slugKey = JSON.stringify(slug);

const SERVER_MAP_FILE = "src/lib/generated/extensions.server.ts";
const GENERATED_TEST_FILE = GENERATED_MANIFEST_FILES.find((p) => p.includes("__tests__"));
const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

if (expectPresent) {
  // Pre-removal probe-meaningfulness assertion: the probe must have REAL
  // loader presence in the emitted maps (package-name specifier + slug key).
  const text = read(SERVER_MAP_FILE);
  if (!text.includes(pkg) || !text.includes(slugKey)) {
    console.error(
      `[assert-generated-maps-omit] FAIL: ${SERVER_MAP_FILE} does not reference ${pkg} ` +
        `(package name present: ${text.includes(pkg)}, slug key ${slugKey} present: ${text.includes(slugKey)}). ` +
        `The probe package no longer exercises the presence contract — pick a probe with real loader entries.`,
    );
    process.exit(1);
  }
  console.log(
    `[assert-generated-maps-omit] OK — probe ${pkg} is referenced by ${SERVER_MAP_FILE} (removal will be meaningful).`,
  );
  process.exit(0);
}

let failed = false;
for (const rel of GENERATED_MANIFEST_FILES) {
  const text = read(rel);
  const hits = [];
  if (text.includes(pkg)) hits.push(`package name "${pkg}"`);
  if (text.includes(slugKey)) hits.push(`slug key ${slugKey}`);
  if (hits.length > 0) {
    console.error(
      `[assert-generated-maps-omit] FAIL: ${rel} still references the absent package (${hits.join(", ")}).`,
    );
    failed = true;
  }
}

// Survivor assertions (anti-vacuity): omission must come from PRESENCE
// FILTERING of one package, never from an empty/gutted emission.
const serverText = read(SERVER_MAP_FILE);
const rootPkg = JSON.parse(read("package.json"));
const systemExtensions = rootPkg?.cinatra?.systemExtensions ?? [];
if (!Array.isArray(systemExtensions) || systemExtensions.length === 0) {
  console.error(
    "[assert-generated-maps-omit] FAIL: root package.json declares no cinatra.systemExtensions — cannot assert survivors.",
  );
  failed = true;
}
for (const name of systemExtensions) {
  if (!serverText.includes(JSON.stringify(name))) {
    console.error(
      `[assert-generated-maps-omit] FAIL: system extension ${name} is missing from ${SERVER_MAP_FILE} — ` +
        `the regeneration dropped part of the never-absent required set (gutted emission, not presence filtering).`,
    );
    failed = true;
  }
}
if (!serverText.includes("guardedExtensionImport(")) {
  console.error(
    `[assert-generated-maps-omit] FAIL: ${SERVER_MAP_FILE} contains NO guardedOptional loader — ` +
      `an emission with zero guarded survivors cannot prove the presence contract.`,
  );
  failed = true;
}
if (GENERATED_TEST_FILE) {
  const testText = read(GENERATED_TEST_FILE);
  // Entry rows are `{ map: "<MAP_NAME>", … }` — the quote distinguishes them
  // from the EXPECTED TYPE ANNOTATION (`{ map: string; … }`), which exists
  // even when the list is empty.
  if (!testText.includes('{ map: "')) {
    console.error(
      `[assert-generated-maps-omit] FAIL: ${GENERATED_TEST_FILE} pins ZERO entries — the generated ` +
        `classification test would pass vacuously.`,
    );
    failed = true;
  }
} else {
  console.error(
    "[assert-generated-maps-omit] FAIL: GENERATED_MANIFEST_FILES lists no generated __tests__ file.",
  );
  failed = true;
}

if (failed) {
  console.error(
    "[assert-generated-maps-omit] The regenerated maps must OMIT every absent package/subpath (presence-aware emission) while RETAINING the present universe.",
  );
  process.exit(1);
}
console.log(
  `[assert-generated-maps-omit] OK — ${GENERATED_MANIFEST_FILES.length} generated files contain no reference to ${pkg}; ` +
    `survivors intact (${systemExtensions.length} system extensions + guarded loaders + non-empty generated test).`,
);
