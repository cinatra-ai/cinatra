/**
 * The connection string the ROOT unit suite hands to code that must never reach
 * a database — and the predicate every DB-presence guard recognises it by.
 *
 * The endpoint keeps the conventional `localhost` host (the code under test
 * treats a refused local connection as "no database"; an address literal does
 * not take that road) but sits on TCP port 1 instead of the PostgreSQL default.
 * The address is perfectly routable: what makes it safe is that nothing in the
 * test environment answers it and no CI service container publishes it, so a
 * connection attempt is refused at once. The earlier placeholder used port
 * 5432, and a PostgreSQL that happened to listen on the conventional local
 * endpoint answered it — fifteen unrelated unit tests then failed on "password
 * authentication failed" instead of seeing a refused connection. The guard test
 * beside this module keeps the endpoint off 5432.
 *
 * A guard must therefore never key on the WHOLE string: the port moved once and
 * can move again, and a guard that no longer recognises the placeholder reads
 * it as a real database and runs a DB tier against nothing. `isPlaceholderDbUrl`
 * keys on the `unused:unused@` credential pair instead — every placeholder in
 * this repository carries it, no real connection string does, and it survives
 * any further move of the host or the port.
 */

/** The mark every placeholder connection string carries. */
export const PLACEHOLDER_DB_URL_CREDENTIALS = "unused:unused@";

/** The endpoint itself. The `unused:unused@localhost` prefix is recognised by
 * the DB-integration tiers, so the prefix must not change. */
export const ROOT_SUITE_PLACEHOLDER_DB_URL = "postgres://unused:unused@localhost:1/unused";

/**
 * True when `url` is a placeholder — "the variable is set but points at no
 * database". THE shared answer for every DB-presence guard.
 */
export function isPlaceholderDbUrl(url: string | null | undefined): boolean {
  return typeof url === "string" && url.includes(PLACEHOLDER_DB_URL_CREDENTIALS);
}
