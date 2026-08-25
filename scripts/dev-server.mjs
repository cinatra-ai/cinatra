// Dev-server launcher that makes `pnpm dev` honor the worktree's .env.local PORT.
//
// Next.js resolves its dev port from the *process* env (PORT) or --port flag
// BEFORE it loads .env.local into the app runtime. Worktrees provisioned by
// `cinatra setup branch` / `cinatra setup clone` write an isolated PORT into
// .env.local, but plain `next dev` never reads it and silently lands on 3000,
// colliding with the main repo. This launcher surfaces .env.local's PORT into
// process.env before spawning Next.js so isolated worktrees bind their own port.
//
// Precedence (unchanged from Next.js): real shell PORT > .env.local PORT > 3000.

import { spawn } from "node:child_process";
import net from "node:net";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_DB_SERVICES,
  isLoopbackHost,
  shouldDiagnoseDrift,
  diagnoseDockerPortDrift,
  resolveMainRepoRoot,
  formatDriftRemedy,
  parseHostPort,
} from "./lib/docker-port-drift.mjs";
import {
  nangoHealthUrl,
  isLocalNangoUrl,
  resolveNangoBaseUrl,
  probeHttpHealth,
} from "./lib/nango-health.mjs";
import {
  COMPOSE_PROJECT_ENV_VAR,
  SKIP_PREFLIGHT_ENV_VAR,
  classifyServiceUrl,
  createComposeRunner,
  formatComposeCommand,
  formatConnectPortMismatch,
  formatStandDownUnreachable,
  formatUnmanagedServices,
  formatUnusableServiceUrl,
  isLinkedWorktree,
  planMessages,
  readEnvFileValue,
  redactUrlCredentials,
  WITHHELD_URL_VALUE,
  resolveComposeHostPortPlan,
  resolveComposeProjectName,
  resolvePublishedHostPort,
  unmanagedComposeServices,
  shouldSkipDevPreflight,
} from "./lib/dev-preflight.mjs";

// Repo root (the dir holding docker-compose*.yml), resolved from THIS script's
// location so the best-effort Nango heal targets the right compose files no
// matter what cwd `pnpm dev` was launched from.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const envPath = path.join(process.cwd(), ".env.local");
// The Nango preflight heals against repoRoot's compose files (resolved from this
// script's location, not cwd), so it reads NANGO_SERVER_URL from the SAME root's
// .env.local — otherwise launching `pnpm dev` from outside the repo root would
// miss a configured remote Nango URL and wrongly fall back to the local default.
const repoEnvPath = path.join(repoRoot, ".env.local");
// Worktree-scoped marker the `pnpm dev:stop` tooling (scripts/dev-stop.mjs)
// reads to find + cleanly SIGTERM THIS worktree's dev server. It
// records the repo root + port so dev-stop can verify ownership before signaling
// and never touch another worktree or the main checkout.
const pidFilePath = path.join(process.cwd(), ".next", "dev-server.json");

// A PORT explicitly set in the real shell environment always wins.
if (!process.env.PORT) {
  const envPort = readEnvFileValue(envPath, "PORT");
  if (envPort) {
    process.env.PORT = envPort;
    console.log(`[dev-server] PORT=${envPort} (from ${path.relative(process.cwd(), envPath) || ".env.local"})`);
  }
}

// Every `.env.local` this launcher may consult: the one in the cwd it was
// launched from, then the repo root's (identical when `pnpm dev` runs from the
// checkout root, different when it does not). First stated value wins.
const ENV_FILES = [envPath, ...(repoEnvPath === envPath ? [] : [repoEnvPath])];

// Look one key up across those files (cwd first).
function lookupEnvFiles(key) {
  for (const file of ENV_FILES) {
    const value = readEnvFileValue(file, key);
    if (value !== undefined) return value;
  }
  return undefined;
}

// cinatra#2839: the bypass switch is resolved ONCE, from the real shell
// environment AND from `.env.local` — a worktree lane records its configuration
// in `.env.local` (that is where it states PORT and its service URLs), so a lane
// that opts out there must be honored exactly as a shell export is. Reading the
// process env alone meant the flag's documented promise — that `pnpm dev`
// starts NOTHING via Docker — silently did not hold for the lanes that need it
// most.
const skipPreflight = shouldSkipDevPreflight({
  processEnv: process.env,
  envFileValues: ENV_FILES.map((file) => readEnvFileValue(file, SKIP_PREFLIGHT_ENV_VAR)),
});

// The compose project this preflight is allowed to act on, resolved from the
// SAME per-worktree switch the rest of the stack uses (COMPOSE_PROJECT_NAME),
// read from the shell env AND `.env.local` because Docker itself only reads the
// former. Unset = the historical main-checkout behavior: compose derives the
// project from the directory basename.
const composeProjectName = resolveComposeProjectName({
  processEnv: process.env,
  envFileValues: [lookupEnvFiles(COMPOSE_PROJECT_ENV_VAR)],
});
// The host ports this preflight may publish. Same resolver
// scripts/dev-compose-env.mjs exports to `make dev` and `pnpm services`, so no
// entry point starts this project on defaults while another derives.
// `portEnv` is what compose interpolates; `unmanaged` names the services whose
// configured URL says they are NOT this checkout's to publish (remote host, or
// loopback with no port stated). Derivation only happens for a named project —
// see resolveComposeHostPortPlan.
const composeHostPortPlan = resolveComposeHostPortPlan({
  processEnv: process.env,
  envFileLookup: lookupEnvFiles,
  projectName: composeProjectName,
  // The project compose derives for this checkout all by itself. A checkout
  // that merely PINS that same name has not made itself a second lane, so the
  // refusals below cannot reach it — see `laneScope` in dev-preflight.mjs.
  defaultProjectName: repoRoot,
  // …unless this IS a second checkout. A linked worktree pinning its own
  // basename matched that test and inherited the operator's leniency, so a
  // missing service URL only warned and then published the shared defaults into
  // the operator's stack. See `isLinkedWorktree`.
  linkedWorktree: isLinkedWorktree(repoRoot),
});

// A plan with a hole in it — a named lane with no host port for a scoped
// service, an unusable CINATRA_*_HOST_PORT, a companion port that overflows —
// is never papered over with the shared default. There is nothing safe to
// publish, so this preflight touches Docker not at all: the refusal is enforced
// at the same chokepoint the skip flag is (`createComposeRunner`), not left as a
// warning the launcher then ignores.
const planRefused = composeHostPortPlan.refusals.length > 0;
if (planRefused) {
  console.error(
    `\n[dev-server] ✖ Compose host-port scoping is unresolved — not touching Docker for this run.\n`,
  );
  for (const message of planMessages(composeHostPortPlan.refusals)) {
    console.error(`  • ${message}`);
  }
  console.error("");
}
for (const message of planMessages(composeHostPortPlan.warnings)) {
  console.warn(`[dev-server] ⚠ ${message}`);
}

// Narrow Docker DB-port preflight (CINATRA_SKIP_DEV_PREFLIGHT=1 to skip, from
// the shell env or `.env.local`). Read-only: it inspects containers, never
// creates them.
//
// `next dev` against a host where the bundled Postgres/Redis containers run but
// publish no host port (a base-only `docker compose up` without
// docker-compose.dev.yml) fails with a cryptic ECONNREFUSED deep in app boot.
// Catch that drift HERE and print the one-command remedy. Plain "not started
// yet" stays a non-blocking warning (start docker, the app reconnects); only the
// positively-diagnosed drift — running container, unpublished port — is fatal,
// because it is a definitively-broken state with a known fix.
// NOTE: `readEnvFileValue` strips dotenv inline comments, so this — the PORT
// read above and every DSN read here — now sees `redis://127.0.0.1:16379` for
// `REDIS_URL=redis://127.0.0.1:16379 # lane cache`, where the old reader
// returned the whole annotated string and parseHostPort fell back to the
// default. A `#` that is part of the value (a dev DB password, a URL fragment)
// still survives: the comment must begin the value or follow whitespace. Both
// halves are asserted in scripts/__tests__/dev-preflight.test.mjs.
// The stated value itself, read by the SAME precedence the address below is
// derived with. Kept separate because the two answer different questions: this
// one is what the operator WROTE, and `parseHostPort` may hand back an address
// that appears nowhere in it (cinatra#2839, round-4 finding).
function envUrlValue(filePath, key) {
  return process.env[key] || readEnvFileValue(filePath, key);
}

function envHostPort(filePath, key, fallback) {
  const value = envUrlValue(filePath, key);
  // parseHostPort applies explicit-port > scheme-default > fallback precedence, so
  // a no-port loopback URL (e.g. postgresql://…@localhost/db = :5432) is NOT
  // mis-read as the bundled host port and never triggers a false drift exit.
  return parseHostPort(value, fallback);
}

function probeTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, host);
  });
}

async function runDbPortPreflight() {
  if (skipPreflight) return;
  if (planRefused) return; // the ports it would diagnose against are the unresolved ones
  // Only the two REQUIRED services gate boot; neo4j (recommended) is skipped to
  // keep healthy boots fast.
  const targets = BUNDLED_DB_SERVICES.filter((s) =>
    ["postgres", "redis"].includes(s.composeService),
  );
  const down = [];
  // Rows whose STATED URL names no address at all. Kept apart from `down`
  // because "down" is an answer about an address, and these have none
  // (cinatra#2839, round-4 finding).
  const unusableUrls = [];
  for (const svc of targets) {
    // The port THIS checkout publishes for the service, read off the SAME plan
    // the compose runner below is pinned to (cinatra#2839, acceptance item 2).
    // Measuring against the hardcoded global default instead is what let this
    // read-only door disagree with the writing one: on a lane it either skipped
    // the diagnosis or condemned a healthy container. `resolvePublishedHostPort`
    // returns the historical default for anything the plan does not scope, so
    // postgres, neo4j and the whole unscoped checkout are untouched.
    const claim = resolvePublishedHostPort({
      composeService: svc.composeService,
      defaultHostPort: svc.defaultHostPort,
      plan: composeHostPortPlan,
    });
    // The plan claims no host port for it: the service is configured somewhere
    // else, so no container here is this checkout's to judge — the same
    // stand-down the Nango heal honors with `--no-deps`.
    //
    // It stands the DIAGNOSIS down, not the PROBE, and the difference is the
    // whole finding (cinatra#2839 round-3): the app still dials whatever its URL
    // resolves to, so "nothing is listening there" stays true and stays worth
    // saying. Skipping the loop here made a scoped, portless loopback
    // `REDIS_URL` — the one shape that reaches this branch and is still probed
    // on this host — say NOTHING where main warned, and ECONNREFUSED in app boot
    // was the next thing the operator heard. `scripts/check-services.mjs` skips
    // only the note and the diagnosis on the same condition and keeps printing
    // the row; this is that same stand-down, on the launching surface.
    const standDown = claim.standDown === true;
    const statedUrl = envUrlValue(envPath, svc.envVar);
    // NO ADDRESS, NO ADDRESS TALK (cinatra#2839, round-4 finding). A stated URL
    // that names no host and port — `REDIS_URL=not a url`, `redis://`, a `:0`
    // nothing can listen on — still reaches `parseHostPort`, which FALLS BACK to
    // the bundled `127.0.0.1:<default>`. Probing that fallback and reporting the
    // result named a service the app never talks to: either "not reachable yet
    // at 127.0.0.1:6379" for an address it does not use, or silence when the
    // operator's own redis happened to answer there. So the shape is settled
    // BEFORE the probe, the probe is not run, and the row gets the validation
    // line instead of a reachability one.
    //
    // It is spoken whatever the scope and whatever the stand-down: the defect is
    // in the URL, not in who publishes the service, and an unscoped checkout
    // with a broken URL was getting the same invented address. `standDown`
    // decides only whether the publishing half of the line is added, since
    // postgres is not a service this plan parameterizes.
    if (classifyServiceUrl(statedUrl).state === "unusable") {
      unusableUrls.push({ svc, url: statedUrl, standDown, hostPortVar: claim.envVar });
      continue;
    }
    const { host, port } = envHostPort(envPath, svc.envVar, {
      host: "127.0.0.1",
      port: svc.defaultHostPort,
    });
    // The probe follows the APP, always — it answers "can the app reach its
    // service?", so resolving it from the plan instead would report a healthy
    // container the app never talks to. When the two disagree on a scoped
    // checkout that disagreement is itself the finding, and a loud one: the lane
    // publishes its own service and then does its work in somebody else's.
    const mismatch = formatConnectPortMismatch({
      service: svc.label,
      claim,
      connectHost: host,
      connectPort: port,
      laneScope: composeHostPortPlan.laneScope,
    });
    if (mismatch) console.warn(`[dev-server] ⚠ ${mismatch}`);
    // A non-loopback host is somebody else's infrastructure — a hosted DB, a
    // shared cache — and always was outside this preflight. Not probed, not
    // diagnosed, not remarked on: the one skip that stays in front of everything.
    if (!isLoopbackHost(host)) continue;
    if (await probeTcp(host, port)) continue; // reachable → fine
    // Reachability and drift are two different questions, and the port test only
    // answers the second. A checkout that connects on a port it does not publish
    // has no container here to diagnose — but "nothing is listening there" is
    // still true, and gating the PROBE on the drift test is what turned that
    // case into total silence followed by ECONNREFUSED in app boot. Probe every
    // loopback service — the stood-down one included; diagnose only the ones
    // this checkout publishes.
    //
    // A stood-down service is never diagnosable: the plan claims no published
    // port for it, so there is nothing for `shouldDiagnoseDrift` to compare
    // against and no container here is this checkout's to inspect. Stated
    // outright rather than left to fall out of an undefined `claim.published`.
    down.push({
      svc,
      host,
      port,
      standDown,
      // Carried so the stand-down warning is formatted from the STATEMENT and
      // the address together, never from the address alone.
      statedUrl,
      // The plan's own name for this service's host-port claim, carried here so
      // the stand-down warning below can name the variable that would end the
      // stand-down without re-deriving it from the port table.
      hostPortVar: claim.envVar,
      diagnosable: !standDown && shouldDiagnoseDrift({ host, port }, svc, claim.published),
    });
  }
  // Before the early return: a row with no address is never in `down`, and this
  // is the one thing an operator with a broken URL needs to hear.
  for (const { svc, url, standDown, hostPortVar } of unusableUrls) {
    console.warn(
      `[dev-server] ⚠ ${formatUnusableServiceUrl({
        service: svc.label,
        urlVar: svc.envVar,
        url,
        hostPortVar,
        standDown,
      })}`,
    );
  }
  if (down.length === 0) return;

  let mainRoot;
  try {
    mainRoot = resolveMainRepoRoot(process.cwd());
  } catch {
    mainRoot = process.cwd();
  }
  const drifted = [];
  for (const { svc, port, diagnosable } of down) {
    // Down, but not at a port this checkout publishes: no container here is its
    // to inspect, so Docker is never touched for it. It still rides in `down`,
    // so the "not reachable yet" warning below names it.
    if (!diagnosable) continue;
    let diag;
    try {
      // `skip` is passed even though this function already returned on it
      // above: the guard belongs on the spawning function, so no call site
      // added later can reach Docker behind the flag. Same reason the compose
      // runner carries its own guard (scripts/lib/dev-preflight.mjs).
      diag = diagnoseDockerPortDrift({
        service: svc,
        mainRoot,
        expectedHostPort: port,
        projectName: composeProjectName,
        skip: skipPreflight,
      });
    } catch {
      diag = { available: false };
    }
    if (diag.available && diag.drift) drifted.push(svc.label);
  }

  if (drifted.length > 0) {
    console.error(`\n[dev-server] ✖ Docker host-port drift — refusing to start ${process.env.PORT ? `on PORT=${process.env.PORT}` : "the dev server"}.\n`);
    console.error(formatDriftRemedy(drifted));
    console.error("(Set CINATRA_SKIP_DEV_PREFLIGHT=1 to bypass this check.)\n");
    process.exit(1);
  }
  // Containers not running / unreachable but no drift — warn and continue; the
  // app retries and the operator may be bringing services up alongside.
  //
  // TWO SENTENCES, because there are two different answers. `pnpm services`
  // brings up the services this checkout publishes — and it REFUSES outright a
  // plan that stands one down (`formatStandDownRefusal`), since a whole-stack
  // `up` would start that service anyway, on the compose default, in somebody
  // else's face. Naming it as the remedy for a stood-down service would send the
  // operator to a command that cannot run, so the stood-down row gets its own
  // line and the remedy that does work (`formatStandDownUnreachable`).
  const publishedHere = down.filter((d) => !d.standDown);
  if (publishedHere.length > 0) {
    console.warn(
      `[dev-server] ⚠ ${publishedHere.map((d) => d.svc.label).join(", ")} not reachable yet — start them with \`pnpm services\` (the app will retry once they are up).`,
    );
  }
  for (const { svc, host, port, hostPortVar, statedUrl } of down.filter((d) => d.standDown)) {
    console.warn(
      `[dev-server] ⚠ ${formatStandDownUnreachable({
        service: svc.label,
        urlVar: svc.envVar,
        hostPortVar,
        host,
        port,
        // The stated URL travels WITH the address, so the formatter can refuse
        // to describe a derived fallback as the configured one. Unreachable by
        // construction here — an unusable URL never reaches `down` — and passed
        // anyway, because the guarantee belongs to the formatter, not to this
        // call site's ordering.
        url: statedUrl,
      })}`,
    );
  }
}

await runDbPortPreflight();

// Run a docker compose subcommand against the bundled dev stack (base +
// loopback-publish override, exactly as `make dev` does), pinned to THIS
// worktree's compose project and host ports, and hard-gated on the skip flag —
// see scripts/lib/dev-preflight.mjs for all three decisions and their tests.
const runCompose = createComposeRunner({
  spawnFn: spawn,
  skip: skipPreflight || planRefused,
  projectName: composeProjectName,
  portEnv: composeHostPortPlan.portEnv,
  cwd: repoRoot,
  baseEnv: process.env,
});

// Poll the /health URL up to `tries` times (spaced `intervalMs` apart). Returns
// true on the first healthy response, false once the budget is exhausted.
async function waitForNangoHealth(healthUrl, { tries, intervalMs }) {
  for (let i = 0; i < tries; i++) {
    if ((await probeHttpHealth(healthUrl, 4000)).ok) return true;
    if (i < tries - 1) await sleep(intervalMs);
  }
  return false;
}

// Nango connector-service preflight (CINATRA_SKIP_DEV_PREFLIGHT=1 to skip —
// honored from the shell env OR `.env.local`, the same switch the DB preflight
// reads; see `skipPreflight` above and scripts/lib/dev-preflight.mjs).
//
// This is the ONLY preflight that WRITES to Docker, so it is the one the skip
// flag exists for. Its `up -d nango-server` also starts nango-server's
// `depends_on` (nango-db, redis) — three containers, their volumes and the
// project network — which is why it is pinned to this worktree's compose
// project rather than a basename-derived one (cinatra#2839).
//
// The connector OAuth gateway (`cinatra-nango-server-1`) runs the upstream
// amd64-only image under qemu on arm64 dev hosts and can segfault. The compose
// `restart: unless-stopped` policy now self-revives a crash, but a host that
// never ran `docker compose up` (a bare `pnpm dev`) has no Nango at all, and a
// hung-but-port-bound process needs a kick. Probe the HTTP /health contract; if
// a LOCAL Nango is down, make ONE best-effort heal (compose up, then a single
// restart if it came up but stayed unhealthy), bounded-wait, otherwise print
// ONE actionable line.
//
// Never fatal: the app boots without connectors and reconnects when Nango
// returns, so this only warns — it must not block dev on the connector backend.
async function runNangoHealthPreflight() {
  if (skipPreflight) return;
  if (planRefused) return; // reported above; nothing here is safe to publish
  const rawUrl =
    process.env.NANGO_SERVER_URL || readEnvFileValue(repoEnvPath, "NANGO_SERVER_URL");
  const healthUrl = nangoHealthUrl(rawUrl);

  if ((await probeHttpHealth(healthUrl, 4000)).ok) return; // healthy → silent

  // A custom remote Nango (hosted / shared infra) is not ours to start — flag it.
  // The address is redacted like every other stated URL this preflight echoes
  // (cinatra#2913, round-5 finding N4): a hosted Nango URL is the shape most
  // likely to carry userinfo, and this line is printed on every `pnpm dev`
  // while that host is down.
  //
  // AND IT HANDLES THE FAIL-CLOSED ANSWER, because it calls the helper DIRECTLY
  // rather than through `formatStatedUrlValue` (round-7 finding B2). A hosted
  // URL the helper cannot structurally redact is named by its VARIABLE here,
  // never by its value.
  if (!isLocalNangoUrl(rawUrl)) {
    const shownNangoUrl = redactUrlCredentials(resolveNangoBaseUrl(rawUrl));
    console.warn(
      shownNangoUrl === WITHHELD_URL_VALUE
        ? `[dev-server] ⚠ Nango connector service is not answering /health at the address NANGO_SERVER_URL states. Its value is not echoed here: this preflight cannot prove it carries no credential. Connectors will fail until it recovers.`
        : `[dev-server] ⚠ Nango connector service at ${shownNangoUrl} is not answering /health — connectors will fail until it recovers.`,
    );
    return;
  }

  // PER-SERVICE stand-down, not an all-or-nothing refusal. `up -d nango-server`
  // also starts its `depends_on` (nango-db, redis), so a service in that blast
  // radius that this checkout may not publish used to make the whole heal
  // refuse. Two different situations were being collapsed:
  //
  //   - nango-server itself is not ours (remote NANGO_SERVER_URL): there is
  //     nothing here to heal. Say so and stop.
  //   - nango-server IS ours but a DEPENDENCY is configured elsewhere: heal
  //     nango-server alone with `--no-deps`, and leave the service that is not
  //     ours untouched instead of publishing a local copy of it on the global
  //     port.
  //
  // WHAT `--no-deps` DOES AND DOES NOT BUY, stated exactly. It buys the
  // stand-down: no local copy of somebody else's service is started on the
  // global port. It does NOT re-point nango-server at that service, and it
  // cannot: the container's dependency addresses are FIXED in docker-compose.yml
  // as project-internal DNS names (`NANGO_DB_HOST: nango-db`,
  // `NANGO_REDIS_URL: redis://redis:6379`, `RECORDS_DATABASE_URL:
  // …@nango-db:5432/nango`). The stand-down is read off a HOST-side URL
  // (REDIS_URL / NANGO_DATABASE_URL), which says where the APP connects — it
  // never reaches inside the container.
  //
  // So the heal has two real outcomes, and an earlier revision of this comment
  // claimed only the second: if a container for that service is still RUNNING
  // and attached to THIS compose project's network (a previous whole-stack
  // `up`), `--no-deps` starts nango-server against it and it becomes healthy.
  // Existing is not enough — a stopped container resolves to nothing. Otherwise
  // the heal SUCCEEDS and the container comes up unable to reach its dependency, then
  // fails /health for the whole poll budget — it does not "fail honestly", it
  // degrades to an unhealthy container. The operator is told that up front
  // below, and the terminal message names the stranded dependency as the first
  // thing to check rather than sending them to the logs unprepared.
  const standDown = new Set(unmanagedComposeServices(composeHostPortPlan.unmanaged));
  if (standDown.has("nango-server")) {
    console.warn(
      `[dev-server] ⚠ Nango connector service is not answering /health, and this checkout will not start one: ${formatUnmanagedServices(
        composeHostPortPlan.unmanaged.filter((u) => u.service === "nango-server"),
      )} — not an explicit-port loopback URL, so that service is not ours to publish. Start it where it is configured, or point the URL at a 127.0.0.1 port this worktree owns.`,
    );
    return;
  }
  const strandedDeps = composeHostPortPlan.unmanaged.filter((u) => u.service !== "nango-server");
  const upArgs = strandedDeps.length
    ? ["up", "-d", "--no-deps", "nango-server"]
    : ["up", "-d", "nango-server"];
  const strandedServices = unmanagedComposeServices(strandedDeps);
  if (strandedDeps.length) {
    console.warn(
      `[dev-server] ⚠ Healing nango-server alone (--no-deps): ${formatUnmanagedServices(strandedDeps)} — configured elsewhere, so this checkout claims no host port for it and will not start a local copy.`,
    );
    console.warn(
      `[dev-server] ⚠ That URL is where the APP connects; it does not re-point the container. nango-server reaches ` +
        `${strandedServices.join(", ")} by the project-internal name fixed in docker-compose.yml, so it becomes healthy only if a ` +
        `${strandedServices.join("/")} container is RUNNING and reachable on this compose project's network — a stopped or ` +
        `absent one is the same failure. Otherwise it will start and stay unhealthy: bring that service up in this project, ` +
        `or point the URL back at a 127.0.0.1 port this checkout publishes.`,
    );
  }

  // Local Nango down: one best-effort heal. `up -d` is idempotent (starts it if
  // stopped; no-op if already running).
  console.warn(
    "[dev-server] ⚠ Nango connector service is down — starting it (docker compose up -d nango-server)…",
  );
  const up = await runCompose(upArgs, { timeoutMs: 120_000 });
  if (!up.available) {
    console.warn(
      `[dev-server] ⚠ Nango connector service is not healthy and Docker is unavailable. Start Docker, then \`${formatComposeCommand({ projectName: composeProjectName, args: upArgs })}\` and re-run \`pnpm dev\`.`,
    );
    return;
  }
  if (!up.ok) {
    // Docker is present but `compose up` itself failed (daemon down, bad config,
    // image pull failure, or the container exited on start). Waiting then
    // restarting would just burn ~60s and end on a misleading "inspect logs"
    // line, so surface the actionable failure path directly and stop here.
    console.warn(
      `[dev-server] ⚠ \`${formatComposeCommand({ projectName: composeProjectName, args: upArgs })}\` failed — connectors will be unavailable. Check Docker is running, then inspect: ${formatComposeCommand({ projectName: composeProjectName, args: ["logs", "--tail=80", "nango-server"] })}`,
    );
    return;
  }
  if (await waitForNangoHealth(healthUrl, { tries: 12, intervalMs: 3000 })) {
    console.log("[dev-server] ✓ Nango connector service is healthy.");
    return;
  }

  // Up but still failing /health (segfaulted-but-port-bound / hung) — one restart.
  console.warn(
    "[dev-server] ⚠ Nango still unhealthy after start — restarting it once (docker compose restart nango-server)…",
  );
  await runCompose(["restart", "nango-server"], { timeoutMs: 60_000 });
  if (await waitForNangoHealth(healthUrl, { tries: 8, intervalMs: 3000 })) {
    console.log("[dev-server] ✓ Nango connector service is healthy.");
    return;
  }

  // A stranded dependency is the LIKELIEST cause of reaching this line, and the
  // one the logs state least obviously (a DNS failure for `nango-db` / `redis`
  // deep in Nango's own startup output). Name it before the log command.
  console.warn(
    `[dev-server] ⚠ Nango connector service is not healthy — connectors will fail.${
      strandedDeps.length
        ? ` This run healed with --no-deps, so ${strandedServices.join(", ")} was NOT started here: if no ${strandedServices.join(
            "/",
          )} container is running and reachable in this compose project, that is the cause, and no amount of restarting nango-server fixes it.`
        : ""
    } Inspect: ${formatComposeCommand({ projectName: composeProjectName, args: ["logs", "--tail=80", "nango-server"] })}`,
  );
}

await runNangoHealthPreflight();

const forwardedArgs = process.argv.slice(2);
const nextBin = path.join(process.cwd(), "node_modules", ".bin", "next");

const child = spawn(nextBin, ["dev", ...forwardedArgs], {
  stdio: "inherit",
  env: process.env,
});

function writePidFile() {
  try {
    mkdirSync(path.dirname(pidFilePath), { recursive: true });
    writeFileSync(
      pidFilePath,
      JSON.stringify(
        {
          wrapperPid: process.pid,
          childPid: child.pid, // the `next dev` parent; the next-server worker is its child
          port: process.env.PORT || null,
          repoRoot: process.cwd(),
          startedAt: new Date().toISOString(),
        },
        null,
        2,
      ),
    );
  } catch {
    // Non-fatal: dev-stop falls back to resolving the listener by port.
  }
}

function clearPidFile() {
  try {
    rmSync(pidFilePath, { force: true });
  } catch {
    /* ignore */
  }
}

writePidFile();

child.on("exit", (code, signal) => {
  clearPidFile();
  if (signal) {
    // Re-raise the child's terminating signal to self so the wrapper exits with
    // matching semantics. Remove our forwarding handlers FIRST, otherwise the
    // re-raised signal is swallowed by the handler below and the wrapper hangs.
    for (const s of ["SIGINT", "SIGTERM"]) process.removeAllListeners(s);
    process.kill(process.pid, signal);
    return;
  }
  process.exit(code ?? 0);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => child.kill(sig));
}
