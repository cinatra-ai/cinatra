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
 *  5. THE SATURATION STATE MACHINE (G5, cinatra#2266 slice 3). "Refuse AND
 *     audit every command" is unbounded when the consumer is gone: a
 *     permanently-full spool would need one record per refused attempt, and
 *     there is by definition no room for them. So the spool has two admission
 *     states — `open` and `saturated` — and the transition into `saturated`
 *     mints exactly ONE durable `audit_spool_full` record, out of a byte
 *     RESERVE held back from admission precisely so that record can always be
 *     written. Every further attempt while saturated is refused with NO record
 *     at all, counted on a persisted counter instead. Admission reopens on a
 *     defined condition — occupancy back at or below a LOW-WATER MARK, which is
 *     what stops the machine flapping and minting an episode per flap.
 *
 * WHAT IS DELIBERATELY NOT HERE:
 *
 *  - FLEET ROUTING (G3) is not a spool concern and is not in this module. The
 *    `spoolId` below is the per-volume identity every read and ACK carries, and
 *    a misrouted ACK is refused here (`wrong_spool`); the ROUTING that keeps a
 *    reader and its acknowledger on one replica lives one layer up, in
 *    `broker-fleet.ts`.
 *
 * SINGLE WRITER. The log is append-only from ONE process. A second writer
 * against the same directory is refused (`AuditSpoolLockedError`) rather than
 * interleaved — two writers appending to one log is how a spool silently
 * corrupts itself.
 */

import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
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

/**
 * Bytes held back from ADMISSION so the one `audit_spool_full` episode record
 * can always be written (cinatra#2266 G5). Admission is bounded by
 * `maxBytes - AUDIT_SPOOL_EPISODE_RESERVE_BYTES`; the episode record itself is
 * bounded by `maxBytes`. Without this the saturation record would be the one
 * record a saturated spool cannot store, and the episode would be invisible
 * exactly when it matters.
 *
 * THE ARITHMETIC, against `buildEpisodeRecord` below — which is deliberately a
 * NARROW projection of the refused attempt rather than the whole prepared
 * record, because a prepared record carries the command text and that is
 * unbounded:
 *
 *   6 identity fields (jobId, orgId, userId, surface, runId, cwd)
 *     × 256 code units × 6 bytes worst-case JSON escape         ≈ 9 216 B
 *   effectivePolicy (an enum + six numbers)                     <   256 B
 *   spoolEpisode { id, openedAtMs }                             <   256 B
 *   decision/reason/seq/atMs/deliveryKey + framing              <   512 B
 *                                                               ── 10 240 B
 *
 * 16 KiB, so the bound holds with room to spare, and
 * `AUDIT_SPOOL_EPISODE_FIELD_CHARS` is what makes the first line true. A test
 * drives hostile, control-character-laden identifiers through this and asserts
 * the encoded frame against this constant — not against a number of its own.
 */
export const AUDIT_SPOOL_EPISODE_RESERVE_BYTES = 16 * 1024;

/** Per-field code-unit cap on the episode record's identity fields. */
export const AUDIT_SPOOL_EPISODE_FIELD_CHARS = 256;

/**
 * The smallest `maxBytes` this spool will open on (cinatra#2266 G5, Codex
 * convergence, adopted).
 *
 * Its arithmetic, so a reader can check it rather than trust it: the episode
 * reserve is held back from admission entirely, and what remains has to fit at
 * least ONE minimal reservation plus the terminal record that reservation
 * guarantees — which is `AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES` twice over. A
 * bound below this admits nothing, which presents as a broker that refuses
 * every command with no record explaining it.
 */
export const AUDIT_SPOOL_MIN_MAX_BYTES =
  AUDIT_SPOOL_EPISODE_RESERVE_BYTES + 2 * AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES;

/**
 * THE REOPEN CONDITION (cinatra#2266 AC7), as a LOW-WATER MARK and not as
 * "there is room again".
 *
 * Admission reopens when occupancy — bytes on disk plus the headroom reserved
 * for in-flight commands — falls to or below
 *
 *     min( AUDIT_SPOOL_RESUME_RATIO × admissionBytes,
 *          admissionBytes − AUDIT_SPOOL_RESUME_HEADROOM_MULTIPLE × terminalHeadroom )
 *
 * and BOTH terms are load bearing, because each one alone flaps on a different
 * shape of spool. Reopening the instant one frame is acknowledged would admit a
 * command, re-saturate on it, and mint a SECOND episode record — a spool
 * oscillating at its bound would then produce exactly the unbounded stream of
 * records G5 exists to prevent.
 *
 *  - THE RATIO alone is wrong on a spool whose bound is small relative to one
 *    command's reserved headroom: saturation there happens BELOW 75 % of the
 *    bound (a single reservation claims most of it), so the mark would already
 *    be satisfied at the moment the episode opened.
 *  - THE ABSOLUTE TERM alone is wrong on a large spool: freeing room for two
 *    more worst-case commands is a rounding error against 64 MiB, so an episode
 *    would close and reopen every few kilobytes the app acknowledges.
 *
 * Taking the smaller of the two makes reopening require whichever is the more
 * demanding for THIS configuration, which is the fail-closed direction. It is
 * also monotone in the bound, so a spool that restarts against a RAISED bound
 * correctly stops being saturated instead of inheriting an episode the volume
 * no longer justifies.
 */
export const AUDIT_SPOOL_RESUME_RATIO = 0.75;

/** Worst-case reservations of room the reopen condition demands (see above). */
export const AUDIT_SPOOL_RESUME_HEADROOM_MULTIPLE = 2;

/**
 * The record `reason` that names a saturation episode. NOT an
 * `ExecFailureReason` — the model-visible refusal stays
 * `audit_spool_unavailable` (one reason for "the plane cannot account for this
 * command", whatever the spool's internal cause) and this is the audit trail's
 * own, finer word for it.
 */
export const AUDIT_SPOOL_FULL_REASON = "audit_spool_full";

/**
 * A single record that cannot fit in an EMPTY spool (cinatra#2266 G5, Codex
 * convergence, adopted).
 *
 * WHY THIS IS NOT SATURATION, which is the whole point of separating them. A
 * saturated spool is a spool holding records nobody has acknowledged yet: it is
 * a TRANSIENT state that the app's own draining resolves, and the episode plus
 * the low-water mark exist to describe exactly that. A record too large for the
 * admission bound resolves to nothing — draining every other record changes
 * nothing about whether THIS one fits.
 *
 * Conflating them latched the plane: an oversized command on a nearly-empty
 * spool opened an episode, the tiny episode record left occupancy far below the
 * low-water mark, and nothing re-evaluated the reopen condition — so a spool
 * with almost nothing in it stayed saturated, refusing every OTHER command,
 * until the broker was restarted. One command could take the plane down.
 *
 * So it is refused on its own: fail-closed for the command that caused it (it
 * is not dispatched, and it is not recorded, because the record is precisely
 * what does not fit), and invisible to every other command.
 */
export class AuditSpoolRecordTooLargeError extends Error {
  readonly code = "audit_spool_record_too_large" as const;
  constructor(message: string) {
    super(message);
    this.name = "AuditSpoolRecordTooLargeError";
  }
}

export class AuditSpoolFullError extends Error {
  readonly code = "audit_spool_full" as const;
  /** The saturation episode this refusal belongs to, once one is open. */
  readonly episodeId: string | undefined;
  constructor(message: string, episodeId?: string) {
    super(message);
    this.name = "AuditSpoolFullError";
    this.episodeId = episodeId;
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

/**
 * ONE SATURATION EPISODE (cinatra#2266 G5) — the bounded unit that replaces an
 * unbounded stream of per-attempt refusal records.
 *
 * An episode opens when a reservation cannot fit inside the admission bound,
 * and closes when occupancy falls back to the low-water mark. It costs exactly
 * one durable audit record (written at OPEN, so a permanently-saturated spool
 * still says so in the trail) plus this state, which is persisted next to the
 * log and rides every drain response.
 */
export type AuditSpoolEpisode = {
  /** `<spoolId>:episode:<n>` — stable, fleet-unique, on the opening record. */
  id: string;
  openedAtMs: number;
  /**
   * Admission attempts refused while this episode was open. Persisted at OPEN,
   * at CLOSE, and at power-of-two crossings in between — a bounded number of
   * writes for an unbounded number of refusals, which is the same discipline
   * the episode record itself follows. A crash can therefore lose the tail of
   * the count but never the episode; the drain response reports the count as
   * what it is.
   */
  refused: number;
  /** Set when admission reopened. Absent ⇒ the episode is still open. */
  closedAtMs?: number;
};

export type AuditSpoolSaturation = {
  state: "open" | "saturated";
  /** Episodes this spool has opened, ever. */
  episodes: number;
  /** The OPEN episode, when `state` is `saturated`. */
  episode?: AuditSpoolEpisode;
  /** The most recently CLOSED episode — the recovery, stated rather than inferred. */
  lastEpisode?: AuditSpoolEpisode;
};

/**
 * The ADMISSION verdict (cinatra#2266 G5). Consulted by the broker BEFORE the
 * first path that would mint a record, which is the whole mechanism: a refused
 * admission writes nothing at all.
 */
export type AuditSpoolAdmission =
  | { admitted: true }
  | { admitted: false; episodeId: string; refused: number; message: string };

export type AuditSpoolStats = {
  frames: number;
  bytes: number;
  maxBytes: number;
  /** The bound NEW work is admitted against — `maxBytes` less the episode reserve. */
  admissionBytes: number;
  /** Occupancy at or below which admission reopens (the low-water mark). */
  resumeBytes: number;
  openReservations: number;
  head: number;
  acked: number;
  /** Reservations refused because the spool could not accept them. */
  refusedReservations: number;
  /** Records recovered as `outcome_unknown` since this process opened. */
  recoveredUnknown: number;
  /** The G5 saturation state machine's current position. */
  saturation: AuditSpoolSaturation;
};

export type AuditSpool = {
  readonly spoolId: string;
  /** False for the in-memory spool — an honest signal, never a silent one. */
  readonly durable: boolean;
  /**
   * G5: may a new command be admitted at all? Called BEFORE anything that
   * would write a record. A refusal COUNTS and writes nothing — that is what
   * makes a permanently-full spool bounded.
   */
  admission(): AuditSpoolAdmission;
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
  /** The persisted G5 saturation state. OPEN PATH. */
  readEpisodeState(): PersistedEpisodeState;
  /** OPEN PATH: persist the saturation state durably. */
  writeEpisodeStateSync(state: PersistedEpisodeState): void;
  /** Persist the saturation state durably (open, close, counter checkpoint). */
  writeEpisodeState(state: PersistedEpisodeState): Promise<void>;
  close(): Promise<void>;
};

/**
 * The saturation state as it lives on the volume. Persisted for one reason
 * above all: a broker CRASH-LOOPING against a still-full spool must not mint a
 * fresh `audit_spool_full` record on every boot. Reloading the open episode is
 * what makes "one record per episode" survive a restart rather than degrade
 * into "one record per restart".
 */
type PersistedEpisodeState = {
  version: number;
  /** Episodes opened by this spool, ever — the episode ids' counter. */
  count: number;
  open: AuditSpoolEpisode | null;
  last: AuditSpoolEpisode | null;
};

const EMPTY_EPISODE_STATE: PersistedEpisodeState = {
  version: AUDIT_SPOOL_FORMAT_VERSION,
  count: 0,
  open: null,
  last: null,
};

function parseEpisode(value: unknown): AuditSpoolEpisode | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<AuditSpoolEpisode>;
  if (typeof raw.id !== "string" || raw.id.length === 0) return null;
  if (!Number.isSafeInteger(raw.openedAtMs)) return null;
  if (!Number.isSafeInteger(raw.refused)) return null;
  return {
    id: raw.id,
    openedAtMs: raw.openedAtMs as number,
    refused: raw.refused as number,
    ...(Number.isSafeInteger(raw.closedAtMs) ? { closedAtMs: raw.closedAtMs as number } : {}),
  };
}

const LOG_FILE = "audit-spool.log";
const META_FILE = "audit-spool.meta.json";
const ACK_FILE = "audit-spool.ack.json";
const EPISODE_FILE = "audit-spool.episode.json";
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

/**
 * A writer identity, minted PER ACQUISITION rather than per process.
 *
 * Per-acquisition is the load-bearing part (Codex round 1, finding 3, ADOPTED).
 * A process-global nonce cannot tell one acquisition from the next, so a
 * release closure held from an EARLIER acquisition would still recognise a
 * LATER acquisition's lock as "ours" and delete it — dropping a live writer's
 * mutual exclusion and letting the next claimant append alongside it. A fresh
 * nonce per acquisition also still satisfies the previous-incarnation rule
 * below: an incarnation that died holding the lock necessarily minted a
 * different one.
 */
const mintWriterNonce = (): string => randomUUID();

/**
 * THIS process incarnation, minted once at module load.
 *
 * The per-acquisition nonce above cannot answer "is the holder a LIVE
 * acquisition of my own process?", and that question has to be answered
 * separately or the previous-incarnation rule below eats a live in-process
 * holder (Codex round 1, finding 4 — a real regression the unit matrix caught
 * the moment the nonce stopped being process-global). Two identities, two
 * jobs: `nonce` says WHICH acquisition, `incarnation` says WHICH PROCESS RUN.
 */
const WRITER_INCARNATION = randomUUID();

type LockHolder = { pid: number; host: string; nonce: string; incarnation: string };

/**
 * Parse a lock document. `null` means "this lock cannot be reasoned about", and
 * every caller treats that as a REFUSAL (cinatra#2325, Codex finding b/d).
 *
 * Three inputs land here and all three must fail closed:
 *   - the LEGACY pid-only form written by a pre-#2325 broker. It carries no
 *     host and no nonce, so none of the reasoning below applies to it;
 *   - a PARTIAL read. `writeFileSync(..., "wx")` creates the file and then
 *     writes it, so a concurrent starter can observe it empty or half-written;
 *   - anything corrupt.
 */
function parseLockHolder(raw: string): LockHolder | null {
  let doc: unknown;
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return null;
  const { pid, host, nonce, incarnation } = doc as Record<string, unknown>;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return null;
  if (typeof host !== "string" || host.length === 0) return null;
  if (typeof nonce !== "string" || nonce.length === 0) return null;
  if (typeof incarnation !== "string" || incarnation.length === 0) return null;
  return { pid: pid as number, host, nonce, incarnation };
}

/**
 * The spool's single-writer lock.
 *
 * A LOCK FILE RECORDS AN IDENTITY, NOT A PID (cinatra#2325). It used to hold
 * the bare `process.pid`, and the recovery path built on that is not merely
 * imprecise in a container — it is ALWAYS WRONG there. The broker is PID 1 in
 * its own PID namespace, so a broker restarted after a SIGKILL reads the dead
 * holder's `1`, probes `process.kill(1, 0)` — which succeeds, because it is
 * probing ITSELF — concludes a live writer holds the spool, and refuses to
 * start. Under `restart: unless-stopped` that is a permanent crash loop: any
 * OOM kill, `docker kill` or hard crash took the broker out for good, and the
 * stale-lock branch below was unreachable in the shipped topology. The battery
 * arm that proves #2266 AC8 crash recovery is what finally caught it.
 *
 * So the document carries `pid`, `host` and a per-process `nonce`, and the
 * question "is the holder still alive?" is answered from all three:
 *
 *   - a DIFFERENT host is refused outright. A pid means nothing across a PID
 *     namespace, and this side cannot probe it — fail closed;
 *   - the SAME host and OUR OWN pid, under a different nonce, is a previous
 *     incarnation of this process: a pid identifies at most one live process
 *     per namespace, and that process is us. Stale, so reclaim it. This is
 *     exactly and only the container-restart case;
 *   - otherwise, the pre-existing `process.kill(pid, 0)` probe decides, with
 *     EPERM still meaning ALIVE (a writer under another uid this one cannot
 *     signal).
 *
 * The identity assumption is stated rather than assumed away: two containers
 * sharing BOTH a hostname and this directory would break the middle rule. The
 * compose file gives the spool its own per-broker volume and sets no hostname,
 * and the deployment note there says why.
 *
 * WHAT THIS STILL DOES NOT BUY, recorded rather than implied. The steal is a
 * RENAME, and a rename is not conditional on the inode it moves — so two
 * starters that both judged the same dead holder can still interleave in ways
 * no amount of re-reading fully closes. Every branch below is written to
 * NARROW that window (fail closed on anything unreadable or unexpected,
 * confirm every claim by nonce afterwards, restore rather than drop a lock that
 * turned out not to be the one judged), and none of them closes it. Closing it
 * needs a real fencing primitive — an advisory `flock`, which Node does not
 * expose and which this single-file bundle cannot take a native dependency for.
 * The residual predates cinatra#2325 and is not made worse by it; what #2325
 * fixes is the case that was not a race at all, but a deterministic misreading
 * of a dead holder as a live one.
 */
function takeLock(dir: string): () => void {
  const lockPath = path.join(dir, LOCK_FILE);
  const host = os.hostname();
  const nonce = mintWriterNonce();
  const claim = (): boolean => {
    try {
      fs.writeFileSync(
        lockPath,
        `${JSON.stringify({ pid: process.pid, host, nonce, incarnation: WRITER_INCARNATION })}\n`,
        { flag: "wx" },
      );
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      return false;
    }
  };
  /**
   * Prove the lock at `lockPath` is OURS, by nonce.
   *
   * Run after EVERY claim, not only after a steal. `wx` proves this process
   * created a file; it does not prove the file is still there, because a racer
   * that observed the OLD holder before we claimed can still rename ours away
   * and claim its own (the steal is a rename and renames are not conditional on
   * an inode). Whoever ends up named by the lock wins; everybody else refuses
   * here rather than appending to a log it does not own.
   */
  const confirmOwnership = (): void => {
    let raw: string;
    try {
      raw = fs.readFileSync(lockPath, "utf8");
    } catch (err) {
      // Name what actually happened. ENOENT is a racer having taken the lock;
      // anything else is a lock this process cannot VERIFY, which is a
      // different (and equally fail-closed) situation (Codex round 1, finding
      // 6, ADOPTED — it used to report both as "disappeared").
      const code = (err as NodeJS.ErrnoException).code;
      throw new AuditSpoolLockedError(
        code === "ENOENT"
          ? "The audit spool lock disappeared immediately after this writer claimed it; " +
            "refusing rather than racing a second writer onto the same log."
          : `The audit spool lock could not be read back after this writer claimed it (${code}); ` +
            "refusing rather than writing against a lock it cannot verify.",
      );
    }
    if (parseLockHolder(raw)?.nonce !== nonce) {
      throw new AuditSpoolLockedError(
        "The audit spool lock was taken by another starter immediately after this writer " +
          "claimed it; refusing rather than racing a second writer onto the same log.",
      );
    }
  };
  if (!claim()) {
    // A lock left behind by a KILLED process must not wedge the spool forever
    // — that would turn a crash into a permanent outage. A lock held by a LIVE
    // process is refused: two writers appending to one log is how a spool
    // silently corrupts itself.
    const holder = parseLockHolder(fs.readFileSync(lockPath, "utf8"));
    if (holder === null) {
      throw new AuditSpoolLockedError(
        "The audit spool lock at this volume is unreadable — it is either a lock written by " +
          "a pre-cinatra#2325 broker (pid only), a lock being written right now by another " +
          "starter, or a corrupt one. A lock this process cannot reason about is never " +
          "stolen (fail-closed). If a previous broker was killed here, remove " +
          `"${LOCK_FILE}" from the spool directory once, after confirming no broker is ` +
          "running against it.",
      );
    }
    if (holder.incarnation === WRITER_INCARNATION) {
      // A LIVE acquisition of this very process run — a second spool opened over
      // one directory. Refuse before the previous-incarnation rule below can
      // mistake our own pid for a dead holder's.
      throw new AuditSpoolLockedError(
        "The audit spool at this volume is already held by THIS process; a second spool " +
          "over one directory is refused (the spool is single-writer by construction).",
      );
    }
    let alive: boolean;
    if (holder.host !== host) {
      // Another host — or another PID namespace wearing another name. Its pid
      // is not a number this side can probe, so it is treated as live.
      alive = true;
    } else if (holder.pid === process.pid) {
      // Our own pid, a DIFFERENT incarnation: a previous incarnation of this
      // process. It cannot be alive — we are that pid. THE CONTAINER-RESTART
      // CASE, and the whole reason this function was rewritten.
      alive = false;
    } else {
      try {
        process.kill(holder.pid, 0);
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
        `The audit spool at this volume is already held by a live writer (pid ${holder.pid} ` +
          `on ${holder.host}); a second writer is refused (the spool is single-writer by ` +
          "construction).",
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
    // The rename is not conditional on the inode, so it may have moved a lock
    // that is NEWER than the dead one we judged. Discard ONLY the exact
    // document we judged; put anything else back and refuse.
    //
    // "Anything else" includes a lock we cannot READ (Codex round 1, finding 1,
    // ADOPTED). Treating an unreadable stolen file as absent — and then
    // deleting it and claiming — is how a transient EIO turns into a second
    // writer on a live log, and it contradicts this module's own rule that a
    // lock it cannot reason about is never stolen.
    let stolenHolder: LockHolder | null = null;
    try {
      stolenHolder = parseLockHolder(fs.readFileSync(stolen, "utf8"));
    } catch {
      stolenHolder = null;
    }
    // ONE rule, and it is positive: discard the stolen file only when it is
    // provably the exact document this starter judged dead. Unreadable,
    // unparseable, and "somebody else's lock" are then all the same answer —
    // put it back and refuse — instead of three branches with three chances to
    // get the fail-closed direction wrong.
    if (stolenHolder === null || stolenHolder.nonce !== holder.nonce) {
      // Restoring is racy in its own right — the path is briefly empty, so a
      // third starter can claim it in between — but the alternative is worse by
      // a wide margin: dropping the file would leave a LIVE writer with no lock
      // at all, and then every future starter becomes a second writer. Narrow,
      // do not widen. (The residual is inherent to a rename-based steal without
      // a fencing primitive and predates this change; see the header.)
      try {
        fs.renameSync(stolen, lockPath);
      } catch {
        /* the path is occupied again — leave the copy rather than delete a lock */
      }
      throw new AuditSpoolLockedError(
        "The audit spool's lock was replaced or became unreadable between this starter's " +
          "read and its steal; refusing rather than racing a second writer onto the same log.",
      );
    }
    fs.rmSync(stolen, { force: true });
    if (!claim()) {
      throw new AuditSpoolLockedError(
        "The audit spool lock could not be claimed after clearing a stale holder.",
      );
    }
  }
  confirmOwnership();
  // RELEASE ONLY WHAT IS STILL OURS. An unconditional unlink would delete a
  // lock a LATER writer legitimately holds — turning this process's shutdown
  // into the removal of somebody else's mutual exclusion.
  let released = false;
  return () => {
    // AT MOST ONCE. A release closure that ran twice would, on its second run,
    // be reasoning about a lock some LATER acquisition legitimately holds.
    if (released) return;
    released = true;
    try {
      if (parseLockHolder(fs.readFileSync(lockPath, "utf8"))?.nonce !== nonce) return;
    } catch {
      return; // already gone, or unreadable — either way not ours to remove
    }
    fs.rmSync(lockPath, { force: true });
  };
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
  const episodePath = path.join(dir, EPISODE_FILE);
  let handle: fsp.FileHandle | undefined;
  /** Serializes saturation-state writes — see `writeEpisodeState` below. */
  let episodeTail: Promise<unknown> = Promise.resolve();

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
    readEpisodeState() {
      let raw: string;
      try {
        raw = fs.readFileSync(episodePath, "utf8");
      } catch (err) {
        // ABSENT is a real answer: a spool that has never saturated.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ...EMPTY_EPISODE_STATE };
        throw err;
      }
      // PRESENT-BUT-UNREADABLE is not — and the fail-closed direction here is
      // the opposite of the ack watermark's. Reading it as "never saturated"
      // would let a broker that is crash-looping against a full spool mint a
      // fresh episode record on every boot, which is precisely the unbounded
      // write G5 exists to prevent. Refuse to open instead.
      let parsed: { version?: unknown; count?: unknown; open?: unknown; last?: unknown };
      try {
        parsed = JSON.parse(raw) as typeof parsed;
      } catch {
        throw new AuditSpoolCorruptError(
          "The audit spool's saturation state on this volume is unreadable; refusing to open " +
            "the spool (reading it as `never saturated` would mint a fresh episode record on " +
            "every restart against a still-full spool).",
        );
      }
      if (parsed.version !== AUDIT_SPOOL_FORMAT_VERSION) {
        throw new AuditSpoolCorruptError(
          `The audit spool's saturation state declares format version ${String(parsed.version)}, ` +
            `this build speaks ${AUDIT_SPOOL_FORMAT_VERSION}; refusing to read it (fail-closed).`,
        );
      }
      return {
        version: AUDIT_SPOOL_FORMAT_VERSION,
        count: Number.isSafeInteger(parsed.count) ? (parsed.count as number) : 0,
        open: parseEpisode(parsed.open),
        last: parseEpisode(parsed.last),
      };
    },
    writeEpisodeStateSync(state) {
      writeFileDurablySync(episodePath, `${JSON.stringify(state)}\n`);
    },
    /**
     * SERIALIZED, and that is not incidental (Codex convergence, adopted —
     * caught by the restart arm asserting a refusal count).
     *
     * The saturation counter is checkpointed from `admission()`, which sits on
     * the synchronous command path and therefore fires this WITHOUT awaiting
     * it. Two such writes in flight against one `.tmp` path both open it `"w"`,
     * both write, and both rename — so the state that lands is whichever rename
     * happened to run last, not the newest state, and a torn interleaving of
     * the two bodies is reachable in between. `close()`'s final flush of the
     * counter's tail lost exactly that race.
     *
     * Chaining them makes the ORDER of issue the order on disk, which is the
     * property every caller here assumes: the last state issued is the state a
     * restart reads.
     */
    writeEpisodeState(state) {
      const body = `${JSON.stringify(state)}\n`;
      const next = episodeTail.then(async () => {
        const tmpPath = `${episodePath}.tmp`;
        const tmp = await fsp.open(tmpPath, "w");
        try {
          await tmp.writeFile(body, "utf8");
          await tmp.sync();
        } finally {
          await tmp.close();
        }
        await fsp.rename(tmpPath, episodePath);
        await fsyncDir(dir);
      });
      // A failed write must not poison the chain for the next one: the counter
      // is best-effort by design and the EPISODE is the durable fact.
      episodeTail = next.catch(() => {});
      return next;
    },
    async close() {
      // Drain the saturation-state chain BEFORE releasing the single-writer
      // lock: a checkpoint still in flight would otherwise rename its `.tmp`
      // into place after the next writer had already taken the volume.
      await episodeTail.catch(() => {});
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
  let episodeState: PersistedEpisodeState = { ...EMPTY_EPISODE_STATE };
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
    readEpisodeState: () => ({ ...episodeState }),
    writeEpisodeStateSync(state) {
      episodeState = { ...state };
    },
    async writeEpisodeState(state) {
      episodeState = { ...state };
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

/**
 * The episode record's NARROW projection of the attempt that saturated the
 * spool (cinatra#2266 G5).
 *
 * It is deliberately not the prepared record. A prepared record carries the raw
 * command text, which is unbounded and model-authored, and the episode record
 * is the ONE record that has to fit inside a fixed reserve — a reserve sized
 * against an unbounded field is not a reserve. Every field here is capped at
 * `AUDIT_SPOOL_EPISODE_FIELD_CHARS` code units, so the frame's encoded size is
 * bounded by the arithmetic on `AUDIT_SPOOL_EPISODE_RESERVE_BYTES` even for
 * hostile identifiers.
 *
 * What is NOT dropped: the job, org, user, surface, run and attempt sequence.
 * An investigation reading "the plane stopped admitting commands at T" needs to
 * know which command it stopped on.
 */
function buildEpisodeRecord(
  prepared: ExecutionAuditRecord,
  episode: AuditSpoolEpisode,
  atMs: number,
): ExecutionAuditRecord {
  const cap = (value: string): string => value.slice(0, AUDIT_SPOOL_EPISODE_FIELD_CHARS);
  return {
    jobId: cap(prepared.jobId),
    orgId: cap(prepared.orgId),
    userId: cap(prepared.userId),
    surface: cap(prepared.surface),
    ...(prepared.runId ? { runId: cap(prepared.runId) } : {}),
    // EMPTY, not truncated: the command text is unbounded and this record's
    // whole job is to fit in a fixed reserve. The command's own record is the
    // refusal the caller received, which carries no audit row at all — that is
    // the trade G5 makes, and it is stated here rather than implied.
    command: "",
    cwd: cap(prepared.cwd),
    seq: prepared.seq,
    decision: "refused",
    reason: AUDIT_SPOOL_FULL_REASON,
    spoolEpisode: { id: episode.id, openedAtMs: episode.openedAtMs },
    effectivePolicy: prepared.effectivePolicy,
    atMs,
  };
}

/** Powers of two — the checkpoint schedule for the refusal counter. */
function isCounterCheckpoint(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

/**
 * The configured bound, VALIDATED (cinatra#2266 G5, Codex convergence, adopted).
 *
 * `EXEC_AUDIT_SPOOL_MAX_BYTES` accepted any positive number, and the clamp on
 * `admissionBytes` turned a too-small one into ZERO: a broker that boots
 * healthy, refuses the FIRST command it is ever given, and — because the episode
 * record itself would not fit in what is left — writes no `audit_spool_full`
 * record to say why. That is the failure mode this whole slice exists to
 * prevent, arrived at through configuration instead of through load.
 * `maxBytes = 1` is not a small spool; it is a dead plane.
 *
 * PURE, AND CALLED BEFORE THE VOLUME LOCK IS TAKEN. A refusal raised from inside
 * `buildSpool` would already hold the single-writer lock on the volume, so a
 * misconfigured bound would leave a lock behind that outlives the process's
 * intent — and the operator who then FIXED the configuration would be met by a
 * lock error instead of a working broker.
 */
function resolveMaxBytes(opts: OpenAuditSpoolOptions): number {
  const maxBytes = opts.maxBytes ?? DEFAULT_AUDIT_SPOOL_MAX_BYTES;
  // FINITE FIRST (Codex round 3, adopted). `NaN < MIN` is FALSE and `Infinity`
  // is genuinely greater, so both slipped past the floor below — and each
  // defeats the thing the bound exists for: every capacity comparison against
  // `NaN` is false, so the spool would admit without limit, and `Infinity` says
  // so outright. A bound that cannot be compared is not a bound.
  if (!Number.isFinite(maxBytes)) {
    throw new AuditSpoolCorruptError(
      `The audit spool was given a non-finite byte bound (${String(maxBytes)}). The bound is what ` +
        "makes the spool refuse rather than grow without limit, and a value no comparison can " +
        "order would silently disable every capacity check — so the spool refuses to open.",
    );
  }
  if (maxBytes < AUDIT_SPOOL_MIN_MAX_BYTES) {
    throw new AuditSpoolCorruptError(
      `The audit spool is configured with a ${maxBytes}-byte bound, below the ` +
        `${AUDIT_SPOOL_MIN_MAX_BYTES}-byte minimum. Below that the episode reserve ` +
        `(${AUDIT_SPOOL_EPISODE_RESERVE_BYTES} bytes) leaves too little admission room to ` +
        "record even one command, so the broker would refuse every command it is given and " +
        "could not write the saturation record that explains why. Refusing to open is the " +
        "honest outcome: a misconfigured bound is a start-up error, not a silent outage.",
    );
  }
  return maxBytes;
}

function buildSpool(storage: SpoolStorage, opts: OpenAuditSpoolOptions): AuditSpool {
  const maxBytes = resolveMaxBytes(opts);
  const now = opts.nowMs ?? (() => Date.now());
  const { spoolId } = storage.identity();

  /**
   * THE ADMISSION BOUND, which is NOT `maxBytes` (cinatra#2266 G5). New work —
   * a reservation, a refusal record — is admitted against `maxBytes` less the
   * episode reserve, so that the one record a saturated spool must still be
   * able to write always has room. Clamped at zero so a pathologically small
   * `maxBytes` degrades to "admit nothing" rather than to a negative bound that
   * would silently admit everything.
   */
  const admissionBytes = Math.max(0, maxBytes - AUDIT_SPOOL_EPISODE_RESERVE_BYTES);
  const resumeBytes = Math.max(
    0,
    Math.min(
      Math.floor(admissionBytes * AUDIT_SPOOL_RESUME_RATIO),
      admissionBytes -
        AUDIT_SPOOL_RESUME_HEADROOM_MULTIPLE * AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES,
    ),
  );

  const frames: SpoolFrame[] = [];
  let bytes = 0;
  let nextPos = 1;
  let ackedPos = 0;
  let reservedHeadroom = 0;
  let refusedReservations = 0;
  let recoveredUnknown = 0;
  // --- G5 saturation state (loaded from the volume, see PersistedEpisodeState) -
  const persistedEpisodes = storage.readEpisodeState();
  let episodeCount = persistedEpisodes.count;
  let episode: AuditSpoolEpisode | null = persistedEpisodes.open;
  let lastEpisode: AuditSpoolEpisode | null = persistedEpisodes.last;
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

  /**
   * @param limit the byte ceiling this append is checked against. Everything
   *   admitted from outside uses `admissionBytes`; the ONE episode record uses
   *   `maxBytes`, which is what the reserve between them is for.
   */
  const appendFrame = async (
    frame: SpoolFrame,
    headroom: number,
    limit: number = admissionBytes,
  ): Promise<void> => {
    const line = encodeFrame(frame);
    const len = Buffer.byteLength(line, "utf8");
    if (bytes + reservedHeadroom + len + headroom > limit) {
      throw new AuditSpoolFullError(
        `The audit spool is at its ${limit}-byte admission bound of ${maxBytes} ` +
          `(${bytes} bytes on disk, ${reservedHeadroom} reserved); it cannot accept ` +
          "another record.",
        episode?.id,
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
  //
  // (the G5 helpers below close over `bytes`/`reservedHeadroom`, so the
  // boot-time reopen check runs after they are declared — see the call under
  // `maybeReopen`'s definition.)

  /** Serializes appends: the log is append-ONLY and single-writer. */
  let tail: Promise<unknown> = Promise.resolve();
  const serialize = <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work, work);
    tail = next.catch(() => {});
    return next;
  };

  // --- G5: the saturation state machine -----------------------------------

  const episodeState = (): PersistedEpisodeState => ({
    version: AUDIT_SPOOL_FORMAT_VERSION,
    count: episodeCount,
    open: episode ? { ...episode } : null,
    last: lastEpisode ? { ...lastEpisode } : null,
  });

  /** Bytes on disk PLUS the capacity in-flight commands have already claimed. */
  const occupancy = (): number => bytes + reservedHeadroom;

  /**
   * ENTER SATURATION. Called from the ONE place a reservation can fail for
   * space, and it does exactly two things the first time: mints the episode and
   * writes its single `audit_spool_full` record out of the reserve. Every later
   * refusal only moves a counter.
   *
   * The record append is BEST EFFORT and deliberately so: the spool is already
   * full and the caller's command is already refused, so a failure here must not
   * turn a fail-closed refusal into a throw the broker would surface as a
   * different fault. Whether it lands or not, the episode is durable state and
   * rides every drain response.
   */
  const enterSaturation = async (prepared: ExecutionAuditRecord): Promise<void> => {
    if (episode) {
      episode.refused += 1;
      if (isCounterCheckpoint(episode.refused)) {
        await storage.writeEpisodeState(episodeState()).catch(() => {});
      }
      return;
    }
    episodeCount += 1;
    episode = {
      id: `${spoolId}:episode:${episodeCount}`,
      openedAtMs: now(),
      refused: 1,
    };
    // Durable BEFORE the record: a crash between the two loses the record (the
    // count and the episode survive), where the reverse order would lose the
    // episode and mint a second record on the next boot — one bounded gap
    // against an unbounded write.
    //
    // AND THE PERSIST'S OWN FAILURE GATES THE RECORD (Codex convergence,
    // adopted). Swallowing it and appending anyway reproduced exactly the
    // ordering this comment claims to avoid: the record lands, the episode
    // state does not, and the next boot reads "never saturated" and mints a
    // SECOND `audit_spool_full` record for one continuous saturation — one per
    // restart, forever, on a crash-looping broker. Returning here keeps the
    // in-memory episode (so THIS process still refuses without writing records)
    // and leaves the volume saying nothing, which the next open re-derives from
    // the occupancy it actually finds. The durable state is the authority for
    // "an episode is open"; a record it cannot vouch for is not written.
    let episodeDurable = true;
    try {
      await storage.writeEpisodeState(episodeState());
    } catch {
      episodeDurable = false;
    }
    if (!episodeDurable) return;
    try {
      const pos = nextPos;
      await appendFrame(
        {
          pos,
          deliveryId: pos,
          kind: "record",
          record: {
            ...buildEpisodeRecord(prepared, episode, now()),
            deliveryKey: deliveryKeyFor(pos),
          },
        },
        0,
        // THE RESERVE. This is the one append checked against `maxBytes`
        // rather than the admission bound — the reserve exists for exactly
        // this record and for nothing else.
        maxBytes,
      );
    } catch {
      /* see the docblock: the refusal stands either way */
    }
  };

  /**
   * REOPEN ADMISSION when occupancy is back at or below the low-water mark.
   * Evaluated wherever occupancy can FALL — an acknowledgement (frames leave)
   * and a commit (the terminal record replaces its larger reservation
   * headroom). Never on a path where it can only rise.
   */
  const maybeReopen = (): boolean => {
    if (!episode) return false;
    if (occupancy() > resumeBytes) return false;
    lastEpisode = { ...episode, closedAtMs: now() };
    episode = null;
    return true;
  };

  // BOOT-TIME REOPEN. A restart re-reads the persisted episode — which is what
  // stops a crash-looping broker minting one record per boot — but the spool it
  // reopens onto may have ROOM: recovery compacts an acknowledged prefix, and
  // an operator may simply have raised the bound. Re-evaluating the same
  // condition here means a restart never inherits a saturation the volume no
  // longer justifies. Conversely, a spool that IS still full stays saturated
  // under the SAME episode id, and mints no second record.
  if (maybeReopen()) storage.writeEpisodeStateSync(episodeState());

  const spool: AuditSpool = {
    spoolId,
    durable: storage.durable,

    /**
     * G5, and the whole reason the state machine exists: while an episode is
     * open this answers "no" and WRITES NOTHING. The counter is in memory and
     * is checkpointed on a power-of-two schedule, so an unbounded stream of
     * attempts costs a bounded number of fsyncs and exactly zero records.
     *
     * Synchronous by design — it sits on the command path in front of every
     * refusal, and an await here would be an await the refusal does not need.
     * The checkpoint write is therefore fire-and-forget and its failure is not
     * the caller's problem: the durable fact is the EPISODE, written when it
     * opened.
     */
    admission() {
      if (!episode) return { admitted: true as const };
      episode.refused += 1;
      if (isCounterCheckpoint(episode.refused)) {
        void storage.writeEpisodeState(episodeState()).catch(() => {});
      }
      return {
        admitted: false as const,
        episodeId: episode.id,
        refused: episode.refused,
        message:
          `The execution plane's audit spool is saturated (episode ${episode.id}, ` +
          `${episode.refused} admission(s) refused since ${new Date(episode.openedAtMs).toISOString()}). ` +
          "New commands are refused rather than run unaccounted for; admission reopens once the " +
          "app has acknowledged enough of the spooled trail to bring it back under its low-water mark.",
      };
    },

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
        const frameBytes = Buffer.byteLength(encodeFrame(frame), "utf8");
        const headroom = frameBytes + AUDIT_SPOOL_TERMINAL_HEADROOM_BYTES;
        // TOO LARGE TO EVER FIT ⇒ REFUSED, NOT SATURATION (Codex convergence,
        // adopted — see AuditSpoolRecordTooLargeError). Measured against an
        // EMPTY spool: `bytes` and `reservedHeadroom` are excluded on purpose,
        // because the question is whether draining could ever make room, and
        // for this record it could not.
        if (frameBytes + headroom > admissionBytes) {
          refusedReservations += 1;
          throw new AuditSpoolRecordTooLargeError(
            `This command's audit record needs ${frameBytes + headroom} bytes (the record plus ` +
              `the headroom its terminal form is guaranteed), which exceeds the spool's whole ` +
              `${admissionBytes}-byte admission bound. An empty spool could not hold it either, ` +
              "so the command is refused rather than opening a saturation episode that no amount " +
              "of draining would ever close. The usual cause is a command line far larger than " +
              "this deployment's audit spool was sized for.",
          );
        }
        try {
          // The headroom argument is what makes the RESERVATION the point of
          // refusal: capacity for the terminal record is claimed here, so a
          // command that was admitted can always be recorded.
          await appendFrame(frame, headroom);
        } catch (err) {
          refusedReservations += 1;
          // G5: this is the ONE place saturation can begin. A space refusal
          // opens an episode (and mints its single record); any OTHER failure
          // — an I/O error, a closed handle — is not saturation and must not be
          // reported as one.
          if (err instanceof AuditSpoolFullError) await enterSaturation(prepared);
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
              // A commit releases MORE headroom than the terminal frame
              // occupies (that is what the headroom was for), so occupancy
              // falls here and the reopen condition can become true.
              if (maybeReopen()) await storage.writeEpisodeState(episodeState()).catch(() => {});
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
        // THE REOPEN CONDITION (G5/AC7), evaluated exactly where occupancy can
        // fall: an acknowledgement is the only thing that removes frames, so it
        // is the only thing that can end a saturation episode. Persisted before
        // the caller is told, so a crash here cannot leave a closed episode
        // looking open (which would refuse commands the spool has room for).
        if (maybeReopen()) await storage.writeEpisodeState(episodeState()).catch(() => {});
        const remaining = frames.filter((f) => f.kind === "record" && f.pos > ackedPos).length;
        return { ok: true as const, head: ackedPos, removed: before - frames.length, remaining };
      });
    },

    stats() {
      return {
        frames: frames.length,
        bytes,
        maxBytes,
        admissionBytes,
        resumeBytes,
        openReservations: openReservations.size,
        head: nextPos - 1,
        acked: ackedPos,
        refusedReservations,
        recoveredUnknown,
        saturation: {
          state: episode ? ("saturated" as const) : ("open" as const),
          episodes: episodeCount,
          ...(episode ? { episode: { ...episode } } : {}),
          ...(lastEpisode ? { lastEpisode: { ...lastEpisode } } : {}),
        },
      };
    },

    async close() {
      await tail.catch(() => {});
      // Flush the refusal counter's tail. It is checkpointed on a power-of-two
      // schedule while the process runs (bounded writes for unbounded attempts),
      // so a clean shutdown is the cheap opportunity to persist the remainder.
      await storage.writeEpisodeState(episodeState()).catch(() => {});
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
  // BEFORE the volume lock — see `resolveMaxBytes`: a bound this build refuses
  // must not leave a single-writer lock behind on the way out.
  resolveMaxBytes(opts);
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
