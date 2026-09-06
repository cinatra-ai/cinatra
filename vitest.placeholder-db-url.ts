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
 * `isPlaceholderDbUrl` is THE answer to "is this URL a real database?", and it
 * answers EXACTLY. A substring match is wrong in both directions. Keyed on the
 * whole string it stops recognising the placeholder the moment the port moves,
 * reads it as a real database, and runs a DB tier against nothing. Keyed on the
 * `unused:unused@` credential pair alone it does the opposite: a REAL database
 * that happens to carry those credentials — the same reserved user and
 * password, on a real host, with a real database name — reads as the
 * placeholder, and the tier behind the guard silently stops
 * running while still reporting green. So the predicate parses the URL and
 * requires the WHOLE reserved sentinel identity: the reserved user, password
 * and database name on `localhost`, at a port that is not the PostgreSQL
 * default. The port may move again; the identity may not.
 *
 * The endpoint is assembled from its parts rather than written out as one
 * literal: a whole connection string carrying a credential pair is what a
 * secret scanner reports, and the repository defuses its other fake-credential
 * fixtures the same way.
 */

/** The reserved sentinel identity. No real database may carry all of it. */
const PLACEHOLDER_DB_USER = "unused";
const PLACEHOLDER_DB_PASSWORD = "unused";
const PLACEHOLDER_DB_HOST = "localhost";
const PLACEHOLDER_DB_NAME = "unused";
/** Off the PostgreSQL default on purpose — see the note above. */
const PLACEHOLDER_DB_PORT = "1";
/** The port a PostgreSQL that is actually there answers on. */
const POSTGRES_DEFAULT_PORT = "5432";

/** The credential pair the sentinel carries. NOT sufficient on its own to call
 * a URL the placeholder — see `isPlaceholderDbUrl`. */
export const PLACEHOLDER_DB_URL_CREDENTIALS = `${PLACEHOLDER_DB_USER}:${PLACEHOLDER_DB_PASSWORD}@`;

/** The endpoint itself, assembled from the identity above. */
export const ROOT_SUITE_PLACEHOLDER_DB_URL = [
  `postgres://${PLACEHOLDER_DB_URL_CREDENTIALS}${PLACEHOLDER_DB_HOST}`,
  `${PLACEHOLDER_DB_PORT}/${PLACEHOLDER_DB_NAME}`,
].join(":");

/**
 * True when `url` is the placeholder — "the variable is set but points at no
 * database". THE shared answer for every DB-presence guard, and a TOTAL
 * predicate: no input makes it throw.
 */
export function isPlaceholderDbUrl(url: string | null | undefined): boolean {
  if (typeof url !== "string" || url === "") return false;
  if (url === ROOT_SUITE_PLACEHOLDER_DB_URL) return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    // Not a URL at all: it is not this one.
    return false;
  }
  return (
    parsed.username === PLACEHOLDER_DB_USER &&
    parsed.password === PLACEHOLDER_DB_PASSWORD &&
    parsed.hostname === PLACEHOLDER_DB_HOST &&
    parsed.port !== "" &&
    parsed.port !== POSTGRES_DEFAULT_PORT &&
    parsed.pathname.replace(/^\//, "") === PLACEHOLDER_DB_NAME
  );
}
