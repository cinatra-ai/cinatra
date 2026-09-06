/**
 * The connection string the ROOT unit suite hands to code that must never reach
 * a database. It keeps the conventional `localhost` host (the code under test
 * treats a refused local connection as "no database"; an address literal does
 * not take that road) but uses TCP port 1 instead of the PostgreSQL default:
 * nothing in the test environment listens there and no CI service container
 * publishes it, so a connection attempt is refused at once. The earlier
 * placeholder used port 5432, and a PostgreSQL that happened to listen on the
 * conventional local endpoint answered it — fifteen unrelated unit tests then
 * failed on "password authentication failed" instead of seeing a refused
 * connection. The guard test beside this module keeps the endpoint off 5432.
 * The DB-integration tiers recognise the placeholder by its
 * `unused:unused@localhost` prefix, so the prefix must not change.
 */
export const ROOT_SUITE_PLACEHOLDER_DB_URL = "postgres://unused:unused@localhost:1/unused";
