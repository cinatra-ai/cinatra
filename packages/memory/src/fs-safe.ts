/**
 * Filesystem safety primitives: bundle-root containment, atomic writes, and
 * exclusive creates.
 *
 * Threat model: memory bundles are untrusted PERSISTED input — a cloned
 * bundle may carry crafted paths, committed symlinks, or oversized files, and
 * none of that may redirect a read or write outside the bundle root. Writes
 * are validated lexically (no absolute paths, no `..` escapes, no hidden or
 * control-character segments), physically (no symlink component between the
 * bundle root and the target), and again at write time (the realpath of the
 * target's parent directory must still resolve inside the bundle root).
 * A concurrent process running with the same privileges as the CLI is outside
 * this boundary — it already owns the files; the server-side sync ingest
 * gates re-validate everything independently.
 */
import { randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";

import { MemoryContainmentError, MemoryError } from "./types.ts";

/**
 * Validate a bundle-relative path lexically and return its normalized POSIX
 * form. Rejects absolute paths, `..` escapes, backslashes, empty paths,
 * control characters, and dotfile segments (hidden files are never concept
 * content).
 */
export function normalizeMemoryRelPath(relPath: string): string {
  if (relPath.includes("\\")) {
    throw new MemoryContainmentError(
      `path ${JSON.stringify(relPath)} contains a backslash; use POSIX separators`,
    );
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(relPath)) {
    throw new MemoryContainmentError(
      `path ${JSON.stringify(relPath)} contains control characters`,
    );
  }
  if (path.posix.isAbsolute(relPath) || path.isAbsolute(relPath)) {
    throw new MemoryContainmentError(
      `path ${JSON.stringify(relPath)} is absolute; concept paths are bundle-relative`,
    );
  }
  const normalized = path.posix.normalize(relPath);
  if (normalized === "." || normalized === "") {
    throw new MemoryContainmentError("path is empty");
  }
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new MemoryContainmentError(
      `path ${JSON.stringify(relPath)} escapes the bundle root`,
    );
  }
  for (const segment of normalized.split("/")) {
    if (segment.startsWith(".")) {
      throw new MemoryContainmentError(
        `path segment ${JSON.stringify(segment)} is hidden or relative; not allowed in a bundle`,
      );
    }
  }
  return normalized;
}

/**
 * Assert that writing `relPath` under `bundleRoot` cannot escape the bundle:
 * every already-existing component on the way to the target (including the
 * target itself) must be a real directory/file, never a symlink.
 * Returns the absolute target path.
 */
export function assertMemoryWriteContained(
  bundleRoot: string,
  relPath: string,
): string {
  const normalized = normalizeMemoryRelPath(relPath);
  const segments = normalized.split("/");
  let current = bundleRoot;
  for (const segment of segments) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = lstatSync(current);
    } catch {
      // Component does not exist yet — everything below it will be created
      // fresh by us; the write-time realpath re-check still applies.
      break;
    }
    if (stat.isSymbolicLink()) {
      throw new MemoryContainmentError(
        `path component ${JSON.stringify(path.relative(bundleRoot, current))} is a symlink; refusing to write through it`,
      );
    }
  }
  return path.join(bundleRoot, normalized);
}

/**
 * Create the target's parent directory and return its REAL path after
 * verifying it still resolves inside the bundle root. This re-check at write
 * time means that even a directory component that changed since validation
 * cannot redirect the write outside the bundle.
 */
function containedRealParentDir(bundleRoot: string, absPath: string): string {
  mkdirSync(path.dirname(absPath), { recursive: true });
  const realParent = realpathSync(path.dirname(absPath));
  const realRoot = realpathSync(bundleRoot);
  if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) {
    throw new MemoryContainmentError(
      `write target parent ${realParent} resolves outside the bundle root ${realRoot}`,
    );
  }
  return realParent;
}

/**
 * Atomically write (or overwrite) a file: write to an exclusively-created
 * temp sibling, then rename over the target. When `bundleRoot` is given, the
 * target parent's realpath is verified to be inside the bundle root first.
 */
export function atomicWriteMemoryFile(
  absPath: string,
  data: string | Uint8Array,
  bundleRoot?: string,
): void {
  const base = path.basename(absPath);
  const dir =
    bundleRoot === undefined
      ? (mkdirSync(path.dirname(absPath), { recursive: true }),
        path.dirname(absPath))
      : containedRealParentDir(bundleRoot, absPath);
  const tmp = path.join(
    dir,
    `.${base}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tmp, data, { flag: "wx" });
    renameSync(tmp, path.join(dir, base));
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // best-effort cleanup only
    }
    throw error;
  }
}

/**
 * Exclusively create a file (O_EXCL): fails with a {@link MemoryError} if the
 * target already exists, so two concurrent creators can never both succeed.
 * The parent's realpath is verified inside the bundle root at write time.
 */
export function exclusiveWriteMemoryFile(
  absPath: string,
  data: string | Uint8Array,
  bundleRoot: string,
): void {
  const dir = containedRealParentDir(bundleRoot, absPath);
  try {
    writeFileSync(path.join(dir, path.basename(absPath)), data, {
      flag: "wx",
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      throw new MemoryError(
        `${path.relative(bundleRoot, absPath)} already exists`,
      );
    }
    throw error;
  }
}
