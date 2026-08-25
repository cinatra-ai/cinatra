// Cinatra service check.
//
// Probes every supporting service Cinatra depends on and reports whether each
// is reachable. Run automatically at the end of `make setup`, and on demand
// with `make check` / `pnpm check:services`.
//
// Most services are checked with a plain TCP connect to their published port —
// that proves the container is up and listening without depending on service-
// specific health routes. Nango is the exception: it probes the HTTP `/health`
// contract, because the emulated amd64 image can hang while still port-bound, in
// which case a TCP connect "passes" but every connector is broken (cinatra#730).
// Ports/hosts are read from .env.local where Cinatra exposes them
// (SUPABASE_DB_URL, REDIS_URL, NANGO_SERVER_URL, GRAPHITI_URL, WAYFLOW_BASE_URL);
// the rest fall back to the docker-compose.yml defaults.
//
// Exit code: non-zero if any REQUIRED service is unreachable (so the check is
// usable as a CI / scripting gate). Recommended-tier and the app itself never
// affect the exit code.
import net from "node:net";
import path from "node:path";
import process from "node:process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  BUNDLED_DB_SERVICES,
  shouldDiagnoseDrift,
  diagnoseDockerPortDrift,
  resolveMainRepoRoot,
  formatDriftRemedy,
  parseHostPort,
} from "./lib/docker-port-drift.mjs";
import {
  COMPOSE_PROJECT_ENV_VAR,
  classifyServiceUrl,
  formatConnectPortMismatch,
  formatGuardedComposeCommand,
  formatUnusableServiceUrl,
  isLinkedWorktree,
  planMessages,
  readEnvFileValue,
  redactUrlCredentials,
  WITHHELD_URL_VALUE,
  resolveComposeHostPortPlan,
  resolveComposeProjectName,
  resolvePublishedHostPort,
} from "./lib/dev-preflight.mjs";
import { nangoHealthUrl, probeHttpHealth } from "./lib/nango-health.mjs";
import { wayflowDownHint } from "./lib/wayflow-down-hint.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ANSI colors — disabled when stdout is not a TTY or NO_COLOR is set.
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const c = (code, s) => (useColor ? `[${code}m${s}[0m` : s);
const green = (s) => c("0;32", s);
const red = (s) => c("0;31", s);
const yellow = (s) => c("1;33", s);
const dim = (s) => c("2", s);

// The `.env.local` this checkout keeps its configuration in, and the ONE reader
// that resolves a value out of it (cinatra#2839). `readEnvFileValue` is the
// launcher's reader and the one `resolveComposeHostPortPlan` resolves the plan
// through, so this file cannot read the same line differently from the plan it
// then compares against.
const envLocalPath = path.join(repoRoot, ".env.local");
const lookupEnvFile = (key) => readEnvFileValue(envLocalPath, key);

// ONE READER FOR ONE FILE (cinatra#2839).
//
// This used to parse the file itself, with a regex that kept dotenv INLINE
// COMMENTS in the value — while the plan resolved the same line through
// `readEnvFileValue`, which strips them (#2845). The two halves of the
// connect/publish note below then read one file two ways: a lane stating
// `REDIS_URL=redis://127.0.0.1:16379 # lane cache` had its published port read
// correctly and its connect port fall back to the shared 6379, so a correct
// lane was accused of the very bleed this check warns about — and its Redis row
// probed the OPERATOR's port under the lane's name.
//
// So the keys are enumerated here and every VALUE comes back through the shared
// reader. Not a second copy of the comment rule: the same function, so the two
// readers cannot drift apart again.
//
// THE ENUMERATION DECIDES NOTHING (cinatra#2913, round-6 finding B1). It only
// says WHICH keys the file states; which LINE of a duplicated key wins is the
// shared reader's answer, and that answer is the last one — the same line
// `@next/env` hands the app. So the skip below is a re-scan guard and nothing
// more: `lookupEnvFile` returns the same value however many times it is asked,
// so the order these keys are met in cannot change what any of them resolves
// to. The regex tolerates the `export ` prefix the shared reader has always
// tolerated, so a key stated as `export REDIS_URL=…` is enumerated here too
// instead of being read as unset while the launcher and the app both saw it.
function readEnvLocal() {
  const env = {};
  if (!existsSync(envLocalPath)) return env;
  for (const line of readFileSync(envLocalPath, "utf8").split("\n")) {
    const match = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=/);
    if (!match) continue;
    const key = match[1];
    if (key in env) continue; // already resolved — the shared reader is the one that picks the line
    const value = lookupEnvFile(key);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

// Derive { host, port } from a URL-shaped env value (explicit port > scheme
// default > compose fallback). Centralized in scripts/lib/docker-port-drift.mjs
// so the dev-server preflight resolves ports identically.
const hostPort = parseHostPort;

// Build the WayFlow `/.health` URL from WAYFLOW_BASE_URL: the same contract the
// docker-compose healthcheck probes. The loader can be hung or crash-looping
// while the port stays bound (its restart policy re-binds it between attempts),
// so a bare TCP connect would report a broken runtime as "up" and drop the
// start hint. Probe HTTP like Nango instead. `/.health` answers 200 for both
// "ok" and "degraded" (per-agent load failures never condemn the runtime), so
// the probe's 2xx rule accepts exactly what the compose healthcheck accepts.
function wayflowHealthUrl(baseUrl) {
  const v = typeof baseUrl === "string" ? baseUrl.trim() : "";
  return `${(v || "http://127.0.0.1:3010").replace(/\/+$/, "")}/.health`;
}

// Probe WayFlow `/.health` and enforce the documented contract EXACTLY as the
// docker-compose healthcheck does: HTTP 200 AND valid JSON whose `status` is
// "ok" or "degraded". A 204, another 2xx, malformed JSON, or any other status
// value is NOT ready; the generic 2xx rule of probeHttpHealth would report
// those as up and suppress the start hint while agent runs still fail.
async function probeWayflowHealth(url, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (res.status !== 200) return false;
    let body;
    try {
      body = await res.json();
    } catch {
      return false;
    }
    return body?.status === "ok" || body?.status === "degraded";
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function probe(host, port, timeoutMs = 2500) {
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

const fileEnv = readEnvLocal();

// SHELL OVER FILE, for the service ENDPOINTS (cinatra#2839).
//
// The app resolves these with the shell winning — Next.js loads `.env.local`
// but never over an exported value, and scripts/dev-server.mjs and
// `resolveComposeHostPortPlan` both read the shell first. Reading the file
// alone made this check report an endpoint nothing connects to whenever one was
// exported, and made the connect/publish note below accuse a lane of a mismatch
// the plan and the app agree on. Restricted to the endpoint variables on
// purpose: MCP_PUBLIC_BASE_URL / APP_PUBLIC_URL stay file-only, which is what
// their own note below documents.
//
// NEO4J_URI is here for the same reason and was missing (cinatra#2913, round-5
// finding N3). It has no row address of its own — Neo4j's row is the fixed
// 127.0.0.1:7687 — but it IS a `BUNDLED_DB_SERVICES` endpoint variable, so the
// classification below reads it, and reading it from the file alone let this
// check condemn a URI the shell had already corrected.
const ENDPOINT_VARS = [
  "SUPABASE_DB_URL",
  "REDIS_URL",
  "NEO4J_URI",
  "NANGO_SERVER_URL",
  "GRAPHITI_URL",
  "WAYFLOW_BASE_URL",
];
const env = { ...fileEnv };
for (const key of ENDPOINT_VARS) {
  const shell = process.env[key];
  if (typeof shell === "string" && shell.trim()) env[key] = shell.trim();
}

// The app's own listen port follows the same rule: scripts/dev-server.mjs takes
// a real shell PORT over `.env.local`, so reading the file alone reported the
// wrong address for the "Cinatra app" row whenever one was exported.
const appPort = Number(process.env.PORT) || Number(fileEnv.PORT) || 3000;

// The compose scoping this checkout runs under, resolved by the SAME resolvers
// `pnpm dev` and the shared derivation step use (cinatra#2839). The drift
// diagnosis below needs both halves: the PROJECT, because an unpinned `compose
// ps` inspects the basename-derived project while a lane's containers live in
// its own — so a lane could be told about a container that is not its own — and
// the PUBLISHED PORT, because redis's host port is per-worktree now, and
// measuring a lane's connect port against the global 6379 either skips the
// diagnosis or condemns a healthy lane container.
const composeProjectName = resolveComposeProjectName({
  processEnv: process.env,
  envFileValues: [lookupEnvFile(COMPOSE_PROJECT_ENV_VAR)],
});
const composeHostPortPlan = resolveComposeHostPortPlan({
  processEnv: process.env,
  envFileLookup: lookupEnvFile,
  projectName: composeProjectName,
  defaultProjectName: repoRoot,
  linkedWorktree: isLinkedWorktree(repoRoot),
});

// tier: "required"  — core; a failure exits non-zero.
//       "recommended" — needed for full agent/object functionality; warn only.
//       "optional"  — behind a docker-compose profile, so NOT started by the
//                     default `docker compose up -d`; informational only (never
//                     warns or fails — its absence on a default setup is normal).
//       "app"       — the Cinatra app itself; informational (not running until
//                     `make dev`).
const services = [
  {
    name: "PostgreSQL",
    tier: "required",
    ...hostPort(env.SUPABASE_DB_URL, { host: "127.0.0.1", port: 5434 }),
    note: "app + Better Auth store",
  },
  {
    name: "Redis",
    tier: "required",
    ...hostPort(env.REDIS_URL, { host: "127.0.0.1", port: 6379 }),
    note: "BullMQ queue, event log",
  },
  {
    name: "Verdaccio",
    tier: "required",
    host: "127.0.0.1",
    port: 4873,
    note: "local agent-package registry",
  },
  {
    name: "Nango",
    tier: "required",
    ...hostPort(env.NANGO_SERVER_URL, { host: "127.0.0.1", port: 3003 }),
    // HTTP /health (not a bare TCP connect): the emulated image can hang while
    // the port stays bound, which a TCP probe would wrongly report as up.
    healthUrl: nangoHealthUrl(env.NANGO_SERVER_URL),
    note: "connector OAuth gateway",
  },
  {
    name: "Neo4j",
    tier: "recommended",
    host: "127.0.0.1",
    port: 7687,
    note: "objects knowledge graph",
  },
  {
    name: "Graphiti",
    tier: "recommended",
    ...hostPort(env.GRAPHITI_URL, { host: "127.0.0.1", port: 8000 }),
    note: "object graph indexer",
  },
  {
    // Recommended (not optional): agent runs are a headline feature and 100%
    // of them hard-fail with ECONNREFUSED while this runtime is down. The
    // profile gate means a default dev bring-up NEVER starts it (#2654), so
    // this check is where a fresh install learns the exact start command.
    // Recommended-tier never affects the exit code.
    name: "WayFlow",
    tier: "recommended",
    ...hostPort(env.WAYFLOW_BASE_URL, { host: "127.0.0.1", port: 3010 }),
    healthUrl: wayflowHealthUrl(env.WAYFLOW_BASE_URL),
    // Contract-validating probe (200 + status ok|degraded), NOT the generic
    // 2xx probeHttpHealth: see probeWayflowHealth.
    probeHealth: probeWayflowHealth,
    note: "agent runtime; serves every installed agent",
    // Mode-aware: a hint that ignores CINATRA_WAYFLOW_RUNTIME tells an
    // operator who deliberately opted out, or who points at an external
    // runtime, to "start" a local container this install never owns. See
    // scripts/lib/wayflow-down-hint.mjs.
    downHint: wayflowDownHint(env.CINATRA_WAYFLOW_RUNTIME),
  },
  {
    name: "Cinatra app",
    tier: "app",
    host: "127.0.0.1",
    port: appPort,
    note: "Next.js dev server",
  },
];

// WHAT EACH BUNDLED SERVICE'S OWN URL SAYS, classified ONCE, before anything is
// probed. The note below reads the same map, so the row and the note cannot
// reach different answers about one stated URL.
const statedByLabel = new Map(
  BUNDLED_DB_SERVICES.map((svc) => [svc.label, { svc, stated: classifyServiceUrl(env[svc.envVar]) }]),
);

// A ROW MAY NOT ASSERT AN ADDRESS ITS OWN URL DISOWNS (cinatra#2913, round-5
// finding N1).
//
// `parseHostPort` falls back to this checkout's bundled `127.0.0.1:<default>`
// whenever the stated URL yields no address, so `REDIS_URL=not a url` built a
// Redis row reading `127.0.0.1:6379` — and on a host where that port answers,
// the row printed `✓ Redis 127.0.0.1:6379 up` two lines above a note saying no
// address for Redis can come from REDIS_URL. The row is the half that counts:
// Redis is required-tier, so the tier accounting and this command's EXIT CODE
// followed the ✓, and an operator whose app cannot reach Redis at all was told
// Redis was up and sent away with exit 0.
//
// So a row whose stated URL classifies `unusable` prints no address, is not
// probed at all, and is never `up`. Not probing is the substance of it: the
// only address there was to probe is one this checkout invented, and a result
// measured there is a fact about the operator's other stack, not about the app.
//
// THE ACCOUNTING IS THEN COMPUTED FROM THE DEFECT, NOT FROM AN ADDRESS. The row
// stays in its tier and counts as unreachable there, because it IS unreachable:
// `getRedisUrl` hands BullMQ the stated value verbatim, so a value that names
// no address is an app that cannot connect. Required-tier therefore exits 1, as
// it does for any other required service the app cannot reach. That is this
// command's ordinary reporting semantic and not a new refusal: nothing is
// stopped, no plan is failed, and `formatUnusableServiceUrl`'s rule — that the
// LAUNCHER warns and lets the app boot — is untouched. What changed is only
// that the checker no longer reports success it did not measure.
//
// SCOPED TO THE SERVICES THAT ALSO GET THE NOTE, deliberately: `BUNDLED_DB_SERVICES`
// is the set `unusableUrlNotes` speaks about, so every disowning row has the
// sentence that explains it. (Under a REFUSED plan the note is withheld with
// everything else port-shaped, and the refusal block prints instead; the row
// still disowns, because whether a stated URL names an address is a question
// about that URL alone and no plan changes the answer.)
for (const svc of services) {
  const entry = statedByLabel.get(svc.name);
  if (entry?.stated.state === "unusable") svc.noAddress = entry.svc.envVar;
}

const results = await Promise.all(
  services.map(async (svc) => ({
    ...svc,
    // Nango + WayFlow carry a healthUrl → probe their HTTP health contract
    // (hung-but-port-bound must read DOWN); everything else TCP-connects. A
    // service-specific probeHealth (WayFlow: 200 + status ok|degraded) wins
    // over the generic 2xx probeHttpHealth.
    // …unless the row states no address (`noAddress`): the only thing there is
    // to connect to is the fallback this checkout invented, and whatever
    // answers there answers for somebody else.
    up: svc.noAddress
      ? false
      : svc.healthUrl
        ? svc.probeHealth
          ? await svc.probeHealth(svc.healthUrl, 2500)
          : (await probeHttpHealth(svc.healthUrl, 2500)).ok
        : await probe(svc.host, svc.port),
  })),
);

console.log(`\n${useColor ? "[1m" : ""}Cinatra service check${useColor ? "[0m" : ""}\n`);

// The address column says what the row is about. For a row that states none,
// that is the words "no address stated" and NOT an invented `host:port` — see
// the `noAddress` note above.
const rowAddress = (r) => (r.noAddress ? "no address stated" : `${r.host}:${r.port}`);

const nameWidth = Math.max(...results.map((r) => r.name.length));
const addrWidth = Math.max(...results.map((r) => rowAddress(r).length));

for (const r of results) {
  let mark;
  if (r.up) mark = green("✓");
  else if (r.tier === "required") mark = red("✗");
  else if (r.tier === "recommended") mark = yellow("✗");
  else mark = dim("○"); // app / optional — informational, not a problem
  const addr = rowAddress(r).padEnd(addrWidth);
  let status;
  if (r.up) status = green("up");
  // Before the tier lines: "DOWN" is the outcome of a probe, and this row was
  // never probed. Say what is actually wrong, and let the note below say it in
  // full.
  else if (r.noAddress)
    status = (r.tier === "required" ? red : yellow)(
      `unreachable — ${r.tier}; ${r.noAddress} states no address`,
    );
  else if (r.tier === "app") status = dim("not started — run `make dev`");
  else if (r.tier === "optional") status = dim("not started; enable its compose profile");
  else if (r.tier === "required") status = red("DOWN — required");
  else status = yellow(r.downHint ? `down — recommended; ${r.downHint}` : "down — recommended");
  console.log(`  ${mark}  ${r.name.padEnd(nameWidth)}  ${dim(addr)}  ${status}  ${dim(r.note)}`);
}

// MCP public URL — a configuration state rather than a service, but the most
// common reason a fresh install can't use the chat. Only the .env.local
// fallback vars are visible here; the canonical value may also be set in the
// admin UI (stored in the database), so report this as informational.
const mcpPublicUrl =
  env.MCP_PUBLIC_BASE_URL?.trim() || env.APP_PUBLIC_URL?.trim() || "";
// Which of the two fallbacks actually stated it, so the withheld branch below
// can name the line the operator has to open.
const mcpPublicUrlVar = env.MCP_PUBLIC_BASE_URL?.trim()
  ? "MCP_PUBLIC_BASE_URL"
  : "APP_PUBLIC_URL";
console.log("");
if (mcpPublicUrl) {
  // Redacted like every other stated URL this surface echoes (cinatra#2913,
  // round-5 finding N4). A tunnel URL is ordinarily credential-free, so this
  // usually prints unchanged — but the rule is "no surface here prints
  // userinfo", and a rule with an exception in it is not a rule.
  //
  // AND THE RULE HAS NO ESCAPE HATCH AT THIS CALL SITE EITHER (round-7 finding
  // B2). This is one of the two lines that call the helper DIRECTLY rather than
  // through `formatStatedUrlValue`, so it is this line's job to handle the
  // fail-closed answer. It names the variable instead of the value, exactly as
  // `formatStatedUrlValue` does, because the variable is what the operator
  // needs to find the line.
  const shownMcpUrl = redactUrlCredentials(mcpPublicUrl);
  console.log(
    shownMcpUrl === WITHHELD_URL_VALUE
      ? `  ${green("✓")}  MCP public URL (env): stated in ${mcpPublicUrlVar}, and not echoed here — ` +
        `this check cannot prove the value carries no credential.`
      : `  ${green("✓")}  MCP public URL (env): ${shownMcpUrl}`,
  );
} else {
  console.log(
    `  ${yellow("○")}  MCP public URL: not set in the environment — the AI chat needs it.`,
  );
  console.log(
    `     ${dim("This check only sees the env fallback (MCP_PUBLIC_BASE_URL / APP_PUBLIC_URL).")}`,
  );
  console.log(
    `     ${dim("The canonical value is set in the app at /configuration/development?tab=tunnel")}`,
  );
  console.log(
    `     ${dim("and stored in the database (getPublicMcpServerUrl) — authoritative even though it")}`,
  );
  console.log(
    `     ${dim("is not visible here. Why + Tailscale setup: https://docs.cinatra.ai/guides/hosting/mcp-public-url/")}`,
  );
}

const requiredDown = results.filter((r) => r.tier === "required" && !r.up);
const recommendedDown = results.filter((r) => r.tier === "recommended" && !r.up);

// Docker host-port drift diagnosis: when a bundled DB/cache service is DOWN but
// its container is actually RUNNING (just not publishing the host port), the
// generic "start them with make dev" message is misleading. Diagnose the real
// cause — a base-only `docker compose up` without docker-compose.dev.yml — and
// print the precise remedy. Best-effort; scoped to the MAIN compose project.
const downByLabel = new Map(
  [...requiredDown, ...recommendedDown].map((r) => [r.name, r]),
);
const driftedLabels = [];
const mismatchNotes = [];
// Service URLs that name no address at all. Reported in the SAME words the
// launcher uses, from the same formatter (cinatra#2839, round-4 finding): the
// two surfaces read one classifier, so neither can decide on its own that a
// stated URL is fine.
const unusableUrlNotes = [];
// A plan with a hole in it resolves NO publishable port for the affected
// service, so neither the drift diagnosis nor the connect/publish note has a
// port to judge against — `resolvePublishedHostPort` would hand back the
// historical default, and this check would then state a port compose is not
// going to publish. scripts/dev-server.mjs stops on the same condition before
// its preflight (`planRefused`); this is that stand-down, on the reporting
// surface. The refusals are printed instead, which is the answer an operator
// running `pnpm check:services` actually needs.
const planRefused = composeHostPortPlan.refusals.length > 0;
// The row this check already probed for each bundled service — its ADDRESS, up
// or down. The connect/publish note is about the address, never about the
// outcome, so it is read from here rather than from the down set.
const rowByLabel = new Map(results.map((r) => [r.name, r]));
// Docker is inspected at most once per run, and only if something is actually
// down; `resolveMainRepoRoot` shells out to git, so it is not paid for by a
// healthy checkout that only needed the note.
let mainRoot;
const mainRepoRoot = () => (mainRoot ??= resolveMainRepoRoot(repoRoot));
if (!planRefused) {
  for (const svc of BUNDLED_DB_SERVICES) {
    const row = rowByLabel.get(svc.label);
    if (!row) continue;
    const claim = resolvePublishedHostPort({
      composeService: svc.composeService,
      defaultHostPort: svc.defaultHostPort,
      plan: composeHostPortPlan,
    });
    // STATED, AND NAMING NO ADDRESS. `parseHostPort` fell back to the bundled
    // `127.0.0.1:<default>` for it, so the row above probed an address the
    // stated URL never mentions — the connect/publish note and the drift
    // diagnosis would both be judging that fallback. Say what is actually wrong
    // instead, and judge nothing: there is no address of this checkout's here.
    // The SAME classification the row was shaped from — read, not recomputed,
    // so no ordering here can make the note and the row disagree.
    const stated = statedByLabel.get(svc.label)?.stated;
    if (stated?.state === "unusable") {
      unusableUrlNotes.push(
        formatUnusableServiceUrl({
          service: svc.label,
          urlVar: svc.envVar,
          url: stated.url,
          hostPortVar: claim.envVar,
          standDown: claim.standDown === true,
        }),
      );
      continue;
    }
    // Configured elsewhere: this checkout publishes no host port for it, so no
    // container found here is its to report on.
    if (claim.standDown) continue;
    // PUBLISHED HERE, CONNECTED THERE — computed for every bundled service,
    // whatever its probe said (cinatra#2839).
    //
    // Building this inside the down-set gate inverted it. The bleed the note
    // exists for is a lane publishing its own redis on 16379 while the app talks
    // to one that ANSWERS on the shared 6379: the row is UP, so the service was
    // never in the down set and the note was never produced. It could only
    // appear when nothing answered on the connect port — the one case where
    // there is no bleed to report. The launcher computes it before probing;
    // this is that ordering, on the reporting surface.
    const mismatch = formatConnectPortMismatch({
      service: svc.label,
      claim,
      connectHost: row.host,
      connectPort: row.port,
      laneScope: composeHostPortPlan.laneScope,
    });
    if (mismatch) mismatchNotes.push(mismatch);
    // The DRIFT diagnosis is a different question and keeps its own gate: only a
    // service that is DOWN, at a port this checkout publishes, has a container
    // here worth inspecting.
    const down = downByLabel.get(svc.label);
    if (!down) continue;
    if (!shouldDiagnoseDrift({ host: down.host, port: down.port }, svc, claim.published)) continue;
    const diag = diagnoseDockerPortDrift({
      service: svc,
      mainRoot: mainRepoRoot(),
      expectedHostPort: down.port,
      projectName: composeProjectName,
    });
    if (diag.available && diag.drift) driftedLabels.push(svc.label);
  }
}

console.log("");
if (planRefused) {
  console.log(red("  ✖ Compose host-port scoping is unresolved — not inspecting Docker for this checkout:"));
  for (const message of planMessages(composeHostPortPlan.refusals)) {
    console.log(dim(`     • ${message}`));
  }
}
for (const note of unusableUrlNotes) {
  console.log(yellow(`  ⚠ ${note}`));
}
for (const note of mismatchNotes) {
  console.log(yellow(`  ⚠ ${note}`));
}
if (driftedLabels.length > 0) {
  console.log(red("  ⚠ Docker host-port drift detected:"));
  for (const line of formatDriftRemedy(driftedLabels).split("\n")) {
    console.log(`  ${dim(line)}`);
  }
}
if (requiredDown.length > 0) {
  console.log(
    red(
      `  ${requiredDown.length} required service(s) unreachable: ${requiredDown
        .map((r) => r.name)
        .join(", ")}.`,
    ),
  );
  // The raw alternative is the GUARDED chain (cinatra#2839): a bare
  // `docker compose up` pasted from here skips scripts/dev-compose-env.mjs, so
  // it neither pins this checkout's compose project — Docker reads
  // COMPOSE_PROJECT_NAME from its own env, never from `.env.local` — nor honors
  // any of the refusals `make dev` now stops on. Same builder as the recipes.
  //
  // LEFT AS IT WAS for a row that states no address (cinatra#2913, round-5
  // finding N1). Starting the stack cannot fix a defective URL, so this line is
  // not that row's remedy — but it IS the remedy for whatever else is down
  // beside it, and the row's own note above already names the fix in full. The
  // generic remedy's fit is a question about every row, which the review
  // records as a follow-up of its own; narrowing it here would be a second
  // change riding on this one.
  console.log(
    dim(
      `  Start them with \`make dev\` (or \`${formatGuardedComposeCommand({
        args: ["up", "-d"],
        requireManageable: true,
      })}\`), then inspect \`make logs\`.`,
    ),
  );
  process.exit(1);
}

if (recommendedDown.length > 0) {
  console.log(
    yellow(
      `  All required services are up. Still starting / down: ${recommendedDown
        .map((r) => r.name)
        .join(", ")} (give containers a minute, or check \`make logs\`).`,
    ),
  );
} else {
  console.log(green("  All services are reachable."));
}
process.exit(0);
