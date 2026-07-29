// Live-wire proof that a registry response body can never carry the bearer
// token out through a thrown pacote error (cinatra#2163).
//
// The failure this pins: pacote's fetch layer is npm-registry-fetch. Through
// 19 its `HttpErrorGeneral` message appended ONLY the response body's `error`
// field; from 20 (pacote 22's fetch layer) it appends `body.error` OR
// `body.message` OR — failing both — the whole body JSON-serialized. A
// registry, reverse proxy, or diagnostic error handler that echoes the inbound
// request back (its `Authorization` header included) therefore lands the
// bearer token in `Error.message` — the field that reaches logs, telemetry and
// surfaced error text. Measured against the stub below: on pacote 21 / fetch
// 19 the token is absent from `Error.message`; on pacote 22 / fetch 20 it is
// present verbatim unless the redacting facade scrubs it.
//
// These tests run the REAL pacote + npm-registry-fetch stack against an
// in-process node:http registry that is deliberately hostile. No mocks on the
// client side — if `createRedactingPacote` is ever bypassed at a call site,
// the token reappears here.

import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  getPublishedExtensionSummary,
  fetchExtensionTarballBytes,
  extractExtensionPackage,
} from "../src/verdaccio/client";
import {
  createRedactingPacote,
  redactTokenInError,
  registryScopedAuthOptions,
} from "../src/verdaccio/registry-auth";
import type { VerdaccioConfig } from "../src/types";

const TOKEN = "cinatra-bearer-SENTINEL-0123456789abcdef";
const UNRELATED = "internal-field-SENTINEL-not-the-token";
const PKG = "@cinatra-test/echo-pkg";

let server: Server;
let config: VerdaccioConfig;
/** Every Authorization header the stub actually received, in order. */
const seenAuth: Array<string | null> = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    seenAuth.push(req.headers.authorization ?? null);
    // Never let make-fetch-happen serve a cached response.
    res.setHeader("cache-control", "no-store");
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    // The hostile shape: the inbound Authorization header echoed back under
    // `message` (the field npm-registry-fetch 20 newly folds into the error
    // message), plus an unrelated internal field under a third key.
    res.end(
      JSON.stringify({
        message: `upstream failure; inbound authorization was ${req.headers.authorization}`,
        internal: UNRELATED,
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  config = {
    registryUrl: `http://127.0.0.1:${port}`,
    packageScope: "@cinatra-test",
    token: TOKEN,
    uiUrl: null,
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/**
 * Assert the protected path is BOTH reached and clean.
 *
 * The reached half matters as much as the clean half: without it, an error
 * raised before the request ever left (a bad spec, a DNS failure, a missing
 * credential) would satisfy "no token in the message" for entirely the wrong
 * reason. So every case asserts the stub saw `Bearer <TOKEN>`, that the error
 * is the stub's own 500, and that the redaction marker is present — i.e. the
 * facade actually had a token to remove — before checking the carriers.
 */
function assertReachedAndRedacted(error: unknown, authBefore: number): void {
  const err = error as Error & { body?: unknown; statusCode?: number };
  // Reached: the stub received the request, carrying the real credential.
  const seen = seenAuth.slice(authBefore);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).toContain(`Bearer ${TOKEN}`);
  // The failure is the stub's hostile 500, not something raised earlier.
  expect(err).toBeInstanceOf(Error);
  expect(err.statusCode).toBe(500);
  // The facade had something to remove — the body fold really happened.
  expect(err.message).toContain("[redacted]");
  // Clean: no carrier retains the credential.
  expect(err.message).not.toContain(TOKEN);
  expect(err.stack ?? "").not.toContain(TOKEN);
  expect(JSON.stringify(err.body ?? null)).not.toContain(TOKEN);
  // Redaction is not suppression — the failure must still be legible.
  expect(err.message).toContain("upstream failure");
}

describe("registry error redaction (cinatra#2163 — the fetch-layer body fold)", () => {
  it("packument failure reaches the registry and does not leak the bearer token", async () => {
    expect.assertions(9);
    const before = seenAuth.length;
    try {
      await getPublishedExtensionSummary({ packageName: PKG }, config);
    } catch (error) {
      assertReachedAndRedacted(error, before);
    }
  });

  it("tarball failure reaches the registry and does not leak the bearer token", async () => {
    expect.assertions(9);
    const before = seenAuth.length;
    try {
      await fetchExtensionTarballBytes({ packageName: PKG, packageVersion: "1.0.0" }, config);
    } catch (error) {
      assertReachedAndRedacted(error, before);
    }
  });

  it("extract failure reaches the registry and does not leak the bearer token", async () => {
    expect.assertions(9);
    const before = seenAuth.length;
    try {
      await extractExtensionPackage({ packageName: PKG, packageVersion: "1.0.0" }, config);
    } catch (error) {
      assertReachedAndRedacted(error, before);
    }
  });

  it("the stub really does echo the credential (the redaction is not vacuous)", async () => {
    // Same request WITHOUT the facade, built through the SAME auth derivation
    // the client uses, so the control differs from the protected paths in
    // exactly one respect: the facade. If this stops leaking, the three cases
    // above have gone quiet for the wrong reason and this test says so.
    const pacote = await import("pacote");
    let raw: (Error & { statusCode?: number }) | null = null;
    try {
      await pacote.packument(PKG, {
        registry: `${config.registryUrl}/`,
        ...registryScopedAuthOptions(config.registryUrl, TOKEN),
        retry: { retries: 0 },
      });
    } catch (error) {
      raw = error as Error & { statusCode?: number };
    }
    expect(raw).toBeInstanceOf(Error);
    expect(raw!.statusCode).toBe(500);
    expect(raw!.message).toContain(TOKEN);
  });
});

describe("redactTokenInError", () => {
  it("preserves the error identity and the status fields call sites branch on", () => {
    const err = Object.assign(new Error(`boom ${TOKEN}`), {
      statusCode: 404,
      code: "E404",
      body: { message: `echo ${TOKEN}`, internal: UNRELATED },
    });
    const out = redactTokenInError(err, TOKEN) as typeof err;
    expect(out).toBe(err);
    expect(out.statusCode).toBe(404);
    expect(out.code).toBe("E404");
    expect(out.message).toBe("boom [redacted]");
    expect((out.body as { message: string }).message).toBe("echo [redacted]");
    // Unrelated body fields are left intact — this is token redaction, not a
    // general body scrubber.
    expect((out.body as { internal: string }).internal).toBe(UNRELATED);
  });

  it("is a no-op for anonymous access (no token configured)", () => {
    const err = new Error("boom");
    expect(redactTokenInError(err, null)).toBe(err);
    expect(err.message).toBe("boom");
  });

  it("scrubs EVERY scoped credential in the options, not just the first", async () => {
    // npm-registry-fetch picks the LONGEST matching path prefix, so the token
    // actually sent may not be the first key in the object. The facade must not
    // have to re-derive that choice: it scrubs all of them.
    const OTHER = "second-scoped-credential-SENTINEL";
    const facade = createRedactingPacote({
      packument: async () => {
        throw new Error(`leak ${TOKEN} and ${OTHER}`);
      },
      tarball: async () => {
        throw new Error("unused");
      },
      extract: async () => {
        throw new Error("unused");
      },
    });
    await expect(
      facade.packument("@x/y", {
        "//host/:_authToken": TOKEN,
        "//host/deep/path/:_authToken": OTHER,
      }),
    ).rejects.toThrow("leak [redacted] and [redacted]");
  });

  it("scrubs a wrapped cause one level down", () => {
    const cause = new Error(`inner ${TOKEN}`);
    const err = Object.assign(new Error(`outer ${TOKEN}`), { cause });
    redactTokenInError(err, TOKEN);
    expect(err.message).toBe("outer [redacted]");
    expect(cause.message).toBe("inner [redacted]");
    expect(cause.stack ?? "").not.toContain(TOKEN);
  });

  it("recovers the token from the registry-scoped option key, not a flat one", async () => {
    const calls: string[] = [];
    const facade = createRedactingPacote({
      packument: async () => {
        calls.push("packument");
        throw new Error(`leak ${TOKEN}`);
      },
      tarball: async () => {
        throw new Error(`leak ${TOKEN}`);
      },
      extract: async () => {
        throw new Error(`leak ${TOKEN}`);
      },
    });

    await expect(
      facade.packument("@x/y", { "//host/:_authToken": TOKEN }),
    ).rejects.toThrow("leak [redacted]");
    // A FLAT `token` option is the shape npm-registry-fetch ignores (#179);
    // the facade must not treat it as the credential either, so nothing is
    // redacted and the mismatch stays visible rather than silently "handled".
    await expect(facade.packument("@x/y", { token: TOKEN })).rejects.toThrow(`leak ${TOKEN}`);
    expect(calls).toHaveLength(2);
  });
});
