/**
 * THE LOCAL-CALLER GATE, AGAINST A REAL RUNNING DEV SERVER.
 *
 * This tier exists for one claim that a unit test cannot settle, and that the
 * codebase had been repeating to itself from a comment: that the dev server
 * SYNTHESISES the forwarded headers, so a check which disqualifies on their
 * PRESENCE refuses every request there is.
 *
 * It is true. MEASURED here on a live server, a `curl` that sent no forwarded
 * header of its own reached the route handler carrying all four of:
 *
 *     x-forwarded-for: 127.0.0.1
 *     x-forwarded-host: 127.0.0.1:<port>
 *     x-forwarded-port: <port>
 *     x-forwarded-proto: http
 *
 * The framework writes them itself (next/dist/server/base-server.js, the
 * `req.headers['x-forwarded-*'] ??= …` block, with `x-forwarded-for` filled from
 * `originalRequest.socket.remoteAddress`). Because those assignments are `??=`,
 * they only fill a header the client did NOT send — which also means that by the
 * time a handler sees them, the framework can no longer tell the two apart
 * either. That is why the stamp in @/lib/request-peer is taken on the
 * diagnostics channel, before any of it happens.
 *
 * What the suite pins down, end to end and through the real HTTP stack:
 *   • the boot mints a 0600 credential where the shared constant says it will;
 *   • a local call that sends NO forwarded header PASSES the gate — the exact
 *     request the old presence check refused;
 *   • the same call refuses without the credential, and with a wrong one;
 *   • the same call refuses the moment the CLIENT sends a forwarded header,
 *     even holding the correct credential;
 *   • a caller cannot forge either stamp.
 *
 * It self-skips without its own flag (the dedicated config sets it), because a
 * suite whose only failure mode is "skipped" reports success by doing nothing.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  BOOT_CREDENTIAL_HEADER,
  BOOT_CREDENTIAL_MIN_LENGTH,
  bootCredentialPath,
} from "@/lib/boot-credential";
import {
  CLIENT_FORWARDED_HEADER,
  SOCKET_PEER_HEADER,
} from "@/lib/request-peer";

const ARMED = process.env.CINATRA_LOOPBACK_DEV_SERVER_TEST === "1";
const repoRoot = path.resolve(__dirname, "..", "..", "..");

/** A free TCP port above 3200 — the dev ports below that belong to the stack. */
async function freePortAbove3200(): Promise<number> {
  for (let port = 3220; port < 3400; port += 1) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = net
        .createServer()
        .once("error", () => resolve(false))
        .once("listening", () => probe.close(() => resolve(true)))
        .listen(port, "127.0.0.1");
    });
    if (free) return port;
  }
  throw new Error("no free port above 3200");
}

let server: ChildProcess | undefined;
let port = 0;
let origin = "";
let credential = "";

describe.skipIf(!ARMED)("the local-caller gate on a live dev server", () => {
  beforeAll(async () => {
    port = await freePortAbove3200();
    origin = `http://127.0.0.1:${port}`;
    server = spawn(
      process.execPath,
      [
        path.join(repoRoot, "node_modules", "next", "dist", "bin", "next"),
        "dev",
        "--port",
        String(port),
        "--hostname",
        "127.0.0.1",
      ],
      {
        cwd: repoRoot,
        // NODE_ENV MUST be development for the child. Next does not load
        // `.env.local` under NODE_ENV=test, and this app's next.config.ts throws
        // on a missing SUPABASE_DB_URL — so a child that inherited vitest's
        // NODE_ENV boots to a config error instead of a server.
        env: { ...process.env, NODE_ENV: "development", PORT: String(port) },
        stdio: "ignore",
        detached: false,
      },
    );

    const deadline = Date.now() + 240_000;
    for (;;) {
      if (Date.now() > deadline) throw new Error("dev server never became ready");
      try {
        const health = await fetch(`${origin}/api/health`);
        if (health.ok) break;
      } catch {
        // not listening yet
      }
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }

    // The boot mints the credential; read it the way a local caller would.
    credential = readFileSync(bootCredentialPath(process.env), "utf8").trim();
  }, 300_000);

  afterAll(() => {
    server?.kill("SIGTERM");
  });

  it("minted this boot's credential at the shared path, 0600", () => {
    const file = bootCredentialPath(process.env);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(credential.length).toBeGreaterThanOrEqual(BOOT_CREDENTIAL_MIN_LENGTH);
  });

  /** The purge route is the one of the three that is middleware-exempt, so it
   *  reaches its own gate with no session — which is what is under test. */
  async function purge(headers: Record<string, string>) {
    return fetch(`${origin}/api/extensions/purge`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });
  }

  it("ADMITS a local call that sends no forwarded header — the request the old check refused", async () => {
    const response = await purge({ [BOOT_CREDENTIAL_HEADER]: credential });
    // Past the gate and into the route's own digest handshake. Under a
    // presence-based check this same request never got here, because the server
    // had already written four x-forwarded-* headers onto it.
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "packageName is required.",
    });
  });

  it("refuses the same call with no credential", async () => {
    expect((await purge({})).status).toBe(403);
  });

  it("refuses the same call with a wrong credential of the same length", async () => {
    const wrong = "0".repeat(credential.length);
    expect((await purge({ [BOOT_CREDENTIAL_HEADER]: wrong })).status).toBe(403);
  });

  it("refuses the moment the CLIENT sends a forwarded header, credential and all", async () => {
    const response = await purge({
      [BOOT_CREDENTIAL_HEADER]: credential,
      "x-forwarded-for": "127.0.0.1",
    });
    expect(response.status).toBe(403);
  });

  it("refuses a forged peer stamp — the stamp is an output, not an input", async () => {
    const response = await purge({
      [BOOT_CREDENTIAL_HEADER]: credential,
      host: "localhost",
      "x-forwarded-for": "127.0.0.1",
      // Both stamps forged to say "local call, nothing forwarded". The server
      // overwrites both before the handler reads them.
      [SOCKET_PEER_HEADER]: "127.0.0.1",
      [CLIENT_FORWARDED_HEADER]: "none",
    });
    expect(response.status).toBe(403);
  });

  it("keeps the framework's own forwarded-header synthesis in view", () => {
    // The behavioural assertions above rest on this being what the installed
    // framework does. Pinning it here means a version that stops synthesising
    // announces itself in this suite rather than silently changing what the
    // gate is defending against.
    const baseServer = readFileSync(
      path.join(repoRoot, "node_modules", "next", "dist", "server", "base-server.js"),
      "utf8",
    );
    expect(baseServer).toContain("req.headers['x-forwarded-host'] ??=");
    expect(baseServer).toContain("req.headers['x-forwarded-proto'] ??=");
    expect(baseServer).toContain("req.headers['x-forwarded-for'] ??=");
  });
});
