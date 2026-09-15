#!/usr/bin/env node
/**
 * Design-conformance stable-id contract check (cinatra#985; aspect-aware
 * since cinatra#986).
 *
 * Enforces, without booting anything:
 *   1. PIN INTEGRITY — each committed manifest under
 *      tests/e2e/design/conformance/manifests/ hashes to its
 *      conformance-pins.json `manifestSha256` and embeds the pinned
 *      `specContentHash` (the copies are verbatim generated artifacts,
 *      never hand-edited).
 *   2. CONTRACT VALIDITY — every surface in testid-contract.json exists in a
 *      pinned manifest and is NOT also WHOLE-SURFACE allowlisted (a covered
 *      surface must shrink the ratchet; an aspect-level entry that only
 *      narrows a covered surface is legitimate). Every allowlist entry names
 *      a real manifest surface, and every allowlist ASPECT names a real
 *      field/action/state on that surface.
 *   3. ID PRESENCE — every component source file a covered surface maps to
 *      still contains its required stable attribute literals. A covered
 *      surface missing its id is a RED: renaming a contract attribute is a
 *      breaking change to the functional-acceptance suite by design.
 *
 * Runs in CI as an early step of design-visual-verify (before the build) and
 * locally via `node scripts/design/check-conformance-testids.mjs`.
 *
 * NOTE: this file was rewritten in the #986 wave; the #985 version read the
 * pre-rename pin path (conformance/spec-pins.json) and crashed after the pin
 * file moved to tests/e2e/design/conformance-pins.json (design#35 path), and
 * carried a stray NUL byte that made git treat it as binary.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const CONF_DIR = path.join(REPO_ROOT, "tests", "e2e", "design", "conformance");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

const pins = readJson(path.join(CONF_DIR, "..", "conformance-pins.json"));
const allowlist = readJson(path.join(CONF_DIR, "allowlist.json")).allow;
const contract = readJson(path.join(CONF_DIR, "testid-contract.json"));

const errors = [];

// --- 1. Pin integrity -------------------------------------------------------
const manifestSurfaces = new Set();
const surfaceAspects = new Map(); // surface id → Set("field:x"/"action:x"/"state:x")
for (const pin of pins.manifests) {
  const file = path.join(CONF_DIR, "manifests", pin.file);
  if (!existsSync(file)) {
    errors.push(`missing committed manifest: tests/e2e/design/conformance/manifests/${pin.file}`);
    continue;
  }
  const bytes = readFileSync(file);
  if (sha256(bytes) !== pin.manifestSha256) {
    errors.push(
      `PIN INTEGRITY: manifests/${pin.file} does not hash to conformance-pins.json manifestSha256 (${pin.manifestSha256}) — re-copy the verbatim generated artifact and update the pin in the same commit`,
    );
    continue;
  }
  const manifest = JSON.parse(bytes.toString("utf8"));
  if (manifest.contentHash !== pin.specContentHash) {
    errors.push(
      `PIN INTEGRITY: manifests/${pin.file} embeds contentHash ${manifest.contentHash}, pinned ${pin.specContentHash}`,
    );
  }
  for (const surface of manifest.surfaces) {
    manifestSurfaces.add(surface.id);
    surfaceAspects.set(
      surface.id,
      new Set([
        ...surface.fields.map((f) => `field:${f.field}`),
        ...surface.actions.map((a) => `action:${a.action}`),
        ...surface.states.map((s) => `state:${s}`),
      ]),
    );
  }
}

// --- 1b. Committed but NOT yet pinned (cinatra#3156) -------------------------
// A drawing joins the pin gate only once EVERY one of its surfaces is covered
// (epic #3155, independent pinning), so between the first wave and the pin
// there is a committed manifest conformance-pins.json deliberately does not
// name. Its surfaces are REAL surfaces: a testid-contract entry or an allowlist
// aspect naming one is valid, and the drivers written against it are the ones
// the pin will later be granted for. PIN INTEGRITY above stays exactly as it
// was — it is a statement about pinned bytes, and an unpinned file has no pin
// to be checked against.
const pinnedFiles = new Set(pins.manifests.map((pin) => pin.file));
const unpinnedManifestFiles = readdirSync(path.join(CONF_DIR, "manifests"))
  .filter((file) => file.endsWith(".json") && !pinnedFiles.has(file))
  .sort();
for (const file of unpinnedManifestFiles) {
  const manifest = JSON.parse(readFileSync(path.join(CONF_DIR, "manifests", file), "utf8"));
  if (manifest.schemaVersion !== "1.0.0") {
    errors.push(`manifests/${file} declares unsupported schemaVersion ${manifest.schemaVersion}`);
    continue;
  }
  for (const surface of manifest.surfaces) {
    manifestSurfaces.add(surface.id);
    surfaceAspects.set(
      surface.id,
      new Set([
        ...surface.fields.map((f) => `field:${f.field}`),
        ...surface.actions.map((a) => `action:${a.action}`),
        ...surface.states.map((s) => `state:${s}`),
      ]),
    );
  }
}

// --- 2. Contract validity ----------------------------------------------------
const wholeSurfaceAllow = new Set(
  allowlist.filter((e) => e.aspects === undefined).map((e) => e.surface),
);
const resolveEntry = (id) => {
  const raw = contract.surfaces[id];
  if (raw && raw.$ref) return contract.shared[raw.$ref];
  return raw;
};

for (const surfaceId of Object.keys(contract.surfaces)) {
  if (manifestSurfaces.size > 0 && !manifestSurfaces.has(surfaceId)) {
    errors.push(
      `testid-contract.json covers "${surfaceId}", which no pinned manifest declares — remove it or re-pin the manifest`,
    );
  }
  if (wholeSurfaceAllow.has(surfaceId)) {
    errors.push(
      `"${surfaceId}" is BOTH covered (testid-contract.json) and whole-surface allowlisted (allowlist.json) — shrink the allowlist`,
    );
  }
  const entry = resolveEntry(surfaceId);
  if (!entry || !Array.isArray(entry.requires)) {
    errors.push(`testid-contract.json entry for "${surfaceId}" resolves to no requires[] block`);
  }
}

for (const entry of allowlist) {
  if (manifestSurfaces.size > 0 && !manifestSurfaces.has(entry.surface)) {
    errors.push(
      `allowlist.json names "${entry.surface}", which no pinned manifest declares — remove the stale entry`,
    );
    continue;
  }
  if (entry.aspects === undefined) continue;
  if (!Array.isArray(entry.aspects) || entry.aspects.length === 0) {
    errors.push(`allowlist.json entry "${entry.surface}" has an empty/invalid aspects[]`);
    continue;
  }
  const declared = surfaceAspects.get(entry.surface);
  for (const aspect of entry.aspects) {
    if (declared && !declared.has(aspect)) {
      errors.push(
        `allowlist.json exempts "${entry.surface}" aspect "${aspect}", which the pinned manifest does not declare — remove the stale aspect`,
      );
    }
  }
}

// --- 3. Stable-id presence in component source -------------------------------
const checkedPairs = new Set();
for (const surfaceId of Object.keys(contract.surfaces)) {
  const entry = resolveEntry(surfaceId);
  if (!entry || !Array.isArray(entry.requires)) continue;
  for (const req of entry.requires) {
    for (const literal of req.literals) {
      const key = `${req.file} ${literal}`;
      if (checkedPairs.has(key)) continue;
      checkedPairs.add(key);
      const abs = path.join(REPO_ROOT, req.file);
      if (!existsSync(abs)) {
        errors.push(`contract file missing: ${req.file} (required by surface "${surfaceId}")`);
        continue;
      }
      if (!readFileSync(abs, "utf8").includes(literal)) {
        errors.push(
          `covered surface "${surfaceId}" lost its stable id: ${req.file} no longer contains ${literal} — contract attributes are breaking-change-by-design (update testid-contract.json + contract.ts + the harness together)`,
        );
      }
    }
  }
}

if (errors.length > 0) {
  console.error("conformance testid-contract check FAILED:\n");
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log(
  `conformance testid-contract check OK (${Object.keys(contract.surfaces).length} covered surfaces, ${allowlist.length} allowlist entries, ${pins.manifests.length} pinned manifests, ${unpinnedManifestFiles.length} committed-not-yet-pinned)`,
);
