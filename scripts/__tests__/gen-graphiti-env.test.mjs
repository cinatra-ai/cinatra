/**
 * cinatra#2582 — the key the app has actually reaches the indexer's container.
 *
 * THE DEFECT. The compose service used to receive
 * `LLM__PROVIDERS__OPENAI__API_KEY: ${OPENAI_API_KEY:-}`, which interpolates
 * from the SHELL env. The app's OpenAI key lives in the app database, so that
 * resolved to the empty string on every normal install: the indexer logged "No
 * LLM client configured", and because extraction runs BEFORE the graph write,
 * every episode was accepted and dropped. Nothing said so.
 *
 * These tests drive the REAL writer against a temp directory with an obviously
 * FAKE key. The point of the exercise is the materialization itself — that the
 * resolved key lands in the file the container reads, under all three names it
 * needs — so nothing about the file write is mocked.
 *
 * Also pinned: a keyless run WARNS instead of silently materializing "", and a
 * run that cannot resolve a key does not clobber one an earlier run wrote (the
 * cold-bring-up case, where Postgres is started by the same command).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  GRAPHITI_KEY_NAMES,
  GRAPHITI_NO_LLM_SENTINEL,
  LOCAL_EMBEDDER_API_URL,
  LOCAL_EMBEDDER_DIMENSIONS,
  LOCAL_EMBEDDER_PLACEHOLDER_KEY,
  buildGraphitiEnv,
  parseDotenv,
  serializeDotenv,
  shouldPreserveExisting,
  generateGraphitiEnv,
} from "../gen-graphiti-env.mjs";

// Obviously fake, and shaped like nothing real.
const FAKE_KEY = "sk-fake-not-a-real-key-2582";

let dir;
let outPath;
const logs = [];
const warns = [];

const sink = {
  log: (msg) => logs.push(String(msg)),
  warn: (msg) => warns.push(String(msg)),
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "graphiti-env-"));
  outPath = path.join(dir, "graphiti", ".graphiti.env");
  logs.length = 0;
  warns.length = 0;
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("buildGraphitiEnv (pure)", () => {
  it("carries ONE resolved key under all three names the image reads", () => {
    const { env, hasKey, embedder } = buildGraphitiEnv(FAKE_KEY);
    expect(hasKey).toBe(true);
    for (const name of GRAPHITI_KEY_NAMES) expect(env[name]).toBe(FAKE_KEY);
    // cinatra#2591: a keyed install embeds on the SAME provider key (the
    // configured-provider branch of the embedder floor), so no second vendor and
    // no local service is involved.
    expect(embedder).toBe("openai");
    expect(env.EMBEDDER__PROVIDER).toBe("openai");
    expect(env.EMBEDDER__PROVIDERS__OPENAI__API_URL).toBeUndefined();
    // The ONLY values in the file are the resolved key plus non-secret
    // selection metadata — never a second credential.
    const secretish = Object.entries(env).filter(([, v]) => v === FAKE_KEY).map(([k]) => k);
    expect(secretish.sort()).toEqual([...GRAPHITI_KEY_NAMES].sort());
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
    expect(shouldPreserveExisting(serializeDotenv(buildGraphitiEnv(null).env))).toBe(false);
    expect(shouldPreserveExisting(serializeDotenv(buildGraphitiEnv(FAKE_KEY).env))).toBe(true);
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

describe("the materialization seam", () => {
  it("lands the resolved key in the container env file, 0600", async () => {
    const result = await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({
        key: FAKE_KEY,
        reason: "resolved from the app's stored OpenAI provider configuration",
      }),
      ...sink,
    });

    expect(result).toMatchObject({ state: "configured", wrote: true });
    const written = parseDotenv(readFileSync(outPath, "utf8"));
    for (const name of GRAPHITI_KEY_NAMES) expect(written[name]).toBe(FAKE_KEY);
    // Owner-only: the file is a credential.
    expect(statSync(outPath).mode & 0o777).toBe(0o600);
    expect(logs.join("\n")).toContain("knowledge-graph provider key CONFIGURED");
  });

  it("never writes the key into a log line", async () => {
    await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({ key: FAKE_KEY, reason: "resolved from the stored config" }),
      ...sink,
    });
    expect([...logs, ...warns].join("\n")).not.toContain(FAKE_KEY);
  });

  it("WARNS an honest keyless state instead of materializing empty values", async () => {
    const result = await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({
        key: null,
        reason: "no OpenAI provider key is configured in the app and OPENAI_API_KEY is unset",
      }),
      ...sink,
    });

    expect(result).toMatchObject({ state: "absent", embedder: "local" });
    const written = parseDotenv(readFileSync(outPath, "utf8"));
    // No credential reached the file: the bare OPENAI_API_KEY that graphiti_core
    // reads is absent, and the LLM slot holds the named sentinel.
    expect(written.OPENAI_API_KEY).toBeUndefined();
    expect(written.LLM__PROVIDERS__OPENAI__API_KEY).toBe(GRAPHITI_NO_LLM_SENTINEL);

    const warning = warns.join("\n");
    expect(warning).toContain("EXTRACTION is OFF");
    // Says what actually happens, so an operator is not left guessing why the
    // graph has no entities — INCLUDING what still works, which since
    // cinatra#2591 is recall over their own rows on the local embedder.
    expect(warning).toContain("dropped");
    expect(warning).toContain("deterministic anchor nodes");
    expect(warning).toContain("LOCAL embedder");
  });

  it("does NOT clobber an already-materialized key when it could not ASK", async () => {
    // The cold-bring-up case: `npm run services` runs this BEFORE it starts
    // Postgres, so the stored key is unreadable on the first pass. Rewriting
    // the file empty there would silently turn indexing off on a working install.
    await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
      ...sink,
    });

    const result = await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({
        key: null,
        reason: "the app's provider-key resolver was not reachable (Error)",
        storedReadFailed: true,
      }),
      ...sink,
    });

    expect(result.wrote).toBe(false);
    expect(parseDotenv(readFileSync(outPath, "utf8")).OPENAI_API_KEY).toBe(FAKE_KEY);
    expect(warns.join("\n")).toContain("keeping it untouched");
  });

  it("does NOT downgrade a materialized key to a fallback during an outage", async () => {
    // The database is unreachable but OPENAI_API_KEY happens to be set. Writing
    // the fallback would silently swap a known-good stored key for a possibly
    // stale one; the fallback is for when there is nothing materialized to keep.
    await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
      ...sink,
    });

    const result = await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({
        key: "sk-fake-stale-env-2582",
        source: "environment",
        reason: "resolved from OPENAI_API_KEY in the environment (legacy path)",
        storedReadFailed: true,
      }),
      ...sink,
    });

    expect(result.wrote).toBe(false);
    expect(parseDotenv(readFileSync(outPath, "utf8")).OPENAI_API_KEY).toBe(FAKE_KEY);
  });

  it("DOES use the fallback when nothing is materialized yet", async () => {
    const result = await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({
        key: "sk-fake-env-2582",
        source: "environment",
        reason: "resolved from OPENAI_API_KEY in the environment (legacy path)",
        storedReadFailed: true,
      }),
      ...sink,
    });

    expect(result.wrote).toBe(true);
    expect(parseDotenv(readFileSync(outPath, "utf8")).OPENAI_API_KEY).toBe("sk-fake-env-2582");
  });

  it("DOES clear a materialized key when the operator removed it", async () => {
    // "Read fine, and there is no key" is a disconnect or a rotation, not a
    // cold start. Preserving there would leave a revoked credential running in
    // the indexer container forever.
    await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
      ...sink,
    });

    const result = await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({
        key: null,
        reason: "no OpenAI provider key is configured in the app and OPENAI_API_KEY is unset",
        storedReadFailed: false,
      }),
      ...sink,
    });

    expect(result).toMatchObject({ state: "absent", wrote: true });
    expect(parseDotenv(readFileSync(outPath, "utf8")).OPENAI_API_KEY).toBeUndefined();
  });

  it("refuses a control-character key WITHOUT destroying the previous one", async () => {
    await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
      ...sink,
    });

    const result = await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({
        key: "sk-fake\nINJECTED=1",
        reason: "stored config",
        storedReadFailed: false,
      }),
      ...sink,
    });

    expect(result.wrote).toBe(false);
    expect(parseDotenv(readFileSync(outPath, "utf8")).OPENAI_API_KEY).toBe(FAKE_KEY);
    const warning = warns.join("\n");
    expect(warning).toContain("REFUSED");
    expect(warning).not.toContain("INJECTED");
  });

  it("writes a keyless file when there is nothing to preserve", async () => {
    expect(existsSync(outPath)).toBe(false);
    await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({ key: null, reason: "no key" }),
      ...sink,
    });
    expect(existsSync(outPath)).toBe(true);
  });

  it("replaces a rotated key rather than preserving the stale one", async () => {
    await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({ key: "sk-fake-old-2582", reason: "stored config" }),
      ...sink,
    });
    await generateGraphitiEnv({
      outPath,
      resolveKey: async () => ({ key: FAKE_KEY, reason: "stored config" }),
      ...sink,
    });
    expect(parseDotenv(readFileSync(outPath, "utf8")).OPENAI_API_KEY).toBe(FAKE_KEY);
  });
});

describe("shouldPreserveExisting (pure)", () => {
  it("is true only when the existing file really carries a key", () => {
    expect(shouldPreserveExisting(serializeDotenv(buildGraphitiEnv(FAKE_KEY).env))).toBe(true);
    expect(shouldPreserveExisting(serializeDotenv(buildGraphitiEnv(null).env))).toBe(false);
    expect(shouldPreserveExisting("OPENAI_API_KEY=\n")).toBe(false);
    expect(shouldPreserveExisting("OPENAI_API_KEY=   \n")).toBe(false);
    expect(shouldPreserveExisting(undefined)).toBe(false);
  });
});
