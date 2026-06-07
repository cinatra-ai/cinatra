// Lockfile utilities extracted from the Verdaccio dependency resolver.
// DependencyTree is sourced from ../types rather than the original resolver module.
//
// JSON lockfile reader/writer for plugin package dependency trees.
// Deterministic emission: 2-space indent, trailing newline, keys sorted
// alphabetically at every level of nesting. Round-trip byte-stable.

import * as fs from "node:fs/promises";
import { z } from "zod";
import type { DependencyTree } from "../types";

export const LOCKFILE_VERSION = 1 as const;

// ---------------------------------------------------------------------------
// Schema + types
// ---------------------------------------------------------------------------

const lockfilePackageSchema = z.object({
  version: z.string().min(1),
  resolved: z.string().min(1),
  integrity: z.string().min(1),
  dependencies: z.record(z.string().min(1), z.string().min(1)).optional(),
});

export const lockfileShapeSchema = z.object({
  lockfileVersion: z.literal(LOCKFILE_VERSION),
  root: z.object({
    packageName: z.string().min(1),
    packageVersion: z.string().min(1),
  }),
  packages: z.record(z.string().min(1), lockfilePackageSchema),
});

export type LockfileShape = z.infer<typeof lockfileShapeSchema>;

// ---------------------------------------------------------------------------
// Stable stringify — recursive alphabetical key sort
// ---------------------------------------------------------------------------

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) {
      out[k] = sortKeys(v);
    }
    return out;
  }
  return value;
}

export function stableStringifyLockfile(lockfile: LockfileShape): string {
  return JSON.stringify(sortKeys(lockfile), null, 2) + "\n";
}

// ---------------------------------------------------------------------------
// Read / write
// ---------------------------------------------------------------------------

export async function readLockfile(path: string): Promise<LockfileShape | null> {
  let raw: string;
  try {
    raw = await fs.readFile(path, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      return null;
    }
    throw err;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(`[lockfile] failed to parse JSON at ${path}:`, (err as Error).message);
    return null;
  }

  const result = lockfileShapeSchema.safeParse(parsed);
  if (!result.success) {
    // eslint-disable-next-line no-console
    console.warn(
      `[lockfile] malformed lockfile at ${path}:`,
      result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "),
    );
    return null;
  }
  return result.data;
}

export async function writeLockfile(
  path: string,
  lockfile: LockfileShape,
): Promise<void> {
  const parsed = lockfileShapeSchema.parse(lockfile);
  const body = stableStringifyLockfile(parsed);
  await fs.writeFile(path, body, "utf8");
}

// ---------------------------------------------------------------------------
// lockfileFromTree — resolver output → lockfile shape
// ---------------------------------------------------------------------------

export function lockfileFromTree(tree: DependencyTree): LockfileShape {
  const packages: LockfileShape["packages"] = {};
  for (const [name, node] of tree.all) {
    const hasDeps = Object.keys(node.dependencies).length > 0;
    const entry: LockfileShape["packages"][string] = {
      version: node.resolvedVersion,
      resolved: node.tarballUrl,
      integrity: node.integrity,
    };
    if (hasDeps) {
      entry.dependencies = { ...node.dependencies };
    }
    packages[name] = entry;
  }
  return {
    lockfileVersion: LOCKFILE_VERSION,
    root: {
      packageName: tree.root.packageName,
      packageVersion: tree.root.resolvedVersion,
    },
    packages,
  };
}
