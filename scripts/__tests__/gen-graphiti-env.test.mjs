/**
 * cinatra#2582 — the key the app has actually reaches the indexer's container,
 * and NEVER a disk.
 *
 * THE FIRST DEFECT. The compose service used to receive
 * `LLM__PROVIDERS__OPENAI__API_KEY: ${OPENAI_API_KEY:-}`, which interpolates
 * from the SHELL env. The app's OpenAI key lives in the app database, so that
 * resolved to the empty string on every normal install: the indexer logged "No
 * LLM client configured", and because extraction runs BEFORE the graph write,
 * every episode was accepted and dropped. Nothing said so.
 *
 * THE SECOND DEFECT, which the first fix created. The generator resolved the
 * key and WROTE IT IN CLEAR to `docker/graphiti/.graphiti.env` for `env_file:`
 * to read. A decrypted credential then lived in the checkout with a lifetime
 * nobody managed: it survived `docker compose down`, `make clean`, a branch
 * switch and a lane teardown, and being gitignored it was invisible to every
 * gate. These tests are what stop that road being taken again.
 *
 * So the assertion that matters has MOVED, not weakened. It used to be "the
 * resolved key lands in the file the container reads". It is now BOTH halves of
 * a stronger claim: the key lands in the ENVIRONMENT of the compose command
 * that creates the container, AND no file anywhere carries it. Nothing about
 * the writer or the exec decision is mocked — the real code runs, against a
 * temp directory and an injected runner that records what it was handed.
 *
 * Also pinned: a keyless run WARNS instead of silently handing over "", a run
 * that cannot ASK does not recreate a container that may be running on a good
 * key (the cold-bring-up case, moved from the file to the container), the
 * generator refuses to write anything key-shaped or anything at all under
 * `docker/`, and it deletes a pre-existing plaintext file and says that it did.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  symlinkSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  GRAPHITI_ALL_KEY_NAMES,
  GRAPHITI_ANTHROPIC_KEY_NAME,
  GRAPHITI_GENERATED_NAMES,
  GRAPHITI_KEY_NAMES,
  GRAPHITI_NO_LLM_SENTINEL,
  HOSTED_EMBEDDER_API_URL,
  HOSTED_EMBEDDER_DIMENSIONS,
  HOSTED_EMBEDDER_MODEL,
  LOCAL_EMBEDDER_API_URL,
  LOCAL_EMBEDDER_DIMENSIONS,
  LOCAL_EMBEDDER_MODEL,
  LOCAL_EMBEDDER_PLACEHOLDER_KEY,
  assertNoKeyShapedValue,
  assertNoMaterializedKey,
  assertRunnableCommand,
  assertWritablePath,
  composeSubcommand,
  buildGraphitiEnv,
  carriesMaterializedKey,
  composeChildEnv,
  parseArgs,
  parseDotenv,
  serializeDotenv,
  sweepLegacyEnvFiles,
  generateGraphitiEnv,
} from "../gen-graphiti-env.mjs";
import { containsKeyShapedValue } from "../lib/key-shaped-values.mjs";

/** The checkout root, for the tests that read the real tree. */
const CHECKOUT_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

// Obviously fake, and shaped like nothing real.
const FAKE_KEY = "sk-fake-not-a-real-key-2582";
// Obviously fake, and shaped like nothing real. Distinct from FAKE_KEY so a test
// can prove the Anthropic credential never lands on an OpenAI-shaped variable.
const FAKE_ANTHROPIC_KEY = "sk-ant-fake-not-a-real-key-2591";

let dir;
/** The sweep target: a stand-in for docker/graphiti/, inside the temp tree. */
let sweepDir;
/** A path OUTSIDE any docker/ directory, for the opt-in template writer. */
let templatePath;
const logs = [];
const warns = [];

/** Records every exec the generator asks for, WITHOUT running one. What it was
 *  handed is the whole assertion, so this captures the argv and the env. */
let runs;
const recordRun = (command, args, env) => {
  runs.push({ command, args, env });
  return 0;
};

const sink = {
  log: (msg) => logs.push(String(msg)),
  warn: (msg) => warns.push(String(msg)),
};

/** The generator, driven with the temp fixture wired in. */
const generate = (options) =>
  generateGraphitiEnv({ sweepDir, run: recordRun, baseEnv: {}, ...sink, ...options });

/** Every value the last recorded exec put in the child environment. */
const lastEnv = () => runs.at(-1)?.env ?? {};

/** Every file under the temp tree, as `path -> contents`. The "no file carries
 *  the key" assertion is over the WHOLE tree, not a path we remembered to look
 *  at: a writer that moved its output would otherwise pass. */
function treeContents(root = dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out[path.relative(root, full)] = readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "graphiti-env-"));
  sweepDir = path.join(dir, "graphiti");
  templatePath = path.join(dir, "inspect", ".graphiti.env");
  mkdirSync(sweepDir, { recursive: true });
  logs.length = 0;
  warns.length = 0;
  runs = [];
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildGraphitiEnv (pure)", () => {
  it("carries ONE resolved key under all three names the image reads", () => {
    const { env, hasKey, embedder } = buildGraphitiEnv(FAKE_KEY);
    expect(hasKey).toBe(true);
    for (const name of GRAPHITI_KEY_NAMES) expect(env[name]).toBe(FAKE_KEY);
    // cinatra#2591 deliverable 3: "configured provider embeddings WHERE
    // AVAILABLE, local Sentence-Transformers as the default FLOOR". OpenAI
    // publishes an embeddings API, so a keyed OpenAI install embeds on its own
    // key — no second vendor, and the local service is not involved.
    //
    // THE ENDPOINT MUST BE RESTATED. config.yaml defaults the embedder base URL
    // to the no-egress local address (`http://kg-embedder:8080/v1`) so an
    // un-generated bring-up cannot reach a vendor — the same trap the LLM half
    // undoes one line above. Leaving it defaulted here would ask for
    // text-embedding-3-small at 1536 wide and be SERVED bge-small-en-v1.5 at 384
    // by the local service, which ignores the requested model name. graphiti
    // declares the width up front, so that mismatch is compared silently wrongly
    // rather than refused loudly. This assertion is the only thing standing
    // between the declaration and the service.
    expect(embedder).toBe("openai");
    expect(env.EMBEDDER__PROVIDER).toBe("openai");
    expect(env.EMBEDDER__PROVIDERS__OPENAI__API_URL).toBe(HOSTED_EMBEDDER_API_URL);
    expect(env.EMBEDDER__PROVIDERS__OPENAI__API_URL).not.toBe(LOCAL_EMBEDDER_API_URL);
    expect(env.EMBEDDER__MODEL).toBe(HOSTED_EMBEDDER_MODEL);
    expect(env.EMBEDDER__DIMENSIONS).toBe(HOSTED_EMBEDDER_DIMENSIONS);
    // The ONLY values in the file are the resolved key plus non-secret
    // selection metadata — never a second credential.
    const secretish = Object.entries(env).filter(([, v]) => v === FAKE_KEY).map(([k]) => k);
    expect(secretish.sort()).toEqual([...GRAPHITI_KEY_NAMES].sort());
  });

  // cinatra#2591 — THE WIDTH INVARIANT, asserted across EVERY arm at once.
  //
  // The keyed-OpenAI defect this pins was a declaration and an endpoint that
  // disagreed: 1536 declared, a 384-wide local service serving it. A per-arm
  // assertion catches that arm; this one catches the NEXT arm too, because the
  // rule is not "the keyed branch is right", it is "the width you declare must
  // be the width the endpoint you name actually serves".
  it("declares the width the endpoint it names actually serves — every arm", () => {
    const arms = [
      { label: "keyless", built: buildGraphitiEnv("") },
      { label: "keyed-openai", built: buildGraphitiEnv(FAKE_KEY) },
      { label: "keyed-anthropic", built: buildGraphitiEnv(FAKE_ANTHROPIC_KEY, "anthropic") },
    ];
    // The two endpoints this product can name, and the width each one serves.
    // LOCAL is baked into docker/kg-embedder; HOSTED is OpenAI's published width
    // for the model named alongside it.
    const servedWidth = {
      [LOCAL_EMBEDDER_API_URL]: { dimensions: LOCAL_EMBEDDER_DIMENSIONS, model: LOCAL_EMBEDDER_MODEL },
      [HOSTED_EMBEDDER_API_URL]: { dimensions: HOSTED_EMBEDDER_DIMENSIONS, model: HOSTED_EMBEDDER_MODEL },
    };

    for (const { label, built } of arms) {
      const url = built.env.EMBEDDER__PROVIDERS__OPENAI__API_URL;
      // Never left to the config.yaml default: that default is the no-egress
      // local address, so an arm that omits the URL silently inherits the local
      // service whatever it declares.
      expect(url, `${label}: names no embedder endpoint`).toBeTruthy();
      const served = servedWidth[url];
      expect(served, `${label}: names an endpoint of unknown width (${url})`).toBeTruthy();
      expect(built.env.EMBEDDER__DIMENSIONS, `${label}: declared width`).toBe(served.dimensions);
      expect(built.env.EMBEDDER__MODEL, `${label}: declared model`).toBe(served.model);
      // And the `embedder` label the caller LOGS must agree with the wire.
      expect(built.embedder, `${label}: reported embedder`).toBe(
        url === LOCAL_EMBEDDER_API_URL ? "local" : "openai",
      );
    }
  });

  // cinatra#2591 deliverable 2 — MULTI-PROVIDER EXTRACTION.
  it("runs extraction on ANTHROPIC and ranks on the LOCAL floor", () => {
    const { env, hasKey, embedder } = buildGraphitiEnv(FAKE_ANTHROPIC_KEY, "anthropic");
    expect(hasKey).toBe(true);
    expect(env.LLM__PROVIDER).toBe("anthropic");
    expect(env[GRAPHITI_ANTHROPIC_KEY_NAME]).toBe(FAKE_ANTHROPIC_KEY);

    // Anthropic publishes NO embeddings API, so an Anthropic install MUST rank
    // on the local floor — that is the whole reason the floor exists. If this
    // ever reads "openai" with a hosted URL, the install needs a second vendor
    // and the deliverable is broken.
    expect(embedder).toBe("local");
    expect(env.EMBEDDER__PROVIDERS__OPENAI__API_URL).toBe(LOCAL_EMBEDDER_API_URL);
    expect(env.EMBEDDER__DIMENSIONS).toBe(LOCAL_EMBEDDER_DIMENSIONS);
  });

  it("never writes the Anthropic key onto an OpenAI-shaped variable", () => {
    const { env } = buildGraphitiEnv(FAKE_ANTHROPIC_KEY, "anthropic");
    // graphiti_core reads the bare OPENAI_API_KEY at init and the embedder's
    // OpenAI-shaped client reads the other two. On this arm they all address the
    // LOCAL floor, so the Anthropic credential must appear on EXACTLY one
    // variable — anything else would put it on a wire it has no business on.
    for (const name of GRAPHITI_KEY_NAMES) {
      expect(env[name]).not.toBe(FAKE_ANTHROPIC_KEY);
    }
    expect(env.OPENAI_API_KEY).toBe(LOCAL_EMBEDDER_PLACEHOLDER_KEY);
    const carrying = Object.entries(env)
      .filter(([, v]) => v === FAKE_ANTHROPIC_KEY)
      .map(([k]) => k);
    expect(carrying).toEqual([GRAPHITI_ANTHROPIC_KEY_NAME]);
  });

  it("keeps an Anthropic file readable as KEYED by the cold-start guard", () => {
    // The clobber guard scans for a materialized credential. An Anthropic file
    // carries none of the three OpenAI names, so a guard that scanned only those
    // would call it keyless and rewrite a real key away on a cold bring-up.
    //
    // Written out by hand rather than round-tripped through buildGraphitiEnv, so
    // this asserts the GUARD and not the writer: the file below is what an
    // Anthropic install materializes, and the pre-#2591 guard reads it as empty.
    const anthropicFile = [
      `${GRAPHITI_ANTHROPIC_KEY_NAME}=${FAKE_ANTHROPIC_KEY}`,
      `OPENAI_API_KEY=${LOCAL_EMBEDDER_PLACEHOLDER_KEY}`,
      `EMBEDDER__PROVIDERS__OPENAI__API_KEY=${LOCAL_EMBEDDER_PLACEHOLDER_KEY}`,
    ].join("\n");
    expect(carriesMaterializedKey(anthropicFile)).toBe(true);
  });

  it("writes NO credential for a blank key — and still boots the indexer", () => {
    // Never an empty VALUE: `KEY=` is exactly the silent behaviour this
    // generator exists to end, and it is what the old compose interpolation did.
    //
    // But "no key" can no longer mean "no file content" (cinatra#2591). Measured
    // against the replacement server: `llm.provider = openai` with a null key
    // makes CrossEncoderFactory construct AsyncOpenAI(api_key=None), which
    // raises and takes the whole server down at startup. A keyless install must
    // not have a crash-looping indexer, so the file carries a NAMED SENTINEL for
    // the LLM key and points the embedder at the local floor.
    for (const blank of [null, undefined, "", "   "]) {
      const { env, hasKey, embedder } = buildGraphitiEnv(blank);
      expect(hasKey).toBe(false);
      expect(embedder).toBe("local");
      // No real credential, and no empty value either.
      expect(env.LLM__PROVIDERS__OPENAI__API_KEY).toBe(GRAPHITI_NO_LLM_SENTINEL);
      expect(env.OPENAI_API_KEY).toBeUndefined();
      expect(Object.values(env).every((v) => typeof v === "string" && v.trim() !== "")).toBe(true);
      // The embedder is the LOCAL service, with the width its baked model emits.
      expect(env.EMBEDDER__PROVIDERS__OPENAI__API_URL).toBe(LOCAL_EMBEDDER_API_URL);
      expect(env.EMBEDDER__PROVIDERS__OPENAI__API_KEY).toBe(LOCAL_EMBEDDER_PLACEHOLDER_KEY);
      expect(env.EMBEDDER__DIMENSIONS).toBe(LOCAL_EMBEDDER_DIMENSIONS);
    }
  });

  it("does not let the sentinel or the local placeholder read as a materialized key", () => {
    // The cold-start guard asks "is a key already materialized?" to decide
    // preserve-vs-rewrite. If either non-credential answered yes, a keyless file
    // would be preserved forever and a key the operator later configured would
    // never reach the container.
    expect(carriesMaterializedKey(serializeDotenv(buildGraphitiEnv(null).env))).toBe(false);
    expect(carriesMaterializedKey(serializeDotenv(buildGraphitiEnv(FAKE_KEY).env))).toBe(true);
  });

  it("trims surrounding whitespace so a stray newline cannot break auth", () => {
    expect(buildGraphitiEnv(` ${FAKE_KEY}\n`).env.OPENAI_API_KEY).toBe(FAKE_KEY);
  });

  it("REFUSES a key with an embedded control character rather than writing it", () => {
    // dotenv is line-oriented: an embedded newline truncates the credential or
    // injects an extra container variable. Refusing degrades to the honest
    // keyless state instead of writing half a key.
    for (const hostile of [
      `sk-fake\nINJECTED=1`,
      `sk-fake\rmore`,
      `sk-fake\u0007tail`,
    ]) {
      const built = buildGraphitiEnv(hostile);
      expect(built.hasKey).toBe(false);
      expect(built.rejected).toBe("control-character");
      // Degrades to the SAME keyless shape as "no key at all": the boot sentinel
      // and the local embedder, and no fragment of the hostile value anywhere.
      expect(built.env.LLM__PROVIDERS__OPENAI__API_KEY).toBe(GRAPHITI_NO_LLM_SENTINEL);
      expect(Object.values(built.env).join("\n")).not.toContain("INJECTED");
      expect(Object.values(built.env).join("\n")).not.toContain("sk-fake");
    }
  });

  it("round-trips through the dotenv serializer the compose parser reads", () => {
    const { env } = buildGraphitiEnv(FAKE_KEY);
    expect(parseDotenv(serializeDotenv(env))).toMatchObject(env);
  });

  it("never emits an EMPTY value on any line, keyed or keyless", () => {
    // The invariant that actually matters: `KEY=` (empty) is what silently
    // disabled extraction. Every line the generator writes has a value.
    for (const built of [buildGraphitiEnv(null), buildGraphitiEnv(FAKE_KEY)]) {
      expect(serializeDotenv(built.env)).not.toMatch(/^[A-Z0-9_]+=\s*$/m);
    }
  });
});

describe("the generated names are the whole set", () => {
  // GRAPHITI_GENERATED_NAMES is what docker-compose.yml declares and what the
  // child environment SCRUBS before setting its own. A variable added to an arm
  // and not to this list would be declared nowhere and scrubbed from nothing —
  // it would silently keep whatever the invoking shell happened to export.
  it("is exactly the union of every arm's variables", () => {
    const union = new Set([
      ...Object.keys(buildGraphitiEnv("").env),
      ...Object.keys(buildGraphitiEnv(FAKE_KEY).env),
      ...Object.keys(buildGraphitiEnv(FAKE_ANTHROPIC_KEY, "anthropic").env),
    ]);
    expect([...GRAPHITI_GENERATED_NAMES].sort()).toEqual([...union].sort());
  });

  it("covers every variable that can carry a credential", () => {
    for (const name of GRAPHITI_ALL_KEY_NAMES) {
      expect(GRAPHITI_GENERATED_NAMES, name).toContain(name);
    }
  });
});

describe("the child environment handed to compose", () => {
  it("carries the resolved key under all three names the image reads", () => {
    const { env } = buildGraphitiEnv(FAKE_KEY);
    const child = composeChildEnv(env, { PATH: "/usr/bin" });
    for (const name of GRAPHITI_KEY_NAMES) expect(child[name]).toBe(FAKE_KEY);
    // The rest of the invoking environment travels through untouched: this is
    // the environment `docker compose` itself runs in, and it needs PATH,
    // COMPOSE_PROJECT_NAME and the port plan the shared scoping step exported.
    expect(child.PATH).toBe("/usr/bin");
  });

  it("SCRUBS an inherited value the arm does not set", () => {
    // `npm run services` does `set -a && source .env.local`, so a stray
    // OPENAI_API_KEY in that file is in this process's environment. The keyless
    // arm emits none — and must not let the inherited one through, because the
    // app's own resolver already declined to use it (a binding to another
    // vendor, an unreadable key). Merging would hand the container a credential
    // no one chose.
    const { env } = buildGraphitiEnv(null);
    expect(env.OPENAI_API_KEY).toBeUndefined();
    const child = composeChildEnv(env, { OPENAI_API_KEY: "sk-fake-inherited-2582", PATH: "/x" });
    expect(child.OPENAI_API_KEY).toBeUndefined();
    expect(child.PATH).toBe("/x");
  });

  it("SCRUBS an inherited value on every generated name", () => {
    const inherited = Object.fromEntries(
      GRAPHITI_GENERATED_NAMES.map((name) => [name, `inherited-${name}`]),
    );
    const child = composeChildEnv(buildGraphitiEnv(null).env, inherited);
    for (const name of GRAPHITI_GENERATED_NAMES) {
      expect(String(child[name] ?? ""), name).not.toContain("inherited-");
    }
  });
});

describe("the materialization seam", () => {
  it("hands the resolved key to the compose command and writes NO file", async () => {
    const result = await generate({
      command: ["docker", "compose", "up", "-d", "graphiti"],
      resolveKey: async () => ({
        key: FAKE_KEY,
        reason: "resolved from the app's stored OpenAI provider configuration",
      }),
    });

    expect(result).toMatchObject({ state: "configured", ran: true, wrote: false, status: 0 });
    // The key reached the container's environment, under every name the image
    // reads — the claim the old file-write test made, now made about the road
    // the container actually gets its configuration from.
    expect(runs).toHaveLength(1);
    expect(runs[0].command).toBe("docker");
    expect(runs[0].args).toEqual(["compose", "up", "-d", "graphiti"]);
    for (const name of GRAPHITI_KEY_NAMES) expect(lastEnv()[name]).toBe(FAKE_KEY);
    // …and NOTHING on disk carries it. Asserted over the whole temp tree.
    expect(treeContents()).toEqual({});
    expect(logs.join("\n")).toContain("knowledge-graph provider key CONFIGURED");
  });

  it("never puts the key in an ARGV", async () => {
    // An argv is world-readable in `ps` for the life of the process; an
    // environment is not. `-e NAME` (not `-e NAME=value`) is the same rule the
    // works-after proof tier follows.
    await generate({
      command: ["docker", "compose", "up", "-d", "graphiti"],
      resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
    });
    expect(JSON.stringify(runs[0].args)).not.toContain(FAKE_KEY);
    expect(runs[0].command).not.toContain(FAKE_KEY);
  });

  it("never writes the key into a log line", async () => {
    await generate({
      command: ["docker", "compose", "up"],
      resolveKey: async () => ({ key: FAKE_KEY, reason: "resolved from the stored config" }),
    });
    expect([...logs, ...warns].join("\n")).not.toContain(FAKE_KEY);
  });

  it("propagates the compose command's exit status", async () => {
    // This script stands in for `docker compose` inside an `&&` chain, so a
    // failed bring-up has to stop that chain rather than reporting success.
    const result = await generate({
      command: ["docker", "compose", "up"],
      run: () => 17,
      resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
    });
    expect(result.status).toBe(17);
  });

  it("WARNS an honest keyless state instead of handing over empty values", async () => {
    const result = await generate({
      command: ["docker", "compose", "up", "-d", "graphiti"],
      resolveKey: async () => ({
        key: null,
        reason: "no OpenAI provider key is configured in the app and OPENAI_API_KEY is unset",
      }),
    });

    expect(result).toMatchObject({ state: "absent", embedder: "local", ran: true });
    // No credential reached the container: the bare OPENAI_API_KEY that
    // graphiti_core reads is absent, and the LLM slot holds the named sentinel.
    expect(lastEnv().OPENAI_API_KEY).toBeUndefined();
    expect(lastEnv().LLM__PROVIDERS__OPENAI__API_KEY).toBe(GRAPHITI_NO_LLM_SENTINEL);

    const warning = warns.join("\n");
    expect(warning).toContain("EXTRACTION is OFF");
    // Says what actually happens, so an operator is not left guessing why the
    // graph has no entities — INCLUDING what still works, which since
    // cinatra#2591 is recall over their own rows on the local embedder.
    expect(warning).toContain("dropped");
    expect(warning).toContain("deterministic anchor nodes");
    expect(warning).toContain("LOCAL embedder");
  });

  it("does NOT recreate the container when it could not ASK", async () => {
    // The cold-bring-up case, moved from the file to the container: the stored
    // key is unreadable on this pass, and the container may well be running on
    // a good one. Recreating it here would silently turn indexing off on a
    // working install, so nothing is recreated and the reason is said out loud.
    const result = await generate({
      command: ["docker", "compose", "up", "-d", "graphiti"],
      resolveKey: async () => ({
        key: null,
        reason: "the app's provider-key resolver was not reachable (Error)",
        storedReadFailed: true,
      }),
    });

    expect(result.ran).toBe(false);
    expect(runs).toEqual([]);
    expect(warns.join("\n")).toContain("NOT recreating");
  });

  it("applies the environment FALLBACK during an outage, and SAYS it is one", async () => {
    // The database is unreachable but OPENAI_API_KEY is set. That is the
    // first-bring-up signature the legacy fallback exists to serve — there is no
    // database yet — and holding back would leave every fresh install with an
    // env key running a keyless indexer.
    //
    // In the file era this case PRESERVED, to avoid writing a possibly stale key
    // over a known-good stored one. Nothing persists now: the swap is bounded by
    // the one command the operator asked for, and the next successful run
    // replaces it. So the verdict changes and the run SAYS what it did, which is
    // what makes it safe to change.
    const result = await generate({
      command: ["docker", "compose", "up", "-d", "graphiti"],
      resolveKey: async () => ({
        key: "sk-fake-stale-env-2582",
        source: "environment",
        reason: "resolved from OPENAI_API_KEY in the environment (legacy path)",
        storedReadFailed: true,
      }),
    });

    expect(result.ran).toBe(true);
    expect(lastEnv().OPENAI_API_KEY).toBe("sk-fake-stale-env-2582");
    const warning = warns.join("\n");
    expect(warning).toContain("ENVIRONMENT fallback");
    expect(warning).toContain("could not be read");
    expect(warning).not.toContain("sk-fake-stale-env-2582");
  });

  it("holds back when it could not ask AND has nothing to offer", async () => {
    // The other half of the same rule, kept whole: with no key to put in its
    // place, recreating would start the container keyless and turn extraction
    // off on an install that may be running perfectly well.
    const result = await generate({
      command: ["docker", "compose", "up", "-d", "graphiti"],
      resolveKey: async () => ({
        key: null,
        reason: "the app's provider-key resolver was not reachable (Error)",
        storedReadFailed: true,
      }),
    });
    expect(result.ran).toBe(false);
    expect(warns.join("\n")).toContain("no key to put in its place");
  });

  it("DOES use the fallback when the configuration read fine and held no key", async () => {
    const result = await generate({
      command: ["docker", "compose", "up", "-d", "graphiti"],
      resolveKey: async () => ({
        key: "sk-fake-env-2582",
        source: "environment",
        reason: "resolved from OPENAI_API_KEY in the environment (legacy path)",
        storedReadFailed: false,
      }),
    });

    expect(result.ran).toBe(true);
    expect(lastEnv().OPENAI_API_KEY).toBe("sk-fake-env-2582");
  });

  it("DOES clear the key from the container when the operator removed it", async () => {
    // "Read fine, and there is no key" is a disconnect or a rotation, not a
    // cold start. Not recreating there would leave a revoked credential running
    // in the indexer container forever.
    const result = await generate({
      command: ["docker", "compose", "up", "-d", "graphiti"],
      resolveKey: async () => ({
        key: null,
        reason: "no OpenAI provider key is configured in the app and OPENAI_API_KEY is unset",
        storedReadFailed: false,
      }),
    });

    expect(result).toMatchObject({ state: "absent", ran: true });
    expect(lastEnv().OPENAI_API_KEY).toBeUndefined();
    expect(lastEnv().LLM__PROVIDERS__OPENAI__API_KEY).toBe(GRAPHITI_NO_LLM_SENTINEL);
  });

  it("hands over a ROTATED key rather than a stale one", async () => {
    await generate({
      command: ["docker", "compose", "up"],
      resolveKey: async () => ({ key: "sk-fake-old-2582", reason: "stored config" }),
    });
    await generate({
      command: ["docker", "compose", "up"],
      resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
    });
    expect(lastEnv().OPENAI_API_KEY).toBe(FAKE_KEY);
  });

  it("refuses a control-character key WITHOUT recreating the container", async () => {
    const result = await generate({
      command: ["docker", "compose", "up", "-d", "graphiti"],
      resolveKey: async () => ({
        key: "sk-fake\nINJECTED=1",
        reason: "stored config",
        storedReadFailed: false,
      }),
    });

    expect(result.ran).toBe(false);
    expect(runs).toEqual([]);
    const warning = warns.join("\n");
    expect(warning).toContain("REFUSED");
    expect(warning).not.toContain("INJECTED");
  });

  it("runs nothing at all when no command was given", async () => {
    const result = await generate({
      resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
    });
    expect(result).toMatchObject({ state: "configured", ran: false, wrote: false });
    expect(runs).toEqual([]);
    expect(treeContents()).toEqual({});
  });
});

describe("nothing key-shaped is ever written", () => {
  it("REFUSES to write a template that carries a key", async () => {
    // The opt-in `--write-env` road exists for inspection, and it can only ever
    // produce a secret-free file: a keyed arm serializes the credential, so the
    // content guard refuses the write outright rather than trimming it.
    await expect(
      generate({
        writeEnvPath: templatePath,
        resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
      }),
    ).rejects.toThrow(/REFUSED to write/);
    expect(existsSync(templatePath)).toBe(false);
  });

  it("DOES write the keyless wiring, which carries no credential", async () => {
    const result = await generate({
      writeEnvPath: templatePath,
      resolveKey: async () => ({ key: null, reason: "no key" }),
    });
    expect(result.wrote).toBe(true);
    const written = parseDotenv(readFileSync(templatePath, "utf8"));
    expect(written.LLM__PROVIDERS__OPENAI__API_KEY).toBe(GRAPHITI_NO_LLM_SENTINEL);
    expect(carriesMaterializedKey(readFileSync(templatePath, "utf8"))).toBe(false);
    // Owner-only even so: it describes an install.
    expect(statSync(templatePath).mode & 0o777).toBe(0o600);
  });

  it("REFUSES any path under docker/, secret-free content included", () => {
    // Structural, and stricter than the content check on purpose: docker/ is
    // read by compose and outlives every container, branch and checkout.
    expect(() => assertWritablePath("docker/graphiti/.graphiti.env")).toThrow(/REFUSED to write/);
    expect(() => assertWritablePath("docker/anything.env")).toThrow(/REFUSED to write/);
    expect(() => assertWritablePath(path.join(tmpdir(), "somewhere.env"))).not.toThrow();
  });

  it("REFUSES an OPAQUE credential that matches no known key shape", async () => {
    // The shapes cannot see every credential: an Azure-hosted deployment, a
    // gateway or a self-hosted vendor issues values with no `sk-` prefix at all.
    // A template judged only by shape would write such a value out in clear and
    // call itself secret-free, so the variable SEMANTICS decide as well.
    const OPAQUE = "kg-converge-opaque-provider-value";
    expect(containsKeyShapedValue(OPAQUE)).toBe(false);
    await expect(
      generate({
        writeEnvPath: templatePath,
        resolveKey: async () => ({ key: OPAQUE, reason: "stored config" }),
      }),
    ).rejects.toThrow(/REFUSED to write/);
    expect(existsSync(templatePath)).toBe(false);
    // …and the refusal names the variable, never the value.
    let message = "";
    try {
      assertNoMaterializedKey(`OPENAI_API_KEY=${OPAQUE}\n`, "the template");
    } catch (err) {
      message = String(err.message);
    }
    expect(message).toContain("OPENAI_API_KEY");
    expect(message).not.toContain(OPAQUE);
  });

  it("REFUSES a path that lands under docker/ through a SYMLINKED parent", () => {
    // The guard is physical, not lexical: `path.resolve` alone reads a
    // symlinked parent as the path the caller typed, which would let a write
    // land in the subtree the gate owns while passing the check.
    const link = path.join(dir, "looks-innocent");
    symlinkSync(path.join(CHECKOUT_ROOT, "docker", "graphiti"), link, "dir");
    expect(() => assertWritablePath(path.join(link, ".graphiti.env"))).toThrow(/REFUSED to write/);
  });

  it("names the SHAPE and the LINE it refused, never the value", () => {
    let message = "";
    try {
      assertNoKeyShapedValue(`# header\nOPENAI_API_KEY=${FAKE_KEY}\n`, "the template");
    } catch (err) {
      message = String(err.message);
    }
    expect(message).toContain("line 2");
    expect(message).toContain("openai-api-key");
    expect(message).not.toContain(FAKE_KEY);
  });
});

describe("the key is never handed to a child that would print it", () => {
  it("REFUSES `docker compose config`, which renders every resolved value", async () => {
    // The seam takes any command on purpose — this script stands in for compose
    // in an `&&` chain. But `config` PRINTS the resolved environment, so running
    // it here would put the credential on a terminal and into a CI log.
    await expect(
      generate({
        command: ["docker", "compose", "-f", "docker-compose.yml", "config"],
        resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
      }),
    ).rejects.toThrow(/REFUSED to run/);
    expect(runs).toEqual([]);
  });

  it("still runs the bring-up it exists for", async () => {
    const result = await generate({
      command: ["docker", "compose", "-f", "docker-compose.yml", "up", "-d", "graphiti"],
      resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
    });
    expect(result.ran).toBe(true);
    expect(lastEnv().OPENAI_API_KEY).toBe(FAKE_KEY);
  });

  it("reads the subcommand past the flags that take a value", () => {
    // `-f config` must not read as the `config` subcommand, and a non-compose
    // command has no subcommand to judge at all.
    expect(composeSubcommand(["docker", "compose", "-f", "config", "up"])).toBe("up");
    expect(composeSubcommand(["docker", "compose", "--profile", "config", "up", "-d"])).toBe("up");
    expect(composeSubcommand(["docker-compose", "config"])).toBe("config");
    expect(composeSubcommand(["printenv", "OPENAI_API_KEY"])).toBe(null);
    expect(() => assertRunnableCommand(["printenv", "config"])).not.toThrow();
    expect(() => assertRunnableCommand(["docker", "compose", "convert"])).toThrow(/REFUSED to run/);
  });
});

describe("the old plaintext file is swept away", () => {
  const legacyPath = () => path.join(sweepDir, ".graphiti.env");

  it("DELETES a pre-existing file that carries a key, and says so LOUDLY", async () => {
    writeFileSync(
      legacyPath(),
      GRAPHITI_KEY_NAMES.map((name) => `${name}=${FAKE_KEY}`).join("\n"),
      { mode: 0o600 },
    );

    const result = await generate({
      resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
    });

    expect(existsSync(legacyPath())).toBe(false);
    expect(result.sweptKeyBearing).toEqual([legacyPath()]);
    const warning = warns.join("\n");
    expect(warning).toContain("REMOVED");
    expect(warning).toContain("in CLEAR");
    // The operator is told what to DO about it — the file is gone, the key was
    // still at rest on this disk.
    expect(warning).toContain("rotate it");
    expect(warning).not.toContain(FAKE_KEY);
  });

  it("DELETES an Anthropic file too — the credential is on its own variable", async () => {
    writeFileSync(legacyPath(), `${GRAPHITI_ANTHROPIC_KEY_NAME}=${FAKE_ANTHROPIC_KEY}\n`);
    const result = await generate({ resolveKey: async () => ({ key: null, reason: "no key" }) });
    expect(existsSync(legacyPath())).toBe(false);
    expect(result.sweptKeyBearing).toEqual([legacyPath()]);
  });

  it("DELETES a stranded `.tmp-<pid>` sibling of an interrupted write", async () => {
    const stranded = path.join(sweepDir, ".graphiti.env.tmp-424242");
    writeFileSync(stranded, `OPENAI_API_KEY=${FAKE_KEY}\n`);
    const result = await generate({ resolveKey: async () => ({ key: null, reason: "no key" }) });
    expect(existsSync(stranded)).toBe(false);
    expect(result.sweptKeyBearing).toEqual([stranded]);
  });

  it("removes a keyless leftover QUIETLY — there is nothing to act on", async () => {
    writeFileSync(legacyPath(), serializeDotenv(buildGraphitiEnv(null).env));
    const result = await generate({ resolveKey: async () => ({ key: null, reason: "no key" }) });
    expect(existsSync(legacyPath())).toBe(false);
    expect(result.swept).toEqual([legacyPath()]);
    expect(result.sweptKeyBearing).toEqual([]);
    expect(warns.join("\n")).not.toContain("REMOVED");
    expect(logs.join("\n")).toContain("leftover from the old road");
  });

  it("leaves every other file in the directory alone", async () => {
    writeFileSync(path.join(sweepDir, "config.yaml"), "llm:\n  provider: openai\n");
    writeFileSync(path.join(sweepDir, "Dockerfile"), "FROM python:3.13-slim\n");
    await generate({ resolveKey: async () => ({ key: null, reason: "no key" }) });
    expect(readdirSync(sweepDir).sort()).toEqual(["Dockerfile", "config.yaml"]);
  });

  it("is a no-op on a checkout that never took the old road", () => {
    const empty = path.join(dir, "never-generated");
    const result = sweepLegacyEnvFiles({ dir: empty, ...sink });
    expect(result).toEqual({ removed: [], keyBearing: [] });
    expect([...logs, ...warns]).toEqual([]);
  });
});

describe("the command line", () => {
  it("takes everything after a bare `--` as the command", () => {
    expect(parseArgs(["--", "docker", "compose", "up", "-d", "graphiti"])).toEqual({
      writeEnvPath: null,
      command: ["docker", "compose", "up", "-d", "graphiti"],
    });
  });

  it("reports the state and runs nothing when given no command", () => {
    expect(parseArgs([])).toEqual({ writeEnvPath: null, command: [] });
  });

  it("takes --write-env before the separator", () => {
    expect(parseArgs(["--write-env", "/tmp/x.env", "--", "docker", "compose", "up"])).toEqual({
      writeEnvPath: "/tmp/x.env",
      command: ["docker", "compose", "up"],
    });
  });

  it("refuses an unknown option rather than guessing", () => {
    // A typo'd flag that is silently ignored is how a bring-up ends up not
    // doing the thing its author asked for.
    expect(() => parseArgs(["--write-en", "/tmp/x"])).toThrow(/unknown option/);
    expect(() => parseArgs(["--write-env"])).toThrow(/needs a path/);
  });
});

describe("carriesMaterializedKey (pure)", () => {
  it("is true only when the text really carries a key", () => {
    expect(carriesMaterializedKey(serializeDotenv(buildGraphitiEnv(FAKE_KEY).env))).toBe(true);
    expect(carriesMaterializedKey(serializeDotenv(buildGraphitiEnv(null).env))).toBe(false);
    expect(carriesMaterializedKey("OPENAI_API_KEY=\n")).toBe(false);
    expect(carriesMaterializedKey("OPENAI_API_KEY=   \n")).toBe(false);
    expect(carriesMaterializedKey(undefined)).toBe(false);
  });
});

describe("docker-compose.yml declares exactly what the generator hands over", () => {
  // THE TWO HALVES MUST AGREE, and nothing else makes them. A variable the
  // generator sets but the service does not declare is silently dropped by
  // compose and the container never sees it; a variable the service declares
  // but the generator never sets is a name that would quietly take whatever the
  // invoking shell exported. Both failures are invisible at run time — the
  // indexer just behaves as if it were configured differently — so the
  // agreement is asserted here instead of being trusted.
  const REPO_ROOT = path.resolve(fileURLToPath(import.meta.url), "..", "..", "..");

  /** The VALUE-LESS entries of the graphiti service's `environment:` block —
   *  `NAME:` with nothing after it, which is how compose is told to take the
   *  value from its own environment. Read by line rather than with a YAML
   *  parser so this suite stays free of a dependency the gate half cannot use. */
  function declaredPassThroughNames() {
    const text = readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");
    const lines = text.split("\n");
    const start = lines.findIndex((line) => line === "  graphiti:");
    expect(start, "the graphiti service").toBeGreaterThan(-1);
    const names = [];
    let inEnvironment = false;
    for (const line of lines.slice(start + 1)) {
      // A new top-level service ends the block.
      if (/^ {2}\S/.test(line)) break;
      if (/^ {4}environment:\s*$/.test(line)) {
        inEnvironment = true;
        continue;
      }
      // A new service-level key ends the environment block.
      if (inEnvironment && /^ {4}\S/.test(line)) break;
      if (!inEnvironment) continue;
      const match = line.match(/^ {6}([A-Z0-9_]+):\s*$/);
      if (match) names.push(match[1]);
    }
    return names;
  }

  it("declares every generated name, value-less, and no others", () => {
    expect(declaredPassThroughNames().sort()).toEqual([...GRAPHITI_GENERATED_NAMES].sort());
  });

  /** The graphiti service block, from its own key to the next service's. */
  function graphitiServiceBlock() {
    const lines = readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8").split("\n");
    const start = lines.findIndex((line) => line === "  graphiti:");
    expect(start, "the graphiti service").toBeGreaterThan(-1);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => /^ {2}\S/.test(line));
    return (end === -1 ? rest : rest.slice(0, end)).join("\n");
  }

  it("does NOT read an env_file — that road is gone", () => {
    // `env_file:` on this service is the defect: it is what made a decrypted
    // key on disk the way the container got configured. Comment lines are
    // stripped first — the block explains the old road at length, and the
    // assertion is about the WIRING, not the prose describing it.
    const directives = graphitiServiceBlock()
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .join("\n");
    expect(directives).not.toContain("env_file");
    expect(directives).not.toContain(".graphiti.env");
  });

  it("interpolates none of them with an empty default", () => {
    // `${NAME:-}` would set the empty string, which OVERRIDES config.yaml's
    // keyless-safe defaults and crash-loops the server — the same override trap
    // the nango and wayflow services document.
    const text = readFileSync(path.join(REPO_ROOT, "docker-compose.yml"), "utf8");
    for (const name of GRAPHITI_GENERATED_NAMES) {
      expect(text, name).not.toContain(`${name}: \${${name}:-}`);
    }
  });
});
