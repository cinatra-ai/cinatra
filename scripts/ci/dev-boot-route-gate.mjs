#!/usr/bin/env node
// THE DEV-BOOT ROUTE GATE (cinatra#3194).
//
// WHAT IT IS FOR
// --------------
// The chat-HITL held-turn end-to-end suite boots its own development server and
// starts driving it the moment the server answers `/api/health`. cinatra#3056
// already proved that "the server answers" is NOT the claim the flow needs and
// added a bounded readiness probe inside the Playwright setup. cinatra#3194 is
// what is left after that probe: on roughly one boot in twenty-five, the runtime
// answers `/api/health` normally and then serves its OWN not-found DOCUMENT for
// `POST /api/auth/sign-up/email` in 110-400 ms, every time, for the whole boot —
// the route is ABSENT, not slow (its measured cold compile is 11.7-21.3 s, an
// order of magnitude inside the 120 s bound). The probe can only report that; it
// cannot mend it, because by the time it runs the server is already the suite's
// only server and Playwright owns its lifecycle.
//
// So this process owns the lifecycle instead. It is what the suite's `webServer`
// command runs:
//
//   1. it starts the development server as its own child, with the environment it
//      inherited — nothing about what the server is is changed here;
//   2. it waits for `/api/health`, exactly as Playwright's `webServer.url` poll
//      did, so the FIRST request this runtime ever sees is still a health GET and
//      the request ordering of the twenty-four green boots in twenty-five is
//      preserved verbatim;
//   3. it then probes the routes the flow depends on, with the SAME
//      side-effect-free requests the Playwright setup uses and the SAME 120 s
//      bound (see `scripts/lib/dev-boot-route-probe.mjs`);
//   4. only when they answer does it open its GATE — a tiny HTTP listener on its
//      own port, which is what `webServer.url` now polls. Until then Playwright
//      has not been told anything is ready, so no test has started;
//   5. and if the bound is spent on the runtime's own not-found document — the
//      `unrouted` verdict, the #3194 signature and nothing else — it replaces the
//      poisoned boot with a fresh one, within a small boot budget, and says so.
//
// THE BOUND IS NOT WIDENED, HERE OR ANYWHERE. #3194 is explicit that a wider
// readiness bound would not have turned one of the recorded reds green and would
// hide the exact signal the bound exists to surface. This process spends the same
// 120 s and then does something about it.
//
// WHY A REBOOT IS THE MITIGATION AND NOT A PATCH. The poisoning is not in this
// repository's code: the route file is on disk and unchanged, and the same commit
// boots green twenty-four times out of twenty-five. It is state inside the
// development runtime's own router for that one process — the same shape
// cinatra#2514 named on a different suite when it called the fast-404 mode "a
// stuck Turbopack route map". A fresh process rebuilds that router from the
// filesystem, which is why replacing the boot is both the smallest and the only
// repository-side fix available; the framework owns the defect itself.
//
// WHAT IT DELIBERATELY DOES NOT DO: it never proxies, rewrites or touches a single
// request the suite makes. The application keeps its own port and answers the
// tests directly. This process only decides WHEN to say "ready", and whether a
// boot deserves to be replaced.

import { execFileSync, spawn } from "node:child_process";
import http from "node:http";
import net from "node:net";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  ROUTE_READY_BOUND_MS,
  bootProbeFailure,
  parseRouteSpec,
  probeRouteUntilAnswered,
  shouldRebootAfter,
} from "../lib/dev-boot-route-probe.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Argument parsing, kept exported and pure so the unit tier reads the defaults
 * from the same place the process does.
 */
export function parseGateArgs(argv) {
  const options = {
    gatePort: 0,
    appUrl: "",
    healthPath: "/api/health",
    routes: [],
    healthBoundMs: 600_000,
    routeBoundMs: ROUTE_READY_BOUND_MS,
    maxBoots: 2,
    childCommand: "",
    shutdownGraceMs: 5_000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--gate-port":
        options.gatePort = Number(value);
        index += 1;
        break;
      case "--app-url":
        options.appUrl = String(value ?? "").replace(/\/+$/, "");
        index += 1;
        break;
      case "--health-path":
        options.healthPath = String(value);
        index += 1;
        break;
      case "--route":
        options.routes.push(parseRouteSpec(value));
        index += 1;
        break;
      case "--health-bound-ms":
        options.healthBoundMs = Number(value);
        index += 1;
        break;
      case "--route-bound-ms":
        options.routeBoundMs = Number(value);
        index += 1;
        break;
      case "--max-boots":
        options.maxBoots = Number(value);
        index += 1;
        break;
      case "--child-command":
        options.childCommand = String(value);
        index += 1;
        break;
      case "--shutdown-grace-ms":
        options.shutdownGraceMs = Number(value);
        index += 1;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (!options.gatePort) throw new Error("--gate-port is required");
  if (!options.appUrl) throw new Error("--app-url is required");
  if (!options.childCommand) throw new Error("--child-command is required");
  if (options.routes.length === 0) throw new Error("at least one --route is required");
  return options;
}

function say(message) {
  console.log(`[boot-gate] ${message}`);
}

/** A bounded GET poll for the health endpoint — the same signal Playwright used. */
async function waitForHealth(url, boundMs, { isChildAlive }) {
  const started = Date.now();
  let attempts = 0;
  while (Date.now() - started < boundMs) {
    if (!isChildAlive()) return { ok: false, attempts, reason: "the development server exited" };
    attempts += 1;
    const remainingMs = Math.max(1, boundMs - (Date.now() - started));
    try {
      const response = await fetch(url, {
        method: "GET",
        signal: AbortSignal.timeout(Math.min(remainingMs, 30_000)),
      });
      if (response.status === 200) {
        // The body is drained rather than read: leaving it undrained keeps the
        // socket alive and node's fetch warns about it on exit.
        await response.arrayBuffer().catch(() => undefined);
        return { ok: true, attempts, elapsedMs: Date.now() - started };
      }
      await response.arrayBuffer().catch(() => undefined);
    } catch {
      // Refused/timed out: the server is not up yet, which is the expected case
      // for most of this wait.
    }
    await sleep(1_000);
  }
  return { ok: false, attempts, reason: `no 200 within ${boundMs}ms` };
}

/** One route's bounded readiness probe against the real server. */
async function probeRoute(appUrl, route, boundMs, onAttempt) {
  const url = `${appUrl}${route.path}`;
  return probeRouteUntilAnswered(
    async (remainingMs) => {
      // AN EMPTY JSON BODY, WHICH CREATES NO STATE. The Playwright setup picked
      // these two requests for exactly that reason and #3056 records the proof:
      // Better Auth validates the sign-up body before it touches the store, and
      // the capabilities handler's first statement answers an unauthenticated
      // call. This process makes the identical request.
      const response = await fetch(url, {
        method: route.method,
        headers: { "content-type": "application/json", origin: appUrl },
        body: route.method === "GET" || route.method === "HEAD" ? undefined : "{}",
        redirect: "manual",
        signal: AbortSignal.timeout(Math.max(1, Math.min(remainingMs, 60_000))),
      });
      const contentType = response.headers.get("content-type");
      await response.arrayBuffer().catch(() => undefined);
      return { status: response.status, contentType };
    },
    { boundMs, onAttempt },
  );
}

/** Is anything listening on this port right now? */
function isPortInUse(port, host) {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host });
    const settle = (value) => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(1_000, () => settle(false));
    socket.on("connect", () => settle(true));
    socket.on("error", () => settle(false));
  });
}

/** Wait until nothing is listening on the port again, so the next boot can bind. */
async function waitForPortFree(port, host, boundMs) {
  const started = Date.now();
  while (Date.now() - started < boundMs) {
    if (!(await isPortInUse(port, host))) return true;
    await sleep(500);
  }
  return false;
}

async function main() {
  const options = parseGateArgs(process.argv.slice(2));
  const appUrl = new URL(options.appUrl);
  const healthUrl = `${options.appUrl}${options.healthPath}`;
  const routeNames = options.routes.map((route) => `${route.method} ${route.path}`);

  say(
    `gate :${options.gatePort} in front of ${options.appUrl} — waiting for ${routeNames.join(", ")} ` +
      `(health bound ${options.healthBoundMs}ms, route bound ${options.routeBoundMs}ms, ` +
      `at most ${options.maxBoots} boot(s))`,
  );

  let child = null;
  let shuttingDown = false;

  // THE WHOLE TREE, NOT THE SHELL — AND IN THIS PROCESS'S OWN GROUP.
  //
  // `pnpm dev` is a shell, which starts `scripts/dev-server.mjs`, which starts
  // the bundler. Signalling only the shell leaves a development server holding
  // the port, so the descendants have to be signalled too.
  //
  // The child is deliberately NOT detached. A child in a process group of its
  // own looks tidier — a group kill would take the whole tree at once — but it
  // is exactly wrong here: the test runner signals THIS process's group at
  // teardown, and a child outside it is simply not reached. That is not a
  // theory. It was measured twice on this branch: the suite reported every test
  // passed and then hung, because the surviving development server outlived its
  // parent. Sharing the group means the runner's own teardown reaches the whole
  // tree even if this process is killed outright, and `killTree` below is what
  // covers the one case the group cannot: replacing a boot, where this process
  // must survive the kill it is issuing.
  const descendantsOf = (pid) => {
    const found = [];
    const queue = [pid];
    while (queue.length > 0) {
      const parent = queue.shift();
      let children = [];
      try {
        children = execFileSync("pgrep", ["-P", String(parent)], { encoding: "utf8" })
          .split("\n")
          .map((line) => Number(line.trim()))
          .filter((value) => Number.isInteger(value) && value > 0);
      } catch {
        // `pgrep` exits non-zero when a process has no children, and may be
        // absent entirely; either way there is nothing more to collect here.
      }
      for (const child_ of children) {
        found.push(child_);
        queue.push(child_);
      }
    }
    return found;
  };

  const killTree = (pid, signal) => {
    if (!pid) return;
    // Deepest first, so a supervising parent cannot restart a child we just
    // signalled, and the parent last so it observes its children going away.
    for (const descendant of descendantsOf(pid).reverse()) {
      try {
        process.kill(descendant, signal);
      } catch {
        // Already gone.
      }
    }
    try {
      process.kill(pid, signal);
    } catch {
      // Already gone.
    }
  };

  const signalChild = (dying, signal) => {
    if (!dying || dying.exitCode !== null || dying.signalCode !== null) return;
    killTree(dying.pid, signal);
  };

  // THE TREE IS LISTED BEFORE THE SIGNAL, NOT LOOKED UP AFTER IT.
  //
  // `pgrep -P` can only name a process's children while that process is alive.
  // The shell `pnpm dev` runs exits promptly on SIGTERM, and a bundler
  // descendant that is mid-compile may not — at which point the shell is gone,
  // its orphan has been reparented, and no walk from the shell's pid can find it
  // any more. Escalating against a list taken BEFORE the first signal is what
  // reaches that orphan; without it the development server survives holding the
  // application port and the next boot cannot bind. (A pid could in principle be
  // recycled between the listing and the escalation; the window is the shutdown
  // grace and the alternative is a guaranteed orphan.)
  const stopChild = async () => {
    if (!child) return;
    const dying = child;
    const doomed = [...descendantsOf(dying.pid).reverse(), dying.pid];
    signalChild(dying, "SIGTERM");
    const deadline = Date.now() + options.shutdownGraceMs;
    while (Date.now() < deadline && dying.exitCode === null && dying.signalCode === null) {
      await sleep(200);
    }
    for (const pid of doomed) {
      try {
        process.kill(pid, 0);
      } catch {
        continue; // already gone
      }
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // raced us to the exit
      }
    }
  };

  // SHUTDOWN HAS TO BE SYNCHRONOUS-FIRST, AND IT HAS TO BE BELTED.
  //
  // Playwright signals THIS process at teardown and then stops waiting; it never
  // reaches the child, which is in a process group of its own by design. Two
  // things follow, and the first version of this file got both wrong:
  //
  //   * the group must be signalled in the SAME TICK the signal arrives, not
  //     after an awaited helper — a shutdown that only starts asynchronously can
  //     be cut short, and an orphaned development server then holds the port;
  //   * an `exit` handler must signal it again, because that runs for every
  //     ordinary exit path (including `process.exit`) and is the last chance to
  //     take the child down with us.
  //
  // The child's output is PIPED rather than inherited for the same accident:
  // an inherited stdio hands the child Playwright's own pipes, so an orphan that
  // outlives this process keeps them open and the whole run hangs after the last
  // test has passed. Piping means the child's log still reaches the job log
  // (forwarded below) and dies with this process either way.
  let killTimer = null;
  const beginShutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    signalChild(child, "SIGTERM");
    killTimer = setTimeout(() => {
      signalChild(child, "SIGKILL");
      process.exit(0);
    }, options.shutdownGraceMs);
    killTimer.unref?.();
  };
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(signal, beginShutdown);
  }
  process.on("exit", () => {
    if (killTimer) clearTimeout(killTimer);
    signalChild(child, "SIGKILL");
  });

  // NOTHING MAY ALREADY OWN THE APPLICATION PORT.
  //
  // The suite declares `reuseExistingServer: false` and means it: the run must
  // never be attributed to a server started with a different environment. That
  // guarantee used to be enforced by Playwright, which refuses to start when the
  // url it polls is already answering — but `webServer.url` now polls THIS
  // process, so Playwright's check covers the gate's port and no longer covers
  // the application's. The check has to live here instead. Without it a stale
  // server left on the port would answer health and both route probes, the gate
  // would certify it, the child would lose the bind, and the suite would run
  // green or red against a server nobody in this run configured.
  const appPort = Number(appUrl.port || (appUrl.protocol === "https:" ? 443 : 80));
  if (await isPortInUse(appPort, appUrl.hostname)) {
    say(
      `something is ALREADY serving on ${appUrl.hostname}:${appPort} — refusing to certify a ` +
        "server this run did not start (the suite requires a fresh server carrying its own " +
        "environment). Stop it and run again.",
    );
    return 1;
  }

  for (let bootIndex = 0; bootIndex < options.maxBoots; bootIndex += 1) {
    if (shuttingDown) return 0;
    say(`boot ${bootIndex + 1}/${options.maxBoots}: starting \`${options.childCommand}\``);
    // `shell: true` so the caller may hand over an ordinary command line, and NOT
    // detached — see `killTree` above for why that matters more than it looks.
    // Output is PIPED and forwarded rather than inherited, so the development
    // server's own log — the evidence trail every investigation of this failure
    // has needed — still reaches the job log verbatim, without handing the child
    // a pipe it could hold open after this process is gone.
    child = spawn(options.childCommand, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    child.stdout?.pipe(process.stdout);
    child.stderr?.pipe(process.stderr);
    let childExited = false;
    child.on("exit", () => {
      childExited = true;
    });

    const health = await waitForHealth(healthUrl, options.healthBoundMs, {
      isChildAlive: () => !childExited,
    });
    if (!health.ok) {
      say(`boot ${bootIndex + 1}: ${options.healthPath} never answered 200 — ${health.reason}`);
      await stopChild();
      return 1;
    }
    say(
      `boot ${bootIndex + 1}: ${options.healthPath} answered 200 after ${health.attempts} attempt(s), ` +
        `${health.elapsedMs}ms`,
    );

    let verdict = "ready";
    let failure = "";
    for (const route of options.routes) {
      const name = `${route.method} ${route.path}`;
      const result = await probeRoute(appUrl.origin, route, options.routeBoundMs, (attempt) => {
        if (attempt.classification === "answered") return;
        say(
          `boot ${bootIndex + 1}: ${name} not routable after ${attempt.attempts} attempt(s) — ` +
            (attempt.status === null
              ? `no response (${attempt.lastError ?? "unknown error"})`
              : `HTTP ${attempt.status}${attempt.contentType ? ` (${attempt.contentType})` : ""}`) +
            ` [${attempt.classification}]`,
        );
      });
      if (result.answered) {
        say(
          `boot ${bootIndex + 1}: ${name} ready — HTTP ${result.status}` +
            `${result.contentType ? ` (${result.contentType})` : ""} after ${result.attempts} ` +
            `attempt(s), ${result.elapsedMs}ms`,
        );
        continue;
      }
      verdict = result.verdict;
      failure = bootProbeFailure(name, options.routeBoundMs, result);
      break;
    }

    if (verdict === "ready") {
      say(`boot ${bootIndex + 1}: every route is routable — opening the gate on :${options.gatePort}`);
      const gate = await openGate(options.gatePort);
      return await waitForChildExit(child, gate, () => shuttingDown);
    }

    // A SPENT BOUND ONLY MEANS #3194 WHILE THE SERVER IS STILL THERE.
    //
    // `unrouted` is "the bound was spent and something answered" — and something
    // DID answer if the runtime served its not-found document and then the
    // process died, which is a crash, not the routing fault this gate replaces
    // boots for. Rebooting after a crash would hide it behind the wrong name, so
    // a dead child is reported as itself and the budget is not spent on it.
    if (childExited) {
      say(
        `boot ${bootIndex + 1}: the development server EXITED while its routes were being ` +
          "probed — this is a crashed server, not the cinatra#3194 routing fault, and it is " +
          `not retried here. Its log is above. (${failure})`,
      );
      await stopChild();
      return 1;
    }

    say(`boot ${bootIndex + 1}: ${failure}`);
    if (!shouldRebootAfter(verdict, { bootIndex, maxBoots: options.maxBoots })) {
      say(
        verdict === "silent"
          ? "the development server never answered this route at all — NOT retrying a boot, " +
              "because nothing here has been diagnosed and a second boot would only hide that."
          : "the boot budget is spent; reporting the unrouted boot rather than opening the gate.",
      );
      await stopChild();
      return 1;
    }
    say(
      `boot ${bootIndex + 1}: this is the cinatra#3194 signature — the runtime served its own ` +
        "not-found document for a route that exists, for the whole bound. Replacing the boot.",
    );
    await stopChild();
    const freed = await waitForPortFree(Number(appUrl.port || 80), appUrl.hostname, 60_000);
    if (!freed) {
      say(`port ${appUrl.port} did not free up after the development server was stopped`);
      return 1;
    }
  }
  return 1;
}

/** The gate itself: a listener that exists only so `webServer.url` can poll it. */
function openGate(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      response.end("dev-boot-route-gate: routes ready\n");
    });
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

/**
 * Hold the gate open for exactly as long as the server it certified is alive.
 *
 * THE LISTENER IS CLOSED WHEN THE CHILD GOES. Leaving it open would keep this
 * process alive after the server it speaks for is gone AND keep `/ready`
 * answering 200 for a dead application — the two halves of the same lie. A child
 * that exits while nobody asked it to is reported as a failure; a child that
 * exits because this process is shutting down is the ordinary end of a run.
 */
function waitForChildExit(child, gate, isShuttingDown) {
  return new Promise((resolve) => {
    const settle = (code, signal) => {
      gate.close();
      if (isShuttingDown()) return resolve(0);
      say(
        "the development server exited on its own " +
          (signal ? `(signal ${signal})` : `(code ${code ?? 0})`) +
          " — the gate is closing with it; anything still running is now talking to nothing.",
      );
      return resolve(signal ? 1 : (code ?? 0) === 0 ? 1 : (code ?? 1));
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      return settle(child.exitCode, child.signalCode);
    }
    child.on("exit", settle);
  });
}

// Only run when executed directly; importing this file (the unit tier does) must
// parse nothing and start nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`[boot-gate] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
