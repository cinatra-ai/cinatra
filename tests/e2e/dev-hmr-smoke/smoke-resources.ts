import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { freemem, totalmem } from "node:os";
import type { SmokePhase } from "./smoke-walk";

type ResourceReaders = {
  readFile: (path: string) => string;
  processTable: () => string;
  freeMemory: () => number;
  totalMemory: () => number;
};

export function parseDevServerProcessTree(table: string, rootPid: number): { rssKiB: number; processCount: number } | null {
  const processes = new Map<number, { parentPid: number; rssKiB: number }>();
  for (const line of table.split("\n")) {
    const fields = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
    if (!fields) continue;
    const [pid, parentPid, rssKiB] = fields.slice(1).map(Number);
    if (pid <= 0 || ![pid, parentPid, rssKiB].every(Number.isSafeInteger)) continue;
    processes.set(pid, { parentPid, rssKiB });
  }
  if (!processes.has(rootPid)) return null;
  const children = new Map<number, number[]>();
  for (const [pid, process] of processes) {
    const siblings = children.get(process.parentPid) ?? [];
    siblings.push(pid);
    children.set(process.parentPid, siblings);
  }
  const descendants = new Set([rootPid]);
  for (const pid of descendants) {
    for (const childPid of children.get(pid) ?? []) descendants.add(childPid);
  }
  const rssKiB = [...descendants].reduce((sum, pid) => sum + processes.get(pid)!.rssKiB, 0);
  return Number.isSafeInteger(rssKiB) ? { rssKiB, processCount: descendants.size } : null;
}

const defaultReaders: ResourceReaders = {
  readFile: (path) => readFileSync(path, "utf8"),
  // Read only numeric fields: command arguments/environment may carry secrets.
  // A failed or oversized scan is unavailable, never a reason to fail the smoke.
  processTable: () => execFileSync("ps", ["-eo", "pid=,ppid=,rss="], {
    encoding: "utf8", timeout: 1_000, maxBuffer: 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  }),
  freeMemory: freemem,
  totalMemory: totalmem,
};

export function readSmokeResources(readers: ResourceReaders = defaultReaders) {
  const unavailable: string[] = [];
  const inMiB = (bytes: number) => Number((bytes / 1048576).toFixed(1));
  const memory = (read: () => number, name: string) => {
    try {
      const bytes = read();
      if (Number.isSafeInteger(bytes) && bytes >= 0) return inMiB(bytes);
    } catch { /* The diagnostic stays absent; exception text is not logged. */ }
    unavailable.push(name);
    return null;
  };
  const freeMemoryMiB = memory(readers.freeMemory, "free-memory");
  const totalMemoryMiB = memory(readers.totalMemory, "total-memory");
  const availableMemoryMiB = memory(() => {
    const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readers.readFile("/proc/meminfo"));
    return available ? Number(available[1]) * 1024 : NaN;
  }, "available-memory");
  let devServerRootPid: number | null = null;
  try {
    const pid = readers.readFile("/tmp/dev-hmr.pid").trim();
    if (/^[1-9]\d*$/.test(pid) && Number.isSafeInteger(Number(pid))) devServerRootPid = Number(pid);
  } catch { /* Missing outside the workflow; leave the diagnostic unavailable. */ }
  let tree: ReturnType<typeof parseDevServerProcessTree> = null;
  if (devServerRootPid === null) unavailable.push("dev-server-pid");
  else {
    try { tree = parseDevServerProcessTree(readers.processTable(), devServerRootPid); } catch { /* Bounded ps can fail. */ }
    if (!tree) unavailable.push("dev-server-process-tree");
  }
  return {
    freeMemoryMiB, availableMemoryMiB, totalMemoryMiB, devServerRootPid,
    // RSS is a sum over the pnpm dev tree, not unique physical memory: shared
    // pages can be counted in more than one process's resident size.
    devServerProcessTreeRssMiB: tree ? inMiB(tree.rssKiB * 1024) : null,
    devServerProcessCount: tree?.processCount ?? null,
    unavailable,
  };
}

export async function withSmokeResourcePhase<T>(
  phase: SmokePhase | "recompile",
  action: () => Promise<T>,
  reporter = { readResources: (): unknown => readSmokeResources(), write: (line: string): void => { process.stdout.write(line); } },
): Promise<T> {
  const report = (edge: "before" | "after") => {
    let resources: unknown;
    try { resources = reporter.readResources(); } catch { resources = { unavailable: ["resource-snapshot"] }; }
    try {
      reporter.write(`[hmr-smoke-resources] ${JSON.stringify({ phase, edge, resources })}\n`);
    } catch { /* Diagnostics must neither prevent the action nor replace its failure. */ }
  };
  report("before");
  try { return await action(); } finally { report("after"); }
}
