// THE FAILURE CLASS, REPRODUCED DETERMINISTICALLY, AND THE GATE'S ANSWER TO IT
// (cinatra#3194).
//
// The defect itself is rare — red once in twenty-five default-branch runs, and
// seven manual cold boots never triggered it — so this tier does not try to
// trigger it. It STAGES it: a stand-in development server that serves the exact
// answers the recorded reds recorded (`/api/health` 200, and the runtime's own
// not-found DOCUMENT for the sign-up route, in a couple of hundred
// milliseconds, for as long as it is asked) on its FIRST boot, and the healthy
// answers on its second.
//
// That is enough to assert the only thing the repository can control: that a boot
// which never registers the route is DETECTED and REPLACED before Playwright is
// ever told anything is ready, instead of reaching the setup and failing the job
// two minutes later. Before this gate existed there was no code between the
// poisoned boot and the suite at all — the readiness probe could only report it.
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import { parseGateArgs } from "../dev-boot-route-gate.mjs";

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dev-boot-route-gate.mjs",
);

/**
 * The stand-in development server.
 *
 * It counts its own boots in a file, so the FIRST process serves the poisoned
 * shape and every later one serves the healthy shape — which is the whole of what
 * "a residual boot race" means for the purposes of this test.
 */
const STANDIN = `
import http from "node:http";
import { readFileSync, writeFileSync } from "node:fs";

const [port, counterPath, poisonedBoots] = process.argv.slice(2);
let boots = 0;
try { boots = Number(readFileSync(counterPath, "utf8")) || 0; } catch {}
boots += 1;
writeFileSync(counterPath, String(boots));
const poisoned = boots <= Number(poisonedBoots);

const server = http.createServer((request, response) => {
  if (request.url === "/api/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, boot: boots }));
    return;
  }
  if (poisoned) {
    // The development runtime's own not-found DOCUMENT: the page tree rendered
    // because nothing was routable at this path.
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>404</body></html>");
    return;
  }
  // What the real handler answers an empty body with.
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "invalid body" }));
});
server.listen(Number(port), "127.0.0.1");
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { server.close(); process.exit(0); });
`;

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** Is anything still serving on this port? — the stand-in answers /api/health. */
async function portAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(2_000),
    });
    await response.arrayBuffer().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

async function gateAnswers(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2_000),
    });
    await response.arrayBuffer().catch(() => undefined);
    return response.status === 200;
  } catch {
    return false;
  }
}

const started = [];

afterEach(() => {
  for (const { child, dir } of started.splice(0)) {
    try {
      if (child.pid) process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Run the gate against a stand-in server that is poisoned for `poisonedBoots`. */
function runGate({ poisonedBoots, maxBoots, appPort, gatePort }) {
  const dir = mkdtempSync(path.join(tmpdir(), "cinatra-3194-"));
  const standin = path.join(dir, "standin.mjs");
  const counter = path.join(dir, "boots.count");
  writeFileSync(standin, STANDIN);

  const child = spawn(
    process.execPath,
    [
      GATE,
      "--gate-port",
      String(gatePort),
      "--app-url",
      `http://127.0.0.1:${appPort}`,
      "--route",
      "POST:/api/auth/sign-up/email",
      "--health-bound-ms",
      "20000",
      "--route-bound-ms",
      "1200",
      "--max-boots",
      String(maxBoots),
      "--shutdown-grace-ms",
      "2000",
      "--child-command",
      `"${process.execPath}" "${standin}" ${appPort} "${counter}" ${poisonedBoots}`,
    ],
    { detached: true, stdio: ["ignore", "pipe", "pipe"] },
  );
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += String(chunk);
  });
  child.stderr.on("data", (chunk) => {
    output += String(chunk);
  });
  const exited = new Promise((resolve) => child.on("exit", (code) => resolve(code)));
  started.push({ child, dir });
  return { child, exited, read: () => output };
}

async function waitUntil(predicate, boundMs) {
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

describe("parseGateArgs", () => {
  it("spends the readiness bound the Playwright tier spends, by default", () => {
    const options = parseGateArgs([
      "--gate-port",
      "1",
      "--app-url",
      "http://localhost:3126/",
      "--route",
      "POST:/api/auth/sign-up/email",
      "--child-command",
      "pnpm dev",
    ]);
    expect(options.routeBoundMs).toBe(120_000);
    expect(options.appUrl).toBe("http://localhost:3126");
    expect(options.routes).toEqual([{ method: "POST", path: "/api/auth/sign-up/email" }]);
    expect(options.healthPath).toBe("/api/health");
    expect(options.maxBoots).toBe(2);
  });

  it("refuses to run without the things it cannot guess", () => {
    expect(() => parseGateArgs([])).toThrow(/--gate-port/);
    expect(() => parseGateArgs(["--gate-port", "1"])).toThrow(/--app-url/);
    expect(() =>
      parseGateArgs(["--gate-port", "1", "--app-url", "http://x", "--child-command", "x"]),
    ).toThrow(/--route/);
  });
});

describe("a boot that never registers the route", () => {
  it("is replaced by a fresh boot, and the gate opens only after the route answers", async () => {
    const appPort = await freePort();
    const gatePort = await freePort();
    const run = runGate({ poisonedBoots: 1, maxBoots: 2, appPort, gatePort });

    const opened = await waitUntil(() => gateAnswers(gatePort), 25_000);
    expect(run.read()).toContain("boot 1/2");
    // The gate must have DIAGNOSED the boot rather than merely timed out on it.
    expect(run.read()).toContain("not-found DOCUMENT");
    expect(run.read()).toContain("Replacing the boot");
    expect(run.read()).toContain("boot 2/2");
    expect(opened).toBe(true);
  });

  it("never opens the gate while every boot in the budget is unrouted, and says which route", async () => {
    const appPort = await freePort();
    const gatePort = await freePort();
    const run = runGate({ poisonedBoots: 5, maxBoots: 2, appPort, gatePort });

    const code = await run.exited;
    expect(code).toBe(1);
    expect(await gateAnswers(gatePort)).toBe(false);
    expect(run.read()).toContain("POST /api/auth/sign-up/email");
    expect(run.read()).toContain("boot budget is spent");
  });
});

describe("shutdown", () => {
  /**
   * THE ORPHAN THIS PINS, because it was real and it cost a whole run.
   *
   * The development server is started in a process group of its OWN, so that an
   * unrouted boot can be replaced by signalling the group rather than only the
   * shell in front of it. Playwright, at teardown, signals the gate and nothing
   * else — so if the gate does not take the group down with it, the development
   * server survives its parent, keeps the port, and (when its output was
   * inherited rather than piped) holds the pipes the runner is waiting on: the
   * suite reports every test passed and then never exits.
   *
   * The assertion is therefore not "the gate exited" but "the SERVER is gone",
   * which is the part that was broken.
   */
  it("takes the development server down with it when it is signalled", async () => {
    const appPort = await freePort();
    const gatePort = await freePort();
    const run = runGate({ poisonedBoots: 0, maxBoots: 2, appPort, gatePort });

    expect(await waitUntil(() => gateAnswers(gatePort), 25_000)).toBe(true);
    expect(await portAnswers(appPort)).toBe(true);

    process.kill(run.child.pid, "SIGTERM");
    await run.exited;

    expect(await waitUntil(async () => !(await portAnswers(appPort)), 15_000)).toBe(true);
  });
});

describe("a boot that registers the route", () => {
  it("opens the gate on the first boot, with no reboot at all", async () => {
    const appPort = await freePort();
    const gatePort = await freePort();
    const run = runGate({ poisonedBoots: 0, maxBoots: 2, appPort, gatePort });

    const opened = await waitUntil(() => gateAnswers(gatePort), 25_000);
    expect(opened).toBe(true);
    expect(run.read()).toContain("every route is routable");
    expect(run.read()).not.toContain("Replacing the boot");
    expect(run.read()).not.toContain("boot 2/2");
  });
});
