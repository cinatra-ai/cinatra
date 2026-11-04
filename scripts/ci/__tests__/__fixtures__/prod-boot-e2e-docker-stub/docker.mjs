// A stand-in `docker` for scripts/ci/prod-boot-e2e.sh (cinatra#4154). The test puts a
// `docker` wrapper first on PATH that runs this file, then runs the real script.
//
// Every call is checked against the exact shapes the script uses before it changes
// anything; any other call exits non-zero and records nothing, so a script change this
// stand-in does not know fails the test instead of passing it. This file exits 97. A
// call whose `--env-file` names a missing file never reaches it: node reads that
// option from its whole argument list and exits 9.
//
// A valid `docker run -d` is recorded as a run in the state file, with its EFFECTIVE
// env resolved once, here: the last `-e NAME=value` of a name wins, and a bare
// `-e NAME` takes the value from the env of this docker invocation (unset stays
// unset), as docker does. The test reads these recorded runs and nothing else.
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
// The script's own `probe` code runs for real under node, with `fetch` replaced by
// fetch-preload.mjs, so its 300-character cut applies to the modelled body.
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
if (!STUB_STATE || !STUB_IMAGE || STUB_SOFT_ENV === undefined || STUB_HARD_ENV === undefined) die("stub env not set");

const state = existsSync(STUB_STATE) ? JSON.parse(readFileSync(STUB_STATE, "utf8")) : { runs: [], containers: {} };
const save = () => writeFileSync(STUB_STATE, JSON.stringify(state));
const names = (list) => list.split(",").filter(Boolean);
const blank = (v) => (v ?? "").trim() === "";
const SIDE_IMAGES = new Set(["postgres:18", "redis:8"]);

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
  if (!c || !c.running || !c.app) return null;
  if (u.pathname === "/api/health") return { ...health(c), url };
  if (u.pathname === "/") return { status: 200, url: `${u.origin}/setup/account`, body: "<html></html>" };
  return null;
}

function runProbe(cmd) {
  // cmd = ["node", "-e", <the script's probe code>, <url>]
  const r = respond(cmd[3]);
  if (r === null) { process.stderr.write("fetch failed\n"); process.exit(1); }
  const p = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(path.join(here, "fetch-preload.mjs")).href, "-e", cmd[2], cmd[3]],
    { env: { ...process.env, STUB_RESPONSE: JSON.stringify(r) }, encoding: "utf8" },
  );
  process.stdout.write(p.stdout);
  process.stderr.write(p.stderr);
  process.exit(p.status ?? 1);
}

/** A container known to the stand-in, or exit 1 as docker does for an unknown name. */
function known(name) {
  const c = state.containers[name];
  if (!c) { process.stderr.write(`Error: No such container: ${name}\n`); process.exit(1); }
  return c;
}

const [verb, ...rest] = args;
switch (verb) {
  case "network":
    if (rest.length === 2 && (rest[0] === "create" || rest[0] === "rm")) process.exit(0);
    die("unknown network call");
    break;
  case "volume":
    if (rest.length === 2 && rest[0] === "rm") process.exit(0);
    die("unknown volume call");
    break;
  case "ps":
    if (rest.length === 3 && rest[0] === "-a" && rest[1] === "--filter" && rest[2].startsWith("name=")) process.exit(0);
    die("unknown ps call");
    break;
  case "rm":
    if (rest.length >= 2 && rest[0] === "-f" && rest.slice(1).every((n) => !n.startsWith("-"))) {
      for (const n of rest.slice(1)) delete state.containers[n];
      save();
      process.exit(0);
    }
    die("unknown rm call");
    break;
  case "restart": {
    if (rest.length !== 1) die("unknown restart call");
    known(rest[0]);
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
      if (state.containers[r.name]) die("run -d of a name in use");
      const hardMissing = app ? names(STUB_HARD_ENV).filter((n) => blank(r.env[n])) : [];
      const c = { name: r.name, image: r.image, app, env: r.env, mounts: r.mounts, hardMissing, running: hardMissing.length === 0 };
      state.runs.push(c);
      state.containers[r.name] = c;
      save();
      process.exit(0);
    }
    if (r.image !== STUB_IMAGE || r.name !== null) die("unknown run --rm call");
    const cmd = r.cmd.join(" ");
    if (r.cmd[0] === "sh" && r.cmd[1] === "-c" && r.cmd.length === 3 && r.mounts.length === 1) process.exit(0);
    if (cmd === "node packages/cli/bin/cinatra.mjs --help") {
      process.stdout.write("Cinatra setup CLI\nUsage: cinatra <command>\n");
      process.exit(0);
    }
    if (cmd === "node node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs instance setup prod") process.exit(0);
    if (r.cmd.length === 4 && r.cmd[0] === "node" && r.cmd[1] === "-e" && r.network) runProbe(r.cmd);
    die("unknown run --rm call");
    break;
  }
  case "exec": {
    const [name, ...cmd] = rest;
    const c = known(name);
    if (!c.running) { process.stderr.write(`Error: container ${name} is not running\n`); process.exit(1); }
    const text = cmd.join(" ");
    if (c.image === "postgres:18" && text === "pg_isready -U postgres -q") process.exit(0);
    if (c.image === "redis:8" && text === "redis-cli ping") { process.stdout.write("PONG\n"); process.exit(0); }
    if (c.image === "postgres:18" && cmd[0] === "psql") {
      process.stdout.write(cmd.includes("-F") ? "2 2 2 0\n" : "@acme/a\n@acme/b\n");
      process.exit(0);
    }
    if (c.app && cmd.length === 3 && cmd[0] === "node" && cmd[1] === "-e") {
      if (cmd[2].includes("pkg.cinatra")) process.stdout.write("@acme/a\n@acme/b\n");
      else if (cmd[2].includes("zz-newer")) process.stdout.write("current-seed-kept newer-pruned user-preserved\n");
      else if (cmd[2].includes("zz-stale")) process.stdout.write("seeded=2 pruned-stale preserved-user\n");
      else die("unknown exec node code");
      process.exit(0);
    }
    die("unknown exec");
    break;
  }
  default:
    die("unknown verb");
}
