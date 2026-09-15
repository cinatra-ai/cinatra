// A dev-fleet image's packs are installed at FIRST BOOT by the reconcile the
// required set already rides — there is no second road.
//
// The prod boot phase reconciles the image-baked OAS seed into the live agent
// runtime mount, and it is driven entirely by that seed's manifest: it never
// reads a lock and never asks which fleet produced the tree. So a preview image
// built with the dev fleet installs the fleet's packs at first boot by the same
// mechanism, and this walks the whole road end to end — acquire the pack the way
// the build stage does, project the seed the way the build stage does, then
// reconcile the way the boot does.
//
// WHAT "INSTALLED AT FIRST BOOT" MEANS HERE, precisely, so no reader over-reads
// this file: the seed reconcile below writes the slug into the agent runtime
// mount and the always-on marker backfill makes it loadable — that, and not a
// database row, is what makes an agent runnable on a fresh instance. A pack that
// declares a serverEntry also gets a canonical `installed_extension` anchor from
// the UNCHANGED boot seeder (bundled serverEntry or required-in-prod); a pack
// that declares none — most of the dev fleet — gets no anchor row, and the
// runtime lifecycle gate's rowless rule serves it from the image-shipped floor
// ("no row" is the ungoverned floor, only an `archived` row fails closed). So
// neither arm needed a change, and this test covers the arm the fleet rides.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import * as tar from "tar";
import { materializeRequiredExtensions } from "@/lib/required-extension-materialize";
import {
  FLEET_DEV,
  acquireDevFleetExtensions,
} from "../../../scripts/extensions/acquire-dev-fleet.mjs";
import { buildRequiredOasSeed } from "../../../scripts/extensions/build-required-oas-seed.mjs";

const DEV_ONLY_PACK = "@cinatra-ai/blog-idea-generator-agent";
const DEV_ONLY_SLUG = "blog-idea-generator-agent";
const SHA = "d".repeat(40);

let root: string;
let appRoot: string;
let archiveRoot: string;
let seedDir: string;
let installDir: string;

const silent = () => {};

async function devPackArchive(): Promise<Buffer> {
  const rootDirName = `${DEV_ONLY_SLUG}-abcdef`;
  const src = path.join(archiveRoot, rootDirName);
  mkdirSync(path.join(src, "cinatra"), { recursive: true });
  writeFileSync(
    path.join(src, "cinatra", "oas.json"),
    JSON.stringify({ openapi: "3.1.0", info: { title: DEV_ONLY_SLUG } }) + "\n",
  );
  writeFileSync(
    path.join(src, "package.json"),
    JSON.stringify({ name: DEV_ONLY_PACK, version: "0.1.0" }) + "\n",
  );
  const out = path.join(archiveRoot, `${rootDirName}.tar.gz`);
  await tar.c({ cwd: archiveRoot, gzip: true, file: out }, [rootDirName]);
  return readFileSync(out);
}

// Typed back to the global fetch shape at the boundary: the acquirer only ever
// calls it with a URL string and reads ok/status/headers/body, so a full Response
// is neither needed nor honest to fake.
function fetchServing(url: string, buf: Buffer): typeof globalThis.fetch {
  const impl = async (requested: string) => {
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
  return impl as unknown as typeof globalThis.fetch;
}

beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "dev-fleet-boot-"));
  appRoot = path.join(root, "app");
  archiveRoot = path.join(root, "archives");
  seedDir = path.join(root, "seed");
  installDir = path.join(root, "agent-mount");
  mkdirSync(path.join(appRoot, "extensions"), { recursive: true });
  mkdirSync(archiveRoot, { recursive: true });
  writeFileSync(
    path.join(appRoot, "cinatra-dev-extensions.lock.json"),
    JSON.stringify({
      schemaVersion: 1,
      packages: [{ packageName: DEV_ONLY_PACK, repo: `cinatra-ai/${DEV_ONLY_SLUG}`, resolvedSha: SHA }],
    }) + "\n",
  );
  writeFileSync(
    path.join(appRoot, "cinatra-required-extensions.lock.json"),
    JSON.stringify({ schemaVersion: 1, packages: [] }) + "\n",
  );
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("a dev-fleet image's packs at first boot", () => {
  it("rides the SAME seed reconcile the required set rides, into the agent runtime mount", async () => {
    const buf = await devPackArchive();
    await acquireDevFleetExtensions({
      repoRoot: appRoot,
      fleet: FLEET_DEV,
      fetchImpl: fetchServing(`https://codeload.github.com/cinatra-ai/${DEV_ONLY_SLUG}/tar.gz/${SHA}`, buf),
      log: silent,
    });
    buildRequiredOasSeed({ source: path.join(appRoot, "extensions"), out: seedDir });

    const result = materializeRequiredExtensions({ installDir, seedDir, failClosed: true });

    expect(result.materialized).toEqual([`cinatra-ai/${DEV_ONLY_SLUG}`]);
    expect(result.changed).toBe(true);
    const liveOas = path.join(installDir, "cinatra-ai", DEV_ONLY_SLUG, "cinatra", "oas.json");
    expect(existsSync(liveOas)).toBe(true);
    expect(JSON.parse(readFileSync(liveOas, "utf8")).info.title).toBe(DEV_ONLY_SLUG);
    expect(existsSync(path.join(installDir, "cinatra-ai", DEV_ONLY_SLUG, "package.json"))).toBe(true);
  });

  it("is idempotent across boots — a second boot re-materializes nothing", async () => {
    const buf = await devPackArchive();
    await acquireDevFleetExtensions({
      repoRoot: appRoot,
      fleet: FLEET_DEV,
      fetchImpl: fetchServing(`https://codeload.github.com/cinatra-ai/${DEV_ONLY_SLUG}/tar.gz/${SHA}`, buf),
      log: silent,
    });
    buildRequiredOasSeed({ source: path.join(appRoot, "extensions"), out: seedDir });
    materializeRequiredExtensions({ installDir, seedDir, failClosed: true });

    const second = materializeRequiredExtensions({ installDir, seedDir, failClosed: true });
    expect(second.materialized).toEqual([]);
    expect(second.unchanged).toEqual([`cinatra-ai/${DEV_ONLY_SLUG}`]);
    expect(second.changed).toBe(false);
  });
});
