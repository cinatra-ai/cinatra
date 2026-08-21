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

import { existsSync, readFileSync, statSync } from "node:fs";
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
 * The inline-comment handling is DELIBERATELY not scoped to the skip flag. This
 * is the launcher's one `.env.local` reader, so widening it also widens how
 * PORT, SUPABASE_DB_URL, REDIS_URL and NANGO_SERVER_URL are read
 * (scripts/dev-server.mjs). That is the intent, not a side effect: an annotated
 * `PORT=13839 # lane port` previously resolved to the literal `13839 # lane
 * port`, which Next.js does not parse as a port, and an annotated DSN parsed to
 * no host port at all and fell back to the bundled default. One rule for one
 * file beats a per-key exception nobody can predict. The narrowness of the
 * comment rule is what keeps the widening safe: a `#` is a comment only when it
 * begins the value or follows whitespace, so a DSN password (`pa#ssword`) and a
 * URL fragment survive untouched. Both are pinned at the reader in
 * scripts/__tests__/dev-preflight.test.mjs; the DSN cases are pinned once more
 * through `parseHostPort`, which is how dev-server.mjs actually consumes them.
 * (A RAW `#` in a password is not valid DSN syntax and never parsed — the point
 * of that case is that the reader hands the parser the value WHOLE, unchanged
 * from `main`.)
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
 * THE STATED VALUE IS RETURNED RAW — surrounding whitespace and all. This
 * function decides only WHETHER a name was stated; whether the stated name is
 * one compose accepts is `resolveComposeHostPortPlan`'s call, and it can only
 * make it on the value the operator actually stated. Trimming here (the pre-fix
 * shape) rewrote that value before anyone judged it, and reopened the hole the
 * canonicality check exists to close, twice over:
 *
 *   - `COMPOSE_PROJECT_NAME=" cinatra"` trimmed to a canonical `cinatra` and was
 *     classified as this checkout's own no-op pin. Compose itself rejects the
 *     raw value outright — it validates an EXPLICIT name, it never cleans one up
 *     — so the operator's stated value was silently rewritten into a name they
 *     had not asked for, and the run continued.
 *   - `COMPOSE_PROJECT_NAME="   "` trimmed to empty and read as "nothing stated
 *     at all": the UNSCOPED checkout, which by design nothing below can refuse.
 *     No project-name line was emitted, so the invalid ambient value — already
 *     in the shell the entry point `eval`s into — survived into every later
 *     compose invocation and failed there, late, with compose's own error. That
 *     is the exact late failure this guard exists to prevent, and it is the same
 *     shape as the rejected-override leak `resolveComposeHostPortPlan` documents:
 *     an omitted key cannot unset a variable the shell already holds.
 *
 * "Stated" is therefore the EMPTY-STRING test, not the trimmed one. An empty
 * value is genuinely unset — that is how the shell spells "no value" (`VAR=`)
 * and how compose itself reads it — and falls through to the next source. A
 * whitespace-only value is a stated value that happens to be unusable, and is
 * refused as such.
 *
 * @param {{ processEnv?: Record<string, string | undefined>, envFileValues?: Array<string | undefined> }} input
 * @returns {string | undefined}
 */
export function resolveComposeProjectName({ processEnv = {}, envFileValues = [] } = {}) {
  const candidates = [processEnv[COMPOSE_PROJECT_ENV_VAR], ...envFileValues];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null) continue;
    const value = String(candidate);
    if (value !== "") return value;
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
 * Is this checkout a LINKED git worktree rather than the main checkout?
 *
 * The one probe that separates "the operator's single stack" from "a second
 * checkout of the same repo on the same host". Git states it structurally, and
 * the test is deliberately two steps rather than one:
 *
 *   1. `.git` must be a FILE whose ENTIRE content is `gitdir: <path>` plus line
 *      endings, the single space mandatory. A main worktree holds `.git` as a
 *      directory instead.
 *   2. …and the path it names must be a linked worktree's ADMIN DIRECTORY,
 *      recognized by a `commondir` regular file inside it, which is what git
 *      writes there and does not write into a plain repository directory.
 *
 * Both steps are structural, not authoritative: this is a cheap read of the
 * layout git maintains, not `git rev-parse`. It is pinned against git's own
 * answer for the running checkout in scripts/__tests__/dev-preflight.test.mjs.
 * It fails toward "the main checkout" — the answer that changes nothing — so a
 * checkout it cannot read stays exactly as lenient as it was before this probe
 * existed.
 *
 * Step 2 is not decoration. `git clone --separate-git-dir` (and `git init` with
 * the same flag) writes a `.git` FILE in a MAIN checkout too, pointing at a
 * repository directory that has no `commondir`. Stopping at step 1 called that
 * operator's own single checkout a second stack and applied the lane refusals to
 * it — taking `make dev` away from exactly the person this scope protects. Two
 * stats, still no `git` subprocess.
 *
 * It matters because `composeDefaultProjectName` alone cannot tell the two
 * apart. A worktree at `…/cinatra-worktrees/x2839` that states
 * `COMPOSE_PROJECT_NAME=x2839` names exactly the project compose would derive
 * from its own basename, so the pin looked like the no-op `checkout` pin and a
 * missing service URL only WARNED — and then published the shared 3003/5435/6379
 * straight into the operator's stack. That is the collision the scoping exists
 * to kill, reintroduced by the leniency meant for the operator alone.
 *
 * The leniency is not about the pin being a no-op; it is about WHOSE stack it
 * is. `scripts/setup.sh` and `make dev` create the operator's stack on the
 * historical defaults from the main checkout, and nothing may take `make dev`
 * away from them. A linked worktree is by construction a SECOND stack on that
 * same host, so its basename-named project is a lane and the refusals apply.
 *
 * Absent or unreadable `.git` (a source export, a tarball) reads as "not a
 * linked worktree" — the conservative answer, which keeps the historical
 * behavior for anything that is not demonstrably a second checkout.
 *
 * @param {string} projectDir  The checkout root.
 * @returns {boolean}
 */
export function isLinkedWorktree(projectDir) {
  const dir = String(projectDir ?? "");
  if (!dir) return false;
  try {
    const dotGit = path.join(dir, ".git");
    if (!statSync(dotGit).isFile()) return false; // a directory → the main worktree
    // Matched against the WHOLE file, not a first line split off it, and with
    // EXACTLY the prefix git itself skips: `"gitdir: "`, one space, then the
    // path, then line endings only. Reading only line one would accept a valid
    // pointer with junk under it; ` *` would accept `gitdir:/path`, which git
    // rejects; ` +` would eat a second space that git keeps as part of the path.
    //
    // Only `\r` and `\n` are stripped, never a trailing space or tab, so the
    // path this reads is never LONGER than the one git reads and this probe is
    // never looser than git. Where it ends up stricter, it simply finds no
    // `commondir` and answers "the main checkout" — which changes nothing.
    const pointer = /^gitdir: (.+?)[\r\n]*$/.exec(readFileSync(dotGit, "utf8"));
    if (!pointer) return false;
    // Resolved against the checkout, because git may write a relative gitdir.
    // A linked worktree's admin directory carries `commondir` as a regular FILE;
    // a `--separate-git-dir` main checkout points at a plain repository, which
    // has none, and must keep the operator's `checkout` leniency. Requiring a
    // file (not merely a name on disk) keeps a stray directory from deciding it.
    return statSync(path.join(path.resolve(dir, pointer[1]), "commondir")).isFile();
  } catch {
    return false; // no .git, unreadable → not demonstrably a second checkout
  }
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
 *   - `"unscoped"` — no COMPOSE_PROJECT_NAME AT ALL (unset, or the empty string
 *     a shell writes as `VAR=`). The canonical single-stack flow:
 *     `scripts/setup.sh`, `make dev` and `pnpm services` pass no `-p` and set no
 *     project name anywhere in this repo, so the operator's stack lands here and
 *     NOTHING below can refuse it. Historical defaults, silently, as before.
 *     That immunity is why the test is "was a name stated?" and not "is there a
 *     name left after trimming": a whitespace-only `COMPOSE_PROJECT_NAME` WAS
 *     stated, and letting it trim its way into this scope handed the operator's
 *     leniency to a value compose will reject — see below.
 *   - `"checkout"` — a name is stated, it is ALREADY CANONICAL, it is the one
 *     compose would have derived from this directory anyway
 *     (`composeDefaultProjectName`), AND this directory is the MAIN checkout
 *     rather than a linked git worktree (`linkedWorktree`). A no-op pin on the
 *     operator's own checkout is not a second lane, so a missing URL is a loud
 *     WARNING here, not a refusal: an operator who merely pinned their own
 *     project name must not have `make dev` taken away from them. The worktree
 *     probe is what makes that test mean what it says — see `isLinkedWorktree`.
 *     Without it, a worktree at `…/x2839` stating `COMPOSE_PROJECT_NAME=x2839`
 *     matched its OWN basename, inherited the operator's leniency, and published
 *     the shared defaults into the operator's stack: the exact collision the
 *     scoping exists to kill. Canonicality is required because the comparison's two sides are not
 *     symmetric — compose normalizes a DERIVED name but only validates an
 *     EXPLICIT one — so a stated `Cinatra!` is refused by compose, never folded
 *     into `cinatra`. Such a name is refused here instead (see below), earlier
 *     and naming the rule. It is judged on the RAW stated value for the same
 *     reason: ` cinatra` is a name compose rejects, and trimming it into a
 *     canonical `cinatra` would approve a value the operator never stated.
 *   - `"lane"` — a canonical name that names a DIFFERENT project than this
 *     directory's. That is a second stack on one host, which is precisely the
 *     situation where a shared default is a collision. Refusals apply.
 *
 * THE UNSCOPED IMMUNITY IS ABSOLUTE, and every rule below states its unscoped
 * half explicitly rather than leaving it to fall out. An INVALID explicit
 * `CINATRA_*_HOST_PORT`, a companion port that OVERFLOWS the port space, and a
 * host port CLAIMED TWICE are each a refusal on a SCOPED checkout and a WARNING
 * on the unscoped one. A checkout that states no project name at all is the
 * operator's single stack by definition, and `make dev` is never taken away from
 * it: the plan is completed with the historical default and the problem is said
 * out loud instead.
 *
 * TWO DIFFERENT TESTS, ON PURPOSE — `scoped` above, `strict` below. They divide
 * on what the checkout STATED, not on how big the blast radius is:
 *
 *   - What a scoped checkout STATES and cannot publish is refused whether it is
 *     a distinct lane or the operator's own no-op pin (`checkout`). NOTE this
 *     really does mean the `checkout` scope: it is not the unscoped immunity,
 *     and the reason is NOT that a second stack exists. The reason is per case,
 *     and none of the three is a value any bring-up can honor:
 *       · an unusable `CINATRA_*_HOST_PORT` — the operator named a published
 *         port and named a non-port;
 *       · a doubly-claimed host port — compose cannot bind one host port twice,
 *         so this one really does fail at bring-up;
 *       · an overflowing companion — this one would NOT fail: the plan simply
 *         emits no key and compose publishes the file's `${…:-3009}` default.
 *         That is precisely why it is refused. Silently falling back means the
 *         companion no longer follows its container's port, on a project that
 *         named itself, which is the collision the scoping exists to kill.
 *     Refusing here names the variable and the rule, ahead of a bind-time error
 *     or a silent wrong port.
 *   - What a scoped checkout merely OMITS is governed by `strict`, and only a
 *     distinct `lane` is refused for it. A missing service URL is not an
 *     unusable statement, it is no statement, and on the operator's own checkout
 *     the historical default is the right answer with a warning.
 *
 * An invalid explicit value must never simply be dropped either: the plan's keys are spread OVER the ambient
 * environment (`createComposeRunner`) and an omitted key cannot unset a shell
 * variable an `eval` already inherited, so a rejected value that produces no
 * replacement reaches compose anyway.
 *
 * @param {{
 *   processEnv?: Record<string, string | undefined>,
 *   envFileLookup?: (key: string) => string | undefined,
 *   projectName?: string,
 *   defaultProjectName?: string,
 *   linkedWorktree?: boolean,
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
  linkedWorktree = false,
} = {}) {
  const read = (key) => {
    const fromShell = String(processEnv[key] ?? "").trim();
    if (fromShell) return fromShell;
    const fromFile = String(envFileLookup(key) ?? "").trim();
    return fromFile || undefined;
  };
  // THE STATED NAME IS JUDGED RAW. Every decision below — stated at all?
  // canonical? — is made on exactly the bytes the operator set, because
  // whitespace is as much a character compose forbids as `!` is, and a check
  // that trims first has already rewritten the value it is about to approve.
  // `resolveComposeProjectName` hands it over untouched for this reason.
  const rawName = String(projectName ?? "");
  // Empty is genuinely unset (`VAR=` is how a shell spells "no value", and how
  // compose reads it). Whitespace-only is STATED — and unusable, so it lands in
  // the refusal below rather than being mistaken for the unscoped checkout, the
  // one scope nothing here is allowed to refuse.
  const scoped = rawName !== "";
  const named = normalizeComposeProjectName(rawName);
  // Compose NORMALIZES the name it derives from a directory basename, but only
  // VALIDATES one stated explicitly: `COMPOSE_PROJECT_NAME=Cinatra!` (or plain
  // `Cinatra`, or ` cinatra` with a leading space) is rejected outright with
  // "invalid project name … must consist only of lowercase alphanumeric
  // characters, hyphens, and underscores as well as start with a letter or
  // number" — it is never cleaned up into `cinatra`. So the two sides of the
  // `checkout` comparison are NOT symmetric, and normalizing (or trimming) the
  // stated name before comparing it let a name compose would refuse be
  // classified as this checkout's own no-op pin.
  const canonical = scoped && rawName === named;
  // What the operator typed, made visible: a name whose whitespace is the whole
  // defect renders as an invisible one in an unquoted message. Quoted only when
  // it differs from its trim, so every name that was already legible stays so.
  const shownName = rawName === rawName.trim() ? rawName : JSON.stringify(rawName);
  // A linked worktree is a SECOND checkout of this repo on this host, so the
  // project named after its own basename is a second stack — never the
  // operator's single one. It gets no `checkout` leniency, whatever it is named.
  const laneScope = !scoped
    ? "unscoped"
    : canonical && !linkedWorktree && named === composeDefaultProjectName(defaultProjectName)
      ? "checkout"
      : "lane";
  // Only a distinct lane is refused for what it merely OMITS. What a scoped
  // checkout STATES and cannot publish is refused either way, `checkout` scope
  // included — see the two-tests note in the docblock above.
  const strict = laneScope === "lane";

  const portEnv = {};
  const unmanaged = [];
  const refusals = [];
  // A stated name compose will not accept can never boot this stack at all, so
  // refuse HERE — at the step that names the variable and the rule — instead of
  // letting the operator meet compose's own error after the entry point has
  // already run part of the way. Applies to every scoped checkout: the name is
  // unusable whether it was meant as a lane or as a pin.
  if (scoped && !canonical) {
    refusals.push({
      service: "compose",
      envVar: COMPOSE_PROJECT_ENV_VAR,
      reason: "project-name-not-canonical",
      message:
        `${COMPOSE_PROJECT_ENV_VAR}=${shownName} is not a name Docker Compose accepts. Compose normalizes only the ` +
        `project name it DERIVES from the directory basename; an explicit one must ALREADY consist only of ` +
        `lowercase alphanumeric characters, hyphens and underscores, and start with a letter or number — ` +
        `compose rejects anything else outright rather than cleaning it up. ` +
        (named
          ? `Set ${COMPOSE_PROJECT_ENV_VAR}=${named} instead`
          : `Choose a name matching that rule`) +
        `, or unset ${COMPOSE_PROJECT_ENV_VAR} to run as the unscoped checkout on the historical defaults.`,
    });
  }
  const warnings = [];
  const note = (list, spec, reason, message) =>
    list.push({ service: spec.service, envVar: spec.envVar, reason, message });

  // How each claim in `portEnv` was decided, kept so the uniqueness check below
  // can name the DECIDING source of a collision instead of only the variable.
  // "state a different port" is useless advice when the operator never wrote the
  // variable the message names — a derived companion is the whole reason this
  // check exists.
  const origin = {};
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
          origin[spec.envVar] = `stated directly as ${spec.envVar}=${explicit}`;
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
        origin[spec.envVar] = `the historical default ${spec.defaultHostPort}`;
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
          // The overflow band (a source port above 65535 - offset).
          const what =
            `${spec.envVar}: the companion port published by the ${spec.service} container follows ` +
            `${spec.derivedFrom}=${sourcePort} by +${offset}, but ${sourcePort} + ${offset} = ${derived} ` +
            `is not a usable host port`;
          if (scoped) {
            // A STATED value that cannot be published, so it is refused on any
            // scoped checkout — the operator's own pin included. Falling back to
            // the global ${spec.defaultHostPort} broke both properties at once:
            // the companion no longer follows its container's port, and two
            // lanes in this band would both land on the shared default.
            note(
              refusals,
              spec,
              "companion-port-overflow",
              `${what}. There is no safe fallback — the shared default ${spec.defaultHostPort} would ` +
                `collide with every other stack. Pick a ${spec.derivedFrom} of at most ${65535 - offset}, or set ` +
                `${spec.envVar} explicitly.`,
            );
            continue;
          }
          // The UNSCOPED checkout is the one scope nothing here may refuse: it
          // states no project name at all, so it is the operator's single stack
          // by definition and `make dev` is never taken away from it. The
          // argument against the fallback does not apply either. That argument
          // is "a named project must not silently land on the shared default",
          // and this checkout has no name: the default is the port it publishes
          // anyway, so the fallback moves nothing. Warn and publish, exactly as
          // an unusable override is handled above.
          note(
            warnings,
            spec,
            "companion-port-overflow",
            `${what} — ignoring the derivation and publishing the historical default ${spec.defaultHostPort} for ` +
              `${spec.service}. This checkout names no compose project, so ${spec.defaultHostPort} is the port it ` +
              `would have published anyway: the fallback puts nothing there that was not already going there. ` +
              `Whether some OTHER stack on this host already holds it is a bind-time answer this step cannot give; ` +
              `a second claim inside this plan is reported by the uniqueness check. Set ${spec.envVar} explicitly ` +
              `to publish it elsewhere.`,
          );
          portEnv[spec.envVar] = String(spec.defaultHostPort);
          origin[spec.envVar] = `the historical default ${spec.defaultHostPort}`;
          continue;
        }
        portEnv[spec.envVar] = String(derived);
        origin[spec.envVar] =
          `derived: the ${spec.service} container publishes it alongside ${spec.derivedFrom}=${sourcePort}, ` +
          `so it follows that port by +${offset}`;
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
        origin[spec.envVar] = `read from ${spec.urlVar}=${configured.url}`;
        continue;
      }

      // Nothing stated for this service.
      if (strict) {
        note(
          refusals,
          spec,
          "missing-service-url",
          `${spec.urlVar} is not stated, so this lane has no host port for ${spec.service}. ` +
            `${COMPOSE_PROJECT_ENV_VAR}=${shownName} names a compose project of its own, and a named lane is never handed ` +
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
            `${COMPOSE_PROJECT_ENV_VAR}=${shownName} is the project compose derives from this directory anyway, so this is ` +
            `read as the checkout's own stack rather than a second lane. If it IS a second lane, state ${spec.urlVar} ` +
            `(or ${spec.envVar}) — otherwise it will collide on ${spec.defaultHostPort}.`,
        );
      }
      portEnv[spec.envVar] = String(spec.defaultHostPort);
      origin[spec.envVar] = `the historical default ${spec.defaultHostPort}`;
    }
  }

  // UNIQUENESS OVER THE FINISHED PLAN. Every rule above decides ONE service in
  // isolation, so each claim can be individually correct and the plan as a whole
  // still impossible: a lane on `NANGO_SERVER_URL=…:16373` gets a companion at
  // 16373 + 6 = 16379, and a `REDIS_URL=…:16379` in the same file claims that
  // very port. Both claims are honored, compose publishes the first mapping and
  // fails to bind the second, and the lane comes up half-started — with nothing
  // in the plan having said a word, because no single rule can see the other's
  // result. The derived companion is what makes this reachable without an
  // operator typo: its port is one nobody typed.
  //
  // Checked here, on the finished set, for the same reason the other guards sit
  // before the `up`: a collision this step can see is one compose must never be
  // asked to discover at bind time.
  const claimedBy = new Map();
  for (const spec of PREFLIGHT_HOST_PORTS) {
    const port = portEnv[spec.envVar];
    if (port === undefined) continue; // stood down or refused — no claim to collide
    if (!claimedBy.has(port)) claimedBy.set(port, []);
    claimedBy.get(port).push(spec);
  }
  for (const [port, specs] of claimedBy) {
    if (specs.length < 2) continue;
    const services = [...new Set(specs.map((spec) => spec.service))];
    // One container publishing the same host port twice is the same bind
    // failure, so services are NOT what makes this a collision — two claims are.
    const claims = specs
      .map((spec) => `${spec.envVar} (${origin[spec.envVar]})`)
      .join(" and ");
    // ONE container publishing a host port twice cannot start at all; two
    // services means one starts and the other does not. Both are a bind failure,
    // and they are not the same outcome — say which.
    const outcome =
      services.length === 1
        ? `the ${services[0]} container cannot start at all`
        : `whichever of ${services.join(" / ")} binds second fails to start, leaving the stack half up`;
    const what =
      `host port ${port} is claimed twice by this plan — ${claims}. Docker binds one host port once, so ${outcome}`;
    // Attributed to the LAST claimant: the first one is the port's incumbent, and
    // naming the newcomer is what makes the message point at something to move.
    const spec = specs[specs.length - 1];
    if (scoped) {
      note(
        refusals,
        spec,
        "duplicate-host-port",
        `${what}. Refusing before anything is published: give each service its own host port. A port nobody typed ` +
          `is still a claim — a companion port follows its container's port by a fixed offset, so moving the ` +
          `port it follows moves it too.`,
      );
      continue;
    }
    note(
      warnings,
      spec,
      "duplicate-host-port",
      `${what}. This checkout states no ${COMPOSE_PROJECT_ENV_VAR}, so nothing here refuses it — the historical ` +
        `single-stack flow is never taken away by this step — and the claims stand exactly as resolved. Compose ` +
        `will still fail to bind the second one. Give each service its own host port; a companion port follows its ` +
        `container's port by a fixed offset, so moving the port it follows moves it too.`,
    );
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

/** The ONE derivation step every entry point runs before it starts the stack. */
export const DEV_COMPOSE_ENV_STEP = "node scripts/dev-compose-env.mjs";

/**
 * A bring-up line an operator may safely paste: the SAME guarded chain the real
 * entry points run, not a bare `docker compose up`.
 *
 * Every entry point that starts this stack — the `Makefile` `dev` target,
 * package.json `services`, scripts/setup.sh — now assigns the derivation step's
 * output, evals it, and only then runs compose. A printed command that skips
 * that chain diverges from every one of them in both ways that matter:
 *
 *   - UNPINNED. The step is what exports COMPOSE_PROJECT_NAME (Docker reads it
 *     from its own env, never from `.env.local`, which is where a lane records
 *     it), so a bare `docker compose up` pasted from a diagnostic starts a
 *     SECOND, basename-derived project the lane cannot see — the original
 *     cinatra#2839 defect, handed to the operator in a remedy line.
 *   - UNGUARDED. It also skips every refusal: a lane with no host port for a
 *     scoped service, an unusable override, a companion port that collides. The
 *     pasted line publishes the shared defaults that the guarded path exists to
 *     refuse.
 *
 * No `-p` is emitted, deliberately: the `eval` puts COMPOSE_PROJECT_NAME into
 * the shell compose inherits, exactly as the real recipes do. Pinning it here
 * as well would print a command that no entry point actually runs, and would
 * state a project name resolved somewhere other than the step whose plan the
 * ports come from.
 *
 * `--require-manageable` belongs on a WHOLE-STACK `up` (see
 * `formatStandDownRefusal`): that is the shape that cannot honor a stand-down,
 * so the step must refuse for it.
 *
 * @param {{ args?: string[], requireManageable?: boolean }} input
 * @returns {string}
 */
export function formatGuardedComposeCommand({ args = [], requireManageable = false } = {}) {
  const step = requireManageable ? `${DEV_COMPOSE_ENV_STEP} --require-manageable` : DEV_COMPOSE_ENV_STEP;
  return (
    `CINATRA_COMPOSE_ENV="$(${step})" && eval "$CINATRA_COMPOSE_ENV" && ` +
    formatComposeCommand({ args })
  );
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
 * scripts/lib/docker-port-drift.mjs shells out on its own (`ps -aq`, `inspect`),
 * so it carries the SAME guard on ITS own spawning function rather than relying
 * on the launcher's entry check. Two spawning functions, two guards — that is
 * what makes the flag's promise hold, rather than one runner every path happens
 * to use today. An earlier revision of this comment called this "the single
 * chokepoint every compose call must pass through", which overstated it. The two
 * do share `buildComposeArgs`, so the project pin and compose-file list cannot
 * fork.
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
