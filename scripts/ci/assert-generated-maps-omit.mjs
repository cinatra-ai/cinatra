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
//     Accepts ONE OR MORE absent packages (the required-only universe prune
//     removes many at once — cinatra#7, dep-drop slice). Asserts EVERY emitted file
//     contains ZERO references to EACH absent package — neither the full
//     package name (record keys, literal import specifiers) nor the bare
//     slug as a quoted map key. A leftover reference means the regeneration
//     did not presence-filter the entry — exactly the #109/#110 fresh-clone
//     build-failure class this check pins.
//     PLUS survivor assertions (anti-vacuity — an empty or gutted emission
//     must fail, not pass):
//       * every root `cinatra.systemExtensions` package still appears in
//         extensions.server.ts (the never-absent required set);
//       * the guarded-loader expectation is REGIME-AWARE (cinatra#151
//         Stage 4, the cover-gate floor): loader GUARDEDNESS is keyed on
//         `cinatra.systemExtensions` (the generator's classification
//         authority), so when the PRESENT universe (the extensions/ tree)
//         contains ONLY system extensions — the floor regime, where
//         extensions == systemExtensions — the correct emission has
//         ZERO guardedOptional loaders, and ANY `guardedExtensionImport(…)`
//         is itself a failure (a guarded loader can only reference a
//         non-system package, which is absent from this universe — a
//         stale/unfiltered emission). With ANY present non-system package
//         at least one guardedOptional loader must survive, as before.
//         Both regimes are REAL assertions — neither is vacuous, and the
//         systemExtensions survivor check above fails an empty/gutted
//         emission in either regime. Regime detection is FAIL-CLOSED:
//         a missing extensions/ tree, an unreadable manifest, or a
//         missing/empty package name is an ERROR, never a silent exclusion;
//       * the generated classification test still pins at least one entry.
//
// Usage:
//   node scripts/ci/assert-generated-maps-omit.mjs --expect-present @scope/pkg
//   node scripts/ci/assert-generated-maps-omit.mjs @scope/pkg [@scope/pkg2 ...]
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GENERATED_MANIFEST_FILES } from "../extensions/generated-manifest-files.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

const args = process.argv.slice(2);
const expectPresent = args.includes("--expect-present");
const pkgs = args.filter((a) => !a.startsWith("--"));
if (pkgs.length === 0 || pkgs.some((p) => !/^@[^/]+\/[^/]+$/.test(p)) || (expectPresent && pkgs.length !== 1)) {
  console.error(
    "[assert-generated-maps-omit] FAIL: pass scoped package name(s) (e.g. @cinatra-ai/media-feeds-connector); " +
      "--expect-present takes exactly one.",
  );
  process.exit(1);
}
// Quoted-slug form catches slug-keyed map entries ("<slug>": …) without
// false-positiving on an unrelated substring.
const slugKeyOf = (pkg) => JSON.stringify(pkg.split("/")[1]);

const SERVER_MAP_FILE = "src/lib/generated/extensions.server.ts";
const GENERATED_TEST_FILE = GENERATED_MANIFEST_FILES.find((p) => p.includes("__tests__"));
const read = (rel) => readFileSync(join(REPO_ROOT, rel), "utf8");

if (expectPresent) {
  // Pre-removal probe-meaningfulness assertion: the probe must have REAL
  // loader presence in the emitted maps (package-name specifier + slug key).
  const pkg = pkgs[0];
  const slugKey = slugKeyOf(pkg);
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
  for (const pkg of pkgs) {
    const slugKey = slugKeyOf(pkg);
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
// Regime-aware guarded-loader expectation (header note): derive the PRESENT
// extension package set from the extensions/ tree (manifest `name` fields,
// FAIL-CLOSED on unreadable/nameless manifests and on a missing tree) and
// key guardedness on `cinatra.systemExtensions` — the generator's
// classification authority (a required-but-not-system package would still
// emit guardedOptional). System-only present universe ⇒ ZERO guarded
// loaders is the correct emission and any guarded loader fails; any present
// non-system package ⇒ at least one guarded survivor must exist, as before.
const systemSet = new Set(systemExtensions);
const presentNames = [];
const extRoot = join(REPO_ROOT, "extensions");
if (!existsSync(extRoot)) {
  console.error(
    "[assert-generated-maps-omit] FAIL: extensions/ tree is missing — regime detection cannot run " +
      "(this check must execute against the pruned-but-present universe, never an empty checkout).",
  );
  failed = true;
} else {
  for (const scope of readdirSync(extRoot, { withFileTypes: true })) {
    if (!scope.isDirectory()) continue;
    for (const ext of readdirSync(join(extRoot, scope.name), { withFileTypes: true })) {
      if (!ext.isDirectory()) continue;
      const pkgPath = join(extRoot, scope.name, ext.name, "package.json");
      if (!existsSync(pkgPath)) {
        console.error(
          `[assert-generated-maps-omit] FAIL: extensions/${scope.name}/${ext.name} has no package.json — ` +
            `cannot classify the present universe (fail-closed).`,
        );
        failed = true;
        continue;
      }
      let name;
      try {
        name = JSON.parse(readFileSync(pkgPath, "utf8"))?.name;
      } catch {
        name = undefined;
      }
      if (typeof name !== "string" || name.length === 0) {
        console.error(
          `[assert-generated-maps-omit] FAIL: extensions/${scope.name}/${ext.name}/package.json has an ` +
            `unreadable or missing "name" — cannot classify the present universe (fail-closed).`,
        );
        failed = true;
        continue;
      }
      presentNames.push(name);
    }
  }
}
const nonSystemPresent = presentNames.filter((n) => !systemSet.has(n));
const systemOnlyRegime = presentNames.length > 0 && nonSystemPresent.length === 0;
const hasGuardedLoader = serverText.includes("guardedExtensionImport(");
if (systemOnlyRegime && hasGuardedLoader) {
  console.error(
    `[assert-generated-maps-omit] FAIL: the present universe is SYSTEM-ONLY (${presentNames.length} ` +
      `package(s), all in cinatra.systemExtensions) but ${SERVER_MAP_FILE} still emits a ` +
      `guardedOptional loader — a guarded loader can only reference a non-system package, ` +
      `so the emission was not presence-filtered.`,
  );
  failed = true;
} else if (presentNames.length > 0 && !systemOnlyRegime && !hasGuardedLoader) {
  console.error(
    `[assert-generated-maps-omit] FAIL: ${SERVER_MAP_FILE} contains NO guardedOptional loader while ` +
      `${nonSystemPresent.length} non-system package(s) are present (e.g. ${nonSystemPresent[0] ?? "?"}) — ` +
      `an emission with zero guarded survivors in a mixed universe cannot prove the presence contract.`,
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
  `[assert-generated-maps-omit] OK — ${GENERATED_MANIFEST_FILES.length} generated files contain no reference to ` +
    `${pkgs.length} absent package(s); survivors intact (${systemExtensions.length} system extensions, ` +
    `${systemOnlyRegime ? "system-only regime: zero guarded loaders as declared" : "mixed universe: guarded loaders survived"}, ` +
    `non-empty generated test).`,
);
