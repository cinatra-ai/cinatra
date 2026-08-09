import "server-only";

// ---------------------------------------------------------------------------
// Knowledge-graph (Graphiti) indexing state + provider-key resolution.
// cinatra#2582 — the operational-honesty layer on the current deployment.
//
// THE DEFECT THIS EXISTS FOR. `docker-compose.yml` used to hand the indexer
// `${OPENAI_API_KEY:-}`. That interpolation reads the SHELL env, and the app's
// OpenAI key does not live there — it lives in the app database, configured
// in-app. So a normal install started the indexer with an EMPTY key. Graphiti
// then logs "No LLM client configured - entity extraction will be limited" and,
// because extraction runs BEFORE the Neo4j write, every episode is accepted and
// then dropped. The knowledge graph was silently empty on every default install
// and nothing anywhere said so.
//
// THIS MODULE IS THE ONE ANSWER TO "IS INDEXING ON?" — used by
//   - `scripts/gen-graphiti-env.mjs` (bring-up: materializes the container env),
//   - the boot phase that states the answer in the app log,
//   - the objects seam's indexing probe (gates the per-episode usage row).
//
// SECRETS. `resolveKnowledgeGraphProviderKey` is the ONLY export that returns
// the key value, it is read through the canonical sealed-at-rest accessor
// (cinatra#2587 — never a raw metadata read), and no function here logs it,
// returns a prefix of it, or puts it in an error. `readKnowledgeGraphIndexingState`
// returns presence only.
// ---------------------------------------------------------------------------

import {
  readRawOpenAIConnectionRow,
  readUnsealedOpenAIConnectionRow,
} from "@/lib/database-metadata";

/** Where a resolved key came from. `null` when nothing resolved. */
export type KnowledgeGraphKeySource = "stored-connection" | "environment";

export type KnowledgeGraphKeyResolution = {
  /** The resolved key, or null. NEVER log, echo, or serialize this. */
  key: string | null;
  source: KnowledgeGraphKeySource | null;
  /** Operator-facing explanation. Key-free by construction. */
  reason: string;
  /**
   * TRUE when the STORED configuration could not be read as a usable key: no
   * database yet, a query error, or a row whose sealed `apiKey` failed to
   * decrypt (a rotated `CINATRA_ENCRYPTION_KEY`, a tampered blob — the seal is
   * fail-closed and simply drops the field, so "unreadable" and "absent" look
   * identical downstream unless the raw row is consulted, which is what
   * `storedKeyPresentButUnreadable` below does).
   *
   * Distinct from "read fine, and there is no key". The bring-up needs the
   * distinction: "I could not ask" must not overwrite a key an earlier run
   * materialized, while "the operator removed the key" MUST — otherwise a
   * disconnected or rotated-away credential would keep running in the indexer
   * container indefinitely.
   */
  storedReadFailed: boolean;
};

/**
 * What the APP knows about the indexer's provider key.
 *
 * Deliberately named for what it measures. The app can see its own stored
 * configuration; it cannot see what the already-running container was started
 * with, and the pinned wrapper reports no readiness. So the honest vocabulary
 * is "configured / absent / unknown", never "indexing is on" — a key saved a
 * minute ago is configured and NOT yet in the container.
 */
export type KnowledgeGraphProviderKeyState = {
  providerKey: "configured" | "absent" | "unknown";
  /** Operator-facing explanation. Key-free by construction. */
  reason: string;
};

function trimmed(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * Did the stored row CARRY an `apiKey` that the unseal then dropped?
 *
 * The canonical unsealed accessor is fail-closed: on a decrypt failure it
 * returns the row with the field removed, which is byte-identical to "the
 * operator never set one". Only the RAW row tells them apart, and the
 * difference decides whether the bring-up preserves or clears a previously
 * materialized credential. Reads shape only — never the value, sealed or not.
 */
function storedKeyPresentButUnreadable(): boolean {
  try {
    const raw = readRawOpenAIConnectionRow();
    const field = raw?.apiKey;
    if (typeof field === "string") return field.trim() !== "";
    return typeof field === "object" && field !== null;
  } catch {
    // The raw read failed too — the caller already treats that as unreadable.
    return true;
  }
}

/**
 * Resolve the OpenAI key the knowledge-graph indexer should run with.
 *
 * Order, and why:
 *  1. the app's STORED provider configuration — the place an operator actually
 *     configures OpenAI, and the source the ruling names;
 *  2. `OPENAI_API_KEY` in the process env — the legacy path. Still honoured
 *     because the works-after/upgrade CI arms and operators who set it in
 *     `.env.local` depend on it, and because it is the only source available
 *     before the database exists (a first bring-up).
 *
 * A database that is unreachable (a cold bring-up brings Postgres up in the
 * same command) is NOT an error here: it degrades to the env fallback, and the
 * caller reports honestly if neither resolves.
 */
export function resolveKnowledgeGraphProviderKey(): KnowledgeGraphKeyResolution {
  let storedReadError: string | null = null;
  try {
    // Canonical UNSEALED accessor (cinatra#2587) for the value.
    const row = readUnsealedOpenAIConnectionRow();
    const stored = trimmed(row?.apiKey);
    if (stored) {
      return {
        key: stored,
        source: "stored-connection",
        reason: "resolved from the app's stored OpenAI provider configuration",
        storedReadFailed: false,
      };
    }
    // No usable key came back. That is EITHER "none configured" OR "the seal
    // failed to open" — the fail-closed unseal drops the field either way, so
    // ask the raw row which one it was.
    if (storedKeyPresentButUnreadable()) {
      storedReadError = "the stored key could not be decrypted";
    }
  } catch (err) {
    // Error CLASS only — a decrypt/DB error must never carry key material.
    storedReadError = err instanceof Error ? err.constructor.name : "unknown error";
  }

  const fromEnv = trimmed(process.env.OPENAI_API_KEY);
  if (fromEnv) {
    return {
      key: fromEnv,
      source: "environment",
      reason: "resolved from OPENAI_API_KEY in the environment (legacy path)",
      storedReadFailed: storedReadError !== null,
    };
  }

  return {
    key: null,
    source: null,
    reason: storedReadError
      ? `no usable OpenAI provider key: the stored configuration could not be read ` +
        `(${storedReadError}) and OPENAI_API_KEY is unset`
      : "no OpenAI provider key is configured in the app and OPENAI_API_KEY is unset",
    storedReadFailed: storedReadError !== null,
  };
}

// The probe runs on the projection path, which fires every repair cycle. The
// underlying read is a synchronous metadata query, so cache the ANSWER (never
// the key) briefly: long enough that a busy outbox drain does not re-query per
// episode, short enough that configuring a key becomes visible within a minute.
const PROVIDER_KEY_STATE_TTL_MS = 60_000;

let cachedState: { at: number; state: KnowledgeGraphProviderKeyState } | null = null;

/**
 * Presence-only view of {@link resolveKnowledgeGraphProviderKey}, cached.
 *
 * `unknown` is deliberate and distinct from `absent`: it means the question
 * could not be answered (no database yet, a key that will not decrypt), and
 * callers that must not over-claim — the usage-metering gate — treat it
 * differently from a confirmed "no key".
 *
 * SCOPE, stated rather than papered over: this answers "does the APP hold a
 * key", which is what the bring-up injects. It cannot see what the
 * already-running container was started with, and the pinned wrapper reports no
 * readiness. Between saving a key and re-running the bring-up, the app reports
 * `configured` while the container still has none — episode rows are then
 * counted for a fan-out that did not happen (they carry no dollars, so the
 * error is a count, not a bill), and the reverse gap under-counts for one
 * restart. Every operator-facing string therefore says the key applies from the
 * next bring-up, and never claims the indexer is running with it.
 */
export function readKnowledgeGraphProviderKeyState(
  options?: { now?: number },
): KnowledgeGraphProviderKeyState {
  const now = options?.now ?? Date.now();
  if (cachedState && now - cachedState.at < PROVIDER_KEY_STATE_TTL_MS) {
    return cachedState.state;
  }
  let state: KnowledgeGraphProviderKeyState;
  try {
    const resolved = resolveKnowledgeGraphProviderKey();
    if (resolved.key) {
      state = { providerKey: "configured", reason: resolved.reason };
    } else if (resolved.storedReadFailed) {
      // We could not ASK. Answering "absent" here would be a claim we cannot
      // make, and the metering gate treats the two differently on purpose.
      state = { providerKey: "unknown", reason: resolved.reason };
    } else {
      state = { providerKey: "absent", reason: resolved.reason };
    }
  } catch (err) {
    state = {
      providerKey: "unknown",
      reason: `provider-key resolution failed: ${
        err instanceof Error ? err.constructor.name : "unknown error"
      }`,
    };
  }
  cachedState = { at: now, state };
  return state;
}

/** Test seam: drop the memoized answer. */
export function __resetKnowledgeGraphIndexingCacheForTests(): void {
  cachedState = null;
}

/**
 * The single operator-facing sentence for the current state. Used by the boot
 * phase and by the bring-up generator so both say the SAME thing.
 *
 * None of these sentences claims the indexer IS indexing: the app cannot see
 * inside the running container. They say what the app has, and what to do to
 * make the container agree.
 */
export function describeKnowledgeGraphIndexing(state: KnowledgeGraphProviderKeyState): string {
  if (state.providerKey === "configured") {
    return (
      `knowledge-graph provider key CONFIGURED — ${state.reason}. ` +
      "The indexer container uses it from its next bring-up (`npm run kg:refresh`); " +
      "a container started before the key was saved is still running without one."
    );
  }
  if (state.providerKey === "absent") {
    return (
      `knowledge-graph indexing OFF — no provider key (${state.reason}). ` +
      "Objects are still saved and listed; they are not indexed into the graph. " +
      "Configure OpenAI in the app, then re-run the bring-up (`npm run kg:refresh`)."
    );
  }
  return (
    `knowledge-graph provider key UNKNOWN — ${state.reason}. ` +
    "Treated as possibly configured; re-run the bring-up (`npm run kg:refresh`) once the " +
    "app's configuration is readable."
  );
}
