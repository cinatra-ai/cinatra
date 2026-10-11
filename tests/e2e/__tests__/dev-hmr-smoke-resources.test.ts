import { describe, expect, it, vi } from "vitest";
import {
  parseDevServerProcessTree,
  readSmokeResources,
  withSmokeResourcePhase,
} from "../dev-hmr-smoke/smoke-resources";

describe("smoke resource diagnostics", () => {
  it("adds resident memory for the PID file's whole tree, excluding unrelated processes", () => {
    expect(parseDevServerProcessTree("10 1 100\n12 11 300\n11 10 200\n99 1 9999\n", 10)).toEqual({ rssKiB: 600, processCount: 3 });
    expect(parseDevServerProcessTree("10 12 100\n11 10 200\n12 11 300\n", 10)).toEqual({ rssKiB: 600, processCount: 3 });
  });

  it("does not invent a zero RSS when the root disappeared or rows are invalid", () => {
    expect(parseDevServerProcessTree("11 10 200\n", 10)).toBeNull();
    expect(parseDevServerProcessTree("10 1 -1\n10 1 NaN\n10 1 123 extra\n", 10)).toBeNull();
  });

  it("reports free and available memory separately with the tree sum clearly named", () => {
    const snapshot = readSmokeResources({
      readFile: (path) => path === "/proc/meminfo" ? "MemAvailable: 2048 kB\n" : "10\n",
      processTable: () => "10 1 1024\n11 10 2048\n99 1 4096\n",
      freeMemory: () => 1048576,
      totalMemory: () => 16777216,
    });
    expect(snapshot).toEqual({ freeMemoryMiB: 1, availableMemoryMiB: 2, totalMemoryMiB: 16, devServerRootPid: 10, devServerProcessTreeRssMiB: 3, devServerProcessCount: 2, unavailable: [] });
  });

  it("keeps missing diagnostics explicit and never includes exception contents", () => {
    const snapshot = readSmokeResources({
      readFile: () => { throw new Error("private command or environment contents"); },
      processTable: () => { throw new Error("private command or environment contents"); },
      freeMemory: () => 1048576,
      totalMemory: () => 16777216,
    });
    expect(snapshot).toEqual({ freeMemoryMiB: 1, availableMemoryMiB: null, totalMemoryMiB: 16, devServerRootPid: null, devServerProcessTreeRssMiB: null, devServerProcessCount: null, unavailable: ["available-memory", "dev-server-pid"] });
    expect(JSON.stringify(snapshot)).not.toContain("private");
  });

  it("does not scan processes for malformed PIDs and survives a failed process scan", () => {
    const processTable = vi.fn(() => { throw new Error("ps exceeded its limit"); });
    const dependencies = { readFile: (path: string) => path === "/proc/meminfo" ? "MemAvailable: 2048 kB" : "10; command", processTable, freeMemory: () => 1, totalMemory: () => 2 };
    expect(readSmokeResources(dependencies).unavailable).toContain("dev-server-pid");
    expect(processTable).not.toHaveBeenCalled();
    expect(readSmokeResources({ ...dependencies, readFile: (path) => path === "/proc/meminfo" ? "MemAvailable: 2048 kB" : "10" }).unavailable).toEqual(["dev-server-process-tree"]);
  });

  it.each(["warm", "precompile", "recompile", "post-recompile"] as const)("prints before and after %s, preserving an action's result", async (phase) => {
    const events: unknown[] = [];
    const readResources = vi.fn(() => ({ freeMemoryMiB: 123 }));
    const result = await withSmokeResourcePhase(phase, async () => { events.push("action"); return 42; }, { readResources, write: (line) => events.push(JSON.parse(line.split(" ").slice(1).join(" "))) });
    expect(result).toBe(42);
    expect(events).toEqual([{ phase, edge: "before", resources: { freeMemoryMiB: 123 } }, "action", { phase, edge: "after", resources: { freeMemoryMiB: 123 } }]);
    expect(readResources).toHaveBeenCalledTimes(2);
  });

  it("prints the after reading on an assertion failure without swallowing the failure", async () => {
    const failure = new Error("HTTP 500");
    const write = vi.fn();
    await expect(withSmokeResourcePhase("post-recompile", async () => { throw failure; }, { readResources: () => ({}), write })).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write.mock.calls[1][0]).toContain('"edge":"after"');
  });

  it("runs the action even when the before reading cannot be written", async () => {
    const action = vi.fn(async () => 42);
    const write = vi.fn().mockImplementationOnce(() => { throw new Error("output unavailable"); });
    await expect(withSmokeResourcePhase("warm", action, { readResources: () => ({}), write })).resolves.toBe(42);
    expect(action).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("preserves the action's assertion when writing the after reading fails", async () => {
    const failure = new Error("HTTP 500");
    const write = vi.fn().mockImplementationOnce(() => {}).mockImplementationOnce(() => { throw new Error("output unavailable"); });
    await expect(withSmokeResourcePhase("post-recompile", async () => { throw failure; }, { readResources: () => ({}), write })).rejects.toBe(failure);
    expect(write).toHaveBeenCalledTimes(2);
  });
});
