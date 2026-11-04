// A stand-in `docker` for scripts/ci/prod-boot-e2e.sh (cinatra#4154). The test puts a
// `docker` wrapper first on PATH that runs this file, then runs the real script.
//
// It records the argv of every `docker run`, keeps each started container's
// effective env in a state file, and answers every other call the script makes with
// the value the script's assertion expects of a sound image. It models /api/health
// from that effective env, in the field order of src/app/api/health/route.ts:
//   - `user-store-mount-check` is degraded when the container has no `-v` mount;
//   - `required-env-soft-check` is degraded when a SOFT_REQUIRED_ENV name has no
//     non-blank effective value (the last `-e NAME=value` wins, as in docker; a bare
//     `-e NAME` takes the value from this process's env);
//   - CINATRA_BOOT_SIMULATE_DEGRADED=1 adds the blocking `boot-degrade-probe`.
// The script's own `probe` code runs for real under node, with `fetch` replaced by
// fetch-preload.mjs, so its 300-character cut applies to the modelled body.
// An unknown call fails with exit 97, so a script change this stand-in does not
// know fails the test instead of passing it.
//
// Env: STUB_STATE (state file), STUB_LOG (JSON lines, one per call), STUB_IMAGE (the
// IMAGE the script boots), STUB_SOFT_ENV (comma-separated SOFT_REQUIRED_ENV names).
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const { STUB_STATE, STUB_LOG, STUB_IMAGE, STUB_SOFT_ENV } = process.env;
const args = process.argv.slice(2);

function die(msg) {
  process.stderr.write(`docker-stub: ${msg}: docker ${args.join(" ")}\n`);
  process.exit(97);
}
if (!STUB_STATE || !STUB_LOG || !STUB_IMAGE || STUB_SOFT_ENV === undefined) die("stub env not set");

const state = existsSync(STUB_STATE) ? JSON.parse(readFileSync(STUB_STATE, "utf8")) : { containers: {} };
const save = () => writeFileSync(STUB_STATE, JSON.stringify(state));
appendFileSync(STUB_LOG, JSON.stringify(args) + "\n");

const FLAGS = new Set(["-d", "--rm"]);
const VALUED = new Set(["--name", "--network", "-e", "-v"]);

/** Parse `run` options; returns { detach, name, env: [[k, v|null]...], mounts, image, cmd }. */
function parseRun(rest) {
  const out = { detach: false, name: null, env: [], mounts: [], image: null, cmd: [] };
  let i = 0;
  for (; i < rest.length; i++) {
    const a = rest[i];
    if (!a.startsWith("-")) break;
    if (FLAGS.has(a)) { if (a === "-d") out.detach = true; continue; }
    if (!VALUED.has(a)) die(`unknown run option ${a}`);
    const v = rest[++i];
    if (v === undefined) die(`no value for ${a}`);
    if (a === "--name") out.name = v;
    else if (a === "-v") out.mounts.push(v);
    else if (a === "-e") {
      const eq = v.indexOf("=");
      out.env.push(eq < 0 ? [v, null] : [v.slice(0, eq), v.slice(eq + 1)]);
    }
  }
  if (i >= rest.length) die("run without an image");
  out.image = rest[i];
  out.cmd = rest.slice(i + 1);
  return out;
}

/** The value a container sees for `name`: the last -e wins; a bare -e reads this env. */
function effective(env, name) {
  let val;
  for (const [k, v] of env) if (k === name) val = v === null ? process.env[name] : v;
  return val;
}

function health(c) {
  const degraded = [];
  const blocking = [];
  if (c.mounts.length === 0) degraded.push("user-store-mount-check");
  const soft = STUB_SOFT_ENV.split(",").filter(Boolean);
  if (soft.some((n) => (effective(c.env, n) ?? "").trim() === "")) degraded.push("required-env-soft-check");
  if (effective(c.env, "CINATRA_BOOT_SIMULATE_DEGRADED") === "1") {
    degraded.push("boot-degrade-probe");
    blocking.push("boot-degrade-probe");
  }
  const bad = blocking.length > 0;
  const body = JSON.stringify({
    status: bad ? "degraded" : "ok",
    degraded: bad,
    port: "3000",
    cloneSlug: null,
    boot: {
      scope: "process-local",
      readiness: bad ? "degraded" : "ready",
      startedAt: 1793742192682,
      readyAt: 1793742203550,
      degradedPhases: degraded,
      blockingPhases: blocking,
    },
  });
  return { status: bad ? 503 : 200, body };
}

/** The response a probe of `url` gets, or null when the container serves nothing. */
function respond(url) {
  const u = new URL(url);
  const c = state.containers[u.hostname];
  if (!c || !c.serving) return null;
  if (u.pathname === "/api/health") return { status: health(c).status, url, body: health(c).body };
  if (u.pathname === "/") return { status: 200, url: `${u.origin}/setup/account`, body: "<html></html>" };
  return null;
}

function runProbe(cmd) {
  // cmd = ["node", "-e", <the script's probe code>, <url>]
  if (cmd.length !== 4 || cmd[0] !== "node" || cmd[1] !== "-e") die("unknown --rm node call");
  const r = respond(cmd[3]);
  if (r === null) { process.stderr.write("fetch failed\n"); process.exit(1); }
  const p = spawnSync(process.execPath, ["--import", pathToFileURL(path.join(here, "fetch-preload.mjs")).href, "-e", cmd[2], cmd[3]], {
    env: { ...process.env, STUB_RESPONSE: JSON.stringify(r) },
    encoding: "utf8",
  });
  process.stdout.write(p.stdout);
  process.stderr.write(p.stderr);
  process.exit(p.status ?? 1);
}

const [verb, ...rest] = args;
const missingEnv = (n) => n.endsWith("-app-missing-env");
switch (verb) {
  case "network":
  case "volume":
  case "rm":
  case "restart":
  case "ps":
    process.exit(0);
  case "run": {
    const r = parseRun(rest);
    if (r.detach) {
      if (!r.name) die("run -d without --name");
      // An app boot of the image serves unless it lacks hard-required env (item 3).
      const isApp = r.image === STUB_IMAGE;
      state.containers[r.name] = { ...r, isApp, serving: isApp && !missingEnv(r.name) };
      save();
      process.exit(0);
    }
    if (r.image !== STUB_IMAGE) die("run --rm of another image");
    if (r.cmd[0] === "sh" && r.cmd[1] === "-c") process.exit(0);
    if (r.cmd.join(" ") === "node packages/cli/bin/cinatra.mjs --help") {
      process.stdout.write("Cinatra setup CLI\nUsage: cinatra <command>\n");
      process.exit(0);
    }
    if (r.cmd.join(" ") === "node node_modules/@cinatra-ai/cinatra/bin/cinatra.mjs instance setup prod") process.exit(0);
    runProbe(r.cmd);
    break;
  }
  case "exec": {
    const [name, ...cmd] = rest;
    const line = cmd.join(" ");
    if (cmd[0] === "pg_isready") process.exit(0);
    if (line === "redis-cli ping") { process.stdout.write("PONG\n"); process.exit(0); }
    if (cmd[0] === "psql") {
      process.stdout.write(cmd.includes("-F") ? "2 2 2 0\n" : "@acme/a\n@acme/b\n");
      process.exit(0);
    }
    if (cmd[0] === "node" && cmd[1] === "-e" && state.containers[name]?.serving) {
      if (cmd[2].includes("pkg.cinatra")) process.stdout.write("@acme/a\n@acme/b\n");
      else if (cmd[2].includes("zz-newer")) process.stdout.write("current-seed-kept newer-pruned user-preserved\n");
      else process.stdout.write("seeded=2 pruned-stale preserved-user\n");
      process.exit(0);
    }
    die("unknown exec");
    break;
  }
  case "inspect": {
    const name = rest[rest.length - 1];
    const c = state.containers[name];
    process.stdout.write(c && c.serving ? "true\n" : "false\n");
    process.exit(0);
  }
  case "logs": {
    const name = rest[rest.length - 1];
    if (missingEnv(name)) {
      process.stdout.write("[required-env-preflight] missing: BETTER_AUTH_SECRET, CINATRA_ENCRYPTION_KEY\n");
    } else if (state.containers[name]?.serving) {
      const c = state.containers[name];
      process.stdout.write("[boot] StaticBundleLoader: 2 packages\n");
      if (c.mounts.length === 0) process.stdout.write('[boot] phase "user-store-mount-check" failed (retryable)\n');
    }
    process.exit(0);
  }
  default:
    die("unknown verb");
}
