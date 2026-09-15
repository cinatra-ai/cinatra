// The OAS seed reads the MATERIALIZED extension set as it is — the dev fleet
// included when the image was built with the dev fleet.
//
// The seed projection is what carries an agent from the build stage into the
// runtime image, and it has never known anything about fleets: it walks the
// acquired tree and seeds every slug that carries an agent OAS. This file pins
// that: acquire a dev-only pack on the dev road, and the seed the image bakes
// carries it alongside the required set; take the required road, and the seed is
// exactly the required set's.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { FLEET_DEV, FLEET_REQUIRED, acquireDevFleetExtensions } from "../acquire-dev-fleet.mjs";
import { buildRequiredOasSeed, readSeedManifest } from "../build-required-oas-seed.mjs";

const DEV_ONLY_PACK = "@cinatra-ai/blog-idea-generator-agent";
const DEV_ONLY_SLUG = "blog-idea-generator-agent";
const REQUIRED_PACK_SLUG = "planner-agent";
const SHA = "c".repeat(40);

let tmp;
let workRoot;
let archiveRoot;
let seedOut;

const silent = () => {};

async function devPackArchive() {
  const rootDirName = `${DEV_ONLY_SLUG}-abcdef`;
  const src = path.join(archiveRoot, rootDirName);
  mkdirSync(path.join(src, "cinatra"), { recursive: true });
  writeFileSync(
    path.join(src, "cinatra", "oas.json"),
    JSON.stringify({ openapi: "3.1.0", info: { title: DEV_ONLY_SLUG } }) + "\n",
  );
  writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: DEV_ONLY_PACK, version: "0.1.0" }) + "\n");
  const out = path.join(archiveRoot, `${rootDirName}.tar.gz`);
  await tar.c({ cwd: archiveRoot, gzip: true, file: out }, [rootDirName]);
  return readFileSync(out);
}

/** Stand in for what `acquire-prod` leaves behind: one required agent tree. */
function writeAlreadyAcquiredRequiredPack() {
  const dir = path.join(workRoot, "extensions", "cinatra-ai", REQUIRED_PACK_SLUG);
  mkdirSync(path.join(dir, "cinatra"), { recursive: true });
  writeFileSync(
    path.join(dir, "cinatra", "oas.json"),
    JSON.stringify({ openapi: "3.1.0", info: { title: REQUIRED_PACK_SLUG } }) + "\n",
  );
  writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: `@cinatra-ai/${REQUIRED_PACK_SLUG}`, version: "1.0.0" }) + "\n",
  );
}

function writeLocks() {
  writeFileSync(
    path.join(workRoot, "cinatra-dev-extensions.lock.json"),
    JSON.stringify(
      { schemaVersion: 1, packages: [{ packageName: DEV_ONLY_PACK, repo: `cinatra-ai/${DEV_ONLY_SLUG}`, resolvedSha: SHA }] },
      null,
      2,
    ) + "\n",
  );
  writeFileSync(
    path.join(workRoot, "cinatra-required-extensions.lock.json"),
    JSON.stringify({ schemaVersion: 1, packages: [] }, null, 2) + "\n",
  );
}

function fetchServing(url, buf) {
  return async (requested) => {
    if (requested !== url) return { ok: false, status: 404, statusText: "Not Found", body: null };
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: () => String(buf.length) },
      body: (async function* () {
        yield buf;
      })(),
    };
  };
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "dev-fleet-seed-"));
  workRoot = path.join(tmp, "app");
  archiveRoot = path.join(tmp, "archives");
  seedOut = path.join(tmp, "seed");
  mkdirSync(path.join(workRoot, "extensions"), { recursive: true });
  mkdirSync(archiveRoot, { recursive: true });
  writeLocks();
  writeAlreadyAcquiredRequiredPack();
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("the image's OAS seed, per fleet", () => {
  it("carries a dev-only pack when the fleet is dev", async () => {
    const buf = await devPackArchive();
    await acquireDevFleetExtensions({
      repoRoot: workRoot,
      fleet: FLEET_DEV,
      fetchImpl: fetchServing(`https://codeload.github.com/cinatra-ai/${DEV_ONLY_SLUG}/tar.gz/${SHA}`, buf),
      log: silent,
    });

    buildRequiredOasSeed({ source: path.join(workRoot, "extensions"), out: seedOut });

    const manifest = readSeedManifest(seedOut);
    const seeded = manifest.slugs.map((s) => `${s.vendor}/${s.slug}`).sort();
    expect(seeded).toEqual([`cinatra-ai/${DEV_ONLY_SLUG}`, `cinatra-ai/${REQUIRED_PACK_SLUG}`]);
    // The seeded dev pack carries the very file the agent runtime scans for.
    const seededOas = path.join(seedOut, "cinatra-ai", DEV_ONLY_SLUG, "cinatra", "oas.json");
    expect(JSON.parse(readFileSync(seededOas, "utf8")).info.title).toBe(DEV_ONLY_SLUG);
  });

  it("carries exactly the required set on the default road", async () => {
    await acquireDevFleetExtensions({
      repoRoot: workRoot,
      fleet: FLEET_REQUIRED,
      fetchImpl: fetchServing("never", Buffer.alloc(0)),
      log: silent,
    });

    buildRequiredOasSeed({ source: path.join(workRoot, "extensions"), out: seedOut });

    const manifest = readSeedManifest(seedOut);
    expect(manifest.slugs.map((s) => `${s.vendor}/${s.slug}`)).toEqual([`cinatra-ai/${REQUIRED_PACK_SLUG}`]);
  });
});
