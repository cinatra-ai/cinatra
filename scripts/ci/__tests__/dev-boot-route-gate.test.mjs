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
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

import {
  COMPILE_READER_MAX_LINE_CHARS,
  createCompileAnnouncementReader,
  parseGateArgs,
  requestTimeoutMs,
} from "../dev-boot-route-gate.mjs";

const GATE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "dev-boot-route-gate.mjs",
);

// THE BOUNDS THIS TIER GIVES THE GATE, in one place, so a wait can be DERIVED
// from them instead of guessed (cinatra#3368). Every `runGate` below passes
// exactly these on the command line.
const GATE_HEALTH_BOUND_MS = 20_000;
const GATE_ROUTE_BOUND_MS = 1_200;
const GATE_SHUTDOWN_GRACE_MS = 2_000;
// The one bound the gate keeps to itself: after it stops an unrouted boot it
// waits this long for the application port to come free before the next boot
// binds it (`waitForPortFree(..., 60_000)` in scripts/ci/dev-boot-route-gate.mjs).
// It is not settable from the command line, so it is mirrored here.
const GATE_PORT_FREE_BOUND_MS = 60_000;

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

const [port, counterPath, poisonedBoots, dieAfterMs, dieAfterRouteHits, compileForMs] =
  process.argv.slice(2);
const startedAt = Date.now();
let announced = false;
let routeHits = 0;
let boots = 0;
try { boots = Number(readFileSync(counterPath, "utf8")) || 0; } catch {}
boots += 1;
writeFileSync(counterPath, String(boots));
const poisonedBoot = boots <= Number(poisonedBoots);

const server = http.createServer((request, response) => {
  if (request.url === "/api/health") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true, boot: boots }));
    return;
  }
  routeHits += 1;
  // DEATH ON THE Nth ROUTE REQUEST, so "the server dies mid-probe" is staged by
  // COUNTING rather than by a timer — the sequence the gate sees is then the
  // same on a fast machine and a loaded one.
  const dieNow = Number(dieAfterRouteHits) > 0 && routeHits >= Number(dieAfterRouteHits);
  // A COMPILE THE RUNTIME ANNOUNCES AND HAS NOT FINISHED (cinatra#3553): the
  // announcement goes to stdout on the first request, exactly as the real
  // runtime prints it, and the path serves the not-found DOCUMENT until the
  // compile "finishes" — which is what the recorded member-B boot did.
  const compiling = Number(compileForMs) > 0 && Date.now() - startedAt < Number(compileForMs);
  if (Number(compileForMs) > 0 && !announced) {
    announced = true;
    console.log("\u25cb Compiling " + request.url + " ...");
  }
  const poisoned = poisonedBoot || compiling;
  if (poisoned) {
    // The development runtime's own not-found DOCUMENT: the page tree rendered
    // because nothing was routable at this path.
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    response.end("<!doctype html><html><body>404</body></html>", () => {
      if (dieNow) process.exit(3);
    });
    return;
  }
  // What the real handler answers an empty body with.
  response.writeHead(400, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: "invalid body" }));
});
server.listen(Number(port), "127.0.0.1");
// A DEVELOPMENT SERVER THAT DIES ON ITS OWN, on demand: the class the gate must
// report as a crash rather than diagnose as the #3194 routing fault.
if (Number(dieAfterMs) > 0) setTimeout(() => process.exit(3), Number(dieAfterMs));
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
function runGate({
  poisonedBoots,
  maxBoots,
  appPort,
  gatePort,
  dieAfterMs = 0,
  dieAfterRouteHits = 0,
  compileForMs = 0,
}) {
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
      String(GATE_HEALTH_BOUND_MS),
      "--route-bound-ms",
      String(GATE_ROUTE_BOUND_MS),
      "--max-boots",
      String(maxBoots),
      "--shutdown-grace-ms",
      String(GATE_SHUTDOWN_GRACE_MS),
      "--child-command",
      `"${process.execPath}" "${standin}" ${appPort} "${counter}" ${poisonedBoots} ${dieAfterMs} ${dieAfterRouteHits} ${compileForMs}`,
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

/**
 * Wait for a line the GATE ITSELF printed, or for the gate to exit — whichever
 * happens first.
 *
 * This is what makes a reading event-driven rather than a wall-clock guess: the
 * gate announces what it is about to do, so the test can wait on the
 * announcement instead of on a number it chose. A gate that exits has nothing
 * left to announce, so the wait ends there rather than burning its failsafe.
 */
async function waitForGateLine(run, needle, boundMs) {
  let hasExited = false;
  run.exited.then(() => {
    hasExited = true;
  });
  const deadline = Date.now() + boundMs;
  while (Date.now() < deadline) {
    if (run.read().includes(needle)) return true;
    if (hasExited) return run.read().includes(needle);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return false;
}

// THE FAILSAFE CEILING FOR A TWO-BOOT REPLACEMENT, DERIVED — never guessed.
//
// A poisoned first boot costs the health bound plus the route bound; the
// replacement costs the shutdown grace and the gate's own wait for the
// application port to come free; the second boot costs a health bound and a
// route bound again. This is the arithmetic of the bounds this file configures,
// not a number picked to look generous — which is precisely what failed before
// (cinatra#3368): a fixed 25 s ceiling, unrelated to the bounds the same test
// had just handed the gate, ended the wait while a loaded box was still on the
// second boot.
const TWO_BOOT_CEILING_MS =
  2 * (GATE_HEALTH_BOUND_MS + GATE_ROUTE_BOUND_MS) +
  GATE_SHUTDOWN_GRACE_MS +
  GATE_PORT_FREE_BOUND_MS;

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

    // THE READING IS THE GATE'S OWN SIGNAL, then the port.
    //
    // `opening the gate on :PORT` is printed immediately before the listener is
    // bound, so waiting for that line waits for the event rather than for a
    // clock; only then is the port probed, with whatever is left of the derived
    // two-boot ceiling above (never less than one route bound) as the settling
    // window. Under load the line arrives late and the wait simply lasts longer;
    // it no longer ends before the gate has had the time its own bounds allow.
    const deadline = Date.now() + TWO_BOOT_CEILING_MS;
    const announced = await waitForGateLine(
      run,
      `opening the gate on :${gatePort}`,
      TWO_BOOT_CEILING_MS,
    );
    const opened =
      announced &&
      (await waitUntil(
        () => gateAnswers(gatePort),
        Math.max(GATE_ROUTE_BOUND_MS, deadline - Date.now()),
      ));
    expect(run.read()).toContain("boot 1/2");
    // The gate must have DIAGNOSED the boot rather than merely timed out on it.
    expect(run.read()).toContain("not-found DOCUMENT");
    expect(run.read()).toContain("Replacing the boot");
    expect(run.read()).toContain("boot 2/2");
    expect(opened).toBe(true);
    // The case may spend the derived ceiling above, so it is given that ceiling
    // plus a probe's worth of settling — the file's 30 s default would otherwise
    // cut the derived wait short again.
  }, TWO_BOOT_CEILING_MS + GATE_ROUTE_BOUND_MS + 5_000);

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

describe("a server this run did not start", () => {
  /**
   * THE GUARANTEE PLAYWRIGHT USED TO ENFORCE, RESTORED HERE.
   *
   * `reuseExistingServer: false` is what makes this suite's result attributable:
   * the server under test carries the environment the config states. Playwright
   * enforced it by refusing to start when the url it polls already answers — and
   * that url is now the GATE's, not the application's. So the gate has to refuse
   * an occupied application port itself, or a stale server would answer health,
   * answer both probes, and be certified while the child that should have served
   * the run lost the bind.
   */
  it("refuses to certify a server already holding the application port", async () => {
    const appPort = await freePort();
    const gatePort = await freePort();
    const squatter = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("{}");
    });
    await new Promise((resolve) => squatter.listen(appPort, "127.0.0.1", resolve));
    try {
      const run = runGate({ poisonedBoots: 0, maxBoots: 2, appPort, gatePort });
      const code = await run.exited;
      expect(code).toBe(1);
      expect(run.read()).toContain("ALREADY serving");
      expect(run.read()).toContain(String(appPort));
      // It must not have opened the gate on somebody else's server.
      expect(await gateAnswers(gatePort)).toBe(false);
    } finally {
      await new Promise((resolve) => squatter.close(resolve));
    }
  });
});

describe("a development server that dies on its own", () => {
  it("closes the gate with it instead of answering ready for a dead application", async () => {
    const appPort = await freePort();
    const gatePort = await freePort();
    const run = runGate({ poisonedBoots: 0, maxBoots: 2, appPort, gatePort, dieAfterMs: 4_000 });

    expect(await waitUntil(() => gateAnswers(gatePort), 25_000)).toBe(true);

    // The server goes; the gate must stop claiming readiness AND stop existing,
    // rather than sitting on an open listener that outlives what it speaks for.
    const code = await run.exited;
    expect(code).not.toBe(0);
    expect(await gateAnswers(gatePort)).toBe(false);
    expect(run.read()).toContain("exited on its own");
  });

  it("is reported as a crash, not diagnosed as the routing fault and rebooted", async () => {
    const appPort = await freePort();
    const gatePort = await freePort();
    // Poisoned, so the probe sees the not-found document first — and then the
    // server dies mid-bound, which is the mixed sequence that used to be read as
    // the #3194 signature and earn a fresh boot.
    const run = runGate({
      poisonedBoots: 5,
      maxBoots: 2,
      appPort,
      gatePort,
      dieAfterRouteHits: 2,
    });

    const code = await run.exited;
    expect(code).toBe(1);
    expect(run.read()).toContain("EXITED while its routes were being probed");
    expect(run.read()).not.toContain("Replacing the boot");
    expect(run.read()).not.toContain("boot 2/2");
    expect(await gateAnswers(gatePort)).toBe(false);
  });
});

describe("requestTimeoutMs", () => {
  /**
   * ONE ATTEMPT IS BOUNDED BY WHAT IS LEFT OF THE BOUND, AND BY NOTHING ELSE
   * (cinatra#3553).
   *
   * This arithmetic used to narrow every attempt to at most 60 s — a second,
   * tighter bound no comment in either file declared, and one that contradicted
   * the probe module's own contract paragraph. It is what ended the recorded
   * member-B request at exactly 60.0 s while the runtime was still compiling the
   * route it had announced, after which that path served the not-found document
   * for the rest of the process. The green boot of the same job answered the same
   * route after 37.6 s, so the cap was the line between the two.
   */
  it("hands an attempt the whole of what is left of the readiness bound", () => {
    expect(requestTimeoutMs(120_000)).toBe(120_000);
    expect(requestTimeoutMs(90_000)).toBe(90_000);
  });

  it("never hands out a non-positive timeout", () => {
    expect(requestTimeoutMs(0)).toBe(1);
    expect(requestTimeoutMs(-5_000)).toBe(1);
  });
});

describe("the compile-announcement reader", () => {
  const ROUTE = "/api/auth/sign-up/email";

  it("reads an announcement split across two chunks of the same stream", () => {
    const reader = createCompileAnnouncementReader();
    reader.write("\u25cb Compiling /api/auth/", "stdout");
    reader.write("sign-up/email ...\n", "stdout");
    expect(reader.has(ROUTE)).toBe(true);
  });

  it("frames each stream on its own, so interleaved output neither loses nor invents one", () => {
    // LOSS: the two halves of a real stdout announcement, with a stderr line
    // arriving in between — a shared buffer would splice the warning into the
    // middle of the path and the announcement would vanish.
    const loses = createCompileAnnouncementReader();
    loses.write("\u25cb Compiling /api/auth/", "stdout");
    loses.write("warning: something\n", "stderr");
    loses.write("sign-up/email ...\n", "stdout");
    expect(loses.has(ROUTE)).toBe(true);

    // SYNTHESIS, which is the half that matters for safety: neither stream ever
    // printed an announcement, and a shared buffer would manufacture one — an
    // extension for a boot that never earned it.
    const invents = createCompileAnnouncementReader();
    invents.write("\u25cb Compiling ", "stdout");
    invents.write("/api/auth/sign-up/email ...\n", "stderr");
    expect(invents.has(ROUTE)).toBe(false);
  });

  it("discards a line past the ceiling, and the rest of that line with it", () => {
    const reader = createCompileAnnouncementReader();
    // Progress output that never sends a newline: it must not be buffered for the
    // life of the boot, and its tail must not be re-read as a line of its own.
    reader.write("x".repeat(COMPILE_READER_MAX_LINE_CHARS + 1), "stdout");
    reader.write(" Compiling /api/auth/sign-up/email ...\n", "stdout");
    expect(reader.has(ROUTE)).toBe(false);
    // ...and the stream is readable again on the next line.
    reader.write("\u25cb Compiling /api/auth/sign-up/email ...\n", "stdout");
    expect(reader.has(ROUTE)).toBe(true);
  });
});

describe("a boot whose route is still compiling (cinatra#3553)", () => {
  /**
   * THE GATE READS ITS CHILD'S STDOUT, and that is the whole of the new signal.
   *
   * This stand-in announces a compile of the probed path and then serves the
   * runtime's own not-found DOCUMENT for longer than the route bound this tier
   * hands the gate — so under the old rule the bound is spent, the boot is called
   * unrouted, and with a single boot in the budget the gate exits without ever
   * opening. Under the new rule the announcement buys this boot its one bounded
   * extension, the route answers inside it, and the gate opens.
   *
   * The poisoned-boot case above is the other half of the pin: a stand-in that
   * announces NOTHING still spends the same bound and is still replaced.
   */
  it("keeps probing a route the runtime announced, and opens the gate when it answers", async () => {
    const appPort = await freePort();
    const gatePort = await freePort();
    const COMPILE_FOR_MS = 4_000;
    const run = runGate({
      poisonedBoots: 0,
      maxBoots: 1,
      appPort,
      gatePort,
      compileForMs: COMPILE_FOR_MS,
    });

    const deadline = Date.now() + GATE_HEALTH_BOUND_MS + COMPILE_FOR_MS + GATE_ROUTE_BOUND_MS;
    const announced = await waitForGateLine(
      run,
      `opening the gate on :${gatePort}`,
      GATE_HEALTH_BOUND_MS + COMPILE_FOR_MS + GATE_ROUTE_BOUND_MS,
    );
    const opened =
      announced &&
      (await waitUntil(
        () => gateAnswers(gatePort),
        Math.max(GATE_ROUTE_BOUND_MS, deadline - Date.now()),
      ));

    // It must have spent the bound on the not-found document first — this is not
    // a route that simply answered.
    expect(run.read()).toContain("[runtime-not-found]");
    // ...and then read the announcement off its own child's stdout and said so.
    expect(run.read()).toContain("ANNOUNCED, UNFINISHED compile");
    expect(run.read()).toContain("every route is routable");
    expect(run.read()).not.toContain("boot budget is spent");
    expect(opened).toBe(true);
  }, GATE_HEALTH_BOUND_MS + 10_000 + GATE_ROUTE_BOUND_MS + 15_000);
});
