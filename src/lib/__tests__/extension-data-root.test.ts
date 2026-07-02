// cinatra#791 — the ONE configurable extension data root: precedence
// env CINATRA_EXTENSION_DATA_ROOT > DB metadata `extension_data_root` >
// default /data/extensions; env wins even over a present DB row (deploy
// determinism); blank/whitespace values never select a source.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";

const readMetadataValueFromDatabase = vi.fn<(key: string, fallback: unknown) => unknown>();
const writeMetadataValueToDatabase = vi.fn();
vi.mock("@/lib/database", () => ({
  readMetadataValueFromDatabase: (key: string, fallback: unknown) =>
    readMetadataValueFromDatabase(key, fallback),
  writeMetadataValueToDatabase: (key: string, value: unknown) =>
    writeMetadataValueToDatabase(key, value),
}));

import {
  DEFAULT_EXTENSION_DATA_ROOT,
  EXTENSION_DATA_ROOT_ENV,
  EXTENSION_DATA_ROOT_METADATA_KEY,
  readExtensionDataRoot,
  resolveExtensionDataRoot,
  writeExtensionDataRoot,
} from "@/lib/extension-data-root";

let priorEnv: string | undefined;
beforeEach(() => {
  priorEnv = process.env[EXTENSION_DATA_ROOT_ENV];
  delete process.env[EXTENSION_DATA_ROOT_ENV];
  readMetadataValueFromDatabase.mockReset().mockReturnValue(null);
  writeMetadataValueToDatabase.mockReset();
});
afterEach(() => {
  if (priorEnv === undefined) delete process.env[EXTENSION_DATA_ROOT_ENV];
  else process.env[EXTENSION_DATA_ROOT_ENV] = priorEnv;
});

describe("readExtensionDataRoot — env > DB > default", () => {
  it("defaults to /data/extensions when neither env nor DB is set", () => {
    expect(readExtensionDataRoot()).toBe(DEFAULT_EXTENSION_DATA_ROOT);
    expect(DEFAULT_EXTENSION_DATA_ROOT).toBe("/data/extensions");
  });

  it("uses the DB metadata value when no env var is set", () => {
    readMetadataValueFromDatabase.mockReturnValue("/mnt/ext-root");
    expect(readExtensionDataRoot()).toBe("/mnt/ext-root");
    expect(readMetadataValueFromDatabase).toHaveBeenCalledWith(
      EXTENSION_DATA_ROOT_METADATA_KEY,
      null,
    );
  });

  it("env WINS over a present DB value (deploy determinism)", () => {
    readMetadataValueFromDatabase.mockReturnValue("/stale/db/root");
    process.env[EXTENSION_DATA_ROOT_ENV] = "/deploy/owned/root";
    expect(readExtensionDataRoot()).toBe("/deploy/owned/root");
  });

  it("a blank/whitespace env value never selects the env source", () => {
    process.env[EXTENSION_DATA_ROOT_ENV] = "   ";
    readMetadataValueFromDatabase.mockReturnValue("/db/root");
    expect(readExtensionDataRoot()).toBe("/db/root");
    process.env[EXTENSION_DATA_ROOT_ENV] = "";
    expect(readExtensionDataRoot()).toBe("/db/root");
  });

  it("a blank/non-string DB value falls through to the default", () => {
    readMetadataValueFromDatabase.mockReturnValue("   ");
    expect(readExtensionDataRoot()).toBe(DEFAULT_EXTENSION_DATA_ROOT);
    readMetadataValueFromDatabase.mockReturnValue(42);
    expect(readExtensionDataRoot()).toBe(DEFAULT_EXTENSION_DATA_ROOT);
  });

  it("trims surrounding whitespace from a real env value", () => {
    process.env[EXTENSION_DATA_ROOT_ENV] = "  /trimmed/root  ";
    expect(readExtensionDataRoot()).toBe("/trimmed/root");
  });
});

describe("resolveExtensionDataRoot — absolute resolution", () => {
  it("keeps an absolute configured root as-is", () => {
    process.env[EXTENSION_DATA_ROOT_ENV] = "/abs/root";
    expect(resolveExtensionDataRoot()).toBe("/abs/root");
  });

  it("resolves a relative configured root against cwd", () => {
    process.env[EXTENSION_DATA_ROOT_ENV] = "rel/extensions";
    expect(resolveExtensionDataRoot()).toBe(path.join(process.cwd(), "rel/extensions"));
  });
});

describe("writeExtensionDataRoot", () => {
  it("writes to the metadata key", () => {
    writeExtensionDataRoot("/new/root");
    expect(writeMetadataValueToDatabase).toHaveBeenCalledWith(
      EXTENSION_DATA_ROOT_METADATA_KEY,
      "/new/root",
    );
  });
});
