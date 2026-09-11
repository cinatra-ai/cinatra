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
//   - `scripts/gen-graphiti-env.mjs` (bring-up: hands the key to the indexer
//     container through the environment of the compose command that creates it —
//     it is never written to a file),
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
  readMetadataValueInternal,
  readRawOpenAIConnectionRow,
  readUnsealedOpenAIConnectionRow,
} from "@/lib/database-metadata";

/** Where a resolved key came from. `null` when nothing resolved. */
export type KnowledgeGraphKeySource = "stored-connection" | "environment";

/**
 * Which vendor performs ENTITY EXTRACTION in the indexer (cinatra#2591
 * deliverable 2).
 *
 * These are the two the epic's 2026-08-09 ruling names, and the two this repo
 * stores a connection for. Upstream graphiti also ships Gemini/Groq/Azure
 * branches; they are deliberately NOT offered here, because cinatra has no
 * stored connection to resolve a key from — adding one is a connector question,
 * not a substrate question.
 *
 * The EMBEDDER is a separate axis and is never this value: Anthropic publishes
 * no embeddings API at all, so an Anthropic install always ranks on the local
 * floor (docker/kg-embedder). See `buildGraphitiEnv` in
 * `scripts/gen-graphiti-env.mjs`.
 */
export type KnowledgeGraphExtractionProvider = "openai" | "anthropic";

export type KnowledgeGraphKeyResolution = {
  /** The resolved key, or null. NEVER log, echo, or serialize this. */
  key: string | null;
  /**
   * WHICH vendor the resolved key belongs to, or null when nothing resolved.
   * The generator keys the container's whole provider block off this, so it
   * must never disagree with `key`.
   */
  provider: KnowledgeGraphExtractionProvider | null;
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
 * The operator's COMMITTED default LLM provider, narrowed to the two the
 * indexer can actually run (cinatra#2591).
 *
 * Read straight from the connector-config metadata key rather than through
 * `@/lib/database#readDefaultLlmProviderFromDatabase`. Two reasons, both about
 * this module's callers: `scripts/gen-graphiti-env.mjs` imports this file
 * during a bring-up whose database may not exist yet, and the whole point of
 * the lazy import there is a SMALL module graph that fails soft. `database.ts`
 * pulls the connector-config cache and the sealing layer with it; the metadata
 * primitive this file already imports does not.
 *
 * The return distinguishes four states, because "the operator chose openai" and
 * "the operator has not chosen yet" must NOT be treated alike — see the
 * cross-vendor rule in `resolveKnowledgeGraphProviderKey`:
 *
 *   "openai" / "anthropic" — BOUND to a vendor this indexer can run.
 *   "unsupported"          — bound to a vendor cinatra stores no connection
 *                            for (gemini/groq/azure). It is still a CHOICE, so
 *                            it binds like any other: extraction resolves
 *                            NOTHING. "We hold no key for your vendor" explains
 *                            why THAT key cannot run extraction; it is not an
 *                            argument for spending a different vendor's.
 *   "unbound"              — the operator has not named a vendor anywhere. No
 *                            choice exists to violate.
 *
 * TWO ROWS, NOT ONE. `llm_default_provider` is written by the setup saga's
 * COMMIT step, but the wizard persists the operator's pick to
 * `setup_provider_selection` BEFORE that — at click time
 * (`src/app/setup/model/actions.ts` -> `selectSetupProviderAction`). Between
 * those two writes, and after a readiness failure that never reached commit, an
 * install has NO committed row while the operator has explicitly chosen a
 * vendor and may already have saved its credential. Reading only the committed
 * row would treat that operator as undecided and route their row content to
 * whichever vendor happened to be tried first. So a selection binds too; the
 * commitment simply outranks it.
 *
 * Both keys are read through the metadata primitive rather than imported from
 * their owning modules on purpose — see the module-graph note above.
 */
type BoundExtractionProvider =
  | KnowledgeGraphExtractionProvider
  | "unsupported"
  | "unbound";

/**
 * The binding, plus the vendor's own NAME when it is one cinatra cannot run.
 *
 * The name is operator-facing only, and it is the whole difference between
 * "extraction is off" and "extraction is off because this install is bound to
 * gemini". Since the choice is binding, "off" now has a vendor-specific cause,
 * and an operator with a perfectly good OpenAI key on file has no other way to
 * learn why it is deliberately not being used.
 */
type BindingRead = { bound: BoundExtractionProvider; vendor: string | null };

/**
 * The vendor name lands in a reason string that is logged and shown. It comes
 * from a database row, so it is narrowed to a short lowercase identifier before
 * it goes anywhere — a name that does not fit is simply omitted, and the
 * sentence still reads. The binding itself never depends on this.
 */
function displayableVendorName(stored: unknown): string | null {
  if (typeof stored !== "string") return null;
  return /^[a-z0-9][a-z0-9._-]{0,31}$/.test(stored) ? stored : null;
}

function narrowBoundProvider(stored: unknown): BindingRead | null {
  // `null` as the fallback is load-bearing: it is how "no row" is told apart
  // from a row that actually says `openai`.
  if (stored === null || stored === undefined || stored === "") return null;
  if (stored === "anthropic") return { bound: "anthropic", vendor: "anthropic" };
  if (stored === "openai") return { bound: "openai", vendor: "openai" };
  return { bound: "unsupported", vendor: displayableVendorName(stored) };
}

function readBoundExtractionProvider(): BindingRead {
  const committed = narrowBoundProvider(
    readMetadataValueInternal<unknown>("connector_config:llm_default_provider", null),
  );
  if (committed) return committed;
  // Not committed yet — fall to the wizard's own selection row.
  const selected = narrowBoundProvider(
    readMetadataValueInternal<unknown>("connector_config:setup_provider_selection", null),
  );
  return selected ?? { bound: "unbound", vendor: null };
}

/**
 * The stored Anthropic key, or null.
 *
 * `anthropic_connection` carries NO designated secret field (asserted by
 * `src/lib/__tests__/connector-config-secret-at-rest.test.ts`), so unlike the
 * OpenAI row there is no seal to open and no "present but undecryptable" state
 * to disambiguate — the value is either there or it is not.
 */
function readStoredAnthropicKey(): string | null {
  const row = readMetadataValueInternal<{ apiKey?: unknown } | null>(
    "connector_config:anthropic_connection",
    null,
  );
  return trimmed(row?.apiKey);
}

/**
 * Resolve the PROVIDER and the key the knowledge-graph indexer should run with.
 *
 * THE RULE: A BOUND VENDOR IS BINDING. Extraction sends ROW CONTENT to
 * whichever vendor runs it, so the vendor is the operator's decision and no
 * source may quietly override it — not the other vendor's stored connection,
 * and not the legacy environment key. An install that named a vendor runs
 * extraction on that vendor or does not run it at all.
 *
 * Resolution, and why:
 *  1. THE BOUND VENDOR'S OWN stored configuration, and only it. The binding is
 *     the committed `llm_default_provider`, or the wizard's
 *     `setup_provider_selection` while no commitment exists yet (cinatra#2591
 *     deliverable 2) — the places an operator actually names a vendor, and the
 *     source the ruling names.
 *  2. NOTHING ELSE, once a vendor is bound. A bound vendor with no usable key
 *     means extraction is OFF, and `describeKnowledgeGraphIndexing` says which
 *     vendor to fix. This holds for a vendor cinatra cannot run at all
 *     (gemini/groq/azure): the absence of a key for the operator's choice is
 *     not a licence to spend someone else's.
 *
 *     An earlier shape tried the OTHER supported vendor here, reasoning that an
 *     install should index rather than sit dark. Do not reinstate it. It reads
 *     as helpful and is not: it shipped object bodies to a vendor the operator
 *     never chose, and the only trace was a reason string. A provider choice a
 *     background job can silently override is not a choice.
 *  3. UNBOUND installs — and only they — try both stored vendors and then
 *     `OPENAI_API_KEY` in the process env. No choice exists anywhere, so there
 *     is nothing to violate. The legacy env path stays because the
 *     works-after/upgrade CI arms and operators who set it in `.env.local`
 *     depend on it, and because it is the only source available before the
 *     database exists (a first bring-up).
 *
 * A binding that could not be READ is not "unbound" — the absence of a fact is
 * not a fact. It resolves nothing either; see `bindingUnknown` below.
 *
 * A database that is unreachable (a cold bring-up brings Postgres up in the
 * same command) is NOT an error here: it degrades to the env fallback, and the
 * caller reports honestly if neither resolves.
 */
export function resolveKnowledgeGraphProviderKey(): KnowledgeGraphKeyResolution {
  let storedReadError: string | null = null;
  let bound: BoundExtractionProvider = "unbound";
  // The bound vendor's own name, for the operator-facing reason only. Non-null
  // only when the binding names a vendor cinatra cannot run.
  let boundVendor: string | null = null;
  // Did we actually learn the binding, or merely fail to ask? The two must not
  // look alike to the environment path below: "no vendor bound" may use the
  // legacy key, "could not tell" may not.
  //
  // TRUE when the binding read threw but the database ANSWERED an independent
  // probe — so the install is initialized and the binding is genuinely unknown,
  // rather than absent because there is no database yet.
  let bindingUnknown = false;

  try {
    const read = readBoundExtractionProvider();
    bound = read.bound;
    boundVendor = read.vendor;
  } catch {
    // Which failure is this? A first bring-up has no database at all, and the
    // legacy env path exists precisely to serve it. A reachable database that
    // would not answer this question is a different animal: the operator may
    // well have bound Anthropic, and we simply cannot see it. Probe a DIFFERENT
    // row to tell them apart — the answer decides whether the env key below is
    // a reasonable default or a guess about someone else's data.
    try {
      readRawOpenAIConnectionRow();
      bindingUnknown = true;
      // "Could not ask" — and it MUST be reported as such. The bring-up
      // generator decides whether to RECREATE the indexer container on
      // `storedReadFailed`: a readable configuration holding no key is a
      // disconnect it must propagate, while an unreadable one with nothing to
      // offer must leave a container that may be running a good key alone. An
      // unknown binding is squarely the second kind, and reporting it as the
      // first would turn extraction off on a transient read error.
      storedReadError = "the configured extraction provider could not be determined";
    } catch {
      // No database. `unbound` stands, and the legacy path stays open.
    }
  }

  try {

    // A BOUND vendor is BINDING — the indexer never silently substitutes the
    // other one, from ANY source, including the legacy environment path below.
    //
    // The earlier shape here tried the operator's vendor and then fell back to
    // the other. That reads as helpful and is not: extraction sends ROW CONTENT
    // to whichever vendor runs it. An install bound to Anthropic whose key is
    // momentarily undecryptable, with a stale OpenAI connection still on file,
    // would have begun shipping object bodies to OpenAI — a vendor the operator
    // did not choose — and the only trace was a reason string. A provider
    // choice that a background job can silently override is not a choice. So a
    // bound vendor with no usable key means extraction is OFF, and
    // `describeKnowledgeGraphIndexing` says which vendor to fix.
    //
    // AND A VENDOR CINATRA CANNOT RUN IS STILL A BOUND VENDOR. `unsupported` is
    // what the binding read returns for a real product selection cinatra stores
    // no connection for — `gemini` above all, which the model picker and the
    // background-job registry both offer and the setup action accepts. Having no
    // Gemini key explains why the GEMINI key cannot run extraction. It says
    // nothing about why the OPENAI key may. Coercing to OpenAI here would take
    // an operator who explicitly chose Gemini and send their object bodies to
    // OpenAI — the identical defect this issue closed for Anthropic, on a third
    // vendor, and reached from a stored connection or an inherited env var
    // alike. So it resolves NOTHING, and the reason names the vendor they chose.
    //
    // `unbound` is the one case that legitimately tries both: no choice exists
    // anywhere, so there is nothing to violate, and an install that configured
    // a vendor before reaching setup should still index.
    //
    // An UNKNOWN binding resolves NOTHING — not from the environment, and not
    // from a stored connection either. The two are the same mistake: a
    // reachable database whose binding row will not read may well say Anthropic,
    // and picking the OpenAI connection just because it happens to be readable
    // is the guess this whole rule exists to refuse. Extraction stays off until
    // the install can say who it chose.
    const order: KnowledgeGraphExtractionProvider[] =
      bindingUnknown || bound === "unsupported"
        ? []
        : bound === "anthropic"
          ? ["anthropic"]
          : bound === "openai"
            ? ["openai"]
            : ["openai", "anthropic"];

    for (const provider of order) {
      if (provider === "anthropic") {
        const stored = readStoredAnthropicKey();
        if (stored) {
          return {
            key: stored,
            provider: "anthropic",
            source: "stored-connection",
            reason:
              bound === "anthropic"
                ? "resolved from the app's stored Anthropic provider configuration"
                : "resolved from the app's stored Anthropic provider configuration " +
                  "(no default provider is committed yet)",
            storedReadFailed: false,
          };
        }
        continue;
      }

      // Canonical UNSEALED accessor (cinatra#2587) for the value.
      const row = readUnsealedOpenAIConnectionRow();
      const stored = trimmed(row?.apiKey);
      if (stored) {
        return {
          key: stored,
          provider: "openai",
          source: "stored-connection",
          reason:
            bound === "openai"
              ? "resolved from the app's stored OpenAI provider configuration"
              // The only other way to reach this loop is `unbound` — an
              // `unsupported` binding never enters it.
              : "resolved from the app's stored OpenAI provider configuration " +
                "(no default provider is committed yet)",
          storedReadFailed: false,
        };
      }
      // No usable key came back. That is EITHER "none configured" OR "the seal
      // failed to open" — the fail-closed unseal drops the field either way, so
      // ask the raw row which one it was.
      if (storedKeyPresentButUnreadable()) {
        storedReadError = "the stored key could not be decrypted";
      }
    }
  } catch (err) {
    // Error CLASS only — a decrypt/DB error must never carry key material.
    storedReadError = err instanceof Error ? err.constructor.name : "unknown error";
    // A throw from `storedKeyPresentButUnreadable`'s own catch cannot reach here,
    // so anything landing here means a read genuinely failed. Whether the
    // DATABASE is reachable was already decided by the binding read above.
  }

  // THE LEGACY ENV PATH IS BOUND TOO. `OPENAI_API_KEY` is, by its name, an
  // OpenAI credential, so honouring it on an install bound to Anthropic would
  // re-open the very hole the order above closes — and by the quietest route,
  // since an env var can be inherited from a shell the operator never edited.
  // It stays available exactly where it was always meant to be: an install with
  // no vendor bound (a first bring-up, before any database exists), or one
  // already bound to OpenAI.
  //
  // AND IT DOES NOT FAIL OPEN. If the binding read THREW, "unbound" is not a
  // fact, it is the absence of one — so an Anthropic install whose metadata read
  // flaked must not silently fall through to an OpenAI key. The two failure
  // shapes are told apart by whether the database answered at all: no database
  // is the first-bring-up signature the legacy path exists to serve, while a
  // reachable database that would not answer this question means the binding is
  // genuinely UNKNOWN, and an unknown binding is not a licence to guess.
  //
  // A binding to a vendor cinatra cannot run (`unsupported`) refuses it for the
  // same reason it refuses the stored connection above, and this is the quieter
  // half of that hole: an env var can be inherited from a shell the operator
  // never edited, so a Gemini-bound install could ship row content to OpenAI
  // with nothing anywhere recording a decision.
  const envRefused =
    bound === "anthropic" || bound === "unsupported" || bindingUnknown;
  const fromEnv = envRefused ? null : trimmed(process.env.OPENAI_API_KEY);
  if (fromEnv) {
    return {
      key: fromEnv,
      provider: "openai",
      source: "environment",
      reason: "resolved from OPENAI_API_KEY in the environment (legacy path)",
      storedReadFailed: storedReadError !== null,
    };
  }

  // An OpenAI key IS set, and the binding is to some other vendor. Worth saying
  // out loud: the operator can see the key on file and would otherwise read
  // "extraction off" as a bug.
  const envIgnoredForBoundVendor =
    (bound === "anthropic" || bound === "unsupported") &&
    trimmed(process.env.OPENAI_API_KEY) !== null;

  return {
    key: null,
    provider: null,
    source: null,
    // NAME the bound vendor. Since the operator's choice is binding, "off" now
    // has a vendor-specific cause, and an operator who reads "no key" while a
    // DIFFERENT vendor is configured would otherwise have no way to tell that
    // the other key is deliberately not being used.
    reason: bindingUnknown
      ? "the configured extraction provider could not be determined, so no key was " +
        "resolved — neither a stored connection nor OPENAI_API_KEY is used as a guess, " +
        "because extraction sends row content and must run on the vendor this install " +
        "actually names."
      : bound === "unsupported"
      ? `the selected extraction provider${boundVendor ? ` (${boundVendor})` : ""} is one ` +
        `cinatra cannot run for knowledge-graph extraction: it stores no connection for ` +
        `that vendor, so there is no key to resolve. A DIFFERENT vendor's key is ` +
        `deliberately NOT substituted` +
        (envIgnoredForBoundVendor
          ? ", including OPENAI_API_KEY, which is set but belongs to another vendor"
          : "") +
        `, because extraction sends row content and must run on the vendor this install ` +
        `actually names. Select OpenAI or Anthropic to turn extraction on.`
      : storedReadError
      ? `no usable extraction provider key: the stored ` +
        `${bound === "anthropic" ? "Anthropic" : "OpenAI"} configuration could not be ` +
        `read (${storedReadError})` +
        (envIgnoredForBoundVendor
          ? ", and OPENAI_API_KEY is set but NOT substituted for the selected vendor"
          : " and OPENAI_API_KEY is unset")
      : bound === "anthropic" || bound === "openai"
        ? `the selected extraction provider (${bound}) has no key configured in the app` +
          (envIgnoredForBoundVendor
            ? ", and OPENAI_API_KEY is set but belongs to the OTHER vendor"
            : ", and OPENAI_API_KEY is unset") +
          `. A key for the other vendor is deliberately NOT substituted — extraction ` +
          `sends row content, so it runs on the vendor you chose.`
        : "no OpenAI or Anthropic provider key is configured in the app and " +
          "OPENAI_API_KEY is unset",
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
      `knowledge-graph EXTRACTION OFF — no provider key (${state.reason}). ` +
      "Objects are still saved and listed, and they are still SEEDED and RANKED " +
      "through their deterministic anchor nodes on the local embedder floor " +
      "(cinatra#2591); what is off is entity extraction. Configure OpenAI or " +
      "Anthropic in the app, then re-run the bring-up (`npm run kg:refresh`)."
    );
  }
  return (
    `knowledge-graph provider key UNKNOWN — ${state.reason}. ` +
    "Treated as possibly configured; re-run the bring-up (`npm run kg:refresh`) once the " +
    "app's configuration is readable."
  );
}
