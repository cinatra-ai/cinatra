// cinatra#926 — boot-time stranded-bytes guard: WARN (never block) when
// artifact_blobs rows exist but the resolved artifact data root has no
// orgs/ dir (a mis-pointed root, not data loss). Silent on a fresh
// instance (no rows).
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runPostgresQueriesSync = vi.fn();
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "test_schema",
}));

const resolveArtifactDataRoot = vi.fn();
vi.mock("@/lib/artifacts/artifact-data-root", () => ({
  resolveArtifactDataRoot: () => resolveArtifactDataRoot(),
  ARTIFACT_DATA_ROOT_ENV: "CINATRA_ARTIFACT_DATA_ROOT",
  ARTIFACT_DATA_ROOT_METADATA_KEY: "artifact_data_root",
}));

import { artifactDataRootGuardPhases } from "@/lib/boot/phases/artifact-data-root-guard";

describe("artifact-data-root-guard boot phase", () => {
  let root: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    root = mkdtempSync(path.join(tmpdir(), "v5-root-guard-"));
    resolveArtifactDataRoot.mockReturnValue(root);
    runPostgresQueriesSync.mockReset();
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    rmSync(root, { recursive: true, force: true });
  });

  const phase = () => {
    const phases = artifactDataRootGuardPhases();
    expect(phases).toHaveLength(1);
    expect(phases[0].name).toBe("artifact-data-root-guard");
    expect(phases[0].policy).toBe("retryable"); // read-only, never deploy-gating
    return phases[0];
  };

  it("skips silently when no artifact_blobs rows exist (fresh instance)", async () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [] }]);
    const outcome = await phase().run();
    expect(outcome).toEqual({ skipped: expect.stringContaining("no artifact_blobs rows") });
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("stays quiet when rows exist AND the root has an orgs/ dir", async () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [{ "?column?": 1 }] }]);
    mkdirSync(path.join(root, "orgs"), { recursive: true });
    await phase().run();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it("WARNS loudly (naming root + both config knobs) when rows exist but orgs/ is missing", async () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [{ "?column?": 1 }] }]);
    await phase().run();
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const msg = String(warnSpy.mock.calls[0][0]);
    expect(msg).toContain(root);
    expect(msg).toContain("CINATRA_ARTIFACT_DATA_ROOT");
    expect(msg).toContain("artifact_data_root");
    expect(msg).toContain("NOT data loss");
  });

  it("lets a DB failure propagate (the retryable runner logs + swallows it)", async () => {
    runPostgresQueriesSync.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(phase().run()).rejects.toThrow("db down");
  });
});
