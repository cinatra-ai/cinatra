import { describe, it, expect } from "vitest";
import { getSchema } from "better-auth/db";
import {
  buildCinatraBetterAuthPlugins,
  buildMcpAuthPlugins,
  cinatraAuthAdditionalUserFields,
  DEFAULT_MCP_SCOPES,
} from "../better-auth-plugins";
import { buildMigrationAuthOptions } from "../../../scripts/better-auth-migrate.mts";

// ---------------------------------------------------------------------------
// Better Auth schema drift guard (runtime ↔ migration parity).
//
// Both `src/lib/auth.ts` (runtime) and `scripts/better-auth-migrate.mts`
// (bootstrap migration `make setup` runs) consume the SAME shared plugin
// factory at `src/lib/better-auth-plugins.ts`. Schema-bearing data lives in
// `src/lib/better-auth-schema.ts`. This test:
//
//   1) Builds a runtime-equivalent options object from the shared factory
//      with realistic runtime behavioral inputs.
//   2) Builds the migration options via the live `buildMigrationAuthOptions`.
//   3) Deep-equals the resulting Better Auth schemas after normalizing
//      closure-bound default-value / onUpdate generators (Better Auth
//      regenerates these per-call — identical code, fresh ref).
//
// This deliberately does NOT import `src/lib/auth.ts` — the vitest setup
// stubs `@/lib/auth`, and force-loading the real module pulls in the
// server-only / React barrel this whole fix exists to avoid. The runtime
// side is locked in by the compile-time tuple annotation on `authPlugins`
// inside `src/lib/auth.ts` — that fails typecheck if anyone pushes a stray
// plugin outside the factory.
// ---------------------------------------------------------------------------

// Exact set of Better Auth models the migration must create. This is the full
// plugin-derived set — note it is a superset of `AUTH_TABLES` in
// packages/cli/src/index.mjs (that list is only a setup-time presence
// sentinel and intentionally omits `twoFactor`).
const EXPECTED_MODELS = [
  "account",
  "invitation",
  "jwks",
  "member",
  "oauthAccessToken",
  "oauthClient",
  "oauthConsent",
  "oauthRefreshToken",
  "organization",
  "session",
  "team",
  "teamMember",
  "twoFactor",
  "user",
  "verification",
];

interface FieldSig {
  type: unknown;
  required: boolean;
}
type SchemaSig = Record<string, Record<string, FieldSig>>;

function normalize(schema: Record<string, unknown>): SchemaSig {
  const out: SchemaSig = {};
  for (const [model, def] of Object.entries(schema)) {
    const fields: Record<string, FieldSig> = {};
    const rawFields = (def as { fields?: Record<string, unknown> }).fields ?? {};
    for (const [fieldName, attr] of Object.entries(rawFields)) {
      const a = attr as { type?: unknown; required?: unknown };
      fields[fieldName] = { type: a.type, required: Boolean(a.required) };
    }
    out[model] = fields;
  }
  return out;
}

// Better Auth's `getSchema()` recreates closure-bound default-value /
// onUpdate generators on every call (identical code, fresh ref). Deep-equal
// on raw output false-fails on those refs. This normalizer replaces every
// function with its `toString()` body so identical-by-CODE generators
// compare equal while still pinning presence + position.
function normalizeSchemaForDriftCompare(value: unknown): unknown {
  if (typeof value === "function") {
    return `<fn ${value.toString()}>`;
  }
  if (Array.isArray(value)) {
    return value.map((entry) => normalizeSchemaForDriftCompare(entry));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = normalizeSchemaForDriftCompare(v);
    }
    return out;
  }
  return value;
}

// A runtime-equivalent options object built from the SAME shared factory the
// real `src/lib/auth.ts` uses. Behavioral inputs are realistic placeholders;
// every schema-bearing input matches the runtime exactly.
function buildRuntimeEquivalentAuthOptions() {
  return {
    appName: "Cinatra",
    user: { additionalFields: cinatraAuthAdditionalUserFields },
    emailAndPassword: { enabled: true },
    plugins: buildCinatraBetterAuthPlugins({
      admin: { allowImpersonatingAdmins: true },
      organization: {
        allowUserToCreateOrganization: async () => true,
      },
      mcpAuthPlugins: buildMcpAuthPlugins({
        validAudiences: [
          "http://localhost:3000/api/mcp",
          "https://public.example.test/api/mcp",
        ],
        scopes: [...DEFAULT_MCP_SCOPES, "a2a:connect"],
        loginPage: "/api/mcp/auth/sign-in",
        consentPage: "/api/mcp/consent",
        signupPage: "/api/mcp/auth/sign-up",
      }),
    }),
  };
}

const runtimeSchema = getSchema(buildRuntimeEquivalentAuthOptions());
const migrationSchema = getSchema(buildMigrationAuthOptions());
const normalizedRuntime = normalize(runtimeSchema);

describe("Better Auth schema parity (runtime ↔ migration)", () => {
  it("runtime and migration produce identical schema (normalized deep-equal)", () => {
    // This is the load-bearing assertion: both consume the SAME factory,
    // so any plugin add / remove / reorder updates BOTH sides at once and
    // the schemas stay equal by construction. A mismatch means someone
    // bypassed the factory.
    expect(normalizeSchemaForDriftCompare(runtimeSchema)).toEqual(
      normalizeSchemaForDriftCompare(migrationSchema),
    );
  });

  it("produces exactly the expected model set", () => {
    expect(Object.keys(normalizedRuntime).sort()).toEqual([...EXPECTED_MODELS].sort());
  });

  it("adds the userType and clientId columns to the user table", () => {
    expect(normalizedRuntime.user.userType).toEqual({ type: "string", required: false });
    expect(normalizedRuntime.user.clientId).toEqual({ type: "string", required: false });
  });

  it("declares the team.slug additionalField (organization plugin)", () => {
    expect(normalizedRuntime.team.slug).toEqual({ type: "string", required: true });
  });

  it("wires the username / twoFactor / admin / organization plugin columns", () => {
    expect(normalizedRuntime.user).toHaveProperty("username"); // username()
    expect(normalizedRuntime.user).toHaveProperty("twoFactorEnabled"); // twoFactor()
    expect(normalizedRuntime.user).toHaveProperty("role"); // admin()
    expect(normalizedRuntime.session).toHaveProperty("activeOrganizationId"); // organization()
    expect(normalizedRuntime.session).toHaveProperty("activeTeamId"); // organization({teams})
  });

  it("includes the MCP auth contract tables (jwt + oauthProvider)", () => {
    for (const table of [
      "jwks",
      "oauthClient",
      "oauthAccessToken",
      "oauthRefreshToken",
      "oauthConsent",
    ]) {
      expect(normalizedRuntime[table], `missing MCP auth model: ${table}`).toBeDefined();
    }
  });
});
