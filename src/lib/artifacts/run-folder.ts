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
import type { FileHandle } from "node:fs/promises";
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
 * Open the FINAL component with `O_NOFOLLOW`.
 *
 * `refuseSymlinksUnder` lstats the path before the open, which is a
 * check-then-use: a link dropped onto the target between the two would be
 * followed. `O_NOFOLLOW` closes that window on the component that matters — the
 * one bytes are read from and written to — inside the kernel, with no second
 * resolution of the name. The traversal above it keeps the blob store's own
 * containment rule, which is what plan §8.1 pins the tools to.
 */
async function openNoFollow(
  orgId: string,
  runId: string,
  relPath: string,
  flags: number,
  root: string,
): Promise<FileHandle> {
  // THE GATE, in the same breath as the open: the name the kernel is handed is
  // the one `containedRunOutputFilePath` validated segment by segment and proved
  // contained, never a string a caller carried in.
  const abs = containedRunOutputFilePath(orgId, runId, relPath, root);
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
 * cannot decode, so a picture read as text comes back as a lossy string that
 * hashes and stores as something the agent never wrote. The round trip is the
 * honest test — text that re-encodes to the same bytes is text, and anything
 * else is refused rather than silently corrupted. (W6 deliberately stops short
 * of pictures; W8 is the slice that gives bytes a road of their own.)
 */
export function decodeUtf8Exact(bytes: Buffer): string | null {
  const text = bytes.toString("utf8");
  return Buffer.from(text, "utf8").equals(bytes) ? text : null;
}

/** The ONE shape a path segment that reaches this module from OUTSIDE the
 *  process may have — an organisation, a run, a name inside the outputs folder:
 *  a plain identifier of letters, digits, dot, dash and underscore. An
 *  identifier and a UUID both have it; a separator, a `..`, a NUL byte and an
 *  encoded traversal do not. */
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9._-]{1,200}$/;

/** One path segment of the folder identity. A segment that is not a plain
 *  identifier is refused BEFORE any disk access — the same posture the blob
 *  store takes on its own scope segments. */
function safeSegment(
  value: string,
  what: string,
  reason: RunFolderRefusalReason = "invalid_scope",
): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new RunFolderRefusal(reason, `run folder ${what} must be a short non-empty id`);
  }
  if (!SAFE_PATH_SEGMENT.test(value)) {
    throw new RunFolderRefusal(
      reason,
      `run folder ${what} "${value}" is not a plain identifier (letters, digits, dot, dash, underscore)`,
    );
  }
  if (value === "." || value === "..") {
    throw new RunFolderRefusal(
      reason,
      `run folder ${what} "${value}" is not a plain identifier (letters, digits, dot, dash, underscore)`,
    );
  }
  return value;
}

/** A segment on the way to a run-folder path, and the word a refusal calls it
 *  by. */
type RunPathSegment = { value: string; what: string; reason?: RunFolderRefusalReason };

/**
 * THE ONE PATH GATE of the run folder.
 *
 * Every segment that originates outside the process — the organisation, the
 * run, and every component of a name inside the outputs folder — is validated
 * against `SAFE_PATH_SEGMENT` first, the path is then RESOLVED under the run
 * data root, and the result is PROVEN to stay inside that root: the path back
 * to the root may not climb out of it (`path.relative`, which is what an escape
 * shows as), and the resolved name must carry the resolved root as its prefix.
 * Anything else is a typed refusal thrown before a name reaches the filesystem.
 *
 * EVERY filesystem call in this module takes its path from HERE — the
 * `O_NOFOLLOW` open, the existing-size `stat` and the parent `mkdir` included —
 * so the check cannot be kept at two sites and forgotten at the third.
 */
function containedRunPath(
  segments: readonly RunPathSegment[],
  root: string = resolveRunDataRoot(),
): string {
  const checked: string[] = [];
  for (const segment of segments) {
    checked.push(safeSegment(segment.value, segment.what, segment.reason));
  }
  const resolved = path.resolve(root, ...checked);
  const back = path.relative(root, resolved);
  if (back.startsWith("..")) {
    throw new RunFolderRefusal("path_escape", "the run folder path leaves the run data root");
  }
  if (path.isAbsolute(back)) {
    throw new RunFolderRefusal("path_escape", "the run folder path leaves the run data root");
  }
  const insideRoot = resolved === root || resolved.startsWith(root + path.sep);
  if (!insideRoot) {
    throw new RunFolderRefusal("path_escape", "the run folder path leaves the run data root");
  }
  return resolved;
}

/** `<root>/<organisation>/<run>/` — the run's own folder. */
export function runFolderPath(orgId: string, runId: string, root?: string): string {
  return containedRunPath(
    [
      { value: orgId, what: "organisation" },
      { value: runId, what: "run" },
    ],
    root ?? resolveRunDataRoot(),
  );
}

/** `<root>/<organisation>/<run>/outputs` — the only place the pickup reads. */
export function runOutputsPath(orgId: string, runId: string, root?: string): string {
  return containedRunPath(
    [
      { value: orgId, what: "organisation" },
      { value: runId, what: "run" },
      { value: RUN_OUTPUTS_DIR, what: "outputs folder" },
    ],
    root ?? resolveRunDataRoot(),
  );
}

/**
 * The absolute path of ONE name inside a run's outputs folder, through the gate.
 *
 * `relPath` is relative to the outputs folder; "" and "." name the outputs
 * folder itself, which is what the parent `mkdir` is handed for a file that sits
 * directly in it.
 */
function containedRunOutputFilePath(
  orgId: string,
  runId: string,
  relPath: string,
  root: string = resolveRunDataRoot(),
): string {
  const segments: RunPathSegment[] = [
    { value: orgId, what: "organisation" },
    { value: runId, what: "run" },
    { value: RUN_OUTPUTS_DIR, what: "outputs folder" },
  ];
  // "" and "." reach here ONLY from this module's own `path.posix.dirname` of an
  // already-gated name (the parent of a file that sits directly in the outputs
  // folder). A caller's own components never arrive in that shape: they are
  // refused, one by one, in `resolveRunOutputPath` BEFORE any normalization.
  for (const component of relPath.split(/[\\/]/)) {
    if (component === "" || component === ".") continue;
    segments.push({ value: component, what: "file name", reason: "invalid_path" });
  }
  return containedRunPath(segments, root);
}

/** Refuse a symlink ANYWHERE on the path from the RUN DATA ROOT down to (and
 *  including) the target. A containment prefix test alone is satisfied by a link
 *  INSIDE the folder that resolves outside it, so the link itself is the thing
 *  refused: never followed, never written through.
 *
 *  The walk starts at the data root rather than at the outputs folder: a link
 *  standing where the ORGANISATION or the RUN directory should be is a path
 *  every check below it is blind to — one run's folder would read and write
 *  another run's files while every prefix test still passed (convergence round,
 *  cinatra#3030). */
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
export async function resolveRunOutputPath(
  input: {
    orgId: string;
    runId: string;
    relPath: string;
  },
  // The run data root, resolved ONCE by the operation that owns this call. The
  // root is configurable at runtime: re-reading it per call would let the path
  // this function CHECKS and the path a later filesystem call USES resolve under
  // two different roots (convergence round, fix leg 3).
  root: string = resolveRunDataRoot(),
): Promise<{ outputsRoot: string; abs: string; relPath: string }> {
  const outputsRoot = runOutputsPath(input.orgId, input.runId, root);
  const raw = input.relPath;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new RunFolderRefusal(
      "invalid_path",
      "a run-folder path must be a non-empty relative path",
    );
  }
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw new RunFolderRefusal(
      "invalid_path",
      `run-folder path "${raw}" must be relative to the outputs folder`,
    );
  }
  if (raw.includes("\0")) {
    throw new RunFolderRefusal("invalid_path", "a run-folder path may not contain a NUL byte");
  }
  // THE GATE, on the caller's OWN components, BEFORE normalization: a component
  // that is not a plain identifier must be refused even when normalizing would
  // make it vanish ("bad name/../report.md" normalizes to "report.md"), and an
  // empty component — a leading, doubled or trailing separator, a backslash-
  // rooted name on a POSIX host — is not a name this folder accepts either.
  for (const component of raw.split(/[\\/]/)) {
    if (component === "..") {
      throw new RunFolderRefusal(
        "path_escape",
        `run-folder path "${raw}" leaves the outputs folder`,
      );
    }
    safeSegment(component, "file name", "invalid_path");
  }
  const normalized = path.normalize(raw);
  if (normalized.split(/[\\/]/).some((s) => s === "..")) {
    throw new RunFolderRefusal("path_escape", `run-folder path "${raw}" leaves the outputs folder`);
  }
  // THE GATE: every component validated, the path resolved, containment proved
  // against the run data root before any of it reaches the filesystem.
  const abs = containedRunOutputFilePath(input.orgId, input.runId, normalized, root);
  if (abs !== outputsRoot && !abs.startsWith(outputsRoot + path.sep)) {
    throw new RunFolderRefusal(
      "path_escape",
      `run-folder path "${raw}" escapes the run's outputs folder`,
    );
  }
  await refuseSymlinksUnder(root, abs);
  return { outputsRoot, abs, relPath: path.relative(outputsRoot, abs).split(path.sep).join("/") };
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
  // The listing walks the folder, so it takes the SAME ancestor check the read
  // and the write take: a link standing where this run's folder should be would
  // otherwise hand back another run's file names and sizes.
  await refuseSymlinksUnder(resolveRunDataRoot(), outputsRoot);
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

/** The bytes currently residing in this run's outputs folder. */
export async function runFolderUsageBytes(orgId: string, runId: string): Promise<number> {
  const files = await listRunOutputFiles({ orgId, runId });
  return files.reduce((sum, f) => sum + f.byteLength, 0);
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
  // ONE root for the whole write: the name that is checked and the name that is
  // opened cannot resolve under two different roots.
  const root = resolveRunDataRoot();
  const resolved = await resolveRunOutputPath(input, root);
  // The stat, the mkdir and the open below take their path FROM THE GATE, so no
  // filesystem call here can be reached with a name that skipped it.
  const target = containedRunOutputFilePath(input.orgId, input.runId, resolved.relPath, root);
  const existing = await fsp.stat(target).catch(() => null);
  const used = await runFolderUsageBytes(input.orgId, input.runId);
  const after = used - (existing?.size ?? 0) + input.bytes.byteLength;
  const runCap = runFolderRunCapBytes();
  if (after > runCap) {
    throw new RunFolderRefusal(
      "run_cap",
      `writing ${input.bytes.byteLength} bytes would put this run at ${after} bytes; the per-run cap is ${runCap} bytes`,
    );
  }
  const parent = containedRunOutputFilePath(
    input.orgId,
    input.runId,
    path.posix.dirname(resolved.relPath),
    root,
  );
  await fsp.mkdir(parent, { recursive: true });
  const handle = await openNoFollow(
    input.orgId,
    input.runId,
    resolved.relPath,
    fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC,
    root,
  );
  try {
    await handle.writeFile(Buffer.from(input.bytes));
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
  // ONE root for the whole read, as on the write road.
  const root = resolveRunDataRoot();
  const resolved = await resolveRunOutputPath(input, root);
  let handle: FileHandle;
  try {
    handle = await openNoFollow(
      input.orgId,
      input.runId,
      resolved.relPath,
      fsConstants.O_RDONLY,
      root,
    );
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

/** A byte stream over one output file — what the pickup hands the store when a
 *  byte-shaped write path exists, so the bytes are streamed once and never held
 *  whole in memory (item 0.22). */
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
