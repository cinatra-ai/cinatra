// cinatra#981 — host-owned request/response log capture backing
// `HostLoggerPort.capture`/`captureDirectory`. Regression parity with the
// pre-#981 connector-side `log-retention.ts` behavior: fixed-width
// lexicographically-sortable filenames, a bounded per-directory cap,
// unrelated-file safety, and a never-throws rotation path.

import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const readMetadataValueFromDatabase = vi.fn<(key: string, fallback: unknown) => unknown>();
const writeMetadataValueToDatabase = vi.fn();
vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: (key: string, fallback: unknown) =>
    readMetadataValueFromDatabase(key, fallback),
  writeMetadataValueToDatabase: (key: string, value: unknown) => writeMetadataValueToDatabase(key, value),
}));

import {
  DEFAULT_CAPTURE_MAX_FILES,
  captureExtensionLogEntry,
  enforceExtensionCaptureRetention,
  resolveExtensionCaptureDirectory,
} from "@/lib/extension-log-capture";
import { EXTENSION_DATA_ROOT_ENV } from "@/lib/extension-data-root";

let dataRoot: string;
let priorEnv: string | undefined;

beforeEach(async () => {
  dataRoot = await mkdtemp(path.join(os.tmpdir(), "cinatra-extension-data-root-"));
  priorEnv = process.env[EXTENSION_DATA_ROOT_ENV];
  process.env[EXTENSION_DATA_ROOT_ENV] = dataRoot;
  readMetadataValueFromDatabase.mockReset().mockReturnValue(null);
  writeMetadataValueToDatabase.mockReset();
});

afterEach(async () => {
  if (priorEnv === undefined) delete process.env[EXTENSION_DATA_ROOT_ENV];
  else process.env[EXTENSION_DATA_ROOT_ENV] = priorEnv;
  await rm(dataRoot, { recursive: true, force: true });
});

describe("resolveExtensionCaptureDirectory", () => {
  it("nests under <extension-data-root>/logs/<packageName>/<channel>, sanitized", () => {
    const dir = resolveExtensionCaptureDirectory("@cinatra-ai/gemini-connector", "gemini-api");
    expect(dir).toBe(path.join(dataRoot, "logs", "cinatra-ai-gemini-connector", "gemini-api"));
  });

  it("never lets an untrusted packageName/channel escape via path traversal", () => {
    const dir = resolveExtensionCaptureDirectory("../../etc", "../../passwd");
    expect(dir.startsWith(path.join(dataRoot, "logs"))).toBe(true);
    expect(dir).not.toContain("..");
  });

  it("falls back to a safe default for an all-symbol packageName/channel", () => {
    const dir = resolveExtensionCaptureDirectory("@@@", "///");
    expect(dir).toBe(path.join(dataRoot, "logs", "extension", "default"));
  });
});

describe("captureExtensionLogEntry", () => {
  it("writes a timestamped JSON file under the resolved directory", async () => {
    await captureExtensionLogEntry("@cinatra-ai/gemini-connector", "gemini-api", {
      label: "generateContent",
      kind: "request",
      body: { prompt: "hi" },
    });
    const dir = resolveExtensionCaptureDirectory("@cinatra-ai/gemini-connector", "gemini-api");
    const files = await readdir(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{4}-\d{2}-\d{2}t[\d-]+z__generatecontent__request\.json$/i);
  });

  it("enforces the retention cap after every write", async () => {
    for (let i = 0; i < 5; i += 1) {
      await captureExtensionLogEntry(
        "@cinatra-ai/openai-connector",
        "openai-api",
        { label: `call-${i}`, kind: "request", body: {} },
        3,
      );
    }
    const dir = resolveExtensionCaptureDirectory("@cinatra-ai/openai-connector", "openai-api");
    expect((await readdir(dir)).length).toBe(3);
  });
});

function captureName(seq: number, kind = "request") {
  const ts = `2026-07-02T00-00-${String(seq).padStart(2, "0")}-000Z`;
  return `${ts}__call__${kind}.json`;
}

describe("enforceExtensionCaptureRetention", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), "cinatra-capture-retention-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("keeps only the newest maxFiles, deleting the oldest", async () => {
    for (let i = 1; i <= 10; i += 1) await writeFile(path.join(dir, captureName(i)), "{}", "utf8");
    await enforceExtensionCaptureRetention(dir, 3);
    expect((await readdir(dir)).sort()).toEqual([captureName(8), captureName(9), captureName(10)]);
  });

  it("defaults to DEFAULT_CAPTURE_MAX_FILES (200)", () => {
    expect(DEFAULT_CAPTURE_MAX_FILES).toBe(200);
  });

  it("never deletes unrelated files", async () => {
    await writeFile(path.join(dir, captureName(1)), "{}", "utf8");
    await writeFile(path.join(dir, captureName(2)), "{}", "utf8");
    await writeFile(path.join(dir, "README.json"), "{}", "utf8");
    await enforceExtensionCaptureRetention(dir, 1);
    expect((await readdir(dir)).sort()).toEqual(["README.json", captureName(2)].sort());
  });

  it("does not throw when the directory is absent", async () => {
    await rm(dir, { recursive: true, force: true });
    await expect(enforceExtensionCaptureRetention(dir, 3)).resolves.toBeUndefined();
  });

  it("does not prune when maxFiles is non-positive", async () => {
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, captureName(1)), "{}", "utf8");
    await enforceExtensionCaptureRetention(dir, 0);
    expect((await readdir(dir)).length).toBe(1);
  });
});
