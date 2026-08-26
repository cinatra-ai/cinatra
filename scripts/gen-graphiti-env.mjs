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

// The keys that carry the resolved provider KEY. It uses pydantic-settings
// (`__` nested delimiter) for its own config AND graphiti_core reads the bare
// OPENAI_API_KEY during internal initialization, so all three carry the same
// value. Every other setting (database wiring, SEMAPHORE_LIMIT, CONFIG_PATH) is
// static and stays in the compose `environment:` block: those are not
// interpolated, share no key with this file, and so never hit the
// empty-override trap.
export const GRAPHITI_KEY_NAMES = [
  "LLM__PROVIDERS__OPENAI__API_KEY",
  "EMBEDDER__PROVIDERS__OPENAI__API_KEY",
  "OPENAI_API_KEY",
];

// The Anthropic extraction key's own variable (cinatra#2591 deliverable 2). It
// is deliberately NOT in GRAPHITI_KEY_NAMES: those three all carry the SAME
// OpenAI value, and an Anthropic key must never be written into any of them.
// `OPENAI_API_KEY` in particular is read by graphiti_core during init and by the
// EMBEDDER's OpenAI-shaped client — on an Anthropic install that client points
// at the local floor, so putting the Anthropic key there would both be wrong
// and put a credential on a wire that has no business seeing it.
export const GRAPHITI_ANTHROPIC_KEY_NAME = "LLM__PROVIDERS__ANTHROPIC__API_KEY";

/** Every variable that can carry a REAL credential, across both providers.
 *  `shouldPreserveExisting` scans this set. */
export const GRAPHITI_ALL_KEY_NAMES = [...GRAPHITI_KEY_NAMES, GRAPHITI_ANTHROPIC_KEY_NAME];

// ---------------------------------------------------------------------------
// THE EMBEDDER FLOOR, AND A BOOT CRASH IT ALSO FIXES (cinatra#2591).
//
// EMBEDDER. Graphiti ranks on embeddings, and every embedder provider it
// supports is a paid hosted API (Anthropic has none at all). So when the app has
// a usable OpenAI key, the embedder rides that key; otherwise it falls back to
// the LOCAL `kg-embedder` service, which speaks the OpenAI `/v1/embeddings`
// contract over a baked-in sentence-transformers model. Upstream's OpenAI
// embedder branch forwards `base_url` to the SDK precisely so a local endpoint
// can stand in.
//
// The floor is not a consolation prize: since cinatra#2591 seeds a deterministic
// anchor node per projected row, RANKING depends on the embedder and not on
// extraction — so an install on the local floor ranks its own rows even with no
// extraction provider at all.
//
// THE CRASH. Measured on the wire 2026-08-10 against the replacement server:
// with `llm.provider = openai` and NO key, the server does not degrade — it
// dies at startup. `LLMClientFactory` warns and returns no client (fine), but
// `CrossEncoderFactory` then builds an `OpenAIRerankerClient` from the SAME
// provider block regardless, and `AsyncOpenAI(api_key=None)` raises
// `OpenAIError: Missing credentials`, taking the whole process down:
//
//   WARNING  Failed to create LLM client: OpenAI API key is not configured.
//   INFO     Using OpenAIRerankerClient from LLM provider
//   ERROR    Failed to initialize Graphiti client: Missing credentials. …
//
// A keyless install must not have a crash-looping indexer, so the keyless file
// carries an explicit SENTINEL for the LLM key. The sentinel is a string, never
// a credential; it is named for what it means so it reads as an explanation
// wherever it surfaces. It cannot buy an extraction call — any request made with
// it is rejected by OpenAI — and nothing in cinatra treats its presence as
// "configured": the app's own state still reads `absent`, because that answer
// comes from `readKnowledgeGraphProviderKeyState`, not from this file.
//
// The reranker it keeps alive is never CALLED on cinatra's path: the recall
// query uses NODE_HYBRID_SEARCH_RRF (reciprocal-rank fusion, no cross-encoder).
// This is purely about letting the server boot.
export const GRAPHITI_NO_LLM_SENTINEL = "cinatra-no-extraction-provider-configured";

// AND the keyless LLM base URL is pointed AT THE LOCAL EMBEDDER, not at
// api.openai.com. Without this the sentinel would be worse than the crash it
// prevents: the server would construct a real OpenAI client, and every keyless
// `add_memory` would POST THE EPISODE BODY — projected row content — to OpenAI
// and only then be refused with a 401. A state whose whole point is "no vendor
// is involved" must not put row content on the wire to a vendor. Pointing at the
// local service keeps extraction failing (it serves embeddings only, so a
// chat-completions call 404s) while nothing leaves the host.
export const NO_EGRESS_LLM_API_URL = "http://kg-embedder:8080/v1";

/** Where the local embedder answers on the compose network. */
export const LOCAL_EMBEDDER_API_URL = "http://kg-embedder:8080/v1";
/** Model + width baked into docker/kg-embedder. `dimensions` MUST match the
 *  model: graphiti declares the width up front and a mismatch produces vectors
 *  the store compares silently wrongly rather than loudly. */
export const LOCAL_EMBEDDER_MODEL = "bge-small-en-v1.5";
export const LOCAL_EMBEDDER_DIMENSIONS = "384";
/** The OpenAI SDK refuses to construct without a non-empty key, and the local
 *  service ignores `Authorization` entirely (it has no auth — it is never
 *  published to a host interface). This is a placeholder, not a credential. */
export const LOCAL_EMBEDDER_PLACEHOLDER_KEY = "cinatra-local-embedder";

const HOSTED_EMBEDDER_MODEL = "text-embedding-3-small";
const HOSTED_EMBEDDER_DIMENSIONS = "1536";

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
export function buildGraphitiEnv(apiKey, provider = "openai") {
  const key = typeof apiKey === "string" ? apiKey.trim() : "";
  const rejected = key && /[\u0000-\u001F\u007F]/.test(key) ? "control-character" : null;
  const usable = rejected ? "" : key;

  if (!usable) {
    // KEYLESS. No longer an EMPTY map: the replacement server needs the LLM
    // sentinel to boot at all (see GRAPHITI_NO_LLM_SENTINEL above), and the
    // embedder is pointed at the local floor so the install still ranks its own
    // rows through their deterministic anchors. What is still absent is the one
    // thing that was ever absent: a real extraction key. No secret is written.
    return {
      env: {
        LLM__PROVIDER: "openai",
        LLM__PROVIDERS__OPENAI__API_KEY: GRAPHITI_NO_LLM_SENTINEL,
        LLM__PROVIDERS__OPENAI__API_URL: NO_EGRESS_LLM_API_URL,
        EMBEDDER__PROVIDER: "openai",
        EMBEDDER__MODEL: LOCAL_EMBEDDER_MODEL,
        EMBEDDER__DIMENSIONS: LOCAL_EMBEDDER_DIMENSIONS,
        EMBEDDER__PROVIDERS__OPENAI__API_URL: LOCAL_EMBEDDER_API_URL,
        EMBEDDER__PROVIDERS__OPENAI__API_KEY: LOCAL_EMBEDDER_PLACEHOLDER_KEY,
      },
      hasKey: false,
      embedder: "local",
      rejected,
    };
  }

  // KEYED, ANTHROPIC (cinatra#2591 deliverable 2). Extraction rides the
  // Anthropic key; embeddings CANNOT — Anthropic publishes no embeddings API,
  // which is the whole reason the local floor exists. So this arm is the one
  // the embedder floor was built for: extraction hosted, ranking local, exactly
  // ONE vendor in the install.
  //
  // The three GRAPHITI_KEY_NAMES variables are still written, and NOT with the
  // Anthropic key: they carry the local embedder's placeholder, because
  // graphiti_core reads the bare OPENAI_API_KEY during init and the embedder's
  // OpenAI-shaped client reads the other two. Pointing them at the local floor
  // keeps the Anthropic credential on exactly one variable.
  if (provider === "anthropic") {
    return {
      env: {
        LLM__PROVIDER: "anthropic",
        [GRAPHITI_ANTHROPIC_KEY_NAME]: usable,
        // config.yaml already carries the real Anthropic base URL (it has no
        // no-egress default to undo — an Anthropic block with a local URL could
        // never serve anything), so it is not restated here.
        EMBEDDER__PROVIDER: "openai",
        EMBEDDER__MODEL: LOCAL_EMBEDDER_MODEL,
        EMBEDDER__DIMENSIONS: LOCAL_EMBEDDER_DIMENSIONS,
        EMBEDDER__PROVIDERS__OPENAI__API_URL: LOCAL_EMBEDDER_API_URL,
        EMBEDDER__PROVIDERS__OPENAI__API_KEY: LOCAL_EMBEDDER_PLACEHOLDER_KEY,
        OPENAI_API_KEY: LOCAL_EMBEDDER_PLACEHOLDER_KEY,
      },
      hasKey: true,
      embedder: "local",
      rejected: null,
    };
  }

  // KEYED, OPENAI. Extraction and embeddings both ride the configured key.
  const env = {};
  for (const name of GRAPHITI_KEY_NAMES) env[name] = usable;
  env.LLM__PROVIDER = "openai";
  // config.yaml defaults the LLM base URL to the no-egress local address so a
  // bare `docker compose up` (no generated file) cannot talk to a vendor. A
  // configured install must put the real endpoint back explicitly.
  env.LLM__PROVIDERS__OPENAI__API_URL = "https://api.openai.com/v1";
  env.EMBEDDER__PROVIDER = "openai";
  env.EMBEDDER__MODEL = HOSTED_EMBEDDER_MODEL;
  env.EMBEDDER__DIMENSIONS = HOSTED_EMBEDDER_DIMENSIONS;
  return { env, hasKey: true, embedder: "openai", rejected: null };
}

// Does the file already carry a usable key? Pure (no IO). The caller combines
// this with "could the stored configuration be read" to decide preserve vs
// rewrite — see generateGraphitiEnv.
export function shouldPreserveExisting(existingContents) {
  const parsed = parseDotenv(existingContents ?? "");
  // Scans BOTH providers' key variables (cinatra#2591): a file written for an
  // Anthropic install carries its credential only on the Anthropic variable, and
  // scanning the OpenAI three alone would read that file as keyless and rewrite
  // a real key away during a cold bring-up.
  return GRAPHITI_ALL_KEY_NAMES.some((name) => {
    const value = typeof parsed[name] === "string" ? parsed[name].trim() : "";
    // The keyless file is no longer empty (it carries the boot sentinel and the
    // local-embedder placeholder), so "is a key materialized" can no longer be
    // "is anything present". Both known non-credentials are excluded by value:
    // treating either as a real key would make the cold-start guard preserve a
    // keyless file forever and hide a key the operator then configured.
    if (!value) return false;
    if (value === GRAPHITI_NO_LLM_SENTINEL) return false;
    if (value === LOCAL_EMBEDDER_PLACEHOLDER_KEY) return false;
    return true;
  });
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
 * @returns {Promise<{state: "configured"|"absent", wrote: boolean, keyCount: number,
 *                     embedder: "openai"|"local"}>}
 */
export async function generateGraphitiEnv({
  outPath,
  resolveKey: resolve = resolveKey,
  log = console.log,
  warn = console.warn,
} = {}) {
  const resolved = await resolve();
  const { env, hasKey, embedder, rejected } = buildGraphitiEnv(resolved.key, resolved.provider);

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
    return { state: "configured", wrote: false, keyCount: 0, embedder: "openai" };
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
        `wrote ${outPath} (provider: ${resolved.provider ?? "openai"}; ` +
        `${Object.keys(env).length} vars, 0600; embedder: ${embedder}). ` +
        "The indexer container picks it up when it is (re)created.",
    );
    return {
      state: "configured",
      wrote: true,
      keyCount: Object.keys(env).length,
      embedder,
    };
  }
  warn(
    `[gen-graphiti-env] knowledge-graph EXTRACTION is OFF — ${resolved.reason}. ` +
      "Episodes are accepted by the indexer and then dropped (extraction runs before the " +
      "graph write), so no entities or facts are extracted. Rows ARE still seeded as " +
      "deterministic anchor nodes and ranked on the LOCAL embedder, so recall over your own " +
      "rows keeps working — what you lose is extracted entities and relationships. " +
      "Configure an OpenAI provider key in the app, then re-run this bring-up " +
      "(`npm run kg:refresh`).",
  );
  return { state: "absent", wrote: true, keyCount: 0, embedder };
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await generateGraphitiEnv({
    outPath: path.join(repoRoot, "docker", "graphiti", ".graphiti.env"),
  });
}
