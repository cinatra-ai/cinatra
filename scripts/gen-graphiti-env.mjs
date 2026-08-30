// Give the Graphiti (knowledge-graph indexer) container the provider key the
// app has actually stored — WITHOUT ever writing that key to a file
// (cinatra#2582, hardened here).
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
// THE ROAD THIS SCRIPT TAKES, AND WHY IT CHANGED
// ----------------------------------------------
// The first fix resolved the key the way the app resolves it and wrote it, in
// clear, into `docker/graphiti/.graphiti.env` (0600, gitignored), which the
// compose service read with `env_file:`. That closed the empty-key defect and
// opened a worse one: a DECRYPTED credential at rest, in the checkout, with a
// lifetime nobody managed. The file survived `docker compose down`, `make
// clean`, a branch switch and a lane teardown; nothing deleted it; and because
// it was gitignored, no gate could see it. Rotating the key in the app did not
// remove the old value from disk.
//
// So the key no longer touches the filesystem at all. THE ROAD:
//
//   the script resolves the key IN MEMORY and EXECS the compose command itself,
//   with the provider variables set in that child process's environment.
//
//     node scripts/gen-graphiti-env.mjs -- docker compose … up -d graphiti
//
// Compose passes a variable to a container when the service declares it, so
// `docker-compose.yml` lists the provider variables under `environment:` with
// NO value ("take it from my environment"). A value-less entry is omitted from
// the container when the variable is unset — it is NOT set to the empty string
// — so `docker/graphiti/config.yaml`'s keyless-safe defaults still apply to a
// bare `docker compose up` that never ran this script. (Measured, not assumed:
// `docker compose config` renders such an entry as `null` when unset, as the
// value when set, and as `""` only when it is set-but-empty.)
//
// The `secrets:` road was considered and not taken: compose secrets are
// delivered as FILES under /run/secrets, and this image reads its configuration
// from environment variables (pydantic-settings) — using secrets would mean
// re-introducing a file and adding an entrypoint to read it back out.
//
// WHAT THIS BUYS, PLAINLY. The credential exists in this process's memory, in
// the environment of the `docker compose` child it starts, and — because that is
// what "give the container this variable" means — in the CONTAINER's own
// environment. Nothing writes it into the checkout. There is no file to forget,
// no file to leak into a backup or a tarball, no file that outlives the
// container, and rotating the key in the app is enough: the next bring-up hands
// over the new one and the old one goes with the old container.
//
// AND THE RESIDUAL, STATED HONESTLY, because a security claim that overstates
// itself is worse than none. Two places still hold the value while the indexer
// runs:
//   - this process and the compose child, readable by the same user (the same
//     exposure the CI proof tier already accepts deliberately —
//     scripts/ci/works-after/graphiti.sh hands the key by NAME for exactly this
//     reason);
//   - the created container's own configuration, where the docker daemon keeps
//     it for the container's life: `docker inspect` shows it, and so does
//     /proc/<pid>/environ inside. That is inherent to configuring this image
//     (pydantic-settings reads environment variables and nothing else), and it
//     is the exposure the `secrets:` road would have traded for a file.
// So the guarantee this script makes is exact: NO CREDENTIAL AT REST IN THE
// TREE, and none that outlives the container it was handed to. `docker compose
// down` is the end of it; a running container is not.
//
// NOTHING UNDER docker/ MAY CARRY A KEY, and this script refuses to be the one
// that puts it there: every write it can make is checked against the shared key
// shapes (scripts/lib/key-shaped-values.mjs), any path under `docker/` is
// refused outright, and every run SWEEPS the old `.graphiti.env` away —
// announcing it when the removed file carried a credential, because that is a
// key an operator now has to consider exposed. `scripts/ci/no-keys-in-docker-tree.mjs`
// is the gate that keeps this true for the whole subtree.
//
// HONEST KEYLESS STATE
// --------------------
// No key is a legitimate state, not an error: the app degrades gracefully
// (objects still save and list; `next.config.ts` deliberately omits the key from
// REQUIRED_ENV). So a keyless run hands the container the keyless configuration
// and SAYS SO — the same sentence the app logs at boot — instead of silently
// handing over "".
//
// COLD-START / CLOBBER GUARD — AND WHERE IT MOVED TO
// --------------------------------------------------
// The guard used to protect a FILE: a run that could not read the stored
// configuration left an already-materialized key alone rather than rewriting it
// away. With no file, the thing to protect is the RUNNING CONTAINER, so the
// guard moved onto the exec: when the stored configuration could not be READ
// (`storedReadFailed` — a database that is not up yet, a key that will not
// decrypt, a resolver that would not import), this script does NOT recreate the
// service. It leaves whatever is running exactly as it is and says why.
//
// The guard is deliberately NOT "no key resolved". A configuration that reads
// fine and holds no key means the operator DISCONNECTED or rotated the key
// away, and that MUST reach the container — otherwise a revoked credential keeps
// running in it indefinitely. Only "we could not ask, and we have nothing to
// offer" holds back; "the answer is no" recreates.
//
// THE LEGACY ENVIRONMENT FALLBACK IS THE ONE EXCEPTION, and it is announced
// rather than silent. "Could not read the stored configuration, but
// `OPENAI_API_KEY` is set" is the FIRST-BRING-UP signature the fallback exists
// to serve: there is no database yet, and holding back there would leave every
// fresh install with a legacy env key running a keyless indexer with nothing
// saying why. So the fallback IS applied — and the run says out loud that it
// used a fallback while the stored configuration was unreadable, so an operator
// whose container was running on a stored key can see that it has just been
// moved onto the environment one and re-run once the database is up.
//
// That is a deliberate change of verdict from the file era, where the same case
// PRESERVED. It is safe here for a reason that only holds without a file: the
// fallback is not written down anywhere and is not re-read. The old worry was a
// stale key on disk, read again at every recreate from then on until somebody
// deleted the file; now it reaches ONE container, the very next successful run
// replaces it, and nothing carries it into the run after that. What it does NOT
// mean — and the earlier wording of this paragraph got this wrong — is that the
// swap ends with the command: the container keeps running on the fallback until
// the next bring-up, which is why the run says out loud that it used one.
//
// This also fixes a case the file never covered: a FIRST cold bring-up wrote a
// keyless file (no database yet) and the operator had to re-run the bring-up to
// get a key in. The entry points now bring the stack up FIRST and exec this
// script afterwards, so the database is reachable by the time the key is
// resolved and the very first bring-up gets it right.
//
// SECRETS: the resolved key is passed to ONE child process's environment and
// NOWHERE else. It is never written to a file, never logged, never echoed, never
// put in an argv, and never included in an error message. Nor is it handed to a
// child that would PRINT it: `docker compose config` renders every resolved
// value to stdout, so that subcommand is refused through this seam
// (`assertRunnableCommand`) — inspect the rendered configuration by running
// compose directly, where these variables are value-less.
//
// USAGE
//   node scripts/gen-graphiti-env.mjs
//       resolve and REPORT the state; sweep any stale file. Writes nothing.
//   node scripts/gen-graphiti-env.mjs -- <command> [args…]
//       the same, then run <command> with the provider variables set in its
//       environment. Exits with the child's status.
//   node scripts/gen-graphiti-env.mjs --write-env <path>
//       materialize the NON-SECRET wiring to <path> for inspection. Refused for
//       any path that lands under docker/ (physically — a symlinked parent does
//       not get you in), and refused outright if the content carries a key
//       SHAPE or a provider key variable holding anything but the named
//       sentinels — so this can only ever produce a secret-free template, an
//       opaque credential that matches no known prefix included.

import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import {
  readFileSync,
  readdirSync,
  writeFileSync,
  mkdirSync,
  chmodSync,
  renameSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { fileURLToPath } from "node:url";

import { containsKeyShapedValue, findKeyShapedLines } from "./lib/key-shaped-values.mjs";

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

/** The HOSTED embedder — cinatra#2591 deliverable 3's "configured provider
 *  embeddings where available". OpenAI publishes an embeddings API, so a keyed
 *  OpenAI install ranks on its own key and the local floor stays what it is
 *  named: a floor for installs that have no embeddings vendor (keyless, and
 *  Anthropic, which publishes none).
 *
 *  THE URL IS NOT OPTIONAL. config.yaml defaults the embedder base URL to the
 *  no-egress LOCAL address for the same reason it defaults the LLM one — an
 *  un-generated `docker compose up` must boot and must not reach a vendor. So a
 *  configured install has to put the real endpoint back EXPLICITLY, exactly as
 *  the LLM half does. Omitting it does not fall back to something harmless: it
 *  asks for `text-embedding-3-small` at 1536 wide and is served
 *  `bge-small-en-v1.5` at 384 by the local service, which ignores the requested
 *  model name. graphiti declares the width up front, so the mismatch is compared
 *  silently wrongly rather than refused loudly.
 *
 *  MODEL, WIDTH and URL are therefore one decision, and the generator's tests
 *  assert them as one across every arm. */
export const HOSTED_LLM_API_URL = "https://api.openai.com/v1";
export const HOSTED_EMBEDDER_API_URL = HOSTED_LLM_API_URL;
export const HOSTED_EMBEDDER_MODEL = "text-embedding-3-small";
export const HOSTED_EMBEDDER_DIMENSIONS = "1536";

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

  // KEYED, OPENAI. Extraction and embeddings both ride the configured key, and
  // BOTH base URLs are restated. config.yaml defaults each of them to the
  // no-egress local address so a bare `docker compose up` (no generated file)
  // cannot talk to a vendor; a configured install must put the real endpoint
  // back explicitly, on both halves. Restating only the LLM half would leave the
  // embedder pointed at the local 384-wide service under a 1536 declaration.
  const env = {};
  for (const name of GRAPHITI_KEY_NAMES) env[name] = usable;
  env.LLM__PROVIDER = "openai";
  env.LLM__PROVIDERS__OPENAI__API_URL = HOSTED_LLM_API_URL;
  env.EMBEDDER__PROVIDER = "openai";
  env.EMBEDDER__MODEL = HOSTED_EMBEDDER_MODEL;
  env.EMBEDDER__DIMENSIONS = HOSTED_EMBEDDER_DIMENSIONS;
  env.EMBEDDER__PROVIDERS__OPENAI__API_URL = HOSTED_EMBEDDER_API_URL;
  return { env, hasKey: true, embedder: "openai", rejected: null };
}

/** Every variable name ANY arm can emit — the union across keyless, keyed-OpenAI
 *  and keyed-Anthropic. It is the set `docker-compose.yml` declares under the
 *  graphiti service's `environment:`, and the set this script SCRUBS from the
 *  child environment before setting its own.
 *
 *  The scrub is the point. `npm run services` does `set -a && source .env.local`
 *  before it reaches compose, so a stray `OPENAI_API_KEY` in that file is in the
 *  environment this script inherits. Merging on top of it would leave any name
 *  THIS arm does not emit — the keyless arm emits no `OPENAI_API_KEY` at all —
 *  holding an inherited value the app's own resolver already refused. So the
 *  child environment is built by DELETING every name below and then setting
 *  exactly what the arm produced: what the container gets is the resolver's
 *  answer, whole, and nothing else.
 *
 *  A suite asserts this list is exactly the union of the three arms, so a new
 *  variable cannot be added to `buildGraphitiEnv` and silently escape the scrub. */
export const GRAPHITI_GENERATED_NAMES = [
  "EMBEDDER__DIMENSIONS",
  "EMBEDDER__MODEL",
  "EMBEDDER__PROVIDER",
  "EMBEDDER__PROVIDERS__OPENAI__API_KEY",
  "EMBEDDER__PROVIDERS__OPENAI__API_URL",
  "LLM__PROVIDER",
  "LLM__PROVIDERS__ANTHROPIC__API_KEY",
  "LLM__PROVIDERS__OPENAI__API_KEY",
  "LLM__PROVIDERS__OPENAI__API_URL",
  "OPENAI_API_KEY",
];

/** The subtree no generated file may ever land in. */
export const FORBIDDEN_WRITE_DIR = path.join(repoRoot, "docker");

/** The file the OLD road wrote, and the temp siblings its atomic replace could
 *  leave behind. Swept on every run. */
export const LEGACY_ENV_DIR = path.join(repoRoot, "docker", "graphiti");
export const LEGACY_ENV_BASENAME = ".graphiti.env";

// Does this dotenv text carry a usable credential? Pure (no IO).
//
// It used to answer "preserve or rewrite the file?". There is no file to
// preserve any more, so it answers the one question that outlived it: is the
// stale artifact this run is about to delete carrying a real key — i.e. does the
// operator have a credential to consider exposed, or merely a stale template?
export function carriesMaterializedKey(existingContents) {
  const parsed = parseDotenv(existingContents ?? "");
  // Scans BOTH providers' key variables (cinatra#2591): a file written for an
  // Anthropic install carries its credential only on the Anthropic variable, and
  // scanning the OpenAI three alone would read that file as keyless.
  return GRAPHITI_ALL_KEY_NAMES.some((name) => {
    const value = typeof parsed[name] === "string" ? parsed[name].trim() : "";
    // The keyless shape is not empty (it carries the boot sentinel and the
    // local-embedder placeholder), so "is a key materialized" cannot be "is
    // anything present". Both known non-credentials are excluded BY VALUE.
    if (!value) return false;
    if (value === GRAPHITI_NO_LLM_SENTINEL) return false;
    if (value === LOCAL_EMBEDDER_PLACEHOLDER_KEY) return false;
    return true;
  });
}

// Serialize to dotenv text (bare values — a dotenv parser treats the post-`=`
// remainder as the literal value; quoting would embed the quotes).
export function serializeDotenv(env) {
  const header =
    "# GENERATED by scripts/gen-graphiti-env.mjs — DO NOT EDIT.\n" +
    "# The NON-SECRET wiring the knowledge-graph indexer runs with. Provider\n" +
    "# credentials are NOT here and never will be: they reach the container\n" +
    "# through the environment of the `docker compose` command that creates it.\n";
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
  return `${header}${body}${body ? "\n" : ""}`;
}

/**
 * Refuse to write anything key-shaped. Throws rather than returning a verdict:
 * a guard whose result can be ignored is decoration.
 *
 * The message names the SHAPE and the LINE, never the value — an error message
 * ends up in a terminal, a CI log and a bug report.
 *
 * @param {string} text
 * @param {string} label  what is being written, for the message
 */
export function assertNoKeyShapedValue(text, label = "the generated file") {
  const lines = findKeyShapedLines(text);
  if (lines.length === 0) return;
  const where = lines.map(({ label: shape, line }) => `line ${line} (${shape})`).join(", ");
  throw new Error(
    `[gen-graphiti-env] REFUSED to write ${label}: it carries a key-shaped value at ${where}. ` +
      "A provider credential reaches the indexer through the process environment of the " +
      "`docker compose` command that creates the container, never through a file.",
  );
}

/**
 * Refuse to write a credential the SHAPES cannot see.
 *
 * `assertNoKeyShapedValue` asks "does this text look like a key?", which is the
 * right question for a file somebody else wrote. It is the wrong question for
 * OUR OWN template: a provider key does not have to look like `sk-…` — an
 * Azure-hosted OpenAI deployment, a gateway, or a self-hosted vendor issues
 * opaque values that match no prefix. Serializing a keyed arm and asking only
 * "does it look like a key?" would write such a value out in clear and call it
 * a template.
 *
 * So the template is judged by what the VARIABLES MEAN, with the same reader
 * that decides whether a swept file carried a credential: any of the provider
 * key variables holding anything other than the two named sentinels is a
 * credential, whatever it looks like.
 *
 * @param {string} text
 * @param {string} label  what is being written, for the message
 */
export function assertNoMaterializedKey(text, label = "the generated file") {
  if (!carriesMaterializedKey(text)) return;
  throw new Error(
    `[gen-graphiti-env] REFUSED to write ${label}: it carries a provider credential on one of ` +
      `${GRAPHITI_ALL_KEY_NAMES.join(", ")}. \`--write-env\` materializes the NON-SECRET ` +
      "wiring only; a credential reaches the indexer through the process environment of the " +
      "`docker compose` command that creates the container, never through a file.",
  );
}

/**
 * Refuse any output path under `docker/`. Structural, and stricter than the
 * content check on purpose: a file there is read by compose and outlives the
 * containers, so it is the wrong home for generated configuration whether or
 * not today's content happens to be secret-free.
 *
 * @param {string} outPath
 */
export function assertWritablePath(outPath) {
  const lexical = path.resolve(outPath);
  // PHYSICAL, not lexical. `path.resolve` alone reads a symlinked parent as the
  // path the caller typed, so `/tmp/inspect/.graphiti.env` whose `inspect` is a
  // link into `docker/graphiti/` would pass a lexical check and land in the
  // subtree anyway. The nearest ancestor that EXISTS is the one that can be a
  // link, so that is the one resolved; the remainder is re-joined onto it.
  const resolved = physicalPath(lexical);
  const forbiddenReal = physicalPath(FORBIDDEN_WRITE_DIR);
  for (const [candidate, forbiddenDir] of [
    [lexical, FORBIDDEN_WRITE_DIR],
    [resolved, forbiddenReal],
  ]) {
    const forbidden = `${forbiddenDir}${path.sep}`;
    if (candidate === forbiddenDir || candidate.startsWith(forbidden)) {
      throwForbiddenWrite(candidate);
    }
  }
}

/**
 * `outPath` with every existing symlinked ancestor resolved to where it really
 * points. A path whose ancestors do not exist yet resolves as far as it can —
 * which is exactly right: what does not exist cannot be a link.
 *
 * @param {string} target  an already-absolute path
 * @returns {string}
 */
function physicalPath(target) {
  let head = target;
  const tail = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail);
    } catch {
      const parent = path.dirname(head);
      // The filesystem root does not exist? Nothing left to resolve.
      if (parent === head) return target;
      tail.unshift(path.basename(head));
      head = parent;
    }
  }
}

/**
 * @param {string} resolved
 * @returns {never}
 */
function throwForbiddenWrite(resolved) {
  throw new Error(
    `[gen-graphiti-env] REFUSED to write ${resolved}: nothing generated may live under ` +
      "docker/. That subtree is read by compose and outlives every container, branch and " +
      "checkout; scripts/ci/no-keys-in-docker-tree.mjs is the gate that keeps it clean.",
  );
}

/**
 * Delete the artifacts of the OLD road, on every run, and say what was there.
 *
 * A file that carried a real credential is announced LOUDLY: the operator's key
 * has been sitting in clear on this disk, possibly since before this change
 * landed, and "it is gone now" is not the whole story — they have to decide
 * whether to rotate it. A keyless leftover is removed quietly, because there is
 * nothing for them to act on.
 *
 * @param {{dir?: string, log?: (m: string) => void, warn?: (m: string) => void}} options
 * @returns {{ removed: string[], keyBearing: string[] }}
 */
export function sweepLegacyEnvFiles({
  dir = LEGACY_ENV_DIR,
  log = console.log,
  warn = console.warn,
} = {}) {
  const removed = [];
  const keyBearing = [];
  let entries = [];
  try {
    entries = readdirSync(dir);
  } catch {
    // No directory, nothing to sweep. Not an error: a checkout that never ran
    // the old road has none of this.
    return { removed, keyBearing };
  }
  for (const name of entries) {
    // The file itself plus the `.tmp-<pid>` siblings the old atomic replace
    // could strand — both are covered by the same gitignore glob, and both
    // could hold a credential.
    if (name !== LEGACY_ENV_BASENAME && !name.startsWith(`${LEGACY_ENV_BASENAME}.tmp-`)) continue;
    const full = path.join(dir, name);
    let contents = "";
    try {
      contents = readFileSync(full, "utf8");
    } catch {
      contents = "";
    }
    const carried = containsKeyShapedValue(contents) || carriesMaterializedKey(contents);
    try {
      rmSync(full, { force: true });
    } catch (err) {
      warn(
        `[gen-graphiti-env] could not remove ${full} (${
          err instanceof Error ? err.constructor.name : "unknown error"
        }). Delete it by hand: nothing reads it any more.`,
      );
      continue;
    }
    removed.push(full);
    if (carried) keyBearing.push(full);
  }

  if (keyBearing.length > 0) {
    warn(
      `[gen-graphiti-env] REMOVED ${keyBearing.join(", ")} — ${
        keyBearing.length === 1 ? "it carried" : "they carried"
      } a provider credential in CLEAR on this disk. Nothing reads that file any more (the ` +
        "indexer gets its key from the environment of the compose command that creates it), " +
        "but the key was at rest here: treat it as exposed and rotate it in the app if that " +
        "matters for your install.",
    );
  } else if (removed.length > 0) {
    log(
      `[gen-graphiti-env] removed ${removed.join(", ")} — a leftover from the old road; ` +
        "it carried no credential and nothing reads it any more.",
    );
  }
  return { removed, keyBearing };
}

/**
 * The environment the compose child runs with: this process's environment, with
 * every generated name REMOVED, then exactly what this arm produced set on top.
 * Pure, and injectable, so a test can assert the whole shape without spawning.
 *
 * @param {Record<string, string>} env  what `buildGraphitiEnv` produced
 * @param {NodeJS.ProcessEnv} baseEnv
 * @returns {Record<string, string>}
 */
export function composeChildEnv(env, baseEnv = process.env) {
  const child = { ...baseEnv };
  for (const name of GRAPHITI_GENERATED_NAMES) delete child[name];
  for (const [name, value] of Object.entries(env)) child[name] = value;
  return child;
}

/**
 * Resolve the key through the app's own resolver.
 *
 * Imported LAZILY and tolerantly: the resolver is TypeScript that reaches the
 * database, so (a) the unit tests can import the pure helpers above without it,
 * and (b) a bring-up whose database is not up yet degrades to "could not ask"
 * instead of crashing the bring-up.
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
      // Could not ask — so the guard must leave the running container alone.
      storedReadFailed: true,
    };
  }
}

/** Compose flags that take a VALUE, so the word after them is not the
 *  subcommand. */
const COMPOSE_VALUE_FLAGS = new Set([
  "-f",
  "--file",
  "-p",
  "--project-name",
  "--profile",
  "--env-file",
  "--project-directory",
  "--parallel",
  "--progress",
  "--ansi",
  "--compatibility",
]);

/** Compose subcommands that RENDER the resolved configuration to stdout — the
 *  provider variables this script sets included. */
export const CONFIG_RENDERING_SUBCOMMANDS = new Set(["config", "convert"]);

/**
 * The compose subcommand of `command`, or null when this is not a compose
 * invocation at all.
 *
 * @param {string[]} command
 * @returns {string | null}
 */
export function composeSubcommand(command) {
  if (!Array.isArray(command) || command.length === 0) return null;
  const [bin, ...rest] = command;
  const base = path.basename(bin);
  let args = rest;
  if (base === "docker") {
    const at = rest.indexOf("compose");
    if (at === -1) return null;
    args = rest.slice(at + 1);
  } else if (base !== "docker-compose") {
    return null;
  }
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (COMPOSE_VALUE_FLAGS.has(arg)) {
      i += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    return arg;
  }
  return null;
}

/**
 * Refuse a child that would PRINT the credential it is being handed.
 *
 * The `-- <command>` seam is deliberately general: this script stands in for
 * `docker compose` in an `&&` chain and must not become a list of blessed
 * invocations. But `docker compose config` renders every resolved service
 * environment value to stdout, so running it through here puts the provider key
 * on a terminal, into a CI log, or into a captured diagnostic — which is the one
 * thing the road that replaced the key file exists to prevent. The key is
 * handed over to be USED by a container, never to be displayed.
 *
 * @param {string[]} command
 */
export function assertRunnableCommand(command) {
  const subcommand = composeSubcommand(command);
  if (subcommand === null || !CONFIG_RENDERING_SUBCOMMANDS.has(subcommand)) return;
  throw new Error(
    `[gen-graphiti-env] REFUSED to run \`docker compose ${subcommand}\` with the provider ` +
      "key in its environment: that subcommand PRINTS the resolved environment, credential " +
      "included, to stdout — a terminal, a CI log, a captured diagnostic. Run it without " +
      "this script to inspect the rendered configuration (the provider variables are " +
      "value-less there, which is the point), and use this script only for a command that " +
      "USES the key, such as `docker compose up -d graphiti`.",
  );
}

/** Default child runner. Injectable so a test drives the decision without
 *  spawning a process. `stdio: inherit` so compose's own output is the
 *  operator's output. */
function runCommand(command, args, env) {
  const result = spawnSync(command, args, { stdio: "inherit", env });
  if (result.error) throw result.error;
  // A signalled child has a null status; report it as a failure, not a success.
  return typeof result.status === "number" ? result.status : 1;
}

/**
 * Resolve the provider key, report the state, sweep the old file, and — when a
 * command was given — run it with the provider variables in its environment.
 *
 * @param {{
 *   resolveKey?: () => Promise<object>,
 *   command?: string[] | null,
 *   run?: (command: string, args: string[], env: Record<string,string>) => number,
 *   baseEnv?: NodeJS.ProcessEnv,
 *   writeEnvPath?: string | null,
 *   sweepDir?: string,
 *   log?: (msg: string) => void,
 *   warn?: (msg: string) => void,
 * }} options
 * @returns {Promise<{state: "configured"|"absent", embedder: "openai"|"local",
 *                    keyCount: number, ran: boolean, status: number, wrote: boolean,
 *                    swept: string[], sweptKeyBearing: string[]}>}
 */
export async function generateGraphitiEnv({
  resolveKey: resolve = resolveKey,
  command = null,
  run = runCommand,
  baseEnv = process.env,
  writeEnvPath = null,
  sweepDir = LEGACY_ENV_DIR,
  log = console.log,
  warn = console.warn,
} = {}) {
  const resolved = await resolve();
  const { env, hasKey, embedder, rejected } = buildGraphitiEnv(resolved.key, resolved.provider);

  if (rejected === "control-character") {
    warn(
      "[gen-graphiti-env] REFUSED: the resolved provider key contains a control character " +
        "(a newline or similar). Environment values are handed to the container one by one, " +
        "but a value carrying a newline is corrupt on every road it could take — it would " +
        "truncate the credential or inject an extra variable. Re-save the key in the app " +
        "without stray whitespace.",
    );
  }

  // Always, before anything else: the old road's artifact does not get to
  // outlive this run.
  const { removed: swept, keyBearing: sweptKeyBearing } = sweepLegacyEnvFiles({
    dir: sweepDir,
    log,
    warn,
  });

  // Opt-in, secret-free template for inspection. Both guards apply, and both
  // THROW: a refusal that only warned would leave the caller believing a file
  // it asked for exists.
  let wrote = false;
  if (writeEnvPath) {
    assertWritablePath(writeEnvPath);
    const text = serializeDotenv(env);
    // Both readers, because they catch different things: the SHAPES catch a
    // credential wherever it sits in the text, and the VARIABLE SEMANTICS catch
    // an opaque credential that matches no shape at all.
    assertNoKeyShapedValue(text, path.resolve(writeEnvPath));
    assertNoMaterializedKey(text, path.resolve(writeEnvPath));
    mkdirSync(path.dirname(path.resolve(writeEnvPath)), { recursive: true });
    // ATOMIC replace, 0600, same directory — a reader sees the old file or the
    // new one, never a truncated one. Kept from the old writer: the content is
    // secret-free now, but a half-written configuration is still a bad thing to
    // hand a container.
    const outPath = path.resolve(writeEnvPath);
    const tmpPath = `${outPath}.tmp-${process.pid}`;
    try {
      writeFileSync(tmpPath, text, { mode: 0o600 });
      chmodSync(tmpPath, 0o600);
      renameSync(tmpPath, outPath);
    } catch (err) {
      try {
        rmSync(tmpPath, { force: true });
      } catch {
        // Best effort.
      }
      throw err;
    }
    wrote = true;
    log(
      `[gen-graphiti-env] wrote the NON-SECRET wiring to ${outPath} ` +
        `(${Object.keys(env).length} vars, 0600). It carries no credential and nothing ` +
        "reads it — it is for your eyes.",
    );
  }

  // THE GUARD, on the exec rather than on a file.
  //
  //   could not ask + NOTHING to offer  → leave the running container alone.
  //   could not ask + a FALLBACK key    → apply it, and say that it is one.
  //   the answer is no                  → reaches the container.
  //
  // A refused key (a control character) is "nothing to offer" whatever else
  // resolved: the value it degraded to is the keyless shape, and pushing that
  // over a container that may be running a good key is exactly the clobber this
  // guard exists to prevent.
  const couldNotAsk = resolved.storedReadFailed === true || rejected !== null;
  const holdBack = couldNotAsk && (!hasKey || rejected !== null);

  let ran = false;
  let status = 0;
  if (command && command.length > 0) {
    if (holdBack) {
      warn(
        "[gen-graphiti-env] NOT recreating the knowledge-graph indexer this run — " +
          `the stored provider configuration could not be read (${resolved.reason}), and ` +
          "there is no key to put in its place. Whatever the container is already running " +
          "with is left untouched: recreating it now would start it keyless and silently " +
          "turn extraction off on a working install. Re-run `npm run kg:refresh` once the " +
          "database is up.",
      );
    } else {
      if (couldNotAsk) {
        warn(
          "[gen-graphiti-env] using the ENVIRONMENT fallback: the stored provider " +
            `configuration could not be read this run (${resolved.reason}). That is the ` +
            "first-bring-up case the fallback exists for, so the indexer is being " +
            "recreated with it. If this install was already running on a stored key, it " +
            "has just been moved onto the environment one — re-run `npm run kg:refresh` " +
            "once the database is up.",
        );
      }
      assertRunnableCommand(command);
      const [bin, ...args] = command;
      status = run(bin, args, composeChildEnv(env, baseEnv));
      ran = true;
    }
  }

  if (hasKey) {
    log(
      `[gen-graphiti-env] knowledge-graph provider key CONFIGURED — ${resolved.reason} ` +
        `(provider: ${resolved.provider ?? "openai"}; ${Object.keys(env).length} vars; ` +
        `embedder: ${embedder}). ` +
        (ran
          ? "It was handed to the compose command in its process environment; no file holds it."
          : "Nothing was written: run `npm run kg:refresh` to hand it to the indexer container."),
    );
    return {
      state: "configured",
      embedder,
      keyCount: Object.keys(env).length,
      ran,
      status,
      wrote,
      swept,
      sweptKeyBearing,
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
  return {
    state: "absent",
    embedder,
    keyCount: 0,
    ran,
    status,
    wrote,
    swept,
    sweptKeyBearing,
  };
}

/**
 * Split argv into this script's own flags and the command after a bare `--`.
 * Pure, so the contract is testable without running anything.
 *
 * @param {string[]} argv  arguments AFTER the script path
 */
export function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const own = separator === -1 ? argv : argv.slice(0, separator);
  const command = separator === -1 ? [] : argv.slice(separator + 1);
  let writeEnvPath = null;
  for (let i = 0; i < own.length; i += 1) {
    if (own[i] === "--write-env") {
      writeEnvPath = own[i + 1] ?? null;
      if (!writeEnvPath) {
        throw new Error("[gen-graphiti-env] --write-env needs a path.");
      }
      i += 1;
      continue;
    }
    throw new Error(
      `[gen-graphiti-env] unknown option ${own[i]}. Usage: ` +
        "gen-graphiti-env.mjs [--write-env <path>] [-- <command> [args…]]",
    );
  }
  return { writeEnvPath, command };
}

// Only run main when invoked directly (not when imported by tests).
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { writeEnvPath, command } = parseArgs(process.argv.slice(2));
  const result = await generateGraphitiEnv({ writeEnvPath, command });
  // The child's status is this script's status: it stands in for `docker
  // compose` in an `&&` chain, so a failed bring-up must stop that chain.
  process.exit(result.status);
}
