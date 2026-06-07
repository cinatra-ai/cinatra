// Shared, app-graph-free definition of Cinatra's Better Auth SCHEMA-bearing
// configuration *data*. Imported by `src/lib/better-auth-plugins.ts` (the
// shared Cinatra plugin tuple factory), which in turn is consumed by BOTH the
// runtime auth config (src/lib/auth.ts) and the bootstrap migration runner
// (scripts/better-auth-migrate.mts) — so the database schema the app expects
// and the schema `make setup` creates cannot drift apart.
//
// This module MUST stay loadable outside the Next.js bundler — it is pulled
// in (transitively, via `better-auth-plugins.ts`) by
// `scripts/better-auth-migrate.mts`, which runs in plain Node (relying on
// Node's native TypeScript type-stripping) during `make setup`, before any
// schema exists. So: no imports at all, no `@/` aliases, no `server-only`,
// no React, no database access; fully erasable syntax (no enum / namespace).
//
// The single-source model spans both schema-bearing *data* (this file) and
// the full plugin tuple (via `./better-auth-plugins.ts`). A precisely-typed
// mutable tuple preserves Better Auth's `auth.$Infer` derivation while
// avoiding a parallel-array drift hazard. See `./better-auth-plugins.ts` for
// the factory and `src/lib/__tests__/better-auth-schema.test.ts` for the
// drift-guard test gating CI.

// Extra columns on the Better Auth `user` table. Keep in sync with the drizzle
// table shapes in src/lib/better-auth-db.ts / src/lib/drizzle-store.ts.
// `as const` keeps each `type` as a string LITERAL so Better Auth's
// `additionalFields` typing (which expects a `DBFieldType` union) accepts it.
export const cinatraAuthAdditionalUserFields = {
  userType: {
    type: "string",
    required: false,
    defaultValue: "human",
    input: false,
  },
  clientId: {
    type: "string",
    required: false,
    defaultValue: null,
    input: false,
  },
} as const;

// Schema-relevant options for the `organization` plugin: `teams` enablement
// (adds the `team` / `teamMember` tables) and the declared `team.slug`
// additionalField (better-auth's createTeam/updateTeam accept it; the column
// is also provisioned by drizzle-store.ts with a UNIQUE-per-org index).
// Behavioral, runtime-only options (e.g. `allowUserToCreateOrganization`)
// are intentionally NOT here — each caller spreads this and adds its own.
export const cinatraOrganizationOptions = {
  teams: {
    enabled: true,
    maximumTeams: 50,
    allowRemovingAllTeams: true,
  },
  schema: {
    team: {
      additionalFields: {
        slug: {
          type: "string",
          required: true,
          input: true,
        },
      },
    },
  },
} as const;
