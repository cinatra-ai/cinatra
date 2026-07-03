// cinatra#926 — the ONE configurable ARTIFACT data root: precedence
// env CINATRA_ARTIFACT_DATA_ROOT > DB metadata `artifact_data_root` >
// default cwd-relative `data/artifacts`; env wins even over a present DB row
// (deploy determinism); blank/whitespace values never select a source.
// Mirrors the cinatra#791 extension-data-root contract, with a RELATIVE
// default (dev/test keep the historical layout; prod opts in via env).
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
  ARTIFACT_DATA_ROOT_ENV,
  ARTIFACT_DATA_ROOT_METADATA_KEY,
  DEFAULT_ARTIFACT_DATA_ROOT,
  readArtifactDataRoot,
  resolveArtifactDataRoot,
  writeArtifactDataRoot,
} from "@/lib/artifacts/artifact-data-root";

let priorEnv: string | undefined;
beforeEach(() => {
  priorEnv = process.env[ARTIFACT_DATA_ROOT_ENV];
  delete process.env[ARTIFACT_DATA_ROOT_ENV];
  readMetadataValueFromDatabase.mockReset().mockReturnValue(null);
  writeMetadataValueToDatabase.mockReset();
});
afterEach(() => {
  if (priorEnv === undefined) delete process.env[ARTIFACT_DATA_ROOT_ENV];
  else process.env[ARTIFACT_DATA_ROOT_ENV] = priorEnv;
});

describe("readArtifactDataRoot — env > DB > default", () => {
  it("defaults to the RELATIVE data/artifacts when neither env nor DB is set", () => {
    expect(readArtifactDataRoot()).toBe(DEFAULT_ARTIFACT_DATA_ROOT);
    expect(DEFAULT_ARTIFACT_DATA_ROOT).toBe(path.join("data", "artifacts"));
    expect(path.isAbsolute(DEFAULT_ARTIFACT_DATA_ROOT)).toBe(false);
  });

  it("uses the DB metadata value when no env var is set", () => {
    readMetadataValueFromDatabase.mockReturnValue("/mnt/artifact-root");
    expect(readArtifactDataRoot()).toBe("/mnt/artifact-root");
    expect(readMetadataValueFromDatabase).toHaveBeenCalledWith(
      ARTIFACT_DATA_ROOT_METADATA_KEY,
      null,
    );
  });

  it("env WINS over a present DB value (deploy determinism)", () => {
    readMetadataValueFromDatabase.mockReturnValue("/stale/db/root");
    process.env[ARTIFACT_DATA_ROOT_ENV] = "/data/artifacts";
    expect(readArtifactDataRoot()).toBe("/data/artifacts");
  });

  it("a blank/whitespace env value never selects the env source", () => {
    process.env[ARTIFACT_DATA_ROOT_ENV] = "   ";
    readMetadataValueFromDatabase.mockReturnValue("/db/root");
    expect(readArtifactDataRoot()).toBe("/db/root");
  });

  it("a blank DB value falls through to the default", () => {
    readMetadataValueFromDatabase.mockReturnValue("   ");
    expect(readArtifactDataRoot()).toBe(DEFAULT_ARTIFACT_DATA_ROOT);
  });

  it("a THROWING metadata read degrades to the default (early boot / no schema)", () => {
    readMetadataValueFromDatabase.mockImplementation(() => {
      throw new Error("schema not ready");
    });
    expect(readArtifactDataRoot()).toBe(DEFAULT_ARTIFACT_DATA_ROOT);
  });
});

describe("resolveArtifactDataRoot — always absolute", () => {
  it("resolves the relative default against cwd", () => {
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue("/some/app");
    try {
      expect(resolveArtifactDataRoot()).toBe(path.join("/some/app", "data", "artifacts"));
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("keeps an absolute configured root as-is", () => {
    process.env[ARTIFACT_DATA_ROOT_ENV] = "/data/artifacts";
    expect(resolveArtifactDataRoot()).toBe("/data/artifacts");
  });

  it("normalizes a trailing separator (containment guard compares root + sep)", () => {
    process.env[ARTIFACT_DATA_ROOT_ENV] = "/data/artifacts/";
    expect(resolveArtifactDataRoot()).toBe("/data/artifacts");
  });
});

describe("writeArtifactDataRoot", () => {
  it("persists to the metadata key", () => {
    writeArtifactDataRoot("/new/root");
    expect(writeMetadataValueToDatabase).toHaveBeenCalledWith(
      ARTIFACT_DATA_ROOT_METADATA_KEY,
      "/new/root",
    );
  });
});
