/**
 * cinatra#3559 — THE replay of the store's schema DDL into a throwaway test
 * schema. One module, so there is exactly one answer to "which statements does
 * an integration file's setup run?".
 *
 * Why the selection is not just the head filter: `buildCreateStoreSchemaQueries`
 * emits a handful of statements whose OWN target is a SHARED `public` table —
 * the Better Auth `user`/`team`/`organization`/`member` tables every schema in
 * the database shares. A throwaway schema does not own those, and no per-file
 * setup does either. When two integration files bootstrap at the same time,
 * both take `AccessExclusiveLock` on the same shared object and Postgres
 * resolves the cycle by killing one of them with `40P01 deadlock detected`.
 * Removing the contended statements removes the class.
 *
 * The skip is STRUCTURAL and anchored on the statement's own leading command,
 * never on an object name and never on an unanchored search of the text:
 *   - a schema-local `CREATE OR REPLACE FUNCTION` may write a shared table in
 *     its BODY, and it must still be created — the schema under test needs it;
 *   - a schema-local table may carry `REFERENCES public."user"(id) ON DELETE
 *     CASCADE`, and that `ON DELETE` is not an `ON <table>` clause;
 *   - the schema qualifier is matched in BOTH spellings the builder uses,
 *     `public."x"` and `"public"."x"`, so a quoted qualifier cannot slip a
 *     shared-table statement past the skip.
 *
 * Why the accepted heads are a per-call option: the copied loops this module
 * replaces were NOT all the same. Most accepted four statement heads; a few
 * also accepted `DO $$ ` — the head of the anonymous blocks that create the
 * bootstrap's ENUM types — and those files need the types the blocks create.
 * The default is the four heads, and a caller that replaced a wider loop names
 * the head it was accepting, so its replay stays statement-for-statement what
 * it was.
 */

/** A statement as the store's schema builders emit it. */
export type StoreSchemaStatement = {
  text: string;
  values?: unknown[];
};

/** The minimal shape of a connected client — a `pg.Client` satisfies it. */
export type StoreSchemaReplayClient = {
  query(text: string, values?: unknown[]): Promise<unknown>;
};

export type StoreSchemaReplayOptions = {
  /**
   * Six-character statement heads this caller replays BESIDES the four
   * defaults, spelled exactly as the statement's own first six characters read
   * once uppercased — `"DO $$ "` for an anonymous block written `DO $$ BEGIN`.
   * A spelling that is not six characters long matches no statement.
   */
  additionalHeads?: readonly string[];
};

/**
 * The four statement heads every schema bootstrap replays. Seed statements
 * (`INSERT`/`UPDATE`) are not replayed: a fresh empty schema has nothing for
 * them to act on.
 */
const REPLAYED_HEADS: readonly string[] = ["CREATE", "ALTER ", "DROP T", "DROP S"];

/** The six-character head a copied loop tested, uppercased as those loops do. */
export function headOf(text: string): string {
  return text.trim().slice(0, 6).toUpperCase();
}

/** Does the head filter — the four defaults plus this caller's — accept it? */
export function isReplayedHead(text: string, options?: StoreSchemaReplayOptions): boolean {
  const head = headOf(text);
  if (REPLAYED_HEADS.includes(head)) return true;
  return (options?.additionalHeads ?? []).some(
    (accepted) => accepted.toUpperCase() === head,
  );
}

/**
 * A shared table as the builder spells it. BOTH spellings occur: most
 * statements write `public."team"`, and the one that provisions an app-owned
 * column on the auth-owned session table writes `"public"."session"` — a
 * qualifier that only matches an unquoted-schema test by accident.
 */
const SHARED_QUALIFIED = String.raw`(?:public|"public")\s*\.\s*"`;

/** Leading commands whose target identifier is the statement's own object. */
const SHARED_TARGET_COMMANDS: readonly RegExp[] = [
  String.raw`^ALTER\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?`,
  String.raw`^DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:ONLY\s+)?`,
  String.raw`^UPDATE\s+(?:ONLY\s+)?`,
  String.raw`^DELETE\s+FROM\s+(?:ONLY\s+)?`,
  String.raw`^INSERT\s+INTO\s+`,
  String.raw`^TRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?`,
].map((command) => new RegExp(command + SHARED_QUALIFIED, "i"));

/** A TRIGGER or an INDEX names its table in an `ON` clause, not after the verb. */
const TRIGGER_OR_INDEX =
  /^(?:CREATE|DROP)\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:CONSTRAINT\s+)?(?:TRIGGER|INDEX)\b/i;
const ON_SHARED_TABLE = new RegExp(String.raw`\bON\s+` + SHARED_QUALIFIED, "i");

/**
 * The part of a TRIGGER or INDEX statement that can carry its own `ON` clause:
 * everything before the body it executes, with string literals blanked. A
 * shared table named inside a quoted argument — `EXECUTE FUNCTION f('ON
 * public."team"')` — is text the statement passes on, never the object it
 * locks, so it must not be read as a target.
 */
function targetClauseOf(statement: string): string {
  const withoutLiterals = statement.replace(/'(?:[^']|'')*'/g, "''");
  const body = withoutLiterals.search(/\bEXECUTE\b/i);
  return body === -1 ? withoutLiterals : withoutLiterals.slice(0, body);
}

/**
 * Is this statement's own target a shared `public` table — as opposed to a
 * schema-local object that merely references or reads one?
 *
 * An anonymous `DO` block is NOT read as a shared target: its leading command
 * is `DO`, its body is a program rather than one target clause, and the callers
 * that replay blocks at all need the types those blocks create. A block whose
 * body writes a shared table is recorded in this change's record instead of
 * being silently dropped.
 */
export function targetsSharedPublicTable(text: string): boolean {
  const statement = text.trim();
  if (SHARED_TARGET_COMMANDS.some((command) => command.test(statement))) {
    return true;
  }
  return TRIGGER_OR_INDEX.test(statement) && ON_SHARED_TABLE.test(targetClauseOf(statement));
}

/** The statements a replay runs, in the builder's own order. */
export function selectReplayStatements<Statement extends StoreSchemaStatement>(
  statements: readonly Statement[],
  options?: StoreSchemaReplayOptions,
): Statement[] {
  return statements.filter(
    (statement) =>
      isReplayedHead(statement.text, options) &&
      !targetsSharedPublicTable(statement.text),
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A fresh empty schema has no seed rows and may already carry an object a
 * sibling statement created — both are expected and neither is a failure.
 */
function isTolerated(err: unknown): boolean {
  const message = messageOf(err);
  return message.includes("does not exist") || message.includes("already exists");
}

/** SQLSTATE 40P01: this connection was chosen as the deadlock victim. */
function isDeadlockVictim(err: unknown): boolean {
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return code === "40P01" || messageOf(err).includes("deadlock detected");
}

/** The single backoff before the one retry below, in milliseconds. */
const DEADLOCK_RETRY_DELAY_MS = 200;

/**
 * Replay `statements` into the schema `client` is pointed at.
 *
 * The ONE retry: with the shared-`public` statements gone, the residue a
 * concurrent bootstrap can still deadlock on is a schema-LOCAL `CREATE TABLE`
 * or `ALTER TABLE` whose foreign key references a shared `public` table, meeting
 * another file's `DROP SCHEMA ... CASCADE` on the same shared row. Each
 * statement is autocommit, so re-running the aborted one is deterministic. It is
 * bounded at a single retry and lives here, in the replay, never around a file.
 */
export async function replayStoreSchema(
  client: StoreSchemaReplayClient,
  statements: readonly StoreSchemaStatement[],
  options?: StoreSchemaReplayOptions,
): Promise<void> {
  for (const statement of selectReplayStatements(statements, options)) {
    for (let attempt = 0; ; attempt += 1) {
      try {
        await client.query(statement.text, statement.values ?? []);
        break;
      } catch (err) {
        if (isTolerated(err)) break;
        if (attempt === 0 && isDeadlockVictim(err)) {
          await new Promise((resolve) => setTimeout(resolve, DEADLOCK_RETRY_DELAY_MS));
          continue;
        }
        throw err;
      }
    }
  }
}
