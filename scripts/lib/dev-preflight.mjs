// Dev-server preflight POLICY — the skip switch and the compose scoping the
// `pnpm dev` preflight (scripts/dev-server.mjs) runs under.
//
// Why this module exists (cinatra#2839): the preflight's two decisions — "may I
// touch Docker at all?" and "which compose project / host ports do I touch?" —
// were both inline in the launcher, which is a top-level script with spawn +
// process.exit side effects and therefore not unit-importable (the same reason
// scripts/lib/nango-health.mjs and scripts/lib/wayflow-down-hint.mjs were split
// out). Inline meant untested, and untested meant two defects shipped together:
//
//   1. CINATRA_SKIP_DEV_PREFLIGHT was read from the PROCESS env only, while
//      every other launcher knob (PORT, NANGO_SERVER_URL) is honored from
//      `.env.local` too. A worktree lane records its configuration in
//      `.env.local` — that IS where a lane states its intent — so a lane that
//      set the flag there got the full preflight anyway, and a best-effort
//      `docker compose up -d nango-server` brought up nango-server plus its
//      `depends_on` (nango-db, redis) behind a flag whose entire documented
//      promise is that nothing starts.
//
//   2. The compose invocation was unscoped: no `-p`, so the project name fell
//      out of the checkout directory's basename. A lane that already runs its
//      own compose project (see evidence/2747-e2e: `p2747-*` containers) got a
//      SECOND, basename-derived project rather than the one it owns, so the
//      "heal" started a duplicate stack the lane could not see. The rest of the
//      stack already scopes itself with COMPOSE_PROJECT_NAME, so this module
//      threads that same switch into the preflight instead of inventing a third
//      convention.
//
// A later review round found the reader leaking the same way the flag did — by
// reading something a lane HAD stated as "not stated at all":
//
//   3. The dotenv reader kept an inline comment in the value, so
//      `CINATRA_SKIP_DEV_PREFLIGHT=1 # lane isolation` read as an unrecognized
//      spelling and the flag was silently dropped — defect (1) again, one layer
//      down.
//
// Host-PORT scoping is the other half of cinatra#2839 (acceptance item 2) and
// lands here, on top of the flag fix. Two lanes each running their own compose
// project still collided the moment either one published, because the compose
// files stated FIXED host ports (3003/3009/5435/6379). Those are parameterized
// now and resolved by `resolveComposeHostPortPlan` below, under four rules the
// review of the first attempt made necessary:
//
//   A. Derivation is GATED on a configured COMPOSE_PROJECT_NAME. A bare main
//      checkout whose REDIS_URL happens to name a non-6379 loopback port is not
//      making a claim about what this project publishes — deriving from it
//      republished the SHARED redis on a changed mapping. No project name
//      configured = no derivation, historical defaults, exactly as before.
//
//   B. The container-side `NANGO_SERVER_URL`/`NANGO_PUBLIC_SERVER_URL` in
//      docker-compose.yml interpolate from the SAME variable as the published
//      port. `NANGO_PUBLIC_SERVER_URL` is what the OAuth callback is built from
//      (packages/sdk-extensions/src/host-context.ts), so a lane published on
//      13003 that still advertised 3003 sent its callbacks to another lane.
//
//   C. ONE derivation step, consumed by every entry point that starts the stack
//      — scripts/dev-compose-env.mjs. `make dev` and `pnpm services` used to
//      start the stack on defaults and `pnpm dev` then reconciled the same
//      project onto derived ports.
//
//   D. nango-connect (3009) has a real derivation source: it is published by the
//      SAME container as nango-server, so it follows nango-server's resolved
//      port by the offset the compose files themselves state (+6). Nothing wrote
//      its variable before, so two ordinary lanes still collided on 3009.
//
// Everything here is PURE (no IO beyond an explicit file read) and
// dependency-injected, so the decisions are asserted in
// scripts/__tests__/dev-preflight.test.mjs without Docker on the box.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/** The documented dev-preflight bypass switch. */
export const SKIP_PREFLIGHT_ENV_VAR = "CINATRA_SKIP_DEV_PREFLIGHT";

/** Docker's own per-project switch — the one the rest of the stack already uses. */
export const COMPOSE_PROJECT_ENV_VAR = "COMPOSE_PROJECT_NAME";

/** The two compose files the dev stack is always composed from (`make dev`). */
export const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.dev.yml"];

const TRUTHY = new Set(["1", "true", "yes", "on"]);
const FALSY = new Set(["0", "false", "no", "off"]);

/**
 * Parse the right-hand side of one `KEY=value` dotenv line.
 *
 * Inline comments are real dotenv syntax and a lane WILL write one — a worktree
 * annotates why it opted out (`CINATRA_SKIP_DEV_PREFLIGHT=1 # lane isolation`).
 * Reading that as the literal value `1 # lane isolation` made
 * `normalizeSkipFlag` see an unrecognized spelling, report "not stated", and the
 * preflight run anyway: the ORIGINAL cinatra#2839 defect's exact shape — an
 * opt-out stated where a lane states things, silently not honored —
 * reintroduced one layer down, in the reader this module extracted.
 *
 * Rules (dotenv convention):
 *   - A quoted value ends at its closing quote; a `#` INSIDE the quotes is
 *     literal, and only trailing whitespace or a comment may follow it.
 *   - An unquoted value is cut at the first `#` that begins the value or is
 *     preceded by whitespace. Requiring that separator (as python-dotenv does)
 *     keeps a `#` that is part of the value itself — a dev DB password, a URL
 *     fragment — from being silently truncated.
 *   - Whatever survives is trimmed; empty means "unset".
 *
 * @param {string} rawValue
 * @returns {string | undefined}
 */
function parseEnvValue(rawValue) {
  const value = String(rawValue).trim();
  if (!value) return undefined;

  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const close = value.indexOf(quote, 1);
    const rest = close === -1 ? undefined : value.slice(close + 1).trim();
    // Only a WELL-FORMED quoted value (closed, followed by nothing but a
    // comment) is treated as quoted. Anything else falls through to the
    // unquoted rule, which is what the previous reader did with an unbalanced
    // quote — no existing `.env.local` changes meaning here.
    if (rest !== undefined && (rest === "" || rest.startsWith("#"))) {
      return value.slice(1, close).trim() || undefined;
    }
  }

  return value.replace(/(^|\s)#.*$/, "").trim() || undefined;
}

/**
 * Read one KEY=value out of a dotenv-style file. Mirrors the launcher's original
 * inline reader: `export ` prefix tolerated, surrounding quotes stripped, blank
 * and `#` lines skipped, first match wins — plus the inline-comment handling in
 * `parseEnvValue`. Returns undefined when the file is absent or the key is
 * unset/empty.
 *
 * @param {string} filePath
 * @param {string} key
 * @returns {string | undefined}
 */
export function readEnvFileValue(filePath, key) {
  if (!filePath || !existsSync(filePath)) return undefined;
  let contents;
  try {
    contents = readFileSync(filePath, "utf8");
  } catch {
    return undefined; // unreadable → treat as unset, never throw out of a preflight
  }
  for (const raw of contents.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = new RegExp(`^(?:export\\s+)?${key}\\s*=\\s*(.*)$`).exec(line);
    if (!m) continue;
    return parseEnvValue(m[1]);
  }
  return undefined;
}

/**
 * Normalize a boolean-ish flag value.
 *
 * Returns `true`/`false` for a RECOGNIZED value and `undefined` for "not
 * stated" — absent, empty, or a spelling this does not model. The tri-state is
 * the point: it lets a caller fall through to the next source instead of
 * treating an unset shell variable as an explicit "no".
 *
 * @param {unknown} raw
 * @returns {boolean | undefined}
 */
export function normalizeSkipFlag(raw) {
  if (raw === undefined || raw === null) return undefined;
  const value = String(raw).trim().toLowerCase();
  if (!value) return undefined;
  if (TRUTHY.has(value)) return true;
  if (FALSY.has(value)) return false;
  return undefined; // unrecognized → not a statement either way
}

/**
 * Decide whether the dev preflight must not touch Docker at all.
 *
 * Precedence mirrors the launcher's documented PORT precedence — the real shell
 * environment wins, `.env.local` is consulted next, default is "run the
 * preflight". An explicitly FALSY shell value (`=0`) is a real statement and
 * overrides a `.env.local` opt-out, so an operator can force the preflight back
 * on for one run without editing the lane's file.
 *
 * @param {{ processEnv?: Record<string, string | undefined>, envFileValues?: Array<string | undefined> }} input
 * @returns {boolean}
 */
export function shouldSkipDevPreflight({ processEnv = {}, envFileValues = [] } = {}) {
  const fromShell = normalizeSkipFlag(processEnv[SKIP_PREFLIGHT_ENV_VAR]);
  if (fromShell !== undefined) return fromShell;
  for (const value of envFileValues) {
    const fromFile = normalizeSkipFlag(value);
    if (fromFile !== undefined) return fromFile;
  }
  return false;
}

/**
 * Resolve the compose project the preflight may act on.
 *
 * A lane names its project with COMPOSE_PROJECT_NAME (the Docker-native switch
 * the rest of the stack uses). Docker reads that from its own process env, but
 * NOT from `.env.local` — which is exactly where a worktree lane records it —
 * so it is read here and passed explicitly as `-p`. Returns undefined when
 * nothing is configured, which preserves the historical behavior for the main
 * checkout: compose derives the project from the directory basename.
 *
 * @param {{ processEnv?: Record<string, string | undefined>, envFileValues?: Array<string | undefined> }} input
 * @returns {string | undefined}
 */
export function resolveComposeProjectName({ processEnv = {}, envFileValues = [] } = {}) {
  const candidates = [processEnv[COMPOSE_PROJECT_ENV_VAR], ...envFileValues];
  for (const candidate of candidates) {
    const value = String(candidate ?? "").trim();
    if (value) return value;
  }
  return undefined;
}

/**
 * Compose's own project-name normalization, applied to a candidate name.
 *
 * Docker Compose lowercases a project name and drops every character outside
 * `[a-z0-9_-]`, then strips leading separators. Reproduced here for ONE
 * comparison: "is the name this checkout states the same project compose would
 * have derived on its own?" — see `composeDefaultProjectName`.
 *
 * @param {unknown} raw
 * @returns {string}
 */
export function normalizeComposeProjectName(raw) {
  return String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/^[^a-z0-9]+/, "");
}

/**
 * The project name compose derives for a checkout ALL BY ITSELF: the normalized
 * basename of the directory it composes from.
 *
 * This is the operator's own stack. `docker compose` in this repo is always
 * invoked from the checkout root with relative `-f` paths (scripts/setup.sh, the
 * `Makefile`, package.json), none of which pass `-p`, so the operator's live
 * project IS this name — `cinatra_cinatra` on the canonical checkout, which is
 * why packages/agents/src/wayflow-url.ts can hardcode `-p cinatra_cinatra`.
 *
 * It matters because a checkout that STATES the very name compose already
 * derives has not made itself a second lane: the pin is a no-op, and the
 * scoping rules below must not treat it as one. See `laneScope`.
 *
 * @param {string} projectDir  The directory compose composes from (the repo root).
 * @returns {string}
 */
export function composeDefaultProjectName(projectDir) {
  return normalizeComposeProjectName(path.basename(String(projectDir ?? "")));
}

/**
 * The host ports the preflight can cause to be published, and where a lane
 * already states each one.
 *
 * `service` is the compose service the port belongs to (so an unpublishable
 * service can be stood down individually rather than refusing the whole heal),
 * `envVar` is the compose interpolation variable the compose files read as
 * `${VAR:-default}`, `defaultHostPort` is the historical fixed port that stays
 * in force when nothing is stated, and `urlVar` is the `.env.local` service URL
 * the app itself connects on — the SAME value the rest of the stack honors, so
 * the published port and the app's client port cannot drift apart.
 *
 * `derivedFrom` names another entry this port follows. nango-connect has no URL
 * of its own anywhere in the repo (`.env.example` states NANGO_SERVER_URL and
 * NANGO_DATABASE_URL and nothing for 3009), and before this it was the one port
 * NOTHING ever wrote — so two ordinary lanes collided on 3009 even after the
 * other three were scoped. It is published by the SAME container as
 * nango-server, so it follows nango-server's resolved port by the offset the
 * compose files state between them (3009 - 3003 = +6). That preserves the
 * non-collision property exactly: two lanes differ on 3009 whenever they differ
 * on 3003, which they must already.
 */
export const PREFLIGHT_HOST_PORTS = [
  {
    service: "nango-server",
    envVar: "CINATRA_NANGO_SERVER_HOST_PORT",
    defaultHostPort: 3003,
    urlVar: "NANGO_SERVER_URL",
  },
  {
    service: "nango-server",
    envVar: "CINATRA_NANGO_CONNECT_HOST_PORT",
    defaultHostPort: 3009,
    derivedFrom: "CINATRA_NANGO_SERVER_HOST_PORT",
  },
  {
    service: "nango-db",
    envVar: "CINATRA_NANGO_DB_HOST_PORT",
    defaultHostPort: 5435,
    urlVar: "NANGO_DATABASE_URL",
  },
  {
    service: "redis",
    envVar: "CINATRA_REDIS_HOST_PORT",
    defaultHostPort: 6379,
    urlVar: "REDIS_URL",
  },
];

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0.0.0.0"]);

const isUsablePort = (port) => Number.isInteger(port) && port > 0 && port < 65536;

/**
 * Read a port the URL STATES, straight off the raw string.
 *
 * `new URL()` cannot answer this: WHATWG normalization drops a port equal to
 * the scheme's default, so `http://localhost:80` and `http://localhost` both
 * leave `url.port === ""`. Those are different statements here — the first
 * claims host port 80, the second claims nothing — so the authority is parsed
 * from the raw text instead. Userinfo is dropped first (`user:pw@host:80`) and
 * an IPv6 literal's bracketed colons are excluded, so neither is mistaken for
 * the port separator.
 *
 * @param {string} rawUrl
 * @returns {number | undefined}
 */
function statedPort(rawUrl) {
  const afterScheme = rawUrl.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  const authority = afterScheme.split(/[/?#]/, 1)[0];
  const hostPart = authority.slice(authority.lastIndexOf("@") + 1);
  const m = /^(?:\[[^\]]*\]|[^:]*):(\d+)$/.exec(hostPart);
  return m ? Number(m[1]) : undefined;
}

/**
 * Extract an EXPLICIT host port from a service URL, and only when it points at
 * this host.
 *
 * Deliberately narrower than docker-port-drift's `parseHostPort`: that helper
 * falls back to the URL scheme's default port, which is right for "where do I
 * connect?" but wrong here. Publishing a container port is a claim on a HOST
 * port, so a URL with no port stated (`http://localhost/…` = :80) must not be
 * read as a request to publish :80, and a remote service
 * (`https://nango.example.com`) is not ours to publish at all.
 *
 * @param {string | undefined} urlValue
 * @returns {number | undefined}
 */
export function explicitLoopbackPort(urlValue) {
  if (!urlValue) return undefined;
  const raw = String(urlValue).trim();
  let url;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  // WHATWG returns an IPv6 hostname bracketed (`[::1]`), so unwrap before the
  // lookup — otherwise the `::1` entry above is unreachable and a legitimate
  // explicit-port IPv6 loopback lane URL reads as somebody else's service.
  let host = url.hostname.replace(/^\[(.*)\]$/, "$1");
  if (host === "host.docker.internal") host = "127.0.0.1";
  if (!LOOPBACK_HOSTS.has(host)) return undefined; // external service — not ours
  // `url.port` for anything WHATWG did not normalize away, the raw authority for
  // a stated default port (`:80`, `:443`) that it did.
  const port = url.port ? Number(url.port) : statedPort(raw);
  return isUsablePort(port) ? port : undefined;
}

/**
 * Classify what one service's configured URL says about who owns its host port.
 *
 *   - `unconfigured` — nothing stated. The historical fixed default stays in
 *     force; this is the main checkout's unchanged behavior.
 *   - `ours` — an explicit-port loopback URL. That port is what this checkout
 *     publishes, and it is the lane's own claim.
 *   - `theirs` — anything else the URL can say: a remote host, or a loopback
 *     host with NO port stated. Either way the service the app talks to is not
 *     one this checkout publishes, so the preflight must neither claim a host
 *     port for it nor start a local copy of it.
 *
 * @param {string | undefined} urlValue
 * @returns {{ state: "unconfigured" } | { state: "ours", port: number, url: string } | { state: "theirs", url: string }}
 */
export function classifyServiceUrl(urlValue) {
  const url = String(urlValue ?? "").trim();
  if (!url) return { state: "unconfigured" };
  const port = explicitLoopbackPort(url);
  return port === undefined ? { state: "theirs", url } : { state: "ours", port, url };
}

/**
 * Plan the host-port claims: the compose interpolation environment, the services
 * this checkout may NOT publish, and the claims it REFUSES to guess at.
 *
 * Per port, precedence is: an explicit `CINATRA_*_HOST_PORT` (shell, then
 * `.env.local`) > a port derived from the lane's own configuration > the
 * historical default.
 *
 * DERIVATION IS GATED ON `projectName`. Without a configured
 * COMPOSE_PROJECT_NAME this is not a lane, it is the main checkout, and a
 * REDIS_URL there names where the app CONNECTS — not a claim about what this
 * project publishes. Deriving from it anyway republished the shared redis on a
 * changed mapping (or failed to bind), which is worse than the collision the
 * derivation exists to fix. Ungated, `resolveComposeHostPortPlan` on a bare main
 * checkout with `REDIS_URL=redis://127.0.0.1:6579` produced 6579; it now
 * produces 6379, and no service is ever reported unmanaged.
 *
 * An explicit `CINATRA_*_HOST_PORT` is honored either way: that is an operator
 * naming a published port directly, not an inference from a client URL.
 *
 * A URL that IS stated but is not an explicit-port loopback URL (a remote host;
 * a loopback host with no port) is reported in `unmanaged` and gets NO key at
 * all — the caller stands that SERVICE down rather than starting someone else's
 * service on this checkout's behalf.
 *
 * A NAMED LANE IS NEVER GIVEN A SCOPED SERVICE'S GLOBAL DEFAULT SILENTLY. That
 * was the hole this rule closes: with a project name configured and (say) no
 * REDIS_URL, the plan used to hand back the shared 6379 without a word, so two
 * named lanes that each omitted one URL collided on that service with each other
 * AND with the operator's stack — the exact quiet failure the port scoping
 * exists to kill. Such a claim is now a REFUSAL that names the missing variable
 * and both fixes (state the port, or stop naming the project).
 *
 * `laneScope` bounds who that refusal can reach, and it is deliberately narrow:
 *
 *   - `"unscoped"` — no COMPOSE_PROJECT_NAME. The canonical single-stack flow:
 *     `scripts/setup.sh`, `make dev` and `pnpm services` pass no `-p` and set no
 *     project name anywhere in this repo, so the operator's stack lands here and
 *     NOTHING below can refuse it. Historical defaults, silently, as before.
 *   - `"checkout"` — a name is stated, but it is the one compose would have
 *     derived from this directory anyway (`composeDefaultProjectName`). A no-op
 *     pin is not a second lane, so a missing URL is a loud WARNING here, not a
 *     refusal: an operator who merely pinned their own project name must not
 *     have `make dev` taken away from them.
 *   - `"lane"` — a name that names a DIFFERENT project than this directory's.
 *     That is a second stack on one host, which is precisely the situation where
 *     a shared default is a collision. Refusals apply.
 *
 * An INVALID explicit `CINATRA_*_HOST_PORT` is refused on any scoped checkout
 * and replaced by the historical default (with a warning) on an unscoped one.
 * It must never simply be dropped: the plan's keys are spread OVER the ambient
 * environment (`createComposeRunner`) and an omitted key cannot unset a shell
 * variable an `eval` already inherited, so a rejected value that produces no
 * replacement reaches compose anyway.
 *
 * @param {{
 *   processEnv?: Record<string, string | undefined>,
 *   envFileLookup?: (key: string) => string | undefined,
 *   projectName?: string,
 *   defaultProjectName?: string,
 * }} input
 * @returns {{
 *   portEnv: Record<string, string>,
 *   unmanaged: Array<{ service: string, envVar: string, urlVar: string, url: string }>,
 *   refusals: Array<{ service: string, envVar: string, reason: string, message: string }>,
 *   warnings: Array<{ service: string, envVar: string, reason: string, message: string }>,
 *   laneScope: "unscoped" | "checkout" | "lane",
 * }}
 */
export function resolveComposeHostPortPlan({
  processEnv = {},
  envFileLookup = () => undefined,
  projectName,
  defaultProjectName,
} = {}) {
  const read = (key) => {
    const fromShell = String(processEnv[key] ?? "").trim();
    if (fromShell) return fromShell;
    const fromFile = String(envFileLookup(key) ?? "").trim();
    return fromFile || undefined;
  };
  const scoped = Boolean(String(projectName ?? "").trim());
  const named = normalizeComposeProjectName(projectName);
  const laneScope = !scoped
    ? "unscoped"
    : named && named === composeDefaultProjectName(defaultProjectName)
      ? "checkout"
      : "lane";
  // Only a distinct lane is refused; see the `laneScope` note above.
  const strict = laneScope === "lane";

  const portEnv = {};
  const unmanaged = [];
  const refusals = [];
  const warnings = [];
  const note = (list, spec, reason, message) =>
    list.push({ service: spec.service, envVar: spec.envVar, reason, message });

  const byVar = new Map(PREFLIGHT_HOST_PORTS.map((spec) => [spec.envVar, spec]));
  // Two passes: a `derivedFrom` port can only be resolved once the entry it
  // follows has been.
  const passes = [
    PREFLIGHT_HOST_PORTS.filter((spec) => !spec.derivedFrom),
    PREFLIGHT_HOST_PORTS.filter((spec) => spec.derivedFrom),
  ];

  for (const pass of passes) {
    for (const spec of pass) {
      const stated = read(spec.envVar);
      if (stated !== undefined) {
        const explicit = Number(stated);
        if (isUsablePort(explicit)) {
          portEnv[spec.envVar] = String(explicit); // an operator's direct claim wins
          continue;
        }
        // Stated, but not a port. Emitting NOTHING here is the leak: the value
        // is already in the ambient environment compose inherits.
        const what = `${spec.envVar}=${stated} is not a usable host port (1-65535)`;
        if (scoped) {
          note(
            refusals,
            spec,
            "invalid-host-port-override",
            `${what}. Refusing: this checkout names a compose project, so publishing ${spec.service} on the shared default ` +
              `${spec.defaultHostPort} behind an override that says otherwise would be a silent collision. ` +
              `Set ${spec.envVar} to a valid port, or unset it.`,
          );
          continue;
        }
        note(
          warnings,
          spec,
          "invalid-host-port-override",
          `${what} — ignoring it and publishing the historical default ${spec.defaultHostPort} for ${spec.service}.`,
        );
        portEnv[spec.envVar] = String(spec.defaultHostPort);
        continue;
      }

      if (spec.derivedFrom) {
        const source = byVar.get(spec.derivedFrom);
        const offset = spec.defaultHostPort - source.defaultHostPort;
        const sourceUnmanaged = unmanaged.find((u) => u.envVar === spec.derivedFrom);
        if (sourceUnmanaged) {
          // Same container as its source: if that is not ours to publish,
          // neither is this.
          unmanaged.push({ ...sourceUnmanaged, envVar: spec.envVar });
          continue;
        }
        // Source already refused → one message for the pair, not two.
        if (refusals.some((r) => r.envVar === spec.derivedFrom)) continue;
        const sourcePort = Number(portEnv[spec.derivedFrom]);
        const derived = sourcePort + offset;
        if (!isUsablePort(derived)) {
          // The overflow band (a source port above 65535 - offset). Falling back
          // to the global ${spec.defaultHostPort} here broke BOTH properties at
          // once: the companion no longer follows its container's port, and two
          // lanes in this band both land on the shared default.
          note(
            refusals,
            spec,
            "companion-port-overflow",
            `${spec.envVar}: the companion port published by the ${spec.service} container follows ` +
              `${spec.derivedFrom}=${sourcePort} by +${offset}, but ${sourcePort} + ${offset} = ${derived} ` +
              `is not a usable host port. There is no safe fallback — the shared default ${spec.defaultHostPort} would ` +
              `collide with every other stack. Pick a ${spec.derivedFrom} of at most ${65535 - offset}, or set ` +
              `${spec.envVar} explicitly.`,
          );
          continue;
        }
        portEnv[spec.envVar] = String(derived);
        continue;
      }

      // Rule A: no lane, no derivation.
      const configured =
        scoped && spec.urlVar ? classifyServiceUrl(read(spec.urlVar)) : { state: "unconfigured" };
      if (configured.state === "theirs") {
        unmanaged.push({
          service: spec.service,
          envVar: spec.envVar,
          urlVar: spec.urlVar,
          url: configured.url,
        });
        continue;
      }
      if (configured.state === "ours") {
        portEnv[spec.envVar] = String(configured.port);
        continue;
      }

      // Nothing stated for this service.
      if (strict) {
        note(
          refusals,
          spec,
          "missing-service-url",
          `${spec.urlVar} is not stated, so this lane has no host port for ${spec.service}. ` +
            `${COMPOSE_PROJECT_ENV_VAR}=${projectName} names a compose project of its own, and a named lane is never handed ` +
            `the shared default ${spec.defaultHostPort} silently: two lanes that each omit ${spec.urlVar} would collide there, ` +
            `with each other and with the operator's stack. Fix it either way — state the port ` +
            `(${spec.urlVar}=<loopback URL with an explicit port>, or ${spec.envVar}=<port>), or unset ` +
            `${COMPOSE_PROJECT_ENV_VAR} to run as the unscoped checkout on the historical defaults.`,
        );
        continue;
      }
      if (scoped && spec.urlVar) {
        note(
          warnings,
          spec,
          "shared-default-on-named-checkout",
          `${spec.urlVar} is not stated, so ${spec.service} falls back to the shared default ${spec.defaultHostPort}. ` +
            `${COMPOSE_PROJECT_ENV_VAR}=${projectName} is the project compose derives from this directory anyway, so this is ` +
            `read as the checkout's own stack rather than a second lane. If it IS a second lane, state ${spec.urlVar} ` +
            `(or ${spec.envVar}) — otherwise it will collide on ${spec.defaultHostPort}.`,
        );
      }
      portEnv[spec.envVar] = String(spec.defaultHostPort);
    }
  }
  return { portEnv, unmanaged, refusals, warnings, laneScope };
}

/**
 * The distinct messages of a plan's `refusals` / `warnings`, in order.
 *
 * A refusal on a derived port repeats its source's, so entries are
 * de-duplicated exactly as `formatUnmanagedServices` de-duplicates a stand-down.
 *
 * @param {Array<{ message: string }>} entries
 * @returns {string[]}
 */
export function planMessages(entries = []) {
  return [...new Set(entries.map((entry) => String(entry.message)))];
}

/**
 * The error a WHOLE-STACK entry point (`make dev`, `pnpm services`) must fail
 * with when this checkout's plan stands a service down.
 *
 * Those entry points run `docker compose up -d` over the whole file, so a
 * service the plan claims no port for still starts there — on the compose
 * default — which is the stand-down being violated at the exact moment it
 * matters. The launcher can honor a stand-down per service (`--no-deps`); a
 * whole-stack up structurally cannot, so the honest enforcement is to not run
 * it. The derivation step exits non-zero with this text and the `&&` chain in
 * the Makefile / package.json recipe never reaches `docker compose up`.
 *
 * @param {{ unmanaged?: Array<{ service: string, urlVar: string, url: string }> }} input
 * @returns {string}
 */
export function formatStandDownRefusal({ unmanaged = [] } = {}) {
  const services = unmanagedComposeServices(unmanaged);
  return (
    `refusing to start the whole stack: ${formatUnmanagedServices(unmanaged)} — not an explicit-port loopback URL, so ` +
    `${services.join(", ")} ${services.length === 1 ? "is" : "are"} not this lane's to publish. A whole-stack ` +
    `\`docker compose up\` has no way to honor that: it would start ${services.length === 1 ? "it" : "them"} anyway, on the ` +
    `compose default, colliding with whoever really owns ${services.length === 1 ? "that service" : "those services"}. ` +
    `Either point the URL at a 127.0.0.1 port this lane owns (or set the matching CINATRA_*_HOST_PORT), or bring the stack ` +
    `up without ${services.length === 1 ? "that service" : "those services"} — \`pnpm dev\` heals nango-server alone ` +
    `(\`--no-deps\`) and honors the stand-down.`
  );
}

/**
 * The distinct compose services a plan says this checkout may not publish.
 *
 * @param {Array<{ service: string }>} unmanaged
 * @returns {string[]}
 */
export function unmanagedComposeServices(unmanaged = []) {
  return [...new Set(unmanaged.map((entry) => entry.service))];
}

/**
 * Render `unmanaged` entries as `VAR=value` for an operator-facing warning, so
 * the line names the configured URL that made the preflight stand down. A
 * derived port repeats its source's URL, so entries are de-duplicated.
 *
 * @param {Array<{ urlVar: string, url: string }>} unmanaged
 * @returns {string}
 */
export function formatUnmanagedServices(unmanaged = []) {
  return [...new Set(unmanaged.map(({ urlVar, url }) => `${urlVar}=${url}`))].join(", ");
}

/**
 * Build the argv for a `docker compose` subcommand, pinned to the resolved
 * project and the dev stack's two compose files.
 *
 * `-p` is emitted only when a project name is configured; omitting it preserves
 * compose's directory-basename derivation for the main checkout, which is what
 * the operator's existing stack is already named.
 *
 * @param {{ projectName?: string, args?: string[] }} input
 * @returns {string[]}
 */
export function buildComposeArgs({ projectName, args = [] } = {}) {
  const project = String(projectName ?? "").trim();
  return [
    "compose",
    ...(project ? ["-p", project] : []),
    ...COMPOSE_FILES.flatMap((file) => ["-f", file]),
    ...args,
  ];
}

/**
 * Render the same invocation as a copy-pasteable command line.
 *
 * Operator guidance MUST be built from `buildComposeArgs` too, not hand-written
 * alongside it: an unpinned command pasted from a warning forks a SECOND
 * compose project that cannot see the lane's stack. Same lesson, same remedy as
 * the WayFlow compose builder in packages/agents/src/wayflow-url.ts (#2803).
 *
 * @param {{ projectName?: string, args?: string[] }} input
 * @returns {string}
 */
export function formatComposeCommand({ projectName, args = [] } = {}) {
  return `docker ${buildComposeArgs({ projectName, args }).join(" ")}`;
}

/**
 * Create the preflight's `docker compose` runner.
 *
 * THE GUARD LIVES HERE, not only at each preflight's entry point. The
 * cinatra#2839 regression was a Docker WRITE reached behind a flag that
 * promises none, so the skip check sits on the chokepoint every compose write
 * passes through: when `skip` is set the runner resolves
 * `{ available: false, skipped: true }` WITHOUT spawning anything, and no
 * future call site added above it can reintroduce the bypass.
 *
 * Precisely: this is the only path that can CREATE anything. It is not the only
 * `docker` spawn in the preflight — the read-only drift diagnosis in
 * scripts/lib/docker-port-drift.mjs shells out on its own (`ps -aq`, `inspect`)
 * and is gated by the launcher's own `skipPreflight` check rather than by this
 * runner. An earlier revision of this comment called it "the single chokepoint
 * every compose call must pass through", which overstated it. The two do share
 * `buildComposeArgs`, so the project pin and compose-file list cannot fork.
 *
 * Resolves `{ available }` — false when Docker is not installed/usable — and
 * `{ ok }` from the exit code. Never throws; output is suppressed (the launcher
 * prints its own lines).
 *
 * @param {{
 *   spawnFn: Function,          // node:child_process spawn (injected for tests)
 *   skip: boolean,
 *   projectName?: string,
 *   portEnv?: Record<string, string>,
 *   cwd: string,
 *   baseEnv?: Record<string, string | undefined>,
 * }} deps
 * @returns {(args: string[], opts?: { timeoutMs?: number }) => Promise<{ available: boolean, ok?: boolean, skipped?: boolean }>}
 */
export function createComposeRunner({
  spawnFn,
  skip,
  projectName,
  portEnv = {},
  cwd,
  baseEnv = {},
}) {
  return function runCompose(args, { timeoutMs = 120_000 } = {}) {
    if (skip) return Promise.resolve({ available: false, skipped: true });
    return new Promise((resolve) => {
      let child;
      try {
        child = spawnFn("docker", buildComposeArgs({ projectName, args }), {
          cwd,
          stdio: "ignore",
          // The host-port overrides are passed as compose interpolation
          // variables; the compose files read them as `${VAR:-default}`.
          env: { ...baseEnv, ...portEnv },
        });
      } catch {
        resolve({ available: false });
        return;
      }
      const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
      child.once("error", () => {
        clearTimeout(timer);
        resolve({ available: false }); // e.g. ENOENT — docker not on PATH
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        resolve({ available: true, ok: code === 0 });
      });
    });
  };
}
