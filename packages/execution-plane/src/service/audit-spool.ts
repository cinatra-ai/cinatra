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
 * prepared frame itself. The terminal record is the prepared one plus the
 * command's outcome (exit code, termination, image digest, wall time,
 * workspace size, egress destinations), so it is bounded above by the prepared
 * frame plus a small constant — and the reservation exists precisely so that
 * committing a command that HAS RUN can never fail for space.
 */
export const AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES = 4096;

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
  readAck(): number;
  /** Append + fsync ONE frame line. Resolves only when it is durable. */
  appendLine(line: string): Promise<void>;
  /** Replace the whole log atomically with these lines; returns new byte size. */
  rewrite(lines: string[]): Promise<number>;
  /** Persist the ACK watermark BEFORE the log is rewritten. */
  writeAck(pos: number): Promise<void>;
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
      } catch {
        alive = false;
      }
    }
    if (alive) {
      throw new AuditSpoolLockedError(
        `The audit spool at this volume is already held by a live writer (pid ${holder}); ` +
          "a second writer is refused (the spool is single-writer by construction).",
      );
    }
    fs.rmSync(lockPath, { force: true });
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
    readAck() {
      try {
        const parsed = JSON.parse(fs.readFileSync(ackPath, "utf8")) as { acked?: unknown };
        return Number.isSafeInteger(parsed.acked) ? (parsed.acked as number) : 0;
      } catch {
        return 0;
      }
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
    async writeAck(pos) {
      const tmpPath = `${ackPath}.tmp`;
      const tmp = await fsp.open(tmpPath, "w");
      try {
        await tmp.writeFile(`${JSON.stringify({ acked: pos })}\n`, "utf8");
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
    readAck: () => acked,
    async appendLine(line) {
      lines.push(line);
    },
    async rewrite(next) {
      lines = [...next];
      return size();
    },
    async writeAck(pos) {
      acked = pos;
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
  const openReservations = new Map<number, SpoolFrame>();

  const deliveryKeyFor = (deliveryId: number): string => `${spoolId}:${deliveryId}`;

  // --- recovery -----------------------------------------------------------
  const loaded = storage.load();
  ackedPos = storage.readAck();
  // POSITIONS ARE NEVER REUSED, including across a restart that carried an OPEN
  // reservation past an acknowledged prefix. `read()` delivers only `pos >
  // ackedPos`, so a recovery frame minted at a position at or below the
  // watermark would be invisible — the `outcome_unknown` record for a
  // dispatched command would exist on disk and never be delivered, which is the
  // exact silence G1 exists to prevent.
  nextPos = Math.max(nextPos, ackedPos + 1);
  const terminalIds = new Set<number>();
  for (let i = 0; i < loaded.lines.length; i += 1) {
    const line = loaded.lines[i]!;
    const frame = decodeFrame(line);
    if (!frame) {
      // A bad frame at the very END of the log is a torn append — the only
      // place a single writer can produce one. Anywhere else it is corruption
      // that would silently reorder or drop live records, so it is REFUSED
      // rather than skipped.
      if (i === loaded.lines.length - 1) break;
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
  // The torn tail (and anything after a broken frame) never happened.
  bytes = frames.reduce((n, f) => n + Buffer.byteLength(encodeFrame(f), "utf8"), 0);
  if (loaded.tornTail || bytes !== loaded.bytes) {
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
        try {
          // The headroom argument is what makes the RESERVATION the point of
          // refusal: capacity for the terminal record is claimed here, so a
          // command that was admitted can always be recorded.
          await appendFrame(frame, AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES);
        } catch (err) {
          refusedReservations += 1;
          throw err;
        }
        reservedHeadroom += AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES;
        openReservations.set(pos, frame);
        return {
          deliveryKey,
          deliveryId: pos,
          commit: (record: ExecutionAuditRecord) =>
            serialize(async () => {
              if (!openReservations.delete(pos)) return;
              reservedHeadroom = Math.max(
                0,
                reservedHeadroom - AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES,
              );
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
              // Overshooting a reservation's headroom is the only way past the
              // bound, and it is bounded by the reservations outstanding.
              await storage.appendLine(line);
              frames.push(terminal);
              bytes += Buffer.byteLength(line, "utf8");
              nextPos = terminal.pos + 1;
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
      return {
        entries: batch.map((f) => f.record),
        head: batch.length > 0 ? batch[batch.length - 1]!.pos : ackedPos,
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
        if (!frames.some((f) => f.kind === "record" && f.pos === input.head)) {
          return {
            ok: false as const,
            reason: "unknown_head" as const,
            message:
              `The acknowledged head ${input.head} is not a delivered record position in this ` +
              "spool; only an exact committed prefix is ever removed.",
          };
        }
        // Durable FIRST, then the log rewrite. A crash between the two
        // re-delivers an already-written prefix, which the kernel's delivery
        // key absorbs; the reverse order would drop records the app never got.
        await storage.writeAck(input.head);
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
