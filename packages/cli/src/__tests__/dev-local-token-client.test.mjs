// The CLIENT half of the development admin bypass contract.
//
// The instance mints a per-boot credential and writes it 0600 into the
// instance data directory; a local tool proves it is the operator on this
// machine by READING that file and presenting the token. This suite pins the
// client's behaviour AND pins it to the server's own constants, so the two
// halves of the contract cannot drift apart in separate edits.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  DEV_LOCAL_TOKEN_FILENAME,
  DEV_LOCAL_TOKEN_HEADER,
  FORWARDED_HEADER_NAMES,
  devLocalRequestHeaders,
  devLocalTokenPath,
  fetchLocalInstance,
  isLoopbackTargetUrl,
  readDevLocalToken,
} from "../dev-local-token-client.mjs";

import {
  DEV_LOCAL_TOKEN_HEADER as SERVER_TOKEN_HEADER,
  FORWARDED_HEADER_NAMES as SERVER_FORWARDED_HEADER_NAMES,
} from "../../../mcp-server/src/dev-admin-bypass.ts";
import {
  DEV_LOCAL_TOKEN_FILENAME as SERVER_TOKEN_FILENAME,
  devLocalTokenPath as serverDevLocalTokenPath,
  mintDevLocalToken,
  resetDevLocalTokenForTest,
} from "../../../mcp-server/src/dev-local-token.ts";

let dataDir;
let env;
let minted;

function mint() {
  resetDevLocalTokenForTest();
  return mintDevLocalToken({
    NODE_ENV: "development",
    CINATRA_MCP_DEV_ADMIN_BYPASS: "true",
    CINATRA_DATA_DIR: dataDir,
  });
}

/** A fetch stand-in that records what the client actually sent. */
function recordingFetch() {
  const calls = [];
  const impl = async (target, init) => {
    calls.push({ target, headers: new Headers(init?.headers ?? {}) });
    return new Response("{}", { status: 200 });
  };
  impl.calls = calls;
  return impl;
}

describe("the local CLI half of the dev-admin-bypass contract", () => {
  beforeEach(() => {
    dataDir = mkdtempSync(path.join(tmpdir(), "cinatra-cli-token-"));
    env = { CINATRA_DATA_DIR: dataDir };
    minted = mint();
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
    resetDevLocalTokenForTest();
  });

  // ONE contract, named in one place on each side. A rename on either side
  // turns this red instead of silently disabling every local CLI call.
  it("names the SAME header, file and forwarded-header set as the instance", () => {
    expect(DEV_LOCAL_TOKEN_HEADER).toBe(SERVER_TOKEN_HEADER);
    expect(DEV_LOCAL_TOKEN_FILENAME).toBe(SERVER_TOKEN_FILENAME);
    expect([...FORWARDED_HEADER_NAMES].sort()).toEqual(
      [...SERVER_FORWARDED_HEADER_NAMES].sort(),
    );
  });

  it("reads the credential the instance minted, from the same path", () => {
    expect(devLocalTokenPath(env)).toBe(serverDevLocalTokenPath(env));
    expect(readDevLocalToken(env)).toBe(minted);
    expect(typeof minted).toBe("string");
    expect(minted).toHaveLength(64);
  });

  it("returns null when this machine holds no credential file", () => {
    rmSync(dataDir, { recursive: true, force: true });
    expect(readDevLocalToken(env)).toBeNull();
    expect(devLocalRequestHeaders("http://127.0.0.1:3000/api/cli/status", env)).toEqual({});
  });

  it("recognises a loopback target and nothing else", () => {
    for (const target of [
      "http://127.0.0.1:3000/api/cli/status",
      "http://127.5.5.5:3000/api/cli/status",
      "http://localhost:3000/api/cli/status",
      "http://[::1]:3000/api/cli/status",
    ]) {
      expect(isLoopbackTargetUrl(target)).toBe(true);
    }
    for (const target of [
      "https://instance.cinatra.ai/api/cli/status",
      "http://10.0.0.4:3000/api/cli/status",
      "http://192.0.2.9/api/cli/status",
      "not-a-url",
    ]) {
      expect(isLoopbackTargetUrl(target)).toBe(false);
    }
  });

  it("sends the credential to the local instance and adds no forwarded header", async () => {
    const impl = recordingFetch();
    await fetchLocalInstance("http://127.0.0.1:3000/api/cli/status", {}, { env, fetchImpl: impl });
    expect(impl.calls).toHaveLength(1);
    const sent = impl.calls[0].headers;
    expect(sent.get(DEV_LOCAL_TOKEN_HEADER)).toBe(minted);
    for (const name of FORWARDED_HEADER_NAMES) {
      expect(sent.get(name)).toBeNull();
    }
  });

  // The credential authorises platform_admin on the machine that minted it.
  // It must never leave it, whatever the caller passed as a target.
  it("NEVER sends the credential to a target that is not this machine", async () => {
    const impl = recordingFetch();
    await fetchLocalInstance("https://instance.cinatra.ai/api/cli/status", {}, { env, fetchImpl: impl });
    expect(impl.calls[0].headers.get(DEV_LOCAL_TOKEN_HEADER)).toBeNull();
  });

  it("strips a forwarded header a caller tried to put on the request", async () => {
    const impl = recordingFetch();
    await fetchLocalInstance(
      "http://127.0.0.1:3000/api/cli/status",
      { headers: { "x-forwarded-for": "127.0.0.1", "x-forwarded-host": "localhost" } },
      { env, fetchImpl: impl },
    );
    const sent = impl.calls[0].headers;
    expect(sent.get("x-forwarded-for")).toBeNull();
    expect(sent.get("x-forwarded-host")).toBeNull();
    expect(sent.get(DEV_LOCAL_TOKEN_HEADER)).toBe(minted);
  });

  it("keeps the caller's own headers and method", async () => {
    const impl = recordingFetch();
    await fetchLocalInstance(
      "http://127.0.0.1:3000/api/cli/status",
      { method: "POST", headers: { accept: "application/json" } },
      { env, fetchImpl: impl },
    );
    expect(impl.calls[0].headers.get("accept")).toBe("application/json");
  });
});
