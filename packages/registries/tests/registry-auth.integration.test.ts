// Live-wire proof for the #179 regression class: these tests run the REAL
// pacote + npm-registry-fetch stack against an in-process HTTP registry stub
// that REQUIRES auth (401 without a Bearer token, 200 with). No mocks on the
// client side — if the options shape ever stops producing an Authorization
// header (e.g. someone reverts to a flat `token` option, which
// npm-registry-fetch silently ignores), the positive-proof tests here go red.
//
// Runs in the standard vitest run: the stub is a plain node:http server on an
// ephemeral 127.0.0.1 port — no Docker, no external registry.
//
// Ordering matters: the negative (unauthenticated) cases run FIRST so a cached
// 200 can never mask a missing credential; the stub additionally sends
// `cache-control: no-store` so make-fetch-happen never caches any response.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  fetchExtensionTarballBytes,
  getPublishedExtensionSummary,
} from "../src/verdaccio/client";
import type { VerdaccioConfig } from "../src/types";

const TOKEN = "integration-test-token";
const PKG = "@cinatra-test/auth-pkg";
const TARBALL_BYTES = Buffer.from("stub-tarball-bytes-for-auth-proof");

type SeenRequest = { url: string; authorization: string | null };

let server: Server;
let registryUrl: string;
const seen: SeenRequest[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = decodeURIComponent(req.url ?? "");
    seen.push({ url, authorization: req.headers.authorization ?? null });
    // Never let make-fetch-happen cache a response — a cached 200 would let
    // the negative (no-credential) case pass without hitting auth.
    res.setHeader("cache-control", "no-store");

    if (req.headers.authorization !== `Bearer ${TOKEN}`) {
      res.statusCode = 401;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ error: "authorization required" }));
      return;
    }

    if (url.endsWith(".tgz")) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/octet-stream");
      res.end(TARBALL_BYTES);
      return;
    }

    if (url === `/${PKG}`) {
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          name: PKG,
          "dist-tags": { latest: "1.0.0" },
          versions: {
            "1.0.0": {
              name: PKG,
              version: "1.0.0",
              cinatra: { kind: "skill" },
              dist: {
                tarball: `${registryUrl}/${PKG}/-/auth-pkg-1.0.0.tgz`,
              },
            },
          },
        }),
      );
      return;
    }

    res.statusCode = 404;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  registryUrl = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

function config(token: string | null): VerdaccioConfig {
  return {
    registryUrl,
    packageScope: "@cinatra-test",
    token,
    uiUrl: null,
  };
}

describe("registry auth integration (auth-required stub)", () => {
  // ------------------------------------------------------------------
  // NEGATIVE PROOF (must run before any authenticated 200 exists):
  // no credential -> the registry's 401 surfaces to the caller.
  // ------------------------------------------------------------------
  it("packument read WITHOUT a credential surfaces the 401", async () => {
    const before = seen.length;
    const err = await getPublishedExtensionSummary(
      { packageName: PKG },
      config(null),
    ).then(
      () => null,
      (e: unknown) => e as Error & { statusCode?: number; code?: string },
    );
    expect(err).not.toBeNull();
    expect(err?.statusCode).toBe(401);
    expect(err?.code).toBe("E401");
    // The stub actually saw an unauthenticated request — no header at all.
    const reqs = seen.slice(before);
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.authorization === null)).toBe(true);
  });

  it("tarball read WITHOUT a credential surfaces the 401", async () => {
    const err = await fetchExtensionTarballBytes(
      { packageName: PKG, packageVersion: "1.0.0" },
      config(null),
    ).then(
      () => null,
      (e: unknown) => e as Error & { statusCode?: number; code?: string },
    );
    expect(err).not.toBeNull();
    expect(err?.statusCode).toBe(401);
  });

  // ------------------------------------------------------------------
  // POSITIVE PROOF: credential -> Bearer header on the wire -> success.
  // This is exactly what the flat-`token` options shape could not do.
  // ------------------------------------------------------------------
  it("packument read WITH a credential sends the Bearer header and succeeds", async () => {
    const before = seen.length;
    const summary = await getPublishedExtensionSummary(
      { packageName: PKG },
      config(TOKEN),
    );
    expect(summary.kind).toBe("skill");
    expect(summary.resolvedVersion).toBe("1.0.0");
    const reqs = seen.slice(before);
    expect(reqs.length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });

  it("tarball read WITH a credential sends the Bearer header on EVERY request (packument + tarball)", async () => {
    const before = seen.length;
    const { bytes, integrity } = await fetchExtensionTarballBytes(
      { packageName: PKG, packageVersion: "1.0.0" },
      config(TOKEN),
    );
    expect(Buffer.compare(bytes, TARBALL_BYTES)).toBe(0);
    expect(integrity).toBe(
      `sha512-${createHash("sha512").update(TARBALL_BYTES).digest("base64")}`,
    );
    const reqs = seen.slice(before);
    const tarballReqs = reqs.filter((r) => r.url.endsWith(".tgz"));
    expect(tarballReqs.length).toBeGreaterThan(0);
    expect(reqs.every((r) => r.authorization === `Bearer ${TOKEN}`)).toBe(true);
  });
});
