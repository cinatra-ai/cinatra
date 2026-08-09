// Generate the narrow Graphiti (knowledge-graph indexer) container env file
// from the app's STORED OpenAI provider configuration (cinatra#2582).
//
// WHY THIS EXISTS
// ---------------
// The `graphiti` docker service used to receive its OpenAI key as
// `environment: OPENAI_API_KEY: ${OPENAI_API_KEY:-}`. That interpolation reads
// the *shell* env — and the app's OpenAI key does not live there. It lives in
// the app database, configured in-app at /configuration/llm. So on a normal
// install the indexer started with an EMPTY key and logged
//   "No LLM client configured - entity extraction will be limited".
// Because Graphiti runs LLM extraction BEFORE the Neo4j write, every episode was
// then accepted and dropped: the knowledge graph was silently empty on every
// default install, and nothing in the app said so.
//
// This generator resolves the key the way the app itself resolves it (the
// stored connection first, `OPENAI_API_KEY` second) and writes it to a narrow,
// gitignored, 0600 file the compose service reads via `env_file`. The service's
// overlapping `environment:` mappings are REMOVED, because an empty
// `environment:` value OVERRIDES an `env_file:` value on the same key — the
// trap already documented on the nango and wayflow services.
//
// We deliberately do NOT point the service at `.env.local`: that file holds 20+
// host secrets the indexer container must never see.
//
// HONEST KEYLESS STATE
// --------------------
// No key is a legitimate state, not an error: the app degrades gracefully
// (objects still save and list; `next.config.ts` deliberately omits the key from
// REQUIRED_ENV). So a keyless run writes a keyless file and SAYS SO — the same
// sentence the app logs at boot — instead of silently materializing "".
//
// COLD-START / CLOBBER GUARD — AND ITS LIMIT
// ------------------------------------------
// `npm run services` runs this BEFORE `docker compose up`, so on a first cold
// bring-up Postgres may not be reachable yet and the stored key cannot be read.
// That must never DELETE a key an earlier run materialized, so an UNREADABLE
// configuration leaves the existing file untouched (the gen-nango-env precedent).
//
// The guard is deliberately NOT "no key resolved". A configuration that reads
// fine and holds no key means the operator DISCONNECTED or rotated the key
// away, and preserving the old file there would keep a revoked credential alive
// in the indexer container indefinitely. Only "we could not ask"
// (`storedReadFailed`) preserves; "the answer is no" rewrites. Preserving also
// beats an environment FALLBACK that happens to resolve during the outage:
// swapping a known-good stored key for a possibly-stale one is a silent
// downgrade, so the fallback only applies when nothing is materialized.
//
// SECRETS: the resolved key is written to the 0600 output file and NOWHERE else.
// It is never logged, never echoed, never included in an error message.

import path from "node:path";
import process from "node:process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// The three keys the knowledge-graph-mcp container needs for provider access.
// It uses pydantic-settings (`__` nested delimiter) for its own config AND
// graphiti_core reads the bare OPENAI_API_KEY during internal initialization,
// so all three carry the same value. Every other setting (database wiring,
// SEMAPHORE_LIMIT) is static and stays in the compose `environment:` block:
// those are not interpolated, share no key with this file, and so never hit the
// empty-override trap.
export const GRAPHITI_KEY_NAMES = [
  "LLM__PROVIDERS__OPENAI__API_KEY",
  "EMBEDDER__PROVIDERS__OPENAI__API_KEY",
  "OPENAI_API_KEY",
];

// Parse a dotenv file into a flat object. Mirrors gen-nango-env.mjs /
// gen-wayflow-env.mjs (same regex) so the parsers never drift.
export function parseDotenv(contents) {
  const env = {};
  for (const line of contents.split("\n")) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (match) env[match[1]] = match[2].replace(/^["']|["']$/g, "");
  }
  return env;
}

// Build the narrow env map from ONE resolved key. Pure (no IO), so the shape is
// unit-testable without a database. A null/blank key yields an EMPTY map — not
// three empty-string entries, which is exactly the silent behaviour this file
// exists to end.
//
// Surrounding whitespace is trimmed first (a trailing newline from a paste is
// not a corrupt key). A control character that survives the trim — anywhere
// INSIDE the value — is then REFUSED, not written: dotenv is line-oriented, so
// an embedded newline would either truncate the credential or inject an extra
// variable into the container's environment. Refusing degrades to the honest
// keyless state, which is strictly safer than a half-written credential.
export function buildGraphitiEnv(apiKey) {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  if (!key) return { env: {}, hasKey: false, rejected: null };
  if (/[\u0000-\u001F\u007F]/.test(key)) {
    return { env: {}, hasKey: false, rejected: "control-character" };
  }
  const env = {};
  for (const name of GRAPHITI_KEY_NAMES) env[name] = key;
  return { env, hasKey: true, rejected: null };
}

// Does the file already carry a usable key? Pure (no IO). The caller combines
// this with "could the stored configuration be read" to decide preserve vs
// rewrite — see generateGraphitiEnv.
export function shouldPreserveExisting(existingContents) {
  const parsed = parseDotenv(existingContents ?? "");
  return GRAPHITI_KEY_NAMES.some(
    (name) => typeof parsed[name] === "string" && parsed[name].trim() !== "",
  );
}

// Serialize to dotenv text (bare values — compose's env_file parser treats the
// post-`=` remainder as the literal value; quoting would embed the quotes).
export function serializeDotenv(env) {
  const header =
    "# GENERATED by scripts/gen-graphiti-env.mjs — DO NOT EDIT.\n" +
    "# The OpenAI key the knowledge-graph indexer runs with, resolved from the\n" +
    "# app's stored provider configuration. Gitignored, 0600.\n";
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return `${header}${body}${body ? "\n" : ""}`;
}

/**
 * Resolve the key through the app's own resolver.
 *
 * Imported LAZILY and tolerantly: the resolver is TypeScript that reaches the
 * database, so (a) the unit tests can import the pure helpers above without it,
 * and (b) a bring-up whose database is not up yet degrades to "no key" instead
 * of crashing the bring-up.
 */
async function resolveKey() {
  try {
    const mod = await import("@/lib/knowledge-graph-indexing");
    return mod.resolveKnowledgeGraphProviderKey();
  } catch (err) {
    // Class only — a resolver/DB error must never carry key material.
    const cls = err instanceof Error ? err.constructor.name : "unknown error";
    return {
      key: null,
      source: null,
      reason: `the app's provider-key resolver was not reachable (${cls})`,
      // Could not ask — so the clobber guard must PRESERVE, not rewrite.
      storedReadFailed: true,
    };
  }
}

/**
 * The materialization seam. Injectable so the tests drive the REAL writer
 * against a temp directory with a fake key — the assertion that matters is
 * "the key lands in the container's env", and a mocked writer would not make it.
 *
 * @param {{outPath: string, resolveKey?: () => Promise<{key: string|null, reason: string}>,
 *          log?: (msg: string) => void, warn?: (msg: string) => void}} options
 * @returns {Promise<{state: "configured"|"absent", wrote: boolean, keyCount: number}>}
 */
export async function generateGraphitiEnv({
  outPath,
  resolveKey: resolve = resolveKey,
  log = console.log,
  warn = console.warn,
} = {}) {
  const resolved = await resolve();
  const { env, hasKey, rejected } = buildGraphitiEnv(resolved.key);

  if (rejected === "control-character") {
    warn(
      "[gen-graphiti-env] REFUSED: the resolved provider key contains a control character " +
        "(a newline or similar). A dotenv value is line-oriented, so writing it would " +
        "truncate the credential or inject an extra container variable. Re-save the key " +
        "in the app without stray whitespace.",
    );
  }

  // PRESERVE whenever the PREFERRED source — the app's stored configuration —
  // could not be read and something usable is already materialized. That covers
  // the cold bring-up (no database yet) and a key that will not decrypt, and it
  // deliberately covers the case where an environment FALLBACK did resolve:
  // replacing a known-good stored key with a possibly-stale env key during a
  // transient database outage is a silent downgrade. The fallback is for when
  // there is nothing materialized to keep.
  //
  // What does NOT preserve: a readable configuration holding no key. That is a
  // disconnect or a rotation, and it must reach the container — otherwise a
  // revoked credential keeps running in it indefinitely.
  const couldNotAsk = resolved.storedReadFailed === true || rejected !== null;
  const materialized =
    existsSync(outPath) && shouldPreserveExisting(readFileSync(outPath, "utf8"));
  if (couldNotAsk && materialized) {
    warn(
      "[gen-graphiti-env] WARNING: the stored provider configuration could not be read " +
        `this run (${resolved.reason}), but the existing ${path.basename(outPath)} still ` +
        "carries a key — keeping it untouched (rewriting it would risk turning " +
        "knowledge-graph indexing off, or downgrading to a stale fallback key).",
    );
    return { state: "configured", wrote: false, keyCount: 0 };
  }

  mkdirSync(path.dirname(outPath), { recursive: true });
  // ATOMIC replace: a fresh 0600 temp file in the same directory, chmod
  // defensively (`mode` only applies on CREATE), then rename over outPath, so
  // readers see the old or the new file and never a truncated one. The temp
  // name shares the ignored `.graphiti.env*` prefix, and a failure between the
  // write and the rename unlinks it rather than leaving a plaintext credential
  // lying in the working tree.
  const tmpPath = `${outPath}.tmp-${process.pid}`;
  try {
    writeFileSync(tmpPath, serializeDotenv(env), { mode: 0o600 });
    chmodSync(tmpPath, 0o600);
    renameSync(tmpPath, outPath);
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Best effort — the surviving temp file is gitignored either way.
    }
    throw err;
  }

  if (hasKey) {
    log(
      `[gen-graphiti-env] knowledge-graph provider key CONFIGURED — ${resolved.reason}; ` +
        `wrote ${outPath} (${GRAPHITI_KEY_NAMES.length} keys, 0600). The indexer container ` +
        "picks it up when it is (re)created.",
    );
    return { state: "configured", wrote: true, keyCount: GRAPHITI_KEY_NAMES.length };
  }
  warn(
    `[gen-graphiti-env] knowledge-graph indexing OFF — ${resolved.reason}. ` +
      "The indexer will start WITHOUT a provider key: episodes are accepted and then " +
      "dropped (extraction runs before the graph write), so the graph stays empty. " +
      "Objects still save and list. Configure an OpenAI provider key in the app, then " +
      "re-run this bring-up.",
  );
  return { state: "absent", wrote: true, keyCount: 0 };
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateGraphitiEnv({
    outPath: path.join(repoRoot, "docker", "graphiti", ".graphiti.env"),
  });
}
