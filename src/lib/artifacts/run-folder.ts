import "server-only";

// THE RUN FOLDER (cinatra#3030, epic #3023 W6; plan (C) item 0.21).
//
//   "[...] with an `outputs` folder inside it that is the only place the pickup
//    reads. Only the application writes it, through its tools, so the run folder
//    lives with the process that runs the pickup [...] The folder is host-side
//    and is never mounted into a sandbox: an agent writes to it through host
//    file tools on the passthrough (write, list, read, confined to the run's
//    folder), and a sandbox publishes a file from its own workspace into the
//    folder through one tool that copies it across the broker [...] A per-file
//    cap equal to the upload cap, a per-run cap, and a retention tier of its
//    own — deleted after pickup plus a grace period, never by artifact
//    reachability."
//
// CONFINEMENT is the same containment rule the blob store uses (plan §8.1: "the
// tools are confined by the same containment rule the blob store uses"):
// `path.resolve` and then a `root + path.sep` prefix test, over a root the data
// root already resolved and normalised. SYMLINKS ARE REFUSED on top of it — a
// prefix test alone is satisfied by a link inside the folder that points out of
// it, so every existing segment from the outputs folder down is `lstat`ed and a
// link anywhere on the path is a refusal, never a follow.
//
// Nothing here reads or writes the database: a run folder "has no table" (plan
// §8.2). The pickup's own record of which folder and file it read lives on the
// ledger row it writes, and the retention tier reads the folder itself.

import { createHash } from "node:crypto";
import { constants as fsConstants, createReadStream } from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

import { resolveRunDataRoot } from "./run-data-root";

/** The only folder the pickup reads (item 0.21). */
export const RUN_OUTPUTS_DIR = "outputs";

/** The pickup receipt the retention tier reads. It lives in the RUN folder, not
 *  in `outputs`, so it is never itself an output. */
export const RUN_PICKUP_RECEIPT = ".pickup.json";

/** The per-file cap: "a per-file cap equal to the upload cap" — the artifact
 *  upload route's `MAX_UPLOAD_BYTES`, restated here rather than imported so a
 *  server library does not depend on a route module. */
export const RUN_FOLDER_FILE_CAP_BYTES = 50 * 1024 * 1024;

/** The per-run cap (item 0.21 names one and leaves its value open; see the
 *  pull request's decisions). Overridable per deployment. */
export const RUN_FOLDER_RUN_CAP_BYTES = 250 * 1024 * 1024;

export const RUN_FOLDER_FILE_CAP_ENV = "CINATRA_RUN_FOLDER_FILE_CAP_BYTES";
export const RUN_FOLDER_RUN_CAP_ENV = "CINATRA_RUN_FOLDER_RUN_CAP_BYTES";

function envBytes(name: string, fallback: number): number {
  const raw = process.env[name];
  if (typeof raw !== "string" || raw.trim() === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function runFolderFileCapBytes(): number {
  return envBytes(RUN_FOLDER_FILE_CAP_ENV, RUN_FOLDER_FILE_CAP_BYTES);
}

export function runFolderRunCapBytes(): number {
  return envBytes(RUN_FOLDER_RUN_CAP_ENV, RUN_FOLDER_RUN_CAP_BYTES);
}

export type RunFolderRefusalReason =
  | "invalid_scope"
  | "invalid_path"
  | "path_escape"
  | "symlink"
  | "file_cap"
  | "run_cap"
  | "not_found";

/** Every refusal is a STATED reason the calling tool fails visibly on. */
export class RunFolderRefusal extends Error {
  constructor(
    readonly reason: RunFolderRefusalReason,
    message: string,
  ) {
    super(message);
    this.name = "RunFolderRefusal";
  }
}

/**
 * Open the FINAL component with `O_NOFOLLOW` (convergence round, adopted in
 * part). `refuseSymlinksUnder` lstats the path before the open, which is a
 * check-then-use: a link dropped onto the target between the two would be
 * followed. `O_NOFOLLOW` closes that window on the component that matters — the
 * one bytes are read from and written to — inside the kernel, with no second
 * resolution of the name. The traversal above it keeps the blob store's own
 * containment rule, which is what plan §8.1 pins the tools to.
 */
async function openNoFollow(abs: string, flags: number): Promise<fsp.FileHandle> {
  try {
    return await fsp.open(abs, flags | fsConstants.O_NOFOLLOW);
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    if (code === "ELOOP" || code === "EMLINK") {
      throw new RunFolderRefusal(
        "symlink",
        "the run folder path became a symbolic link — the run folder refuses links",
      );
    }
    throw err;
  }
}

/**
 * The bytes decoded as UTF-8, or null when they are NOT UTF-8 text.
 *
 * `Buffer.toString("utf8")` never fails: it substitutes U+FFFD for every byte it
 * cannot decode, so a PNG read as text comes back as a lossy string that hashes
 * and stores as something the agent never wrote. The round trip is the honest
 * test — text that re-encodes to the same bytes is text, and anything else is
 * refused rather than silently corrupted. (W6 deliberately stops short of
 * pictures; W8 is the slice that gives bytes a road of their own.)
 */
export function decodeUtf8Exact(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

/** One path segment of the folder identity. An organisation or run id that is
 *  not a plain identifier is refused BEFORE any disk access — the same posture
 *  the blob store's `safe()` takes on its own scope segments. */
function safeSegment(value: string, what: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new RunFolderRefusal("invalid_scope", `run folder ${what} must be a short non-empty id`);
  }
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new RunFolderRefusal(
      "invalid_scope",
      `run folder ${what} "${value}" is not a plain identifier (letters, digits, dot, dash, underscore)`,
    );
  }
  return value;
}

/** `<root>/<organisation>/<run>/` — the run's own folder. */
export function runFolderPath(orgId: string, runId: string): string {
  return path.join(resolveRunDataRoot(), safeSegment(orgId, "organisation"), safeSegment(runId, "run"));
}

/** `<root>/<organisation>/<run>/outputs` — the only place the pickup reads. */
export function runOutputsPath(orgId: string, runId: string): string {
  return path.join(runFolderPath(orgId, runId), RUN_OUTPUTS_DIR);
}

/** Refuse a symlink ANYWHERE on the path from the outputs folder down to (and
 *  including) the target. A containment prefix test alone is satisfied by a link
 *  INSIDE the folder that resolves outside it, so the link itself is the thing
 *  refused: never followed, never written through. */
async function refuseSymlinksUnder(base: string, abs: string): Promise<void> {
  const rel = path.relative(base, abs);
  const segments = rel.length === 0 ? [] : rel.split(path.sep);
  const candidates: string[] = [base];
  let cursor = base;
  for (const segment of segments) {
    cursor = path.join(cursor, segment);
    candidates.push(cursor);
  }
  for (const candidate of candidates) {
    let st;
    try {
      st = await fsp.lstat(candidate);
    } catch {
      continue; // does not exist yet — nothing to follow
    }
    if (st.isSymbolicLink()) {
      throw new RunFolderRefusal(
        "symlink",
        `run folder path "${path.relative(base, candidate) || "."}" is a symbolic link — the run folder refuses links`,
      );
    }
  }
}

/**
 * Resolve one caller-supplied relative path INSIDE the run's outputs folder.
 * The containment rule the blob store uses, plus the symlink refusal.
 */
export async function resolveRunOutputPath(input: {
  orgId: string;
  runId: string;
  relPath: string;
}): Promise<{ outputsRoot: string; abs: string; relPath: string }> {
  const outputsRoot = runOutputsPath(input.orgId, input.runId);
  const raw = input.relPath;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new RunFolderRefusal("invalid_path", "a run-folder path must be a non-empty relative path");
  }
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new RunFolderRefusal("invalid_path", `run-folder path "${raw}" must be relative to the outputs folder`);
  }
  if (raw.includes("\0")) {
    throw new RunFolderRefusal("invalid_path", "a run-folder path may not contain a NUL byte");
  }
  const normalized = path.normalize(raw);
  if (normalized.split(/[\\/]/).some((s) => s === "..")) {
    throw new RunFolderRefusal("path_escape", `run-folder path "${raw}" leaves the outputs folder`);
  }
  const abs = path.resolve(outputsRoot, normalized);
  if (abs !== outputsRoot && !abs.startsWith(outputsRoot + path.sep)) {
    throw new RunFolderRefusal("path_escape", `run-folder path "${raw}" escapes the run's outputs folder`);
  }
  await refuseSymlinksUnder(outputsRoot, abs);
  return { outputsRoot, abs, relPath: path.relative(outputsRoot, abs).split(path.sep).join("/") };
}

/** The bytes currently residing in this run's outputs folder. */
export async function runFolderUsageBytes(orgId: string, runId: string): Promise<number> {
  const files = await listRunOutputFiles({ orgId, runId });
  return files.reduce((sum, f) => sum + f.byteLength, 0);
}

export type RunOutputFile = {
  /** Path relative to the outputs folder, with `/` separators. */
  relPath: string;
  byteLength: number;
  /** Absolute path — host-side only; never handed to a caller of a tool. */
  absPath: string;
};

/** Every file in the run's outputs folder, deepest paths included, in a stable
 *  order. A symlink is not a file the pickup reads: it is skipped here and
 *  refused by every write, so one can only appear if something outside the
 *  application put it there. */
export async function listRunOutputFiles(input: {
  orgId: string;
  runId: string;
}): Promise<RunOutputFile[]> {
  const outputsRoot = runOutputsPath(input.orgId, input.runId);
  const out: RunOutputFile[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const abs = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const st = await fsp.stat(abs).catch(() => null);
      if (!st) continue;
      out.push({
        relPath: path.relative(outputsRoot, abs).split(path.sep).join("/"),
        byteLength: st.size,
        absPath: abs,
      });
    }
  }
  await walk(outputsRoot);
  out.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
  return out;
}

/**
 * Write one file into the run's outputs folder — the write half of the file
 * tools, and the landing place of the sandbox publish. Both caps are enforced
 * here, so no caller can reach the folder past them.
 */
export async function writeRunOutputFile(input: {
  orgId: string;
  runId: string;
  relPath: string;
  bytes: Uint8Array;
}): Promise<{ relPath: string; byteLength: number; sha256: string }> {
  const fileCap = runFolderFileCapBytes();
  if (input.bytes.byteLength > fileCap) {
    throw new RunFolderRefusal(
      "file_cap",
      `the file is ${input.bytes.byteLength} bytes; the run folder's per-file cap is ${fileCap} bytes`,
    );
  }
  const resolved = await resolveRunOutputPath(input);
  const existing = await fsp.stat(resolved.abs).catch(() => null);
  const used = await runFolderUsageBytes(input.orgId, input.runId);
  const after = used - (existing?.size ?? 0) + input.bytes.byteLength;
  const runCap = runFolderRunCapBytes();
  if (after > runCap) {
    throw new RunFolderRefusal(
      "run_cap",
      `writing ${input.bytes.byteLength} bytes would put this run at ${after} bytes; the per-run cap is ${runCap} bytes`,
    );
  }
  await fsp.mkdir(path.dirname(resolved.abs), { recursive: true });
  const handle = await openNoFollow(
    resolved.abs,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
  );
  try {
    await handle.writeFile(input.bytes);
  } finally {
    await handle.close();
  }
  return {
    relPath: resolved.relPath,
    byteLength: input.bytes.byteLength,
    sha256: createHash("sha256").update(input.bytes).digest("hex"),
  };
}

/** Read one file back out of the run's outputs folder, capped. */
export async function readRunOutputFile(input: {
  orgId: string;
  runId: string;
  relPath: string;
  maxBytes?: number;
}): Promise<{ relPath: string; byteLength: number; bytes: Buffer }> {
  const resolved = await resolveRunOutputPath(input);
  let handle: fsp.FileHandle;
  try {
    handle = await openNoFollow(resolved.abs, fsConstants.O_RDONLY);
  } catch (err) {
    if (err instanceof RunFolderRefusal) throw err;
    throw new RunFolderRefusal("not_found", `run-folder file "${input.relPath}" does not exist`);
  }
  try {
    // The size is read off THE OPEN HANDLE, so the file that is measured and the
    // file that is read are the same file — a name resolved twice is a name that
    // can mean two things.
    const st = await handle.stat();
    if (!st.isFile()) {
      throw new RunFolderRefusal("not_found", `run-folder file "${input.relPath}" does not exist`);
    }
    const cap = input.maxBytes ?? runFolderFileCapBytes();
    if (st.size > cap) {
      throw new RunFolderRefusal(
        "file_cap",
        `run-folder file "${input.relPath}" is ${st.size} bytes; the read cap is ${cap} bytes`,
      );
    }
    return { relPath: resolved.relPath, byteLength: st.size, bytes: await handle.readFile() };
  } finally {
    await handle.close();
  }
}

/** A byte stream over one output file — what the pickup hands the store, so the
 *  bytes are streamed once and never held whole in memory (item 0.22). */
export function runOutputFileStream(absPath: string): AsyncIterable<Uint8Array> {
  return createReadStream(absPath) as unknown as AsyncIterable<Uint8Array>;
}

/** sha256 of one output file, streamed. */
export async function hashRunOutputFile(absPath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absPath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type RunFolderPickupReceipt = {
  /** ISO instant the pickup finished reading this folder. */
  pickedUpAt: string;
  /** How many files the pickup read — evidence on the folder itself. */
  files: number;
};

/** Record that the pickup has read this folder. The retention tier deletes the
 *  folder at this instant plus the grace period — "never by artifact
 *  reachability" (item 0.21). */
export async function markRunFolderPickedUp(input: {
  orgId: string;
  runId: string;
  at: Date;
  files: number;
}): Promise<void> {
  const folder = runFolderPath(input.orgId, input.runId);
  const receipt: RunFolderPickupReceipt = {
    pickedUpAt: input.at.toISOString(),
    files: input.files,
  };
  await fsp.mkdir(folder, { recursive: true });
  await fsp.writeFile(path.join(folder, RUN_PICKUP_RECEIPT), JSON.stringify(receipt));
}

/** The pickup receipt, or null when the folder has not been picked up. */
export async function readRunFolderPickup(
  folderAbsPath: string,
): Promise<RunFolderPickupReceipt | null> {
  try {
    const raw = await fsp.readFile(path.join(folderAbsPath, RUN_PICKUP_RECEIPT), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      typeof (parsed as RunFolderPickupReceipt).pickedUpAt === "string"
    ) {
      return parsed as RunFolderPickupReceipt;
    }
    return null;
  } catch {
    return null;
  }
}

/** Delete one run's folder, bytes and all. Used by the retention tier and by a
 *  test that cleans up after itself; nothing else removes a run folder. */
export async function deleteRunFolder(orgId: string, runId: string): Promise<void> {
  await fsp.rm(runFolderPath(orgId, runId), { recursive: true, force: true });
}
