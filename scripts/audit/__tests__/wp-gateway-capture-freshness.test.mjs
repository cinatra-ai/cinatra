// wp-gateway-capture-freshness — companion tests (pure node:test, no pnpm).
//
// Drives checkFreshness(root) against temp trees that mirror the provenance
// inputs (pins.lock, fixture-plugin/, capture-annotations.mjs, api-map.json,
// equivalence.spec.ts). A capture whose provenance was built from the tree
// passes; mutating any hashed input turns it STALE; removing an input turns it
// MISSING; absent captures dir / no provenanced captures skip cleanly; invalid
// JSON is a hard error. Mirrors the pin-gate companion-test pattern (node --test).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { checkFreshness } from "../wp-gateway-capture-freshness.mjs";
import { buildProvenance } from "../../../tests/e2e/wp-mcp-gateway/provenance.mjs";

const CAPTURES_REL = "tests/e2e/wp-mcp-gateway/captures";

/** Lay down a minimal repo tree carrying every provenance input. */
function makeTree() {
  const root = mkdtempSync(path.join(tmpdir(), "wp-cap-fresh-"));
  mkdirSync(path.join(root, "docker/wordpress/fixture-plugin/includes"), { recursive: true });
  mkdirSync(path.join(root, CAPTURES_REL), { recursive: true });
  writeFileSync(path.join(root, "docker/wordpress/pins.lock"), '{"schemaVersion":1}\n');
  writeFileSync(path.join(root, "docker/wordpress/fixture-plugin/fixture-thirdparty-mcp.php"), "<?php // fixture\n");
  writeFileSync(path.join(root, "docker/wordpress/fixture-plugin/includes/abilities.php"), "<?php // abilities\n");
  writeFileSync(path.join(root, "tests/e2e/wp-mcp-gateway/capture-annotations.mjs"), "// producer\n");
  writeFileSync(path.join(root, CAPTURES_REL, "adapter-0.5.0-api-map.json"), '{"schemaVersion":1}\n');
  writeFileSync(path.join(root, "tests/e2e/wp-mcp-gateway/equivalence.spec.ts"), "// equivalence\n");
  return root;
}

/** Write a capture with a fresh provenance block computed from `root`. */
function writeCapture(root, name, keys) {
  const provenance = buildProvenance(root, { runUrl: "http://run", commit: "abc", keys });
  writeFileSync(path.join(root, CAPTURES_REL, name), JSON.stringify({ schemaVersion: 1, subClaim: "a", provenance }, null, 2));
  return provenance;
}

test("fresh capture (4 canonical hashes) passes", () => {
  const root = makeTree();
  try {
    writeCapture(root, "annotations-a-raw-tools-list.json");
    const { ok, errors, skipped, checked } = checkFreshness(root);
    assert.equal(ok, true, errors.join("\n"));
    assert.equal(skipped, false);
    assert.equal(checked, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fresh capture including equivalenceSha256 passes", () => {
  const root = makeTree();
  try {
    writeCapture(root, "verify-verdicts.json", [
      "pinsLockSha256",
      "fixturePluginSha256",
      "producerSha256",
      "apiMapSha256",
      "equivalenceSha256",
    ]);
    const { ok, errors } = checkFreshness(root);
    assert.equal(ok, true, errors.join("\n"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("mutating pins.lock after capture is STALE", () => {
  const root = makeTree();
  try {
    writeCapture(root, "annotations-a-raw-tools-list.json");
    writeFileSync(path.join(root, "docker/wordpress/pins.lock"), '{"schemaVersion":1,"changed":true}\n');
    const { ok, errors } = checkFreshness(root);
    assert.equal(ok, false);
    assert.match(errors.join("\n"), /STALE.*pinsLockSha256/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("editing a fixture-plugin file after capture is STALE (tree hash)", () => {
  const root = makeTree();
  try {
    writeCapture(root, "annotations-a-raw-tools-list.json");
    writeFileSync(path.join(root, "docker/wordpress/fixture-plugin/includes/abilities.php"), "<?php // abilities EDITED\n");
    const { ok, errors } = checkFreshness(root);
    assert.equal(ok, false);
    assert.match(errors.join("\n"), /STALE.*fixturePluginSha256/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("removing a hashed input after capture is MISSING", () => {
  const root = makeTree();
  try {
    writeCapture(root, "annotations-a-raw-tools-list.json");
    rmSync(path.join(root, "tests/e2e/wp-mcp-gateway/capture-annotations.mjs"));
    const { ok, errors } = checkFreshness(root);
    assert.equal(ok, false);
    assert.match(errors.join("\n"), /producerSha256 recorded but its input.*MISSING/s);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("absent captures dir skips cleanly", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wp-cap-fresh-empty-"));
  try {
    const { ok, skipped } = checkFreshness(root);
    assert.equal(ok, true);
    assert.equal(skipped, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("captures dir with no provenanced files skips cleanly", () => {
  const root = makeTree();
  try {
    // api-map.json has no `provenance` block — must be ignored, not flagged.
    const { ok, skipped, checked } = checkFreshness(root);
    assert.equal(ok, true);
    assert.equal(skipped, true);
    assert.equal(checked, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid JSON capture is a hard error", () => {
  const root = makeTree();
  try {
    writeFileSync(path.join(root, CAPTURES_REL, "broken.json"), "{ not json");
    const { ok, errors } = checkFreshness(root);
    assert.equal(ok, false);
    assert.match(errors.join("\n"), /broken\.json: not valid JSON/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
