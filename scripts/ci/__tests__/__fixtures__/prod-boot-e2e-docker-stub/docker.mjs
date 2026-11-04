// A stand-in `docker` for scripts/ci/prod-boot-e2e.sh (cinatra#4154). The test puts a
// `docker` wrapper first on PATH that runs this file, then runs the real script.
//
// Each call is checked before it changes anything. A call of a shape the script does
// not use exits 97. A call that real docker refuses exits as docker does: a `run` on a
// network that was not created in this run, or with an empty or malformed `-v`, exits
// 125; a name that is not a recorded container, network or volume exits 1. A call
// whose `--env-file` names a missing file never reaches this file: node reads that
// option from its whole argument list and exits 9. A refused call records nothing.
//
// The commands the script runs inside containers must equal, byte for byte, the
// literals in script-calls.json: the `probe` code, the three `node -e` checks, the
// `psql` argument lists and SQL, and the two `sh -c` bodies (as bash expands them).
// A change to one of those literals in the script is refused here until the file is
// updated, so the test fails instead of passing on a canned answer.
//
// State (STUB_STATE) holds the networks, the volumes and the containers of the run,
// and every valid `docker run -d` in `runs`, with its EFFECTIVE env resolved once:
// the last `-e NAME=value` of a name wins, and a bare `-e NAME` takes the value from
// the env of this docker invocation (unset stays unset), as docker does. The test
// reads these recorded runs and the final state, and nothing else.
//
// An app container (a run of STUB_IMAGE) is modelled from that env:
//   - a STUB_HARD_ENV name without a non-blank value makes it fail at start, as the
//     import-time preflight does; its logs name exactly those variables;
//   - otherwise it serves, and /api/health follows src/app/api/health/route.ts and
//     src/lib/boot/health-status.ts: `user-store-mount-check` is degraded when it has
//     no `-v` mount, `required-env-soft-check` when a STUB_SOFT_ENV name has no
//     non-blank value, and CINATRA_BOOT_SIMULATE_DEGRADED=1 adds the blocking
//     `boot-degrade-probe`. Any degraded phase makes `degraded` true and the nested
//     readiness "degraded"; only a blocking phase makes the status "degraded" with
//     HTTP 503, otherwise it stays "ok" with HTTP 200.
//   - each start (`run -d`, `restart`) of an app with the extension volume mounted at
//     its CINATRA_EXTENSION_DATA_ROOT reconciles that volume as the boot does: the
//     stale and the newer seed-owned dirs are pruned, the required seed is
//     materialized, the user dir stays. The materialize and rollback checks answer
//     from that volume state.
// The script's own `probe` code runs for real under node, with `fetch` replaced by
// fetch-preload.mjs, which answers only a GET of the probed URL; so the 300-character
// cut of `probe` applies to the modelled body.
//
// Env: STUB_STATE (state file), STUB_IMAGE (the IMAGE the script boots),
// STUB_SOFT_ENV and STUB_HARD_ENV (comma-separated SOFT_ and HARD_REQUIRED_ENV names).
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { STUB_STATE, STUB_IMAGE, STUB_SOFT_ENV, STUB_HARD_ENV } = process.env;
const args = process.argv.slice(2);

function die(msg) {
  process.stderr.write(`docker-stub: ${msg}: docker ${args.join(" ")}\n`);
  process.exit(97);
}
/** Exit as real docker does when it refuses a call. */
function refuse(code, msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(code);
}
if (!STUB_STATE || !STUB_IMAGE || STUB_SOFT_ENV === undefined || STUB_HARD_ENV === undefined) die("stub env not set");

const CALLS = JSON.parse(readFileSync(path.join(here, "script-calls.json"), "utf8"));
const state = existsSync(STUB_STATE)
  ? JSON.parse(readFileSync(STUB_STATE, "utf8"))
  : { runs: [], containers: {}, networks: [], volumes: {} };
const save = () => writeFileSync(STUB_STATE, JSON.stringify(state));
const names = (list) => list.split(",").filter(Boolean);
const blank = (v) => (v ?? "").trim() === "";
const SIDE_IMAGES = new Set(["postgres:18", "redis:8"]);
const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DATA_ROOT = "/srv/extensions-data";
const equal = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

/** Parse `run` options; dies on anything the script does not use. */
function parseRun(rest) {
  const out = { detach: false, remove: false, name: null, network: null, env: {}, mounts: [], image: null, cmd: [] };
  let i = 0;
  for (; i < rest.length && rest[i].startsWith("-"); i++) {
    const a = rest[i];
    if (a === "-d") { out.detach = true; continue; }
    if (a === "--rm") { out.remove = true; continue; }
    if (!["--name", "--network", "-e", "-v"].includes(a)) die(`unknown run option ${a}`);
    const v = rest[++i];
    if (v === undefined) die(`no value for ${a}`);
    if (a === "--name") out.name = v;
    else if (a === "--network") out.network = v;
    else if (a === "-v") out.mounts.push(v);
    else {
      const eq = v.indexOf("=");
      const k = eq < 0 ? v : v.slice(0, eq);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) die(`bad -e ${v}`);
      if (eq >= 0) out.env[k] = v.slice(eq + 1);
      else if (process.env[k] !== undefined) out.env[k] = process.env[k];
      else delete out.env[k];
    }
  }
  if (i >= rest.length) die("run without an image");
  out.image = rest[i];
  out.cmd = rest.slice(i + 1);
  if (out.detach === out.remove) die("run needs exactly one of -d and --rm");
  return out;
}

/** Check what real docker checks before a run starts; exits on a refusal. */
function checkRun(r) {
  if (r.name !== null && !NAME.test(r.name)) refuse(125, `docker: Error response from daemon: Invalid container name (${r.name}).`);
  if (r.network !== null && !state.networks.includes(r.network)) {
    refuse(125, `docker: Error response from daemon: network ${r.network} not found.`);
  }
  if (r.mounts.length > 1) die("run with more than one -v");
  for (const m of r.mounts) {
    const parts = m.split(":");
    if (parts.length !== 2 || !NAME.test(parts[0]) || !/^\/[^:]*$/.test(parts[1])) {
      refuse(125, `docker: Error response from daemon: invalid volume specification: '${m}'.`);
    }
  }
}

/** The volume an app container mounts at its extension data root, or null. */
function dataVolume(c) {
  if (c.mounts.length !== 1) return null;
  const [vol, target] = c.mounts[0].split(":");
  return target === DATA_ROOT && c.env.CINATRA_EXTENSION_DATA_ROOT === DATA_ROOT ? vol : null;
}

/** A start of a container: the app's preflight, then the boot reconcile of its volume. */
function start(c) {
  c.running = c.hardMissing.length === 0;
  const vol = c.app && c.running ? dataVolume(c) : null;
  if (vol !== null) {
    const v = state.volumes[vol];
    v.stale = false;
    v.newer = false;
    v.materialized = true;
  }
}

function health(c) {
  const degraded = [];
  const blocking = [];
  if (c.mounts.length === 0) degraded.push("user-store-mount-check");
  if (names(STUB_SOFT_ENV).some((n) => blank(c.env[n]))) degraded.push("required-env-soft-check");
  if (c.env.CINATRA_BOOT_SIMULATE_DEGRADED === "1") {
    degraded.push("boot-degrade-probe");
    blocking.push("boot-degrade-probe");
  }
  const blocked = blocking.length > 0;
  const body = JSON.stringify({
    status: blocked ? "degraded" : "ok",
    degraded: degraded.length > 0,
    port: "3000",
    cloneSlug: null,
    boot: {
      scope: "process-local",
      readiness: degraded.length > 0 ? "degraded" : "ready",
      startedAt: 1793742192682,
      readyAt: 1793742203550,
      degradedPhases: degraded,
      blockingPhases: blocking,
    },
  });
  return { status: blocked ? 503 : 200, body };
}

/** The response a probe of `url` gets, or null when nothing serves there. */
function respond(url) {
  const u = new URL(url);
  const c = state.containers[u.hostname];
  if (!c || !c.running || !c.app || !state.networks.includes(c.network)) return null;
  if (u.pathname === "/api/health") return { ...health(c), url };
  if (u.pathname === "/") return { status: 200, url: `${u.origin}/setup/account`, body: "<html></html>" };
  return null;
}

function runProbe(cmd) {
  // cmd = ["node", "-e", <the script's probe code>, <url>]
  const r = respond(cmd[3]);
  const p = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(path.join(here, "fetch-preload.mjs")).href, "-e", cmd[2], cmd[3]],
    { env: { ...process.env, STUB_RESPONSE: JSON.stringify(r === null ? null : { ...r, request: cmd[3] }) }, encoding: "utf8" },
  );
  process.stdout.write(p.stdout);
  process.stderr.write(p.stderr);
  process.exit(p.status ?? 1);
}

/** A container known to the stand-in, or exit 1 as docker does for an unknown name. */
function known(name) {
  const c = state.containers[name];
  if (!c) refuse(1, `Error: No such container: ${name}`);
  return c;
}

/** Answer an exec in an app container; the code must equal one of the script's checks. */
function execApp(c, cmd) {
  if (cmd.length !== 3 || cmd[0] !== "node" || cmd[1] !== "-e") die("unknown exec in the app");
  const code = cmd[2];
  const v = state.volumes[dataVolume(c)] ?? null;
  if (code === CALLS.declaredRequired) {
    process.stdout.write("@acme/a\n@acme/b\n");
    process.exit(0);
  }
  if (code === CALLS.materialize) {
    if (v === null || !v.materialized) refuse(1, "MISSING @acme/a");
    if (v.stale) refuse(1, "STALE-NOT-PRUNED zz-stale/gone-agent");
    if (!v.user) refuse(1, "USER-DIR-PRUNED acme/user-agent");
    process.stdout.write("seeded=2 pruned-stale preserved-user\n");
    process.exit(0);
  }
  if (code === CALLS.rollback) {
    if (v === null || !v.materialized) refuse(1, "CURRENT-SEED-MISSING @acme/a");
    if (v.newer) refuse(1, "NEWER-SEED-NOT-PRUNED zz-newer/future-agent");
    if (!v.user) refuse(1, "USER-DIR-PRUNED-ON-ROLLBACK acme/user-agent");
    process.stdout.write("current-seed-kept newer-pruned user-preserved\n");
    process.exit(0);
  }
  die("unknown exec node code");
}

/** Answer an exec in the postgres container; the argv must equal one the script sends. */
function execPg(cmd) {
  const base = ["psql", "-U", "postgres", "-d", "postgres"];
  if (equal(cmd, ["pg_isready", "-U", "postgres", "-q"])) process.exit(0);
  if (equal(cmd, [...base, "-tA", "-F", " ", "-c", CALLS.anchorCountsSql])) {
    process.stdout.write("2 2 2 0\n");
    process.exit(0);
  }
  if (equal(cmd, [...base, "-tA", "-c", CALLS.requiredSql])) {
    process.stdout.write("@acme/a\n@acme/b\n");
    process.exit(0);
  }
  if (equal(cmd, [...base, "-c", CALLS.digestlessSql])) process.exit(0);
  die("unknown exec in postgres");
}

const [verb, ...rest] = args;
switch (verb) {
  case "network": {
    if (rest.length !== 2 || !NAME.test(rest[1])) die("unknown network call");
    const [op, net] = rest;
    if (op === "create") {
      if (state.networks.includes(net)) refuse(1, `Error response from daemon: network with name ${net} already exists`);
      state.networks.push(net);
    } else if (op === "rm") {
      if (!state.networks.includes(net)) refuse(1, `Error response from daemon: network ${net} not found`);
      if (Object.values(state.containers).some((c) => c.network === net)) {
        refuse(1, `Error response from daemon: error while removing network: network ${net} has active endpoints`);
      }
      state.networks = state.networks.filter((n) => n !== net);
    } else die("unknown network call");
    save();
    process.exit(0);
  }
  case "volume": {
    if (rest.length !== 2 || rest[0] !== "rm" || !NAME.test(rest[1])) die("unknown volume call");
    if (!state.volumes[rest[1]]) refuse(1, `Error response from daemon: get ${rest[1]}: no such volume`);
    delete state.volumes[rest[1]];
    save();
    process.exit(0);
  }
  case "ps": {
    if (rest.length !== 3 || rest[0] !== "-a" || rest[1] !== "--filter" || !rest[2].startsWith("name=")) die("unknown ps call");
    const part = rest[2].slice("name=".length);
    const rows = Object.values(state.containers).filter((c) => c.name.includes(part));
    process.stdout.write(["IMAGE\tSTATUS\tNAMES", ...rows.map((c) => `${c.image}\t${c.running ? "Up" : "Exited"}\t${c.name}`)].join("\n") + "\n");
    process.exit(0);
  }
  case "rm": {
    if (rest.length < 2 || rest[0] !== "-f" || !rest.slice(1).every((n) => NAME.test(n))) die("unknown rm call");
    const missing = rest.slice(1).filter((n) => !state.containers[n]);
    for (const n of rest.slice(1)) delete state.containers[n];
    save();
    for (const n of missing) process.stderr.write(`Error response from daemon: No such container: ${n}\n`);
    for (const n of rest.slice(1)) if (!missing.includes(n)) process.stdout.write(`${n}\n`);
    process.exit(missing.length > 0 ? 1 : 0);
  }
  case "restart": {
    if (rest.length !== 1) die("unknown restart call");
    const c = known(rest[0]);
    c.running = false;
    start(c);
    save();
    process.stdout.write(`${c.name}\n`);
    process.exit(0);
  }
  case "inspect": {
    if (rest.length !== 3 || rest[0] !== "-f" || rest[1] !== "{{.State.Running}}") die("unknown inspect call");
    process.stdout.write(known(rest[2]).running ? "true\n" : "false\n");
    process.exit(0);
  }
  case "logs": {
    if (rest.length !== 1) die("unknown logs call");
    const c = known(rest[0]);
    if (!c.app) process.exit(0);
    if (c.hardMissing.length > 0) {
      process.stdout.write(`[required-env-preflight] missing required env: ${c.hardMissing.join(", ")}\n`);
    } else {
      process.stdout.write("[boot] StaticBundleLoader: 2 packages\n");
      if (c.mounts.length === 0) process.stdout.write('[boot] phase "user-store-mount-check" failed (retryable)\n');
    }
    process.exit(0);
  }
  case "run": {
    const r = parseRun(rest);
    if (r.detach) {
      if (!r.name || !r.network) die("run -d without --name or --network");
      if (r.cmd.length !== 0) die("run -d with a command");
      const app = r.image === STUB_IMAGE;
      if (!app && !SIDE_IMAGES.has(r.image)) die("run -d of an unknown image");
      checkRun(r);
      if (state.containers[r.name]) {
        refuse(125, `docker: Error response from daemon: Conflict. The container name "/${r.name}" is already in use.`);
      }
      for (const m of r.mounts) {
        const vol = m.split(":")[0];
        state.volumes[vol] ??= { stale: false, newer: false, user: false, materialized: false };
      }
      const hardMissing = app ? names(STUB_HARD_ENV).filter((n) => blank(r.env[n])) : [];
      const c = { name: r.name, image: r.image, app, network: r.network, env: r.env, mounts: r.mounts, hardMissing, running: false };
      start(c);
      state.runs.push(c);
      state.containers[r.name] = c;
      save();
      process.exit(0);
    }
    if (r.image !== STUB_IMAGE || r.name !== null) die("unknown run --rm call");
    checkRun(r);
    if (r.network === null && r.mounts.length === 0 && equal(r.cmd, ["node", "packages/cli/bin/cinatra.mjs", "--help"])) {
      process.stdout.write("Cinatra setup CLI\nUsage: cinatra <command>\n");
      process.exit(0);
    }
    if (r.network !== null && r.mounts.length === 0
      && equal(r.cmd, ["node", "node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs", "instance", "setup", "prod"])) {
      process.exit(0);
    }
    if (r.network !== null && r.mounts.length === 0 && r.cmd.length === 4 && r.cmd[0] === "node" && r.cmd[1] === "-e") {
      if (r.cmd[2] !== CALLS.probe) die("unknown probe code");
      runProbe(r.cmd);
    }
    if (r.network === null && r.mounts.length === 1 && r.mounts[0].split(":")[1] === DATA_ROOT
      && r.cmd.length === 3 && r.cmd[0] === "sh" && r.cmd[1] === "-c") {
      const vol = r.mounts[0].split(":")[0];
      if (r.cmd[2] === CALLS.preseedSh) {
        state.volumes[vol] ??= { stale: false, newer: false, user: false, materialized: false };
        state.volumes[vol].stale = true;
        state.volumes[vol].user = true;
      } else if (r.cmd[2] === CALLS.newerSeedSh) {
        state.volumes[vol] ??= { stale: false, newer: false, user: false, materialized: false };
        state.volumes[vol].newer = true;
      } else die("unknown sh -c body");
      save();
      process.exit(0);
    }
    die("unknown run --rm call");
    break;
  }
  case "exec": {
    const [name, ...cmd] = rest;
    const c = known(name);
    if (!c.running) refuse(1, `Error response from daemon: container ${name} is not running`);
    if (c.image === "postgres:18") execPg(cmd);
    if (c.image === "redis:8" && equal(cmd, ["redis-cli", "ping"])) {
      process.stdout.write("PONG\n");
      process.exit(0);
    }
    if (c.app) execApp(c, cmd);
    die("unknown exec");
    break;
  }
  default:
    die("unknown verb");
}
