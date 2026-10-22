// ---------------------------------------------------------------------------
// Atomic update of one connector-config row (the host `update` member).
//
// A whole-row `write` drops a change that another writer stored between the
// caller's read and its write. `update(connectorId, updater)` closes that
// window: each attempt reads the RAW stored text (never the process cache),
// derives the next row with the caller's updater, and persists it with ONE
// conditional statement — a byte-equal compare-and-swap when the row exists,
// an insert-if-absent that reports whether THIS call inserted it otherwise.
// A missed persist starts the next attempt from a fresh read. The row's own
// stored bytes are its version, so no column and no migration is needed.
//
// Errors are value-free: every error thrown out of `update` is one of the
// classes below, with a fixed message that names the key only and no `cause`.
// The error the updater or the store threw is dropped. The only internal
// record is one log line with the key and the code. A store failure adds an
// allow-listed SQLSTATE only when the store's error carries one as its own
// `code`; the Postgres bridge (postgres-sync.ts `resultsOrThrow`) does not
// carry it today, so the live line has none.
// ---------------------------------------------------------------------------

import {
  compareAndSwapMetadataValueInternal,
  insertRawMetadataValueIfAbsentInternal,
  readRawMetadataStringInternal,
} from "@/lib/database-metadata";
import { hasSecretFields } from "@/lib/connector-config-secret-fields";

export type ConnectorConfigUpdater = (current: unknown) => unknown;

export type ConnectorConfigUpdatePort = {
  readRaw(key: string): string | null;
  /** true = this swap landed. */
  compareAndSwap(key: string, nextRaw: string, expectedRaw: string): boolean;
  /** true = THIS call inserted the row. */
  insertIfAbsent(key: string, nextRaw: string): boolean;
  cacheSet(key: string, value: unknown): void;
  cacheEvict(key: string): void;
  log(line: string): void;
};

export const CONNECTOR_CONFIG_UPDATE_ATTEMPTS = 5;

export class ConnectorConfigUpdateError extends Error {
  readonly code: string;
  readonly key: string;
  constructor(name: string, code: string, key: string, message: string) {
    super(message);
    this.name = name;
    this.code = code;
    this.key = key;
  }
}

export class ConnectorConfigConflictError extends ConnectorConfigUpdateError {
  constructor(key: string) {
    super("ConnectorConfigConflictError", "CONNECTOR_CONFIG_CONFLICT", key, `Connector config ${key} changed under every update attempt; nothing was written.`);
  }
}
export class ConnectorConfigRowUnparseableError extends ConnectorConfigUpdateError {
  constructor(key: string) {
    super("ConnectorConfigRowUnparseableError", "CONNECTOR_CONFIG_ROW_UNPARSEABLE", key, `Connector config ${key} holds text that is not JSON; nothing was written.`);
  }
}
export class ConnectorConfigUpdaterFailedError extends ConnectorConfigUpdateError {
  constructor(key: string) {
    super("ConnectorConfigUpdaterFailedError", "CONNECTOR_CONFIG_UPDATER_FAILED", key, `Connector config ${key}: the updater failed; nothing was written.`);
  }
}
export class ConnectorConfigUpdateInvalidError extends ConnectorConfigUpdateError {
  constructor(key: string) {
    super("ConnectorConfigUpdateInvalidError", "CONNECTOR_CONFIG_UPDATE_INVALID", key, `Connector config ${key}: the updater returned no storable value; nothing was written.`);
  }
}
export class ConnectorConfigStoreFailedError extends ConnectorConfigUpdateError {
  constructor(key: string) {
    super("ConnectorConfigStoreFailedError", "CONNECTOR_CONFIG_STORE_FAILED", key, `Connector config ${key}: the store failed; the row may or may not have changed.`);
  }
}
export class ConnectorConfigUpdateUnsupportedError extends ConnectorConfigUpdateError {
  constructor(key: string) {
    super("ConnectorConfigUpdateUnsupportedError", "CONNECTOR_CONFIG_UPDATE_UNSUPPORTED", key, `Connector config ${key} has sealed fields; update is not supported for it; nothing was written.`);
  }
}

const SQLSTATE = /^[0-9A-Z]{5}$/;

/** The underlying error's OWN string `code`, only when it has the SQLSTATE shape. */
function sqlStateOf(error: unknown): string | undefined {
  try {
    if (error === null || (typeof error !== "object" && typeof error !== "function")) return undefined;
    const code: unknown = Object.getOwnPropertyDescriptor(error, "code")?.value;
    return typeof code === "string" && SQLSTATE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

const REFUSED = Symbol("refused");

/** A thenable is refused; its rejection is marked handled first, so a refused async updater leaves no unhandled rejection. */
function isThenable(value: object): boolean {
  let then: unknown;
  try {
    then = (value as { then?: unknown }).then;
  } catch {
    return true;
  }
  if (typeof then !== "function") return false;
  try { Reflect.apply(then, value, [undefined, () => {}]); } catch { /* refused anyway */ }
  return true;
}

/**
 * A copy of `value` built from the JSON kinds only (an allow-list): null, booleans,
 * strings, finite numbers, arrays without holes and plain objects (prototype
 * Object.prototype or null) of own enumerable data properties with string keys.
 * `undefined` is allowed only as an object property value and is dropped, as
 * JSON drops it. Anything else is REFUSED: NaN, Infinity, bigint, symbol,
 * function, thenable, Map, Set, Date, boxed primitive, class instance, accessor,
 * symbol key, hole, cycle.
 */
function jsonCopy(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : REFUSED;
  if (typeof value === "function") {
    isThenable(value);
    return REFUSED;
  }
  if (typeof value !== "object" || ancestors.has(value) || isThenable(value)) return REFUSED;
  const isArray = Array.isArray(value);
  const proto: unknown = Object.getPrototypeOf(value);
  if (isArray ? proto !== Array.prototype : proto !== Object.prototype && proto !== null) return REFUSED;
  const ownKeys = Reflect.ownKeys(value);
  // An array holds its indices and `length` only: a hole or an extra key refuses.
  if (isArray && ownKeys.length !== (value as unknown[]).length + 1) return REFUSED;
  const keys = isArray ? ownKeys.filter((name) => name !== "length") : ownKeys;
  if (isArray && !keys.every((name, i) => name === String(i))) return REFUSED;
  const out = (isArray ? [] : Object.create(null)) as Record<string, unknown>;
  ancestors.add(value);
  for (const name of keys) {
    if (typeof name !== "string") return REFUSED;
    const d = Object.getOwnPropertyDescriptor(value, name);
    if (!d || !d.enumerable || !("value" in d)) return REFUSED;
    if (d.value === undefined && !isArray) continue;
    const copy = jsonCopy(d.value, ancestors);
    if (copy === REFUSED) return REFUSED;
    out[name] = copy;
  }
  ancestors.delete(value);
  return out;
}

/** The JSON text to store, or UPDATE_INVALID when `next` is not made of JSON kinds only. */
function storableRaw(next: unknown, key: string): string {
  let raw: unknown;
  try {
    const copy = jsonCopy(next, new Set());
    raw = copy === REFUSED ? undefined : JSON.stringify(copy);
  } catch {
    raw = undefined; // a proxy trap or a too-deep value
  }
  if (typeof raw !== "string") throw new ConnectorConfigUpdateInvalidError(key);
  return raw;
}

/**
 * Apply `updater` to the stored row of `connectorId` atomically (rules U0-U11).
 * Returns once one conditional persist landed; throws a value-free
 * {@link ConnectorConfigUpdateError} otherwise. A call that throws CONFLICT,
 * ROW_UNPARSEABLE, UPDATER_FAILED, UPDATE_INVALID or UNSUPPORTED wrote nothing.
 */
export function updateConnectorConfigVia(
  port: ConnectorConfigUpdatePort,
  connectorId: string,
  updater: ConnectorConfigUpdater,
  isSealed: (connectorId: string) => boolean,
): void {
  const key = `connector_config:${connectorId}`;
  let sqlstate: string | undefined;
  const storeStep = <T>(step: () => T, accept: (value: unknown) => boolean): T => {
    let value: unknown;
    try {
      value = step();
    } catch (error) {
      sqlstate = sqlStateOf(error);
      throw new ConnectorConfigStoreFailedError(key);
    }
    // A port result outside its contract leaves the outcome unknown: refuse.
    if (!accept(value)) throw new ConnectorConfigStoreFailedError(key);
    return value as T;
  };
  const isBoolean = (value: unknown) => typeof value === "boolean";

  try {
    // U0: a sealed id is refused before any store or cache call.
    if (isSealed(connectorId)) throw new ConnectorConfigUpdateUnsupportedError(key);
    for (let attempt = 0; attempt < CONNECTOR_CONFIG_UPDATE_ATTEMPTS; attempt += 1) {
      // U1/U2: the raw stored text, never the process cache; null = absent.
      const observedRaw = storeStep(() => port.readRaw(key), (v) => v === null || typeof v === "string");
      let current: unknown = null;
      if (observedRaw !== null) {
        try {
          current = JSON.parse(observedRaw);
        } catch {
          throw new ConnectorConfigRowUnparseableError(key); // U3
        }
      }
      let next: unknown;
      try {
        next = updater(current); // U4
      } catch {
        throw new ConnectorConfigUpdaterFailedError(key);
      }
      const nextRaw = storableRaw(next, key);
      // U5: one conditional statement; `true` is done at once, `false` retries.
      const landed =
        observedRaw === null
          ? storeStep(() => port.insertIfAbsent(key, nextRaw), isBoolean)
          : storeStep(() => port.compareAndSwap(key, nextRaw, observedRaw), isBoolean);
      if (landed) {
        try {
          port.cacheSet(key, JSON.parse(nextRaw)); // U8: the value as stored
        } catch {
          try { port.cacheEvict(key); } catch { /* in-memory cache; nothing to undo */ }
        }
        return;
      }
    }
    throw new ConnectorConfigConflictError(key); // U7
  } catch (caught) {
    const error =
      caught instanceof ConnectorConfigUpdateError ? caught : new ConnectorConfigStoreFailedError(key);
    // U8/U11 hold for every thrown error, UNSUPPORTED included (U0 bars only the store calls before it).
    try { port.cacheEvict(key); } catch { /* in-memory cache; nothing to undo */ }
    const state = error instanceof ConnectorConfigStoreFailedError && sqlstate ? ` sqlstate=${sqlstate}` : "";
    try { port.log(`[connector-config.update] key=${key} code=${error.code}${state}`); } catch { /* record only */ }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// The process cache of connector-config rows (read by
// `readConnectorConfigFromDatabase` in database.ts) and the live port. They
// live here, not in database.ts: that file sits at its file-size-ratchet
// ceiling, and this module must not import it.
// ---------------------------------------------------------------------------

// Connector config TTL: 10 s. Short enough that tunnel URL rotation is picked
// up quickly by BullMQ worker threads (which have a separate globalThis from
// the web process and cannot receive cache-invalidation writes from the tunnel
// manager). Without a TTL the stale URL is cached forever per-process.
export const CONNECTOR_CONFIG_CACHE_TTL_MS = 10_000;

export function getConnectorConfigCache(): Map<string, { value: unknown; expiresAt: number }> {
  if (!globalThis.__cinatraConnectorConfigCache) {
    globalThis.__cinatraConnectorConfigCache = new Map<string, { value: unknown; expiresAt: number }>();
  }
  return globalThis.__cinatraConnectorConfigCache;
}

const LIVE_CONNECTOR_CONFIG_UPDATE_PORT: ConnectorConfigUpdatePort = {
  readRaw: (key) => readRawMetadataStringInternal(key),
  compareAndSwap: (key, nextRaw, expectedRaw) => compareAndSwapMetadataValueInternal(key, nextRaw, expectedRaw),
  insertIfAbsent: (key, nextRaw) => insertRawMetadataValueIfAbsentInternal(key, nextRaw),
  cacheSet: (key, value) => {
    getConnectorConfigCache().set(key, { value: structuredClone(value), expiresAt: Date.now() + CONNECTOR_CONFIG_CACHE_TTL_MS });
  },
  cacheEvict: (key) => {
    getConnectorConfigCache().delete(key);
  },
  log: (line) => console.warn(line),
};

/** The host `update` member of `@cinatra-ai/host:connector-config`. */
export function updateConnectorConfigInDatabase(connectorId: string, updater: ConnectorConfigUpdater): void {
  updateConnectorConfigVia(LIVE_CONNECTOR_CONFIG_UPDATE_PORT, connectorId, updater, hasSecretFields);
}
