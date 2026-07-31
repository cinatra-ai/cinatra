/**
 * The DURABLE AUDIT SPOOL (cinatra#2266 slice 2 — design gaps G1 + G2).
 *
 * WHAT THIS REPLACES. Until this module the broker's audit relay was two plain
 * arrays in the broker process, and `drainAudit` REMOVED what it returned at
 * the moment the response was built — before it was serialized, before it left
 * the process, and long before anyone confirmed a write. A broker restart lost
 * what it was holding; an app that died after the pull lost records that had
 * already been deleted from the only copy that existed. That is at-most-once
 * delivery of the only record that a model's sandbox command happened at all.
 *
 * WHAT IT PROVIDES, precisely:
 *
 *  1. A BOUNDED, CRASH-SAFE, APPEND-ONLY LOG on the broker's own volume. Every
 *     append is `write()` + `fsync()` before it is considered emitted. The
 *     bound is on BYTES ON DISK, not on a record count, because the thing that
 *     must not happen is filling the volume.
 *
 *  2. A PHYSICAL DELIVERY IDENTITY (G2). Every deliverable frame carries a
 *     spool-local, strictly monotonic `deliveryId`, and the ACK/de-dup key is
 *     `<spoolId>:<deliveryId>`. The D6 design's `jobId + seq + decision` stays
 *     on the record as the LOGICAL correlation key — it is not what the ACK
 *     protocol keys on, and it cannot be: pre-dispatch refusals have no
 *     dispatch sequence, two same-decision refusals on one job would collide,
 *     and `decision` in the key lets contradictory records share one sequence.
 *
 *  3. A DURABLE PRE-DISPATCH RESERVATION (G1). `reserve()` writes a prepared
 *     record — and reserves the capacity its terminal form will need — BEFORE
 *     the command is dispatched, and returns the delivery identity that the
 *     terminal record will be committed under. A reservation or fsync failure
 *     THROWS, and the broker's contract is that a throw here prevents dispatch:
 *     an execution the plane cannot account for must not happen. A crash
 *     between dispatch and completion leaves the reservation unresolved, and
 *     the next `open()` converts it into an explicit `outcome_unknown` record
 *     rather than letting the command vanish.
 *
 *  4. READ-THEN-ACK, NOT A DESTRUCTIVE TAKE. `read()` is a pure read: repeating
 *     it returns the same head. Frames leave the spool only in `ack()`, which
 *     refuses a stale head, a head that is not an exact delivered position, and
 *     a head presented against a different `spoolId`.
 *
 * WHAT IS DELIBERATELY NOT HERE (slice 3, and named so the boundary is not
 * discovered later):
 *
 *  - G3 FLEET ROUTING. The `spoolId` below is a per-volume identity, persisted
 *     in the spool's own metadata, and every read/ACK carries it — that much is
 *     forced by G2 (a delivery key must be unique across the fleet, or the
 *     kernel's unique index would collapse two replicas' records into one). The
 *     REST of G3 — sticky job routing so a replica's records are only ever
 *     ACKed by a reader that read them, and the fleet-level misdelivery
 *     analysis — is not in this slice.
 *  - G5 SATURATION. A full spool here refuses the RESERVATION, which refuses
 *     the command (fail-closed, the correct direction). The bounded
 *     `audit_spool_full` EPISODE record, the "do not mint a record per refused
 *     attempt" rule and the defined reopen condition are slice 3. This module
 *     counts refused reservations in memory (`stats().refusedReservations`) so
 *     the episode has something true to be built from.
 *
 * SINGLE WRITER. The log is append-only from ONE process. A second writer
 * against the same directory is refused (`AuditSpoolLockedError`) rather than
 * interleaved — two writers appending to one log is how a spool silently
 * corrupts itself.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

import type { ExecutionAuditRecord } from "../types";

/** On-disk format version. A mismatch is refused, never coerced. */
export const AUDIT_SPOOL_FORMAT_VERSION = 1;

/** Default byte ceiling for the log file. */
export const DEFAULT_AUDIT_SPOOL_MAX_BYTES = 64 * 1024 * 1024;

/**
 * Headroom reserved for the TERMINAL form of a prepared record, on top of the
 * prepared frame itself. The reservation exists precisely so that committing a
 * command that HAS RUN can never fail for space, so this has to be a real upper
 * bound on what the terminal record adds — not a round number (Codex round 3,
 * adopted: at 4 KiB it was not).
 *
 * THE ARITHMETIC, against what `ExecutionBroker.buildAuditRecord` actually adds
 * to the prepared record:
 *
 *   egressDestinations   32 entries × (253-byte host cap + port + allowed +
 *                        JSON punctuation ≈ 45 B)               ≈  9 536 B
 *   imageDigest          capped at 512 B by the builder         ≈     512 B
 *   exitCode, termination, wallMs, workspaceKb,
 *   egressTotalBytes, egressDestinationsTotal, reason           <     256 B
 *   slack                                                       <   1 984 B
 *                                                               ── 12 288 B
 *
 * The caps are BYTE caps, not code-unit caps, and that distinction is load
 * bearing: the builder narrows a host and a digest to characters whose JSON
 * encoding is one byte each and which `JSON.stringify` never escapes, so their
 * length IS their encoded size (`boundAuditText` in `broker.ts`). A plain
 * `.slice()` would not bound anything — 253 three-byte characters are 759
 * bytes, and one control character escapes to six. Change a cap there and
 * change this constant with it.
 */
export const AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES = 12_288;

export class AuditSpoolFullError extends Error {
  readonly code = "audit_spool_full" as const;
  constructor(message: string) {
    super(message);
    this.name = "AuditSpoolFullError";
  }
}

export class AuditSpoolCorruptError extends Error {
  readonly code = "audit_spool_corrupt" as const;
  constructor(message: string) {
    super(message);
    this.name = "AuditSpoolCorruptError";
  }
}

export class AuditSpoolLockedError extends Error {
  readonly code = "audit_spool_locked" as const;
  constructor(message: string) {
    super(message);
    this.name = "AuditSpoolLockedError";
  }
}

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

/**
 * `reserved` — a prepared record written before dispatch. NEVER delivered: it
 * is bookkeeping that says "a command was authorized and handed to the sandbox
 * under this delivery identity". It is resolved either by its terminal
 * `record` frame or, after a crash, by recovery minting the `outcome_unknown`
 * terminal form for it.
 *
 * `record` — a deliverable audit record. Exactly these are what `read()`
 * returns and what an ACK removes.
 */
export type SpoolFrameKind = "reserved" | "record";

type SpoolFrame = {
  /** Append order. Strictly increasing, persisted, stable across rewrites. */
  pos: number;
  /** Delivery identity. A terminal frame REUSES its reservation's id. */
  deliveryId: number;
  kind: SpoolFrameKind;
  record: ExecutionAuditRecord;
};

export type AuditSpoolReservation = {
  /** `<spoolId>:<deliveryId>` — the ACK/de-dup key the terminal record rides. */
  deliveryKey: string;
  deliveryId: number;
  /** Write the terminal record under this reservation's delivery identity. */
  commit(record: ExecutionAuditRecord): Promise<void>;
};

export type AuditSpoolReadResult = {
  /** Deliverable records, in producer order, each stamped with `deliveryKey`. */
  entries: ExecutionAuditRecord[];
  /**
   * The ACK cursor for this batch: the `pos` of the last entry returned, or
   * the current watermark when the batch is empty. ACKing it commits exactly
   * this prefix.
   */
  head: number;
  /** Deliverable records beyond `head` still in the spool. */
  remaining: number;
};

export type AuditSpoolAckResult =
  | { ok: true; head: number; removed: number; remaining: number }
  | {
      ok: false;
      reason: "wrong_spool" | "stale_head" | "unknown_head";
      message: string;
    };

export type AuditSpoolStats = {
  frames: number;
  bytes: number;
  maxBytes: number;
  openReservations: number;
  head: number;
  acked: number;
  /** Reservations refused because the spool could not accept them. */
  refusedReservations: number;
  /** Records recovered as `outcome_unknown` since this process opened. */
  recoveredUnknown: number;
};

export type AuditSpool = {
  readonly spoolId: string;
  /** False for the in-memory spool — an honest signal, never a silent one. */
  readonly durable: boolean;
  /** Append a terminal record that had no reservation (every refusal path). */
  append(record: ExecutionAuditRecord): Promise<string>;
  /** G1: prepare + reserve capacity BEFORE dispatch. Throws ⇒ do not dispatch. */
  reserve(prepared: ExecutionAuditRecord): Promise<AuditSpoolReservation>;
  read(limit?: number): AuditSpoolReadResult;
  ack(input: { spoolId: string; head: number }): Promise<AuditSpoolAckResult>;
  stats(): AuditSpoolStats;
  close(): Promise<void>;
};

// ---------------------------------------------------------------------------
// Framing: one line per frame, integrity-checked
// ---------------------------------------------------------------------------

/**
 * `<digest16> <json>\n`. The digest is what makes a TORN append detectable:
 * a partially-flushed line either has no terminating newline or does not hash
 * to its own digest, and either way it is never read back as a good record.
 */
function frameDigest(json: string): string {
  return createHash("sha256").update(json).digest("hex").slice(0, 16);
}

function encodeFrame(frame: SpoolFrame): string {
  const json = JSON.stringify(frame);
  return `${frameDigest(json)} ${json}\n`;
}

function decodeFrame(line: string): SpoolFrame | null {
  const sep = line.indexOf(" ");
  if (sep !== 16) return null;
  const digest = line.slice(0, sep);
  const json = line.slice(sep + 1);
  if (frameDigest(json) !== digest) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const frame = parsed as Partial<SpoolFrame>;
  if (
    !Number.isSafeInteger(frame.pos) ||
    !Number.isSafeInteger(frame.deliveryId) ||
    (frame.kind !== "reserved" && frame.kind !== "record") ||
    !frame.record ||
    typeof frame.record !== "object"
  ) {
    return null;
  }
  return frame as SpoolFrame;
}

// ---------------------------------------------------------------------------
// Storage seam — the state machine above is IDENTICAL for both placements
// ---------------------------------------------------------------------------

/**
 * THE OPEN PATH IS SYNCHRONOUS, THE RUNTIME PATH IS NOT — and that split is
 * deliberate. Opening happens once, inside the broker's boot composition, which
 * is synchronous by design (`composeBrokerService` validates every scoped-env
 * acknowledgement and throws; making it async to accommodate a file read would
 * ripple through every entrypoint and every composition test for no gain).
 * Appending, acknowledging and rewriting happen on the command path, where a
 * synchronous `fsync` would block the broker's HTTP server for every record.
 */
type SpoolStorage = {
  readonly durable: boolean;
  /** The persisted spool identity (created on first open). OPEN PATH. */
  identity(): { spoolId: string };
  /** Every persisted line, plus the byte size of the log. OPEN PATH. */
  load(): { lines: string[]; tornTail: boolean; bytes: number };
  /** OPEN PATH: append + fsync one recovery frame. */
  appendLineSync(line: string): void;
  /** OPEN PATH: atomically replace the log; returns the new byte size. */
  rewriteSync(lines: string[]): number;
  /** OPEN PATH: persist the watermark + high-water mark durably. */
  writeAckSync(pos: number, nextPos: number): void;
  /** The committed watermark AND the position high-water mark. */
  readAck(): { acked: number; nextPos: number };
  /** Append + fsync ONE frame line. Resolves only when it is durable. */
  appendLine(line: string): Promise<void>;
  /** Replace the whole log atomically with these lines; returns new byte size. */
  rewrite(lines: string[]): Promise<number>;
  /** Persist the ACK watermark + the position high-water mark, BEFORE the log
   *  is rewritten. */
  writeAck(pos: number, nextPos: number): Promise<void>;
  close(): Promise<void>;
};

const LOG_FILE = "audit-spool.log";
const META_FILE = "audit-spool.meta.json";
const ACK_FILE = "audit-spool.ack.json";
const LOCK_FILE = "audit-spool.lock";

async function fsyncDir(dir: string): Promise<void> {
  // Directory fsync is what makes a rename durable. Not every platform
  // supports it (Windows); a failure here must not take the spool down —
  // the file's own fsync already happened.
  let handle: fsp.FileHandle | undefined;
  try {
    handle = await fsp.open(dir, "r");
    await handle.sync();
  } catch {
    /* best effort, by design */
  } finally {
    await handle?.close().catch(() => {});
  }
}

function takeLock(dir: string): () => void {
  const lockPath = path.join(dir, LOCK_FILE);
  const claim = (): boolean => {
    try {
      fs.writeFileSync(lockPath, `${process.pid}\n`, { flag: "wx" });
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return false;
    }
  };
  if (!claim()) {
    // A lock left behind by a KILLED process must not wedge the spool forever
    // — that would turn a crash into a permanent outage. A lock held by a LIVE
    // process is refused: two writers appending to one log is how a spool
    // silently corrupts itself.
    const holder = Number.parseInt(fs.readFileSync(lockPath, "utf8").trim(), 10);
    let alive = false;
    if (Number.isInteger(holder) && holder > 0) {
      try {
        process.kill(holder, 0);
        alive = true;
      } catch (err) {
        // EPERM means the process EXISTS and belongs to another user — a live
        // writer this one merely cannot signal (Codex round 2, adopted).
        // Treating every error as death would steal a lock from a running
        // broker under a different UID and put two writers on one append log.
        // Only ESRCH ("no such process") is evidence of death; anything else
        // is treated as alive, which is the fail-closed direction.
        alive = (err as NodeJS.ErrnoException).code !== "ESRCH";
      }
    }
    if (alive) {
      throw new AuditSpoolLockedError(
        `The audit spool at this volume is already held by a live writer (pid ${holder}); ` +
          "a second writer is refused (the spool is single-writer by construction).",
      );
    }
    // THE STEAL IS A RENAME, NOT AN UNLINK (Codex convergence, adopted —
    // finding 6). `rmSync` + `wx` looks atomic and is not: two starters can
    // both observe the same dead holder, and the second one's `rmSync` deletes
    // the FIRST one's freshly-claimed lock, leaving two live writers on one
    // append log. `renameSync` moves the exact stale inode and succeeds for
    // AT MOST ONE racer; every other racer gets ENOENT and refuses rather than
    // clearing a lock it did not observe.
    const stolen = `${lockPath}.stale-${process.pid}-${randomUUID()}`;
    try {
      fs.renameSync(lockPath, stolen);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new AuditSpoolLockedError(
          "The audit spool's stale lock was reclaimed by another starter while this one was " +
            "reading it; refusing rather than racing a second writer onto the same log.",
        );
      }
      throw err;
    }
    fs.rmSync(stolen, { force: true });
    if (!claim()) {
      throw new AuditSpoolLockedError(
        "The audit spool lock could not be claimed after clearing a stale holder.",
      );
    }
  }
  return () => fs.rmSync(lockPath, { force: true });
}

function fsyncDirSync(dir: string): void {
  let fd: number | undefined;
  try {
    fd = fs.openSync(dir, "r");
    fs.fsyncSync(fd);
  } catch {
    /* best effort, by design (see fsyncDir) */
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

function createFileStorage(dir: string): SpoolStorage {
  fs.mkdirSync(dir, { recursive: true });
  const releaseLock = takeLock(dir);
  const logPath = path.join(dir, LOG_FILE);
  const metaPath = path.join(dir, META_FILE);
  const ackPath = path.join(dir, ACK_FILE);
  let handle: fsp.FileHandle | undefined;

  const openAppend = async (): Promise<fsp.FileHandle> => {
    handle ??= await fsp.open(logPath, "a");
    return handle;
  };

  const writeFileDurablySync = (target: string, body: string): void => {
    const tmpPath = `${target}.tmp`;
    const fd = fs.openSync(tmpPath, "w");
    try {
      fs.writeFileSync(fd, body, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmpPath, target);
    fsyncDirSync(dir);
  };

  const splitLog = (raw: string): { lines: string[]; tornTail: boolean; bytes: number } => {
    const parts = raw.split("\n");
    // A well-formed log ends in a newline, so the last split element is "".
    // Anything else is a partially-flushed final line — a torn append.
    const trailing = parts.pop() ?? "";
    return {
      lines: parts,
      tornTail: trailing.length > 0,
      bytes: Buffer.byteLength(raw, "utf8") - Buffer.byteLength(trailing, "utf8"),
    };
  };

  return {
    durable: true,
    identity() {
      let raw: string | undefined;
      try {
        raw = fs.readFileSync(metaPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      }
      if (raw !== undefined) {
        const parsed = JSON.parse(raw) as { version?: number; spoolId?: string };
        if (parsed.version !== AUDIT_SPOOL_FORMAT_VERSION) {
          throw new AuditSpoolCorruptError(
            `The audit spool on this volume declares format version ${String(parsed.version)}, ` +
              `this build speaks ${AUDIT_SPOOL_FORMAT_VERSION}; refusing to read it (fail-closed).`,
          );
        }
        if (typeof parsed.spoolId !== "string" || parsed.spoolId.length === 0) {
          throw new AuditSpoolCorruptError(
            "The audit spool metadata on this volume carries no spoolId; refusing to read it.",
          );
        }
        return { spoolId: parsed.spoolId };
      }
      const spoolId = randomUUID();
      writeFileDurablySync(
        metaPath,
        `${JSON.stringify({ version: AUDIT_SPOOL_FORMAT_VERSION, spoolId })}\n`,
      );
      return { spoolId };
    },
    load() {
      try {
        return splitLog(fs.readFileSync(logPath, "utf8"));
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        return { lines: [], tornTail: false, bytes: 0 };
      }
    },
    appendLineSync(line) {
      const fd = fs.openSync(logPath, "a");
      try {
        fs.writeFileSync(fd, line, "utf8");
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    },
    rewriteSync(lines) {
      const body = lines.join("");
      writeFileDurablySync(logPath, body);
      return Buffer.byteLength(body, "utf8");
    },
    writeAckSync(pos, nextPos) {
      writeFileDurablySync(ackPath, `${JSON.stringify({ acked: pos, nextPos })}\n`);
    },
    readAck() {
      let raw: string;
      try {
        raw = fs.readFileSync(ackPath, "utf8");
      } catch (err) {
        // ABSENT is a real answer: a spool that has never been acknowledged.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return { acked: 0, nextPos: 0 };
        }
        throw err;
      }
      // PRESENT-BUT-UNREADABLE is not (Codex convergence, adopted — finding 4).
      // Treating it as zero would re-deliver an already-committed prefix AND —
      // worse — restart the position counter, so a genuinely new record could
      // be minted under a delivery key the kernel has already seen and would
      // de-duplicate away. Refuse to read the spool instead.
      let parsed: { acked?: unknown; nextPos?: unknown };
      try {
        parsed = JSON.parse(raw) as { acked?: unknown; nextPos?: unknown };
      } catch {
        throw new AuditSpoolCorruptError(
          "The audit spool's acknowledgement watermark on this volume is unreadable; refusing " +
            "to open the spool (reading it as zero would re-issue delivery identities the " +
            "authz kernel has already recorded).",
        );
      }
      if (!Number.isSafeInteger(parsed.acked)) {
        throw new AuditSpoolCorruptError(
          "The audit spool's acknowledgement watermark on this volume carries no valid " +
            "position; refusing to open the spool.",
        );
      }
      return {
        acked: parsed.acked as number,
        nextPos: Number.isSafeInteger(parsed.nextPos) ? (parsed.nextPos as number) : 0,
      };
    },
    async appendLine(line) {
      const fh = await openAppend();
      await fh.writeFile(line, "utf8");
      await fh.sync();
    },
    async rewrite(lines) {
      const tmpPath = `${logPath}.tmp`;
      const body = lines.join("");
      const tmp = await fsp.open(tmpPath, "w");
      try {
        await tmp.writeFile(body, "utf8");
        await tmp.sync();
      } finally {
        await tmp.close();
      }
      await handle?.close().catch(() => {});
      handle = undefined;
      await fsp.rename(tmpPath, logPath);
      await fsyncDir(dir);
      return Buffer.byteLength(body, "utf8");
    },
    async writeAck(pos, nextPos) {
      const tmpPath = `${ackPath}.tmp`;
      const tmp = await fsp.open(tmpPath, "w");
      try {
        // `nextPos` is a HIGH-WATER MARK, persisted alongside the watermark
        // (Codex convergence, adopted — finding 4). Without it, a crash between
        // this write and the log rewrite that empties the log entirely would
        // restart the position counter at 1 and re-issue delivery keys the
        // kernel already holds — which the kernel would then de-duplicate away,
        // silently losing a NEW record.
        await tmp.writeFile(`${JSON.stringify({ acked: pos, nextPos })}\n`, "utf8");
        await tmp.sync();
      } finally {
        await tmp.close();
      }
      await fsp.rename(tmpPath, ackPath);
      await fsyncDir(dir);
    },
    async close() {
      await handle?.close().catch(() => {});
      handle = undefined;
      releaseLock();
    },
  };
}

function createMemoryStorage(): SpoolStorage {
  let lines: string[] = [];
  let acked = 0;
  let ackedNextPos = 0;
  const spoolId = randomUUID();
  const size = (): number => lines.reduce((n, l) => n + Buffer.byteLength(l, "utf8"), 0);
  return {
    durable: false,
    identity: () => ({ spoolId }),
    load: () => ({ lines: [...lines], tornTail: false, bytes: size() }),
    appendLineSync(line) {
      lines.push(line);
    },
    rewriteSync(next) {
      lines = [...next];
      return size();
    },
    writeAckSync(pos, nextPos) {
      acked = pos;
      ackedNextPos = nextPos;
    },
    readAck: () => ({ acked, nextPos: ackedNextPos }),
    async appendLine(line) {
      lines.push(line);
    },
    async rewrite(next) {
      lines = [...next];
      return size();
    },
    async writeAck(pos, nextPos) {
      acked = pos;
      ackedNextPos = nextPos;
    },
    async close() {
      lines = [];
    },
  };
}

// ---------------------------------------------------------------------------
// The spool state machine
// ---------------------------------------------------------------------------

export type OpenAuditSpoolOptions = {
  /** Directory on the broker's own volume. Omit for the in-memory placement. */
  dir?: string;
  maxBytes?: number;
  nowMs?: () => number;
};

function buildSpool(storage: SpoolStorage, opts: OpenAuditSpoolOptions): AuditSpool {
  const maxBytes = opts.maxBytes ?? DEFAULT_AUDIT_SPOOL_MAX_BYTES;
  const now = opts.nowMs ?? (() => Date.now());
  const { spoolId } = storage.identity();

  const frames: SpoolFrame[] = [];
  let bytes = 0;
  let nextPos = 1;
  let ackedPos = 0;
  let reservedHeadroom = 0;
  let refusedReservations = 0;
  let recoveredUnknown = 0;
  /**
   * The highest `head` this spool has actually HANDED OUT (Codex convergence,
   * adopted — finding 3). An ACK is a statement about a batch the caller read;
   * validating only that the position exists would let a head nobody was ever
   * given delete records that were never delivered. Reset to the watermark on
   * every open: after a restart nothing has been issued yet, so the app must
   * re-read before it can acknowledge anything.
   */
  let maxIssuedHead = 0;
  const openReservations = new Map<number, SpoolFrame>();

  const deliveryKeyFor = (deliveryId: number): string => `${spoolId}:${deliveryId}`;

  // --- recovery -----------------------------------------------------------
  const loaded = storage.load();
  const watermark = storage.readAck();
  ackedPos = watermark.acked;
  maxIssuedHead = ackedPos;
  // POSITIONS ARE NEVER REUSED — three independent lower bounds, and each one
  // closes a different hole:
  //  - `ackedPos + 1`, because a restart can carry an OPEN reservation past an
  //    acknowledged prefix, and `read()` delivers only `pos > ackedPos`: a
  //    recovery frame minted at or below the watermark would exist on disk and
  //    never be delivered, which is the exact silence G1 exists to prevent;
  //  - the persisted high-water mark, because a crash between the watermark
  //    write and a rewrite that empties the log would otherwise restart the
  //    counter at 1 and re-issue delivery keys the kernel already holds (Codex
  //    convergence, adopted);
  //  - the highest surviving frame, below.
  nextPos = Math.max(nextPos, ackedPos + 1, watermark.nextPos);
  const terminalIds = new Set<number>();
  let droppedTailFrame = false;
  for (let i = 0; i < loaded.lines.length; i += 1) {
    const line = loaded.lines[i]!;
    const frame = decodeFrame(line);
    if (!frame) {
      // A bad frame at the very END of the log is a torn append — the only
      // place a single writer can produce one. Anywhere else it is corruption
      // that would silently reorder or drop live records, so it is REFUSED
      // rather than skipped.
      if (i === loaded.lines.length - 1) {
        droppedTailFrame = true;
        break;
      }
      throw new AuditSpoolCorruptError(
        `The audit spool log holds an unreadable frame at line ${i + 1} of ` +
          `${loaded.lines.length}; refusing to read past it (a corrupt frame is never ` +
          "read as a good record).",
      );
    }
    frames.push(frame);
    if (frame.kind === "record") terminalIds.add(frame.deliveryId);
    nextPos = Math.max(nextPos, frame.pos + 1);
  }
  // COMPACT THE ACKNOWLEDGED PREFIX AT OPEN, by the same rule `ack()` applies
  // (Codex convergence, adopted — finding 5). A crash between the watermark
  // write and the log rewrite leaves frames on disk that the app has already
  // committed. They are correctly never re-delivered (`read()` filters on
  // `ackedPos`), but they still occupy the byte bound — so an almost-full,
  // fully-acknowledged log would restart logically empty and refuse every new
  // reservation, with no future ACK able to trigger the compaction that would
  // free it. Open-reservation frames are carried forward, exactly as in `ack()`.
  const committedIds = new Set(
    frames.filter((f) => f.kind === "record").map((f) => f.deliveryId),
  );
  const live = frames.filter(
    (f) =>
      f.pos > ackedPos ||
      (f.kind === "reserved" && !committedIds.has(f.deliveryId)),
  );
  const compacted = live.length !== frames.length;
  frames.length = 0;
  frames.push(...live);

  // The torn tail (and anything after a broken frame) never happened.
  // A DROPPED TAIL FRAME STILL CONSUMED A POSITION (Codex round 2, adopted).
  // A partially-flushed append, or a complete line whose digest does not match,
  // is discarded above — but the writer had already allocated its position, so
  // reusing it would mint a SECOND record under a delivery key that may already
  // have reached the kernel. A single writer can leave at most one such frame,
  // and it is always the last, so its position is exactly one past the highest
  // frame that did decode.
  if (loaded.tornTail || droppedTailFrame) nextPos += 1;

  bytes = frames.reduce((n, f) => n + Buffer.byteLength(encodeFrame(f), "utf8"), 0);
  if (loaded.tornTail || droppedTailFrame || compacted || bytes !== loaded.bytes) {
    // The torn tail (and anything after it) is REMOVED from the file, not just
    // skipped in memory: a later append would otherwise be written after a
    // partial frame and the log would never parse again.
    bytes = storage.rewriteSync(frames.map(encodeFrame));
  }

  const appendFrame = async (frame: SpoolFrame, headroom: number): Promise<void> => {
    const line = encodeFrame(frame);
    const len = Buffer.byteLength(line, "utf8");
    if (bytes + reservedHeadroom + len + headroom > maxBytes) {
      throw new AuditSpoolFullError(
        `The audit spool is at its ${maxBytes}-byte bound (${bytes} bytes on disk, ` +
          `${reservedHeadroom} reserved); it cannot accept another record.`,
      );
    }
    await storage.appendLine(line);
    frames.push(frame);
    bytes += len;
    nextPos = Math.max(nextPos, frame.pos + 1);
  };

  // Unresolved reservations from a previous life become explicit
  // `outcome_unknown` records — the G1 property: a crash between dispatch and
  // completion surfaces as a record, never as silence.
  for (const frame of frames.filter((f) => f.kind === "reserved")) {
    if (terminalIds.has(frame.deliveryId)) continue;
    const unknown: SpoolFrame = {
      pos: nextPos,
      deliveryId: frame.deliveryId,
      kind: "record",
      record: {
        ...frame.record,
        decision: "outcome_unknown",
        reason: "outcome_unknown",
        deliveryKey: deliveryKeyFor(frame.deliveryId),
        atMs: now(),
      },
    };
    // Recovery must never be the thing that fails for space: the headroom for
    // this exact frame was reserved before the command was dispatched.
    const line = encodeFrame(unknown);
    storage.appendLineSync(line);
    frames.push(unknown);
    bytes += Buffer.byteLength(line, "utf8");
    nextPos += 1;
    terminalIds.add(frame.deliveryId);
    recoveredUnknown += 1;
  }

  // PERSIST THE HIGH-WATER MARK THAT RECOVERY JUST MOVED (Codex round 3,
  // adopted — finding 4). The bump for a dropped tail frame, and the positions
  // the `outcome_unknown` frames above consumed, live only in memory until
  // something writes them down. A broker that opened, recovered and then closed
  // WITHOUT appending or acknowledging anything would lose the bump — and the
  // next open would hand out a position, and therefore a delivery key, that a
  // discarded frame had already used and that the kernel may already hold.
  // One fsync at boot, and only when the mark actually moved.
  if (nextPos > watermark.nextPos) storage.writeAckSync(ackedPos, nextPos);

  // --- writes -------------------------------------------------------------

  /** Serializes appends: the log is append-ONLY and single-writer. */
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };

  const spool: AuditSpool = {
    spoolId,
    durable: storage.durable,

    append(record) {
      return serialize(async () => {
        const pos = nextPos;
        const deliveryKey = deliveryKeyFor(pos);
        await appendFrame(
          { pos, deliveryId: pos, kind: "record", record: { ...record, deliveryKey } },
          0,
        );
        return deliveryKey;
      });
    },

    reserve(prepared) {
      return serialize(async () => {
        const pos = nextPos;
        const deliveryKey = deliveryKeyFor(pos);
        const frame: SpoolFrame = {
          pos,
          deliveryId: pos,
          kind: "reserved",
          record: { ...prepared, deliveryKey },
        };
        // THE HEADROOM IS SIZED FROM THIS RECORD, not from a flat constant
        // (Codex convergence, adopted — finding 2). The terminal frame REPEATS
        // the whole prepared record and adds the command's outcome, so a flat
        // 4 KiB reservation under-reserves for any record whose own frame is
        // larger than that — a long command line is enough — and the commit
        // that must never fail for space would push the file past the bound by
        // an amount nothing had accounted for.
        const headroom =
          Buffer.byteLength(encodeFrame(frame), "utf8") + AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES;
        try {
          // The headroom argument is what makes the RESERVATION the point of
          // refusal: capacity for the terminal record is claimed here, so a
          // command that was admitted can always be recorded.
          await appendFrame(frame, headroom);
        } catch (err) {
          refusedReservations += 1;
          throw err;
        }
        reservedHeadroom += headroom;
        openReservations.set(pos, frame);
        let settled = false;
        let committing = false;
        return {
          deliveryKey,
          deliveryId: pos,
          commit: (record: ExecutionAuditRecord) =>
            serialize(async () => {
              // Re-entrancy guard as well as a settled guard (Codex round 2,
              // adopted): the broker calls `commit` exactly once per
              // reservation, and a concurrent second call must not append a
              // second terminal frame.
              //
              // WHAT A FAILED `fsync` LEAVES, stated rather than glossed: the
              // bytes may be on disk while this rejects, so a host that DID
              // retry could produce two terminal frames for one reservation.
              // Both carry the SAME delivery key, so recovery reads them as one
              // resolved reservation and the kernel's unique delivery key
              // collapses them into one row — the at-least-once contract
              // absorbing a duplicate, which is exactly what it is for.
              if (settled || committing) return;
              committing = true;
              const terminal: SpoolFrame = {
                pos: nextPos,
                deliveryId: pos,
                kind: "record",
                record: { ...record, deliveryKey },
              };
              const line = encodeFrame(terminal);
              // NOT bound-checked. The command HAS RUN; the capacity was
              // reserved before it was dispatched, and a record of a real
              // execution is never the thing this bound is allowed to drop.
              await storage.appendLine(line);
              // THE RESERVATION IS CLOSED ONLY AFTER THE TERMINAL FRAME IS
              // DURABLE (Codex convergence, adopted — finding 1). Closing it
              // first looked harmless and was not: a failed terminal append
              // would leave a reservation that is no longer "open", so the next
              // ACK would truncate it away and the executed command would
              // vanish from the trail entirely. Keeping it open means a failed
              // commit degrades to `outcome_unknown` on the next recovery —
              // the fail-closed direction — and the throw still reaches the
              // broker's own best-effort guard.
              settled = true;
              openReservations.delete(pos);
              reservedHeadroom = Math.max(0, reservedHeadroom - headroom);
              frames.push(terminal);
              bytes += Buffer.byteLength(line, "utf8");
              nextPos = terminal.pos + 1;
            }).finally(() => {
              committing = false;
            }),
        };
      });
    },

    read(limit) {
      const deliverable = frames
        .filter((f) => f.kind === "record" && f.pos > ackedPos)
        .sort((a, b) => a.pos - b.pos);
      const take =
        limit === undefined ? deliverable.length : Math.max(0, Math.min(limit, deliverable.length));
      const batch = deliverable.slice(0, take);
      const head = batch.length > 0 ? batch[batch.length - 1]!.pos : ackedPos;
      maxIssuedHead = Math.max(maxIssuedHead, head);
      return {
        entries: batch.map((f) => f.record),
        head,
        remaining: deliverable.length - batch.length,
      };
    },

    ack(input) {
      return serialize(async () => {
        if (input.spoolId !== spoolId) {
          return {
            ok: false as const,
            reason: "wrong_spool" as const,
            message:
              "The acknowledgement names a different spool than the one that produced these " +
              "records; nothing is removed (a misrouted ACK must never delete another " +
              "volume's audit trail).",
          };
        }
        if (input.head <= ackedPos) {
          return {
            ok: false as const,
            reason: "stale_head" as const,
            message:
              `The acknowledged head ${input.head} is at or behind this spool's committed ` +
              `watermark ${ackedPos}; a stale ACK is refused rather than replayed.`,
          };
        }
        if (
          input.head > maxIssuedHead ||
          !frames.some((f) => f.kind === "record" && f.pos === input.head)
        ) {
          return {
            ok: false as const,
            reason: "unknown_head" as const,
            message:
              `The acknowledged head ${input.head} is not a record position this spool has ` +
              "delivered; only an exact committed prefix of what was actually READ is ever " +
              "removed.",
          };
        }
        // Durable FIRST, then the log rewrite. A crash between the two
        // re-delivers an already-written prefix, which the kernel's delivery
        // key absorbs; the reverse order would drop records the app never got.
        await storage.writeAck(input.head, nextPos);
        const before = frames.length;
        const survivors = frames.filter(
          (f) =>
            f.pos > input.head ||
            // An OPEN reservation is carried forward across every truncation:
            // dropping it would erase the only evidence that a dispatched
            // command exists, which is exactly the G1 hole.
            (f.kind === "reserved" && openReservations.has(f.deliveryId)),
        );
        frames.length = 0;
        frames.push(...survivors);
        bytes = await storage.rewrite(frames.map(encodeFrame));
        ackedPos = input.head;
        const remaining = frames.filter((f) => f.kind === "record" && f.pos > ackedPos).length;
        return { ok: true as const, head: ackedPos, removed: before - frames.length, remaining };
      });
    },

    stats() {
      return {
        frames: frames.length,
        bytes,
        maxBytes,
        openReservations: openReservations.size,
        head: nextPos - 1,
        acked: ackedPos,
        refusedReservations,
        recoveredUnknown,
      };
    },

    async close() {
      await tail.catch(() => {});
      await storage.close();
    },
  };
  return spool;
}

/**
 * Open (or create) the durable spool on the broker's own volume. Takes the
 * single-writer lock, recovers a torn tail, and converts every unresolved
 * reservation into an `outcome_unknown` record before returning.
 *
 * SYNCHRONOUS by design — it is called from the broker's synchronous boot
 * composition, and every fail-closed refusal it can raise
 * (`AuditSpoolLockedError`, `AuditSpoolCorruptError`) is a start-up refusal,
 * not a runtime one.
 */
export function openAuditSpool(opts: OpenAuditSpoolOptions & { dir: string }): AuditSpool {
  return buildSpool(createFileStorage(opts.dir), opts);
}

/**
 * A spool with the SAME state machine and no volume behind it. For the
 * in-process placement (whose sinks already reach the kernel) and for tests.
 * `durable` is false and rides the drain response, so no caller can mistake it
 * for the real thing.
 */
export function createMemoryAuditSpool(opts: OpenAuditSpoolOptions = {}): AuditSpool {
  return buildSpool(createMemoryStorage(), opts);
}
