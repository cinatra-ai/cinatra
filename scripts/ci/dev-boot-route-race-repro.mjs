#!/usr/bin/env node
// THE CONSTRAINED COLD-BOOT LOOP (cinatra#3194).
//
// WHY A LOOP AND NOT A GUESS
// --------------------------
// #3194's own investigation could not trigger the failure by hand: seven manual
// cold boots all answered the sign-up route on the first probe, while CI has it
// red once in twenty-five default-branch runs. A defect measured at that rate
// cannot be argued about from a single boot, so this script makes the boot the
// unit of measurement: it runs N cold boots back to back under the same
// constraints the job imposes, probes the routes the flow depends on the INSTANT
// the server reports healthy, and writes down what each boot answered.
//
// It is the acceptance evidence for two of #3194's items at once: the
// reproduction attempt (run it against a tree without the gate and count the
// unrouted boots) and the ten-consecutive-boots claim (run it with
// `--iterations 10` and require a zero exit).
//
// WHAT "COLD" AND "CONSTRAINED" MEAN HERE, precisely, because a benchmark that
// warms up measures the wrong thing:
//   * the build cache directory is REMOVED before every boot, so no boot inherits
//     another's compiled routes;
//   * the route probe is the FIRST request after the health poll — there is no
//     warm-up request at all, unlike `scripts/bench-cold-start.mjs`, which warms
//     deliberately so its compile numbers are not contaminated. Here the very
//     first hit is the thing under test;
//   * the server is niced, and pinned to a core set where the platform can pin
//     (`taskset`). What was ACTUALLY applied is recorded in the report rather than
//     assumed, so a run on a platform without `taskset` cannot quietly claim a
//     constraint it never had.
//
// USAGE
//   node scripts/ci/dev-boot-route-race-repro.mjs \
//     --iterations 15 --app-url http://localhost:3126 --out /tmp/3194-boots
//
// Exit code: 0 when every boot registered every route, 1 otherwise — so the
// script is usable as a gate, not only as a report.

import { spawn } from "node:child_process";
import { mkdirSync, openSync, rmSync, writeFileSync, closeSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  ROUTE_READY_BOUND_MS,
  parseRouteSpec,
  probeRouteUntilAnswered,
} from "../lib/dev-boot-route-probe.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function parseReproArgs(argv) {
  const options = {
    iterations: 15,
    appUrl: "http://localhost:3126",
    healthPath: "/api/health",
    routes: [],
    healthBoundMs: 900_000,
    routeBoundMs: ROUTE_READY_BOUND_MS,
    out: "",
    childCommand: "pnpm dev",
    distDir: ".next",
    nice: 10,
    pinCores: "",
    keepGoing: true,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    switch (flag) {
      case "--iterations":
        options.iterations = Number(value);
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
      case "--out":
        options.out = String(value);
        index += 1;
        break;
      case "--child-command":
        options.childCommand = String(value);
        index += 1;
        break;
      case "--dist-dir":
        options.distDir = String(value);
        index += 1;
        break;
      case "--nice":
        options.nice = Number(value);
        index += 1;
        break;
      case "--pin-cores":
        options.pinCores = String(value);
        index += 1;
        break;
      case "--stop-on-first-unrouted":
        options.keepGoing = false;
        break;
      default:
        throw new Error(`unknown argument: ${flag}`);
    }
  }
  if (options.routes.length === 0) {
    options.routes = [
      parseRouteSpec("POST:/api/auth/sign-up/email"),
      parseRouteSpec("POST:/api/assistants/chat/capabilities"),
    ];
  }
  if (!options.out) throw new Error("--out is required (the per-boot logs go there)");
  return options;
}

/**
 * The constraint prefix, and an honest record of what it could apply.
 *
 * `taskset` exists on Linux (the job's platform) and not on macOS, so a lane
 * reproducing this locally is niced but not pinned. That difference is REPORTED
 * rather than papered over: a boot that was not pinned may not carry the same
 * contention the runner has, and a report that claimed otherwise would be the
 * kind of evidence this issue was created to stop producing.
 */
export function constraintPrefix({ nice, pinCores, hasTaskset }) {
  const applied = [];
  const parts = [];
  if (pinCores && hasTaskset) {
    parts.push(`taskset -c ${pinCores}`);
    applied.push(`pinned to cores ${pinCores}`);
  } else if (pinCores) {
    applied.push(`NOT pinned (taskset unavailable on this platform; asked for ${pinCores})`);
  }
  if (Number.isFinite(nice) && nice > 0) {
    parts.push(`nice -n ${nice}`);
    applied.push(`niced to ${nice}`);
  }
  return { prefix: parts.join(" "), applied };
}

function hasCommand(name) {
  const probe = spawn("sh", ["-c", `command -v ${name} >/dev/null 2>&1`], { stdio: "ignore" });
  return new Promise((resolve) => probe.on("exit", (code) => resolve(code === 0)));
}

/**
 * Remove the build cache, tolerating the transient directory-busy failures a
 * copy-on-write filesystem produces while the just-killed bundler's last handles
 * close — the same guard `scripts/bench-cold-start.mjs` already needs.
 */
function removeDistDir(distDir) {
  rmSync(distDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 250 });
}

async function portInUse(port, host) {
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

async function waitForPortFree(port, host, boundMs) {
  const started = Date.now();
  while (Date.now() - started < boundMs) {
    if (!(await portInUse(port, host))) return true;
    await sleep(500);
  }
  return false;
}

async function waitForHealth(url, boundMs, isChildAlive) {
  const started = Date.now();
  let attempts = 0;
  while (Date.now() - started < boundMs) {
    if (!isChildAlive()) return { ok: false, attempts, reason: "the development server exited" };
    attempts += 1;
    try {
      const response = await fetch(url, { method: "GET", signal: AbortSignal.timeout(30_000) });
      await response.arrayBuffer().catch(() => undefined);
      if (response.status === 200) return { ok: true, attempts, elapsedMs: Date.now() - started };
    } catch {
      // not up yet
    }
    await sleep(1_000);
  }
  return { ok: false, attempts, reason: `no 200 within ${boundMs}ms` };
}

async function main() {
  const options = parseReproArgs(process.argv.slice(2));
  const appUrl = new URL(options.appUrl);
  const port = Number(appUrl.port || 80);
  const outDir = path.resolve(options.out);
  mkdirSync(outDir, { recursive: true });

  const { prefix, applied } = constraintPrefix({
    nice: options.nice,
    pinCores: options.pinCores,
    hasTaskset: await hasCommand("taskset"),
  });
  const command = prefix ? `${prefix} ${options.childCommand}` : options.childCommand;

  console.log(`[repro] ${options.iterations} cold boot(s) of \`${command}\` against ${options.appUrl}`);
  console.log(`[repro] constraints: ${applied.length ? applied.join("; ") : "none requested"}`);
  console.log(`[repro] build cache removed before every boot: ${options.distDir}`);
  console.log(`[repro] per-boot logs: ${outDir}`);

  const boots = [];
  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    if (await portInUse(port, appUrl.hostname)) {
      throw new Error(`port ${port} is already in use — refusing to attribute a boot to another server`);
    }
    removeDistDir(path.resolve(options.distDir));
    const logPath = path.join(outDir, `boot-${String(iteration).padStart(2, "0")}.log`);
    const logFd = openSync(logPath, "w");
    const startedAt = Date.now();
    const child = spawn(command, {
      shell: true,
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: process.env,
    });
    let exited = false;
    child.on("exit", () => {
      exited = true;
    });

    const record = {
      iteration,
      startedAtIso: new Date(startedAt).toISOString(),
      log: path.relative(process.cwd(), logPath),
      routes: {},
    };

    const health = await waitForHealth(
      `${options.appUrl}${options.healthPath}`,
      options.healthBoundMs,
      () => !exited,
    );
    record.health = health;
    if (health.ok) {
      for (const route of options.routes) {
        const name = `${route.method} ${route.path}`;
        const result = await probeRouteUntilAnswered(
          async (remainingMs) => {
            const response = await fetch(`${appUrl.origin}${route.path}`, {
              method: route.method,
              headers: { "content-type": "application/json", origin: appUrl.origin },
              body: route.method === "GET" || route.method === "HEAD" ? undefined : "{}",
              redirect: "manual",
              signal: AbortSignal.timeout(Math.max(1, Math.min(remainingMs, 60_000))),
            });
            const contentType = response.headers.get("content-type");
            await response.arrayBuffer().catch(() => undefined);
            return { status: response.status, contentType };
          },
          { boundMs: options.routeBoundMs },
        );
        record.routes[name] = {
          answered: result.answered,
          verdict: result.verdict,
          status: result.status,
          contentType: result.contentType,
          attempts: result.attempts,
          elapsedMs: result.elapsedMs,
          firstAnswer: result.classifications[0] ?? null,
          classifications: result.classifications,
        };
      }
    }

    record.registered =
      health.ok === true && Object.values(record.routes).every((route) => route.answered === true);
    record.wallMs = Date.now() - startedAt;
    boots.push(record);

    console.log(
      `[repro] boot ${iteration}/${options.iterations}: ${record.registered ? "REGISTERED" : "FAILED"} ` +
        (health.ok
          ? `(health ${health.elapsedMs}ms; ` +
            Object.entries(record.routes)
              .map(
                ([name, route]) =>
                  `${name} -> ${route.status ?? "no response"}` +
                  `${route.contentType ? ` ${route.contentType}` : ""} in ${route.elapsedMs}ms ` +
                  `[${route.verdict}]`,
              )
              .join("; ") +
            ")"
          : `(health never answered: ${health.reason})`),
    );

    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    const graceDeadline = Date.now() + 30_000;
    while (Date.now() < graceDeadline && !exited) await sleep(250);
    if (!exited) {
      try {
        if (child.pid) process.kill(-child.pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
    closeSync(logFd);
    if (!(await waitForPortFree(port, appUrl.hostname, 60_000))) {
      throw new Error(`port ${port} did not free after boot ${iteration}`);
    }
    if (!record.registered && !options.keepGoing) break;
  }

  const registered = boots.filter((boot) => boot.registered).length;
  const summary = {
    iterations: options.iterations,
    ran: boots.length,
    registered,
    failed: boots.length - registered,
    appUrl: options.appUrl,
    command,
    constraints: applied,
    routeBoundMs: options.routeBoundMs,
    boots,
  };
  const summaryPath = path.join(outDir, "boots.json");
  writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`[repro] ${registered}/${boots.length} boot(s) registered every route — ${summaryPath}`);
  return registered === boots.length && boots.length > 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`[repro] ${err instanceof Error ? err.message : String(err)}`);
      process.exitCode = 1;
    },
  );
}
