/**
 * The placeholder connection string and its predicate, under the `@/` alias.
 *
 * The definitions live beside `vitest.config.ts` (which reads the constant to
 * set `SUPABASE_DB_URL` for the root unit suite), and every DB-presence guard
 * under `src/` imports them from here so there is exactly ONE answer to "is
 * this URL a real database?" — see the module comment there for why a guard
 * must never key on the whole string.
 */
export {
  PLACEHOLDER_DB_URL_CREDENTIALS,
  ROOT_SUITE_PLACEHOLDER_DB_URL,
  isPlaceholderDbUrl,
} from "../../../vitest.placeholder-db-url";
