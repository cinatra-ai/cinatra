// The local CLI round trip, over a REAL socket.
//
// Every other suite drives the trust decision with a supplied peer address.
// This one opens an actual HTTP listener on a loopback port, lets the runtime
// report the peer itself, and has the CLI client read the real 0600 credential
// file off disk and send it. So the whole contract is exercised end to end:
// mint at boot -> file on disk -> client reads it -> real connection -> the
// instance's own decision.
//
// It also drives the attack the change closes: a caller that writes
// `Host: localhost` and the forwarded chain a development server would
// synthesise from it, over the same listener, is REFUSED.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { fetchLocalInstance } from "../dev-local-token-client.mjs";
import { grantDevAdminBypassForRequest } from "../../../mcp-server/src/dev-admin-bypass-request.ts";
import {
  mintDevLocalToken,
  resetDevLocalTokenForTest,
} from "../../../mcp-server/src/dev-local-token.ts";
import { installLocalConnectionCapture } from "../../../mcp-server/src/local-connection.ts";

let server;
let origin;
let dataDir;
let env;
let bootToken;
let previousFlag;

/** The instance side: the shared decision, over whatever arrived. */
function handler(request, response) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) headers.set(name, value.join(","));
  }
  const granted = grantDevAdminBypassForRequest(headers);
  response.writeHead(granted ? 200 : 401, { "content-type": "application/json" });
  response.end(JSON.stringify({ granted }));
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "cinatra-cli-roundtrip-"));
  env = { CINATRA_DATA_DIR: dataDir };
  previousFlag = process.env.CINATRA_MCP_DEV_ADMIN_BYPASS;
  process.env.CINATRA_MCP_DEV_ADMIN_BYPASS = "true";

  installLocalConnectionCapture();
  resetDevLocalTokenForTest();
  bootToken = mintDevLocalToken({
    NODE_ENV: "development",
    CINATRA_MCP_DEV_ADMIN_BYPASS: "true",
    CINATRA_DATA_DIR: dataDir,
  });

  server = http.createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
  rmSync(dataDir, { recursive: true, force: true });
  resetDevLocalTokenForTest();
  if (previousFlag === undefined) delete process.env.CINATRA_MCP_DEV_ADMIN_BYPASS;
  else process.env.CINATRA_MCP_DEV_ADMIN_BYPASS = previousFlag;
});

describe("local CLI round trip over a real loopback connection", () => {
  it("grants the local operator: the client reads the boot credential and is admitted", async () => {
    const response = await fetchLocalInstance(`${origin}/api/cli/status`, {}, { env });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ granted: true });
  });

  // THE DEFECT the change closes. Same listener, same loopback reachability a
  // proxy or tunnel terminating on this machine would have — but the caller
  // holds no credential and only CLAIMS to be local in its headers.
  it("REFUSES a caller that only claims to be local in its headers", async () => {
    const response = await fetch(`${origin}/api/cli/status`, {
      headers: {
        host: "localhost",
        "x-forwarded-host": "localhost",
        "x-forwarded-for": "127.0.0.1",
        "x-forwarded-proto": "http",
      },
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ granted: false });
  });

  it("REFUSES even the real credential once a forwarded header is on the request", async () => {
    const response = await fetch(`${origin}/api/cli/status`, {
      headers: {
        "x-cinatra-dev-local-token": bootToken,
        "x-forwarded-for": "127.0.0.1",
      },
    });
    expect(response.status).toBe(401);
  });

  it("REFUSES a loopback caller that presents no credential", async () => {
    const response = await fetch(`${origin}/api/cli/status`);
    expect(response.status).toBe(401);
  });

  it("REFUSES a loopback caller presenting a credential of the right shape but the wrong value", async () => {
    const response = await fetch(`${origin}/api/cli/status`, {
      headers: { "x-cinatra-dev-local-token": "0".repeat(bootToken.length) },
    });
    expect(response.status).toBe(401);
  });
});
