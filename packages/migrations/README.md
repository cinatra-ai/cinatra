# @cinatra-ai/migrations

The canonical schema-migration runner for Cinatra (cinatra#116 + #118, umbrella
#115: one migration engine org-wide). It drives `node-pg-migrate`
programmatically over a single shared ledger (`pgmigrations`) partitioned by
per-source namespace (`core__` for `migrations/core/`,
`ext_<scope>_<pkg>__` for an extension's declared migrations dir), so
independently-versioned sources can never collide.

This is an INTERNAL package (`private: true`, never published). It carries ZERO
`@cinatra-ai/*` dependencies — only Node builtins (`node:path`,
`node:fs/promises`) plus a lazy runtime import of `pg` and `node-pg-migrate` —
so it loads identically from plain Node (the CLI), the app boot pass, and the
extension migration host.

It was relocated here from `packages/cli/src/core-migrations.mjs` (cinatra#403)
to remove the host→CLI dependency smell: the host imported the runner through
`@cinatra-ai/cli/core-migrations`, which made the application depend on the
command-line tool. The runner now lives in its own leaf package that both the
host and the CLI depend on.

## Public API

`@cinatra-ai/migrations` / `@cinatra-ai/migrations/core-migrations`

- `runCoreMigrations(opts)` — apply the `core__` chain from `migrations/core/`.
- `runNamespacedMigrations(opts)` — apply a namespaced (e.g. extension) chain.
- `isFreshCoreSchema(client, schemaName)` — whether the core chain is unapplied.
- `extensionMigrationNamespace(packageName)` — the ledger namespace for an extension.
- `validateNamespacedMigrationsDir(...)` / `validateCoreMigrationsDir(dirAbs)` —
  the filename/sequence preflight contract.
- Plus the migration-contract constants and assertion helpers
  (`CORE_MIGRATIONS_DIR`, `CORE_MIGRATION_NAMESPACE`, `assertDownTargetsInNamespace`, …).

See `migrations/README.md` (repo root) for the migration-authoring convention.

## Docs

See https://docs.cinatra.ai
