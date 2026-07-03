// cinatra#793 — the agent runtime-mount projection boot phase: installed
// (active|locked) agent-kind canonical rows with a trusted FINALIZED store
// digest whose mount slug dir is MISSING are projected store→mount; present
// dirs are skipped (idempotent); per-package failures are non-fatal.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const listInstalledExtensions = vi.fn();
vi.mock("@cinatra-ai/extensions/canonical-store", () => ({
  listInstalledExtensions: (...a: unknown[]) => listInstalledExtensions(...(a as [unknown])),
}));

const resolveFinalizedStorePayload = vi.fn();
vi.mock("@/lib/extension-store-payload", () => ({
  resolveFinalizedStorePayload: (...a: unknown[]) =>
    resolveFinalizedStorePayload(...(a as [unknown])),
}));

let MOUNT_ROOT = "";
vi.mock("@cinatra-ai/agents/agent-runtime-mount", () => ({
  resolveAgentRuntimeMountDir: () => MOUNT_ROOT,
}));

// The real materializer semantics are pinned in packages/agents; here we spy
// the projection wiring (staged COPY in, mount target, commit, install lock).
const materializeAgentPackageToDisk = vi.fn(async (_input: unknown): Promise<unknown> => undefined);
const commitMaterialize = vi.fn(async (_result: unknown) => {});
vi.mock("@cinatra-ai/agents", () => ({
  materializeAgentPackageToDisk: (...a: unknown[]) =>
    materializeAgentPackageToDisk(...(a as [unknown])),
  commitMaterialize: (...a: unknown[]) => commitMaterialize(...(a as [unknown])),
  withInstallLock: async (_pkg: string, fn: () => Promise<unknown>) => fn(),
}));

import { agentMountProjectionPhases } from "@/lib/boot/phases/agent-mount-projection";

let tmp: string;

function row(packageName: string, kind = "agent", status = "active", organizationId: string | null = null) {
  return { packageName, kind, status, organizationId, source: { type: "verdaccio" } };
}

beforeEach(() => {
  vi.clearAllMocks();
  tmp = mkdtempSync(path.join(os.tmpdir(), "agent-mount-projection-"));
  MOUNT_ROOT = path.join(tmp, "mount");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

async function runPhase() {
  const phases = agentMountProjectionPhases();
  expect(phases).toHaveLength(1);
  expect(phases[0].name).toBe("agent-mount-projection");
  expect(phases[0].policy).toBe("degraded");
  return phases[0].run();
}

describe("agent-mount-projection boot phase", () => {
  it("projects a missing mount dir from the finalized store payload (staged copy, commit)", async () => {
    const storeDir = path.join(tmp, "store", "agent", "@acme", "writer", "d".repeat(16));
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(path.join(storeDir, "package.json"), JSON.stringify({ name: "@acme/writer" }));
    listInstalledExtensions.mockResolvedValue([row("@acme/writer")]);
    resolveFinalizedStorePayload.mockResolvedValue({
      storeDir,
      digest: "d".repeat(128),
      version: "1.0.0",
      registryUrl: null,
    });
    materializeAgentPackageToDisk.mockResolvedValue({
      materialized: true,
      targetDir: path.join(MOUNT_ROOT, "acme", "writer"),
      priorDirBackup: null,
      wasReinstall: false,
    });

    await runPhase();

    // Resolved PER ROW at its EXACT org scope (platform-global would fail
    // closed on multi-org packages).
    expect(resolveFinalizedStorePayload).toHaveBeenCalledWith({
      packageName: "@acme/writer",
      expectedKind: "agent",
      orgId: null,
    });
    expect(materializeAgentPackageToDisk).toHaveBeenCalledTimes(1);
    const call = materializeAgentPackageToDisk.mock.calls[0][0] as {
      extractedTempDir: string;
      packageName: string;
      agentInstallDir: string;
    };
    expect(call.packageName).toBe("@acme/writer");
    expect(call.agentInstallDir).toBe(MOUNT_ROOT);
    // The staging dir is a COPY of the store payload (never the store dir itself)
    // and carries the payload bytes.
    expect(call.extractedTempDir).not.toBe(storeDir);
    expect(existsSync(path.join(call.extractedTempDir, "package.json"))).toBe(false); // staged dir already cleaned up
    expect(commitMaterialize).toHaveBeenCalledTimes(1);
  });

  it("skips a package whose mount slug dir already exists (idempotent)", async () => {
    mkdirSync(path.join(MOUNT_ROOT, "acme", "writer"), { recursive: true });
    listInstalledExtensions.mockResolvedValue([row("@acme/writer")]);

    await runPhase();

    expect(resolveFinalizedStorePayload).not.toHaveBeenCalled();
    expect(materializeAgentPackageToDisk).not.toHaveBeenCalled();
  });

  it("skips rows with no finalized store payload and non-agent/non-live rows", async () => {
    listInstalledExtensions.mockResolvedValue([
      row("@acme/no-payload"),
      row("@acme/a-skill", "skill"),
      row("@acme/archived", "agent", "archived"),
    ]);
    resolveFinalizedStorePayload.mockResolvedValue(null);

    await runPhase();

    // Only the live agent row is even resolved; nothing is projected.
    expect(resolveFinalizedStorePayload).toHaveBeenCalledTimes(1);
    expect(materializeAgentPackageToDisk).not.toHaveBeenCalled();
  });

  it("multi-org rows: projects when every org scope pins the SAME digest dir; refuses on conflict", async () => {
    const storeDir = path.join(tmp, "store-multi");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(path.join(storeDir, "package.json"), "{}");
    listInstalledExtensions.mockResolvedValue([
      row("@acme/multi", "agent", "active", "org-1"),
      row("@acme/multi", "agent", "active", "org-2"),
    ]);
    // Same digest dir for both org scopes → unambiguous → projected once.
    resolveFinalizedStorePayload.mockResolvedValue({
      storeDir,
      digest: "f".repeat(128),
      version: "1.0.0",
      registryUrl: null,
    });
    materializeAgentPackageToDisk.mockResolvedValue({
      materialized: true,
      targetDir: path.join(MOUNT_ROOT, "acme", "multi"),
      priorDirBackup: null,
      wasReinstall: false,
    });
    await runPhase();
    expect(resolveFinalizedStorePayload).toHaveBeenNthCalledWith(1, {
      packageName: "@acme/multi",
      expectedKind: "agent",
      orgId: "org-1",
    });
    expect(resolveFinalizedStorePayload).toHaveBeenNthCalledWith(2, {
      packageName: "@acme/multi",
      expectedKind: "agent",
      orgId: "org-2",
    });
    expect(materializeAgentPackageToDisk).toHaveBeenCalledTimes(1);

    // CONFLICT: the two org scopes pin DIFFERENT digest dirs → refuse (no guess).
    vi.clearAllMocks();
    rmSync(path.join(MOUNT_ROOT, "acme"), { recursive: true, force: true });
    listInstalledExtensions.mockResolvedValue([
      row("@acme/multi", "agent", "active", "org-1"),
      row("@acme/multi", "agent", "active", "org-2"),
    ]);
    resolveFinalizedStorePayload
      .mockResolvedValueOnce({ storeDir, digest: "f".repeat(128), version: "1.0.0", registryUrl: null })
      .mockResolvedValueOnce({ storeDir: storeDir + "-other", digest: "0".repeat(128), version: "2.0.0", registryUrl: null });
    await runPhase();
    expect(materializeAgentPackageToDisk).not.toHaveBeenCalled();
  });

  it("a per-package projection failure is swallowed (non-fatal) and does not block the rest", async () => {
    const storeDir = path.join(tmp, "store2");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(path.join(storeDir, "package.json"), "{}");
    listInstalledExtensions.mockResolvedValue([row("@acme/bad"), row("@acme/good")]);
    resolveFinalizedStorePayload.mockResolvedValue({
      storeDir,
      digest: "e".repeat(128),
      version: "1.0.0",
      registryUrl: null,
    });
    materializeAgentPackageToDisk
      .mockRejectedValueOnce(new Error("disk boom"))
      .mockResolvedValueOnce({
        materialized: true,
        targetDir: path.join(MOUNT_ROOT, "acme", "good"),
        priorDirBackup: null,
        wasReinstall: false,
      });

    await expect(runPhase()).resolves.not.toThrow();
    expect(materializeAgentPackageToDisk).toHaveBeenCalledTimes(2);
    expect(commitMaterialize).toHaveBeenCalledTimes(1);
  });
});
