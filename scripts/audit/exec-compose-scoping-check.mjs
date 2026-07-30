// Execution-plane compose SCOPING self-check (exec-plane L3, epic cinatra#1705).
//
// The execution plane's containment argument rests on two structural claims,
// and neither survives on good intentions:
//
//   1. NO APP SECRET SURFACE. Every exec service is configured from its own
//      scoped env file under the exec-plane directory. Not the app's .env.local,
//      not a shared env_file, not an inherited app variable. A broker that can
//      read SUPABASE_DB_URL is a broker whose compromise is a database
//      compromise, which is exactly the coupling the separate services exist to
//      break.
//
//   2. THE DOCKER SOCKET IS ON THE WORKER, AND ONLY ON THE WORKER. A socket is
//      root on the host. The worker needs one; nothing else in the topology
//      does, and since the broker routes its volume + container operations to
//      the worker over the typed seam it genuinely does not.
//
// This gate asserts both against docker-compose.exec.yml. It is deliberately
// dependency-free (`node --test`-able, no pnpm install needed): the YAML subset
// parser below understands nested maps, `- ` sequences and plain/quoted
// scalars, and REFUSES anything it does not model (anchors, flow collections,
// block scalars) rather than guessing — a gate that silently mis-parses is
// worse than no gate. Merge keys (`<<: *anchor`) are the one exception: they
// are skipped, because the alias they pull in is itself checked where it is
// defined at the top level.
//
// Usage:
//   node scripts/audit/exec-compose-scoping-check.mjs [path-to-compose.yml]

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export const DEFAULT_COMPOSE_PATH = "docker-compose.exec.yml";

/** The services this gate governs, and which of them may hold a socket. */
export const SOCKET_ALLOWED_SERVICES = new Set(["cinatra-exec-worker"]);

/** Directory prefix every exec `env_file` must resolve under. */
export const EXEC_ENV_DIR_TOKEN = "/opt/cinatra-exec";

/**
 * `/opt/cinatra-exec/<service-slug>/.env` — the only shape a scoped env file
 * takes. Anchored on the exec directory so that `/opt/cinatra-exec/.env`, a
 * SHARED file that would put every service's secrets in every service, is
 * rejected as firmly as the app's own env file is.
 */
export const SCOPED_ENV_FILE_RE = new RegExp(
  `${EXEC_ENV_DIR_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/[a-z][a-z0-9-]*/\\.env$`,
);

/**
 * App keys that must NEVER appear on an exec service. Not an exhaustive list of
 * app configuration — an exhaustive list would rot. It is the SECRET SURFACE:
 * the values whose presence in an exec container would make that container's
 * compromise an app compromise. The allowlist below is the real fence; this
 * list exists so a violation names the specific coupling it re-introduces.
 */
export const BANNED_APP_KEYS = [
  "SUPABASE_DB_URL",
  "BETTER_AUTH_SECRET",
  "BETTER_AUTH_URL",
  "CINATRA_ENCRYPTION_KEY",
  "CINATRA_BRIDGE_TOKEN",
  "CINATRA_CONTEXT_ATTEST_KEY",
  "NANGO_ENCRYPTION_KEY",
  "NANGO_DATABASE_URL",
  "NANGO_SERVER_URL",
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GRAPHITI_URL",
  "WAYFLOW_BASE_URL",
  "SENTRY_AUTH_TOKEN",
  "SENTRY_DSN",
  "REDIS_URL",
  "BULLMQ_QUEUE_NAME",
  // The voucher SIGNING key. The broker is verify-only and is structurally
  // incapable of minting; handing it the private half would silently make it
  // capable, which is the one authorization property the whole voucher design
  // rests on.
  "EXECUTION_VOUCHER_SIGNING_KEY",
];

/**
 * Every key an exec service is allowed to declare inline. Anything outside this
 * set fails the gate even when it is not on the banned list — the fence is an
 * ALLOWLIST, so a newly-added app variable cannot leak in just by not having
 * been thought of yet.
 *
 * Secrets are not here on purpose: they arrive through the scoped env FILE, and
 * a compose file is a committed artifact.
 */
export const ALLOWED_INLINE_KEYS = new Set([
  // wire + identity
  "EXEC_INSTANCE",
  "EXEC_PROTOCOL_VERSION",
  "EXEC_LISTEN_ADDRESS",
  "EXEC_BROKER_LISTEN_PORT",
  "EXEC_WORKER_LISTEN_PORT",
  "EXEC_WORKER_URL",
  // broker acknowledgements
  "EXEC_BROKER_RUN_LIVENESS",
  "EXEC_BROKER_VOLUME_OPS",
  // egress
  "EXEC_SANDBOX_NETWORK",
  "EXEC_EGRESS_MODE",
  "EXEC_EGRESS_ALLOWLIST",
  "EXEC_EGRESS_MAX_BYTES_PER_JOB",
  "EXEC_GATEWAY_HOST",
  "EXEC_GATEWAY_PORT",
  "EXEC_GATEWAY_ADMIN_URL",
  // host exclusivity
  "EXEC_HOST_EXCLUSIVITY",
  "EXEC_HOST_EXCLUSIVITY_LEASE",
  "EXEC_HOST_EXCLUSIVITY_TENANT",
  "EXEC_HOST_EXCLUSIVITY_RENEW_INTERVAL_MS",
  // mTLS material — PATHS only; the key files ride a mount
  "EXEC_TLS_CA_FILE",
  "EXEC_TLS_CERT_FILE",
  "EXEC_TLS_KEY_FILE",
  "EXEC_TLS_CLIENT_CERT_FILE",
  "EXEC_TLS_CLIENT_KEY_FILE",
  // sandbox base image
  "CINATRA_SANDBOX_L0_IMAGE",
  // gateway process config
  "EGRESS_PROXY_PORT",
  "EGRESS_ADMIN_PORT",
  "EGRESS_MODE",
  "EGRESS_ALLOWLIST",
  "EGRESS_MAX_BYTES_PER_JOB",
]);

// ---------------------------------------------------------------------------
// A strict YAML subset. Fails closed on anything it does not model.
// ---------------------------------------------------------------------------

class ComposeParseError extends Error {}

/** Parse the compose subset this repo's exec file is written in. */
export function parseComposeSubset(text) {
  const lines = [];
  text.split("\n").forEach((raw, index) => {
    const withoutComment = stripComment(raw);
    if (withoutComment.trim().length === 0) return;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    lines.push({ indent, content: withoutComment.trim(), lineNo: index + 1 });
  });
  const [value, next] = parseBlock(lines, 0, 0);
  if (next !== lines.length) {
    throw new ComposeParseError(
      `unconsumed content at line ${lines[next].lineNo} (unsupported YAML construct)`,
    );
  }
  return value;
}

function stripComment(line) {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      // A `#` only starts a comment at the start of the token or after a space.
      if (i === 0 || line[i - 1] === " ") return line.slice(0, i);
    }
  }
  return line;
}

function parseBlock(lines, start, indent) {
  if (start >= lines.length) return [null, start];
  if (lines[start].content.startsWith("- ") || lines[start].content === "-") {
    return parseSequence(lines, start, indent);
  }
  return parseMapping(lines, start, indent);
}

function parseSequence(lines, start, indent) {
  const items = [];
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (!line.content.startsWith("-")) break;
    const rest = line.content.slice(1).trim();
    i += 1;
    if (rest.length === 0) {
      const [nested, next] = parseBlock(lines, i, lines[i]?.indent ?? indent);
      items.push(nested);
      i = next;
      continue;
    }
    if (/^[A-Za-z0-9_.$/{}-]+:( |$)/.test(rest) || /^"[^"]*":( |$)/.test(rest)) {
      // An inline first key of a mapping item (`- path: …`). Re-parse the
      // remainder of the item as a mapping whose first line is this one.
      const synthetic = [
        { indent: 0, content: rest, lineNo: line.lineNo },
        ...lines
          .slice(i)
          .filter((l) => l.indent > indent)
          .map((l) => ({ ...l, indent: l.indent - (indent + 2) })),
      ];
      const consumed = lines.slice(i).findIndex((l) => l.indent <= indent);
      const take = consumed === -1 ? lines.length - i : consumed;
      const [mapping] = parseMapping(synthetic.slice(0, take + 1), 0, 0);
      items.push(mapping);
      i += take;
      continue;
    }
    items.push(parseScalar(rest, line.lineNo));
  }
  return [items, i];
}

function parseMapping(lines, start, indent) {
  const map = {};
  let i = start;
  while (i < lines.length && lines[i].indent === indent) {
    const line = lines[i];
    if (line.content.startsWith("- ")) break;
    if (line.content.startsWith("<<:")) {
      // Merge key — the anchor's own definition is checked where it is declared.
      i += 1;
      continue;
    }
    const match = /^("(?:[^"]*)"|[^:]+):\s*(.*)$/.exec(line.content);
    if (!match) {
      throw new ComposeParseError(
        `line ${line.lineNo}: not a supported mapping entry ("${line.content}")`,
      );
    }
    const key = unquote(match[1]);
    const inline = match[2];
    i += 1;
    if (inline.length > 0) {
      if (inline.startsWith("&") || inline.startsWith("*")) {
        throw new ComposeParseError(
          `line ${line.lineNo}: YAML anchors/aliases are not modelled by this gate`,
        );
      }
      if (inline === "|" || inline === ">" || inline.startsWith("{")) {
        throw new ComposeParseError(
          `line ${line.lineNo}: block scalars and flow mappings are not modelled by this gate`,
        );
      }
      if (inline.startsWith("[")) {
        map[key] = parseFlowSequence(inline, line.lineNo);
        continue;
      }
      map[key] = parseScalar(inline, line.lineNo);
      continue;
    }
    if (i < lines.length && lines[i].indent > indent) {
      const [nested, next] = parseBlock(lines, i, lines[i].indent);
      map[key] = nested;
      i = next;
      continue;
    }
    map[key] = null;
  }
  return [map, i];
}

/**
 * A FLAT flow sequence of scalars (`["exec"]`, `["node", "/app/x.mjs"]`) — the
 * only flow construct compose files here use. A nested one is refused: this
 * gate models exactly what it can check, and no more.
 */
function parseFlowSequence(raw, lineNo) {
  const trimmed = raw.trim();
  if (!trimmed.endsWith("]")) {
    throw new ComposeParseError(
      `line ${lineNo}: a flow sequence must open and close on one line`,
    );
  }
  const body = trimmed.slice(1, -1).trim();
  if (body.length === 0) return [];
  if (body.includes("[") || body.includes("{")) {
    throw new ComposeParseError(
      `line ${lineNo}: nested flow collections are not modelled by this gate`,
    );
  }
  return splitFlowItems(body).map((item) => parseScalar(item, lineNo));
}

/** Split on commas that are not inside a quoted item. */
function splitFlowItems(body) {
  const items = [];
  let current = "";
  let inSingle = false;
  let inDouble = false;
  for (const ch of body) {
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    if (ch === "," && !inSingle && !inDouble) {
      items.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseScalar(raw, lineNo) {
  if (raw.startsWith("&") || raw.startsWith("*")) {
    throw new ComposeParseError(
      `line ${lineNo}: YAML anchors/aliases are not modelled by this gate`,
    );
  }
  return unquote(raw);
}

function unquote(raw) {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/** Strip a `${VAR:-default}` / `${VAR:?msg}` wrapper down to its default. */
export function resolveInterpolation(value) {
  return String(value ?? "").replace(
    /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?(?::\?[^}]*)?\}/g,
    (_all, _name, fallback) => fallback ?? "",
  );
}

/** Run every scoping assertion. Returns a list of violation strings. */
export function checkExecComposeScoping(doc) {
  const violations = [];
  const services = doc?.services;
  if (!services || typeof services !== "object") {
    return ["the compose file declares no `services` mapping"];
  }
  const banned = new Set(BANNED_APP_KEYS);

  for (const [name, service] of Object.entries(services)) {
    if (!service || typeof service !== "object") {
      violations.push(`${name}: not a mapping`);
      continue;
    }

    // 1. env_file — present, and every path under the exec-plane directory.
    const envFiles = normalizeEnvFiles(service.env_file);
    if (envFiles.length === 0) {
      violations.push(
        `${name}: declares no scoped env_file — configuration must come from ` +
          `${EXEC_ENV_DIR_TOKEN}/<service>/.env, never from an inherited app environment`,
      );
    }
    for (const entry of envFiles) {
      const resolved = resolveInterpolation(entry);
      if (!resolved.includes(EXEC_ENV_DIR_TOKEN)) {
        violations.push(
          `${name}: env_file "${entry}" resolves outside ${EXEC_ENV_DIR_TOKEN} — ` +
            `an exec service must never read the app's env file`,
        );
      }
      // Every scoped file is exactly `<exec-dir>/<service>/.env`. Anything else
      // — `.env.local`, a shared `<exec-dir>/.env`, a deeper path — is the
      // app's surface arriving under a different name.
      if (!SCOPED_ENV_FILE_RE.test(resolved)) {
        violations.push(
          `${name}: env_file "${entry}" is not a per-service ` +
            `${EXEC_ENV_DIR_TOKEN}/<service>/.env file`,
        );
      }
    }

    // 2. inline environment — allowlisted keys only, banned keys named loudly.
    const env = normalizeEnvironment(service.environment);
    for (const key of env) {
      if (banned.has(key)) {
        violations.push(
          `${name}: declares banned app key ${key} — an exec service that holds it ` +
            `couples its compromise to the app's`,
        );
        continue;
      }
      if (!ALLOWED_INLINE_KEYS.has(key)) {
        violations.push(
          `${name}: declares ${key}, which is not in the exec-plane inline allowlist ` +
            `(add it to ALLOWED_INLINE_KEYS only if it is genuinely exec-plane configuration)`,
        );
      }
    }

    // 3. the docker socket — worker only.
    const volumes = Array.isArray(service.volumes) ? service.volumes : [];
    for (const volume of volumes) {
      if (typeof volume !== "string") continue;
      if (!volume.includes("docker.sock")) continue;
      if (!SOCKET_ALLOWED_SERVICES.has(name)) {
        violations.push(
          `${name}: mounts the docker socket — a socket is root on the host and ` +
            `belongs to the worker alone`,
        );
      }
    }
  }

  // 4. the worker must actually have one (a topology with no socket anywhere
  //    would pass every check above while being unable to run a command).
  const worker = services["cinatra-exec-worker"];
  const workerVolumes = Array.isArray(worker?.volumes) ? worker.volumes : [];
  if (!workerVolumes.some((v) => typeof v === "string" && v.includes("docker.sock"))) {
    violations.push(
      "cinatra-exec-worker: no docker socket mounted — the worker cannot run a command",
    );
  }

  // 5. the sandbox network must be internal by construction.
  const network = doc?.networks?.["cinatra-exec-internal"];
  if (String(network?.internal) !== "true") {
    violations.push(
      "networks.cinatra-exec-internal: must be `internal: true` — a sandbox network " +
        "with a NAT route makes egress policy advisory",
    );
  }

  return violations;
}

function normalizeEnvFiles(value) {
  if (value === undefined || value === null) return [];
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry : entry?.path))
    .filter((entry) => typeof entry === "string");
}

function normalizeEnvironment(value) {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value
      .filter((entry) => typeof entry === "string")
      .map((entry) => entry.split("=")[0].trim());
  }
  if (typeof value === "object") return Object.keys(value);
  return [];
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function main(argv) {
  const target = resolve(process.cwd(), argv[2] ?? DEFAULT_COMPOSE_PATH);
  let doc;
  try {
    doc = parseComposeSubset(readFileSync(target, "utf8"));
  } catch (err) {
    process.stderr.write(
      `exec-compose-scoping-check: cannot read ${target}: ${err.message}\n`,
    );
    return 2;
  }
  const violations = checkExecComposeScoping(doc);
  if (violations.length > 0) {
    process.stderr.write(
      `exec-compose-scoping-check: ${violations.length} violation(s) in ${target}\n`,
    );
    for (const violation of violations) process.stderr.write(`  - ${violation}\n`);
    return 1;
  }
  process.stdout.write(
    `exec-compose-scoping-check: OK — no app secret surface, socket on the worker only (${target})\n`,
  );
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  process.exit(main(process.argv));
}
