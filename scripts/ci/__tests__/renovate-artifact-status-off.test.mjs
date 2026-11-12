// The self-hosted Renovate run (.github/workflows/renovate-self-hosted.yml,
// renovate-version 44.2.3) must not try to set the `renovate/artifacts`
// commit status: the run's token cannot POST commit statuses, the POST
// answers 403 and the run stops before it updates the dependency dashboard.
// Renovate 44.2.3 skips the status when statusCheckNames.artifactError is
// null or an empty string (lib/workers/repository/update/branch/artifacts.ts,
// docs/usage/configuration-options.md "statusCheckNames").
//
// Run it with `node --test <this file>`. The root Vitest suite also
// includes this file (vitest.config.ts includes
// scripts/ci/__tests__/**/*.test.{ts,mjs}); the PR's CI run proves the
// Vitest side.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const { test } = process.env.VITEST ? await import("vitest") : await import("node:test");

const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..", "..");

test("renovate.json disables the renovate/artifacts status check (statusCheckNames.artifactError is null)", () => {
  const config = JSON.parse(readFileSync(path.join(REPO_ROOT, "renovate.json"), "utf8"));
  assert.equal(typeof config.statusCheckNames, "object");
  assert.notEqual(config.statusCheckNames, null);
  assert.ok(
    Object.prototype.hasOwnProperty.call(config.statusCheckNames, "artifactError"),
    "statusCheckNames.artifactError must be set explicitly",
  );
  assert.equal(config.statusCheckNames.artifactError, null);
});
