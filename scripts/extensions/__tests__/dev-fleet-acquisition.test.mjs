// The dev-fleet acquisition road for the preview image.
//
// Every archive in this file is built in a TEMPORARY tree and served through an
// injected fetch — nothing here reaches the network, and nothing is written into
// the real checkout. The committed-lock cases below read the two real locks but
// never acquire from them; they exist because the counts and the disjointness of
// those two files are what the image build's pack counts are measured against.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";
import {
  FLEET_BUILD_ARG,
  FLEET_DEV,
  FLEET_REQUIRED,
  acquireDevFleetExtensions,
  parseExtensionFleet,
  readDevFleetLock,
} from "../acquire-dev-fleet.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

let tmp;
let workRoot;
let archiveRoot;

const silent = () => {};

/** Build a gzipped source archive shaped like a codeload tarball. */
async function makeArchive(pkgName, { oas = false, extraFile = null } = {}) {
  const rootDirName = `${pkgName.replace(/^@[^/]+\//, "")}-abcdef`;
  const src = path.join(archiveRoot, rootDirName);
  mkdirSync(src, { recursive: true });
  writeFileSync(path.join(src, "package.json"), JSON.stringify({ name: pkgName, version: "0.1.0" }) + "\n");
  writeFileSync(path.join(src, "README.md"), `# ${pkgName}\n`);
  if (oas) {
    mkdirSync(path.join(src, "cinatra"), { recursive: true });
    writeFileSync(
      path.join(src, "cinatra", "oas.json"),
      JSON.stringify({ openapi: "3.1.0", info: { title: pkgName } }) + "\n",
    );
  }
  if (extraFile) writeFileSync(path.join(src, extraFile.name), extraFile.body);
  const out = path.join(archiveRoot, `${rootDirName}.tar.gz`);
  await tar.c({ cwd: archiveRoot, gzip: true, file: out }, [rootDirName]);
  return readFileSync(out);
}

/** An injected fetch that serves `urlToBuffer` and counts its calls. */
function fetchServing(urlToBuffer) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const buf = urlToBuffer[url];
    if (!buf) return { ok: false, status: 404, statusText: "Not Found", body: null };
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: { get: (h) => (h.toLowerCase() === "content-length" ? String(buf.length) : null) },
      body: (async function* () {
        yield buf;
      })(),
    };
  };
  impl.calls = calls;
  return impl;
}

const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);

function writeLock(fileName, packages) {
  writeFileSync(path.join(workRoot, fileName), JSON.stringify({ schemaVersion: 1, packages }, null, 2) + "\n");
}

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), "dev-fleet-"));
  workRoot = path.join(tmp, "repo");
  archiveRoot = path.join(tmp, "archives");
  mkdirSync(path.join(workRoot, "extensions"), { recursive: true });
  mkdirSync(archiveRoot, { recursive: true });
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("parseExtensionFleet", () => {
  it("defaults an absent or empty selector to the required set", () => {
    expect(parseExtensionFleet(undefined)).toBe(FLEET_REQUIRED);
    expect(parseExtensionFleet("")).toBe(FLEET_REQUIRED);
    expect(parseExtensionFleet("   ")).toBe(FLEET_REQUIRED);
  });

  it("accepts the dev fleet", () => {
    expect(parseExtensionFleet("dev")).toBe(FLEET_DEV);
  });

  it("refuses anything else rather than quietly building the required set", () => {
    expect(() => parseExtensionFleet("devel")).toThrow(/unknown CINATRA_EXTENSION_FLEET value/);
  });

  it("names the build argument the tooling half passes", () => {
    expect(FLEET_BUILD_ARG).toBe("CINATRA_EXTENSION_FLEET");
  });
});

describe("acquireDevFleetExtensions — the required (default) road", () => {
  it("is a no-op: no lock read, no request, no file touched", async () => {
    const fetchImpl = fetchServing({});
    const res = await acquireDevFleetExtensions({
      repoRoot: workRoot,
      fleet: FLEET_REQUIRED,
      fetchImpl,
      log: silent,
    });
    expect(res.skipped).toBe(true);
    expect(res.reason).toBe("required-fleet");
    expect(fetchImpl.calls).toEqual([]);
    expect(existsSync(path.join(workRoot, "extensions", "cinatra-ai"))).toBe(false);
  });
});

describe("acquireDevFleetExtensions — the dev road", () => {
  it("materializes each locked pack where the required set lands, with an ownership marker", async () => {
    const buf = await makeArchive("@cinatra-ai/blog-idea-generator-agent", { oas: true });
    writeLock("cinatra-dev-extensions.lock.json", [
      { packageName: "@cinatra-ai/blog-idea-generator-agent", repo: "cinatra-ai/blog-idea-generator-agent", resolvedSha: SHA_A },
    ]);
    writeLock("cinatra-required-extensions.lock.json", []);
    const url = `https://codeload.github.com/cinatra-ai/blog-idea-generator-agent/tar.gz/${SHA_A}`;
    const fetchImpl = fetchServing({ [url]: buf });

    const res = await acquireDevFleetExtensions({ repoRoot: workRoot, fleet: FLEET_DEV, fetchImpl, log: silent });

    expect(res.results).toHaveLength(1);
    expect(res.results[0].action).toBe("downloaded");
    const dest = path.join(workRoot, "extensions", "cinatra-ai", "blog-idea-generator-agent");
    expect(existsSync(path.join(dest, "package.json"))).toBe(true);
    expect(existsSync(path.join(dest, "cinatra", "oas.json"))).toBe(true);
    const marker = JSON.parse(readFileSync(path.join(dest, ".cinatra-acquired.json"), "utf8"));
    expect(marker.resolvedSha).toBe(SHA_A);
    expect(marker.fleet).toBe(FLEET_DEV);
    expect(marker.treeSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("pins the URL to the locked commit SHA (an immutable ref, never a branch)", async () => {
    const buf = await makeArchive("@cinatra-ai/web-research-agent");
    writeLock("cinatra-dev-extensions.lock.json", [
      { packageName: "@cinatra-ai/web-research-agent", repo: "cinatra-ai/web-research-agent", resolvedSha: SHA_B },
    ]);
    writeLock("cinatra-required-extensions.lock.json", []);
    const url = `https://codeload.github.com/cinatra-ai/web-research-agent/tar.gz/${SHA_B}`;
    const fetchImpl = fetchServing({ [url]: buf });

    await acquireDevFleetExtensions({ repoRoot: workRoot, fleet: FLEET_DEV, fetchImpl, log: silent });
    expect(fetchImpl.calls).toEqual([url]);
  });

  it("is idempotent: a second run re-verifies the tree it wrote and makes no request", async () => {
    const buf = await makeArchive("@cinatra-ai/web-research-agent");
    writeLock("cinatra-dev-extensions.lock.json", [
      { packageName: "@cinatra-ai/web-research-agent", repo: "cinatra-ai/web-research-agent", resolvedSha: SHA_B },
    ]);
    writeLock("cinatra-required-extensions.lock.json", []);
    const url = `https://codeload.github.com/cinatra-ai/web-research-agent/tar.gz/${SHA_B}`;
    await acquireDevFleetExtensions({ repoRoot: workRoot, fleet: FLEET_DEV, fetchImpl: fetchServing({ [url]: buf }), log: silent });

    const second = fetchServing({});
    const res = await acquireDevFleetExtensions({ repoRoot: workRoot, fleet: FLEET_DEV, fetchImpl: second, log: silent });
    expect(res.results[0].action).toBe("verified-existing");
    expect(second.calls).toEqual([]);
  });

  it("refuses a pack the REQUIRED lock owns — the required road stays the sole authority for its set", async () => {
    writeLock("cinatra-dev-extensions.lock.json", [
      { packageName: "@cinatra-ai/anthropic-connector", repo: "cinatra-ai/anthropic-connector", resolvedSha: SHA_A },
    ]);
    writeLock("cinatra-required-extensions.lock.json", [
      { packageName: "@cinatra-ai/anthropic-connector", repo: "cinatra-ai/anthropic-connector", resolvedSha: SHA_B },
    ]);
    await expect(
      acquireDevFleetExtensions({ repoRoot: workRoot, fleet: FLEET_DEV, fetchImpl: fetchServing({}), log: silent }),
    ).rejects.toThrow(/pinned in BOTH locks/);
  });

  it("never clobbers a directory it does not own (an acquired required tree included)", async () => {
    const dest = path.join(workRoot, "extensions", "cinatra-ai", "planner-agent");
    mkdirSync(dest, { recursive: true });
    writeFileSync(path.join(dest, "package.json"), JSON.stringify({ name: "@cinatra-ai/planner-agent" }));
    writeLock("cinatra-dev-extensions.lock.json", [
      { packageName: "@cinatra-ai/planner-agent", repo: "cinatra-ai/planner-agent", resolvedSha: SHA_A },
    ]);
    writeLock("cinatra-required-extensions.lock.json", []);
    await expect(
      acquireDevFleetExtensions({ repoRoot: workRoot, fleet: FLEET_DEV, fetchImpl: fetchServing({}), log: silent }),
    ).rejects.toThrow(/not acquisition-managed/);
  });

  it("refuses an archive whose package.json names a different package", async () => {
    const buf = await makeArchive("@cinatra-ai/somebody-else");
    writeLock("cinatra-dev-extensions.lock.json", [
      { packageName: "@cinatra-ai/web-research-agent", repo: "cinatra-ai/web-research-agent", resolvedSha: SHA_B },
    ]);
    writeLock("cinatra-required-extensions.lock.json", []);
    const url = `https://codeload.github.com/cinatra-ai/web-research-agent/tar.gz/${SHA_B}`;
    await expect(
      acquireDevFleetExtensions({ repoRoot: workRoot, fleet: FLEET_DEV, fetchImpl: fetchServing({ [url]: buf }), log: silent }),
    ).rejects.toThrow(/does not match the locked packageName/);
  });

  it("fails the run on an HTTP failure rather than shipping a short fleet", async () => {
    writeLock("cinatra-dev-extensions.lock.json", [
      { packageName: "@cinatra-ai/web-research-agent", repo: "cinatra-ai/web-research-agent", resolvedSha: SHA_B },
    ]);
    writeLock("cinatra-required-extensions.lock.json", []);
    await expect(
      acquireDevFleetExtensions({ repoRoot: workRoot, fleet: FLEET_DEV, fetchImpl: fetchServing({}), log: silent }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe("readDevFleetLock — the committed lock", () => {
  it("accepts the committed dev lock and carries the fleet a development boot syncs", () => {
    const lock = readDevFleetLock(path.join(repoRoot, "cinatra-dev-extensions.lock.json"));
    expect(lock.packages.length).toBeGreaterThan(0);
    expect(lock.packages.map((p) => p.packageName)).toContain("@cinatra-ai/blog-idea-generator-agent");
  });

  it("is disjoint from the required lock, so the dev road never re-acquires a verified required tree", () => {
    const dev = readDevFleetLock(path.join(repoRoot, "cinatra-dev-extensions.lock.json"));
    const required = JSON.parse(
      readFileSync(path.join(repoRoot, "cinatra-required-extensions.lock.json"), "utf8"),
    );
    const requiredNames = new Set(required.packages.map((p) => p.packageName));
    const overlap = dev.packages.map((p) => p.packageName).filter((n) => requiredNames.has(n));
    expect(overlap).toEqual([]);
    // The counts an image build is measured against: required-only, and the
    // union a dev-fleet build carries.
    expect(requiredNames.size).toBe(26);
    expect(dev.packages.length).toBe(90);
  });

  it("rejects a lock entry without a 40-hex commit SHA", () => {
    writeLock("cinatra-dev-extensions.lock.json", [
      { packageName: "@cinatra-ai/web-research-agent", repo: "cinatra-ai/web-research-agent", resolvedSha: "main" },
    ]);
    expect(() => readDevFleetLock(path.join(workRoot, "cinatra-dev-extensions.lock.json"))).toThrow(
      /resolvedSha must be a 40-hex lowercase commit SHA/,
    );
  });
});
