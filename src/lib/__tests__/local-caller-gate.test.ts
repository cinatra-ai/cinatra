/**
 * THE ONE local-caller decision shared by /api/skills/reset-repo,
 * /api/extensions/purge and the A2A dev bypass.
 *
 * The suite is written against the attack the old Host-header check could not
 * see: a request whose `Host` says `localhost`, whose `x-forwarded-*` chain is
 * synthesised to look like a local hop, and which arrives from anywhere on the
 * network. Under the old check that request was indistinguishable from the
 * operator's own CLI. Here it must be refused three times over.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  BOOT_CREDENTIAL_HEADER,
  INSTANCE_DATA_DIR_ENV,
  mintBootCredential,
} from "@/lib/boot-credential";
import {
  CLIENT_FORWARDED_HEADER,
  NO_CLIENT_FORWARDED,
  SOCKET_PEER_HEADER,
} from "@/lib/request-peer";
import { localCallerVerdict } from "@/lib/local-caller-gate";

let dataDir: string;
let env: Record<string, string | undefined>;
let secret: string;

beforeEach(() => {
  dataDir = mkdtempSync(path.join(tmpdir(), "cinatra-local-caller-"));
  env = {
    [INSTANCE_DATA_DIR_ENV]: dataDir,
    NODE_ENV: "development",
    CINATRA_RUNTIME_MODE: "development",
  };
  secret = mintBootCredential(env);
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

/** A request as the stamp leaves it for a genuine local CLI call. */
function localRequest(extra: Record<string, string> = {}) {
  return {
    url: "http://localhost:3000/api/skills/reset-repo",
    headers: new Headers({
      [SOCKET_PEER_HEADER]: "127.0.0.1",
      [CLIENT_FORWARDED_HEADER]: NO_CLIENT_FORWARDED,
      [BOOT_CREDENTIAL_HEADER]: secret,
      ...extra,
    }),
  };
}

describe("localCallerVerdict", () => {
  it("admits the operator's own loopback call with the boot credential", () => {
    expect(localCallerVerdict(localRequest(), env)).toEqual({ ok: true });
  });

  it("REFUSES a Host: localhost request with a synthesised forwarded chain", () => {
    // The whole reason this change exists. Every header below is one a remote
    // caller can set; only the peer stamp is not.
    const spoofed = {
      url: "http://localhost:3000/api/skills/reset-repo",
      headers: new Headers({
        host: "localhost:3000",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-host": "localhost",
        "x-forwarded-proto": "http",
        [SOCKET_PEER_HEADER]: "2001:db8::1",
        [CLIENT_FORWARDED_HEADER]: "x-forwarded-for,x-forwarded-host,x-forwarded-proto",
        [BOOT_CREDENTIAL_HEADER]: secret,
      }),
    };
    const verdict = localCallerVerdict(spoofed, env);
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.status).toBe(403);
  });

  it("refuses a remote peer that presents a valid credential", () => {
    const verdict = localCallerVerdict(
      localRequest({ [SOCKET_PEER_HEADER]: "2001:db8::1" }),
      env,
    );
    expect(verdict).toEqual({
      ok: false,
      status: 403,
      reason: "non-loopback-socket-peer",
    });
  });

  it("refuses a loopback peer that presents NO credential", () => {
    const request = localRequest();
    request.headers.delete(BOOT_CREDENTIAL_HEADER);
    expect(localCallerVerdict(request, env)).toEqual({
      ok: false,
      status: 403,
      reason: "boot-credential-not-presented",
    });
  });

  it("refuses a loopback peer that presents the WRONG credential", () => {
    const verdict = localCallerVerdict(
      localRequest({ [BOOT_CREDENTIAL_HEADER]: "z".repeat(secret.length) }),
      env,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe(
      "boot-credential-not-presented",
    );
  });

  it("refuses when the client sent a forwarded header, credential and peer notwithstanding", () => {
    const verdict = localCallerVerdict(
      localRequest({ [CLIENT_FORWARDED_HEADER]: "x-forwarded-for" }),
      env,
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.ok === false && verdict.reason).toBe(
      "client-forwarded-header:x-forwarded-for",
    );
  });

  it("refuses an unstamped request — a runtime that cannot see the socket answers nobody", () => {
    const request = {
      url: "http://localhost:3000/api/skills/reset-repo",
      headers: new Headers({ [BOOT_CREDENTIAL_HEADER]: secret }),
    };
    expect(localCallerVerdict(request, env)).toEqual({
      ok: false,
      status: 403,
      reason: "socket-peer-not-stamped",
    });
  });

  it("refuses under a production build before it looks at the request at all", () => {
    expect(localCallerVerdict(localRequest(), { ...env, NODE_ENV: "production" })).toEqual(
      { ok: false, status: 403, reason: "production-build" },
    );
  });

  it("refuses outside a development runtime mode", () => {
    expect(
      localCallerVerdict(localRequest(), {
        ...env,
        CINATRA_RUNTIME_MODE: "production",
      }),
    ).toEqual({ ok: false, status: 403, reason: "not-development-runtime" });
  });

  it("refuses when no credential was ever minted, even on a loopback socket", () => {
    rmSync(dataDir, { recursive: true, force: true });
    const verdict = localCallerVerdict(localRequest(), env);
    expect(verdict.ok).toBe(false);
  });
});
