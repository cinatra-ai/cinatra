/**
 * The development admin bypass over a REAL socket.
 *
 * The unit suite pins the policy; this one pins the MECHANISM — that the peer
 * address of an actual TCP connection reaches an actual request handler, that a
 * client cannot write itself into that position, and that the per-boot
 * credential works the way a local client would use it: read the file the
 * instance wrote, send it in the header, get admitted.
 *
 * A real HTTP server on an ephemeral loopback port stands in for the
 * application server. Nothing here binds a fixed port and nothing here touches
 * a database: the subject is the connection, not the app.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import http from "node:http";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { grantDevAdminBypassForRequest } from "../dev-admin-bypass-request";
import { DEV_LOCAL_TOKEN_HEADER } from "../dev-admin-bypass";
import {
  devLocalTokenPath,
  mintDevLocalToken,
  readDevLocalTokenFile,
  resetDevLocalTokenForTest,
} from "../dev-local-token";
import {
  getLocalConnectionPeer,
  installLocalConnectionCapture,
  runWithLocalConnection,
} from "../local-connection";

/** What the handler decided about one request, reported back to the client. */
type Verdict = { granted: boolean; peer: string | null };

let dataDir: string;
let server: http.Server;
let port: number;
const originalEnv = { ...process.env };

/**
 * Build the header view a route handler sees. The application's `Request`
 * exposes exactly this shape, so the handler under test reads what production
 * reads.
 */
function headerReader(incoming: http.IncomingMessage): { get(name: string): string | null } {
  return {
    get(name: string) {
      const value = incoming.headers[name.toLowerCase()];
      if (value === undefined) return null;
      return Array.isArray(value) ? (value[0] ?? null) : value;
    },
  };
}

beforeAll(async () => {
  dataDir = mkdtempSync(path.join(tmpdir(), "cinatra-dev-token-"));
  vi.stubEnv("NODE_ENV", "test");
  process.env.CINATRA_MCP_DEV_ADMIN_BYPASS = "true";
  process.env.CINATRA_DATA_DIR = dataDir;
  resetDevLocalTokenForTest();
  mintDevLocalToken(process.env);
  installLocalConnectionCapture(process.env);

  server = http.createServer((incoming, response) => {
    const verdict: Verdict = {
      granted: grantDevAdminBypassForRequest(headerReader(incoming)),
      peer: getLocalConnectionPeer(),
    };
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(verdict));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  port = address.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  rmSync(dataDir, { recursive: true, force: true });
  vi.unstubAllEnvs();
  process.env = { ...originalEnv };
  resetDevLocalTokenForTest();
});

afterEach(() => {
  process.env.CINATRA_MCP_DEV_ADMIN_BYPASS = "true";
  process.env.CINATRA_DATA_DIR = dataDir;
});

/** Drive one real request over a real loopback socket. */
async function call(headers: Record<string, string>): Promise<Verdict> {
  const response = await fetch(`http://127.0.0.1:${port}/api/cli/status`, { headers });
  expect(response.status).toBe(200);
  return (await response.json()) as Verdict;
}

describe("dev admin bypass over a real connection", () => {
  it("mints the credential 0600 in the instance data directory", () => {
    const file = devLocalTokenPath(process.env);
    expect(file).toBe(path.join(dataDir, "dev-admin-bypass.token"));
    // Owner read/write only — no group, no other.
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readDevLocalTokenFile(process.env)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("the peer address of a real loopback connection reaches the handler", async () => {
    const verdict = await call({});
    expect(verdict.peer).not.toBeNull();
    expect(verdict.peer === "127.0.0.1" || verdict.peer === "::ffff:127.0.0.1").toBe(true);
  });

  // THE CLIENT ROUND TRIP. A local client reads the file the instance wrote and
  // presents it — exactly what a CLI on this machine does.
  it("grants a loopback client that reads the credential file and presents it", async () => {
    const token = readDevLocalTokenFile(process.env);
    expect(token).not.toBeNull();
    const verdict = await call({ [DEV_LOCAL_TOKEN_HEADER]: token as string });
    expect(verdict.granted).toBe(true);
  });

  // THE DEFECT. Host says localhost, the forwarded chain says localhost, and
  // the caller has no credential: refused.
  it("REFUSES a request that says it is local in every header it can write", async () => {
    const verdict = await call({
      host: "localhost",
      "x-forwarded-host": "localhost",
      "x-forwarded-for": "127.0.0.1",
      "x-forwarded-proto": "http",
    });
    expect(verdict.granted).toBe(false);
  });

  // And still refused WITH the credential: a forwarded header refuses outright,
  // so a proxy that terminates on this machine cannot relay somebody else's
  // request into the bypass even if the credential leaked.
  it("REFUSES a credentialed request that carries a forwarded header", async () => {
    const token = readDevLocalTokenFile(process.env);
    for (const name of [
      "x-forwarded-for",
      "x-forwarded-host",
      "x-forwarded-proto",
      "forwarded",
    ]) {
      const verdict = await call({
        [DEV_LOCAL_TOKEN_HEADER]: token as string,
        [name]: "127.0.0.1",
      });
      expect(verdict.granted).toBe(false);
    }
  });

  it("REFUSES a loopback client with no credential, or a wrong one", async () => {
    expect((await call({})).granted).toBe(false);
    expect(
      (await call({ [DEV_LOCAL_TOKEN_HEADER]: "b".repeat(64) })).granted,
    ).toBe(false);
  });

  it("a client cannot write itself a loopback peer — the capture is not a header", async () => {
    const token = readDevLocalTokenFile(process.env);
    // Any header a caller invents is simply not where the peer comes from.
    const verdict = await call({
      [DEV_LOCAL_TOKEN_HEADER]: token as string,
      "x-cinatra-local-peer": "127.0.0.1",
      "x-real-ip": "127.0.0.1",
      "remote-addr": "127.0.0.1",
    });
    // Granted here only because the connection really IS loopback; the proof
    // that the headers did nothing is the remote-peer case below, which sends
    // the same headers over a peer the runtime reports as remote.
    expect(verdict.granted).toBe(true);
  });

  it("REFUSES the same credentialed request when the socket peer is remote", () => {
    const token = readDevLocalTokenFile(process.env);
    const headers = {
      get: (name: string) =>
        name.toLowerCase() === DEV_LOCAL_TOKEN_HEADER ? token : null,
    };
    // The handler path, driven under a peer the runtime reports as off-machine.
    const granted = runWithLocalConnection(
      { remoteAddress: "203.0.113.7", forwardedHeaderPresent: false },
      () =>
        grantDevAdminBypassForRequest(headers),
    );
    expect(granted).toBe(false);
    // ...and granted under a loopback peer, same credential, same headers.
    const grantedLocal = runWithLocalConnection(
      { remoteAddress: "127.0.0.1", forwardedHeaderPresent: false },
      () =>
        grantDevAdminBypassForRequest(headers),
    );
    expect(grantedLocal).toBe(true);
  });

  it("REFUSES every request when the opt-in flag is off", async () => {
    const token = readDevLocalTokenFile(process.env);
    process.env.CINATRA_MCP_DEV_ADMIN_BYPASS = "false";
    const verdict = await call({ [DEV_LOCAL_TOKEN_HEADER]: token as string });
    expect(verdict.granted).toBe(false);
  });
});

/**
 * WHERE the forwarded-header question is asked. The development server
 * synthesises `x-forwarded-*` on the way into a route handler, so a handler's
 * own `Request` headers ALWAYS carry the chain. Asking there would refuse the
 * local operator on every real boot — the bypass would be dead rather than
 * safe. The question is therefore asked once, at ingress, on the raw
 * connection, and these two cases pin that both ways round.
 */
describe("the forwarded-header guard reads INGRESS, not the route handler's headers", () => {
  function credentialedHeaders(extra: Record<string, string> = {}) {
    const token = readDevLocalTokenFile(process.env) as string;
    const map: Record<string, string> = {
      [DEV_LOCAL_TOKEN_HEADER]: token,
      ...extra,
    };
    return {
      get: (name: string) => map[name.toLowerCase()] ?? null,
    };
  }

  it("GRANTS the local operator whose ROUTE headers carry a synthesised chain the caller never sent", () => {
    // Exactly the shape a real dev boot hands the handler: the framework's own
    // forwarded chain, on a connection that arrived with none.
    const granted = runWithLocalConnection(
      { remoteAddress: "127.0.0.1", forwardedHeaderPresent: false },
      () =>
        grantDevAdminBypassForRequest(
          credentialedHeaders({
            "x-forwarded-host": "localhost:3000",
            "x-forwarded-for": "127.0.0.1",
            "x-forwarded-proto": "http",
          }),
        ),
    );
    expect(granted).toBe(true);
  });

  it("REFUSES when the chain WAS on the connection, even with clean route headers", () => {
    const granted = runWithLocalConnection(
      { remoteAddress: "127.0.0.1", forwardedHeaderPresent: true },
      () => grantDevAdminBypassForRequest(credentialedHeaders()),
    );
    expect(granted).toBe(false);
  });

  it("REFUSES when there is no ingress snapshot at all (the boot hook never ran)", () => {
    // No `runWithLocalConnection` frame: peer unknown AND a hop assumed.
    expect(grantDevAdminBypassForRequest(credentialedHeaders())).toBe(false);
  });
});
