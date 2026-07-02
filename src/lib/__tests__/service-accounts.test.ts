import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import {
  serviceAccountsDb,
  serviceAccountsPool,
  type ServiceAccountRecord,
  type CreateServiceAccountResult,
} from "@/lib/service-accounts";

const SOURCE = readFileSync("src/lib/service-accounts.ts", "utf-8");

describe("service-accounts — module surface", () => {
  it("exports serviceAccountsDb + serviceAccountsPool", () => {
    expect(serviceAccountsDb).toBeDefined();
    expect(serviceAccountsPool).toBeDefined();
  });

  it("ServiceAccountRecord type accepts a fully-populated row", () => {
    const sample: ServiceAccountRecord = {
      id: "uuid",
      name: "n",
      orgId: null,
      clientId: "cid",
      scopes: "run.read",
      revokedAt: null,
      rotatedAt: null,
      previousClientId: null,
      gracePeriodSeconds: 900,
      createdBy: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    expect(sample.id).toBe("uuid");
  });

  it("CreateServiceAccountResult includes plaintext clientSecret", () => {
    const r: CreateServiceAccountResult = {
      id: "i", name: "n", orgId: null, clientId: "c", clientSecret: "s", scopes: "",
    };
    expect(r.clientSecret).toBe("s");
  });
});

describe("service-accounts — source assertions", () => {
  it("imports server-only", () => {
    expect(SOURCE).toContain('import "server-only"');
  });

  it("uses the shared pooled-DB scaffold — does NOT import any getDb global", () => {
    expect(SOURCE).not.toMatch(/from "@\/lib\/database"/);
    expect(SOURCE).not.toMatch(/\bgetDb\b/);
    expect(SOURCE).toContain('from "@/lib/db/pooled"');
    expect(SOURCE).toContain('getPooledDb({ name: "service-accounts" })');
    expect(SOURCE).toContain("export const serviceAccountsPool");
    expect(SOURCE).toContain("export const serviceAccountsDb");
  });

  it("revokeServiceAccount sets revoked_at and does NOT delete the oauthClient row", () => {
    const fn = SOURCE.match(/export async function revokeServiceAccount[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toContain("revoked_at = now()");
    expect(fn).not.toContain(`DELETE FROM public."oauthClient"`);
    expect(fn).not.toContain("DELETE FROM public.oauth_application");
  });

  it("rotateServiceAccount sets previous_client_id + rotated_at and rotates the oauthClient row", () => {
    const fn = SOURCE.match(/export async function rotateServiceAccount[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toContain("previous_client_id");
    expect(fn).toContain("rotated_at = now()");
    expect(fn).toContain("deleteOAuthClientByClientId");
    expect(fn).toContain("insertOAuthClient");
  });

  it("readServiceAccountByClientId honors grace-period window", () => {
    const fn = SOURCE.match(/export async function readServiceAccountByClientId[\s\S]*?\n\}/)?.[0] ?? "";
    expect(fn).toContain("previous_client_id = ");
    expect(fn).toContain("grace_period_seconds");
    expect(fn).toContain("rotated_at IS NOT NULL");
  });

  it("never logs clientSecret", () => {
    expect(SOURCE).not.toMatch(/console\.\w+\([^\)]*clientSecret/);
  });

  it("schema-qualifies the service_accounts table via process.env.SUPABASE_SCHEMA", () => {
    expect(SOURCE).toContain("SUPABASE_SCHEMA");
    expect(SOURCE).toContain("service_accounts");
  });

  it("delegates lazy pooling + idle-error listener to the shared scaffold (#303)", () => {
    // The lazy pool + idempotent idle-error listener now live in @/lib/db/pooled
    // (covered by src/lib/db/__tests__/pooled.test.ts). This store delegates
    // rather than hand-rolling the boilerplate.
    expect(SOURCE).toContain('getPooledDb({ name: "service-accounts" })');
    expect(SOURCE).not.toContain("new Pool(");
  });

  it("imports the shared OAuth-client helper from @/lib/better-auth-oauth-client (single source of truth)", () => {
    // The SHA-256 hashing + oauthClient INSERT lives in a
    // single shared module; service-accounts.ts consumes it via import,
    // not by duplicating the helper locally. The shared module's own
    // unit test (`better-auth-oauth-client.test.ts`) asserts the hash
    // algorithm; here we only assert the wiring.
    expect(SOURCE).toMatch(
      /from\s+["']@\/lib\/better-auth-oauth-client["']/,
    );
    expect(SOURCE).toMatch(/\binsertOAuthClient\b|\binsertOAuthClientRow\b/);
    expect(SOURCE).toMatch(/\bdeleteOAuthClient\b|\bdeleteOAuthClientRow\b/);
    // Defensive: local definitions of these helpers must not exist.
    expect(SOURCE).not.toMatch(/^function\s+hashClientSecret/m);
    expect(SOURCE).not.toContain('createHash("sha256")');
  });

  it("clientSecret is generated via randomBytes(32).toString('base64url') with cinatra_a2a_ prefix", () => {
    // crypto.randomUUID() yields ~122 bits; randomBytes(32) yields 256.
    // The prefix lets leaked-secret scanners locate provenance.
    expect(SOURCE).toContain("randomBytes(32).toString(\"base64url\")");
    expect(SOURCE).toContain("cinatra_a2a_");
    // Both create + rotate paths must use the stronger generator so
    // rotation does not keep the crypto.randomUUID() pattern.
    // Slice the source between each function header and the next
    // top-level `// ---` separator (the codebase convention) so brace
    // matching is not needed.
    const sliceBetween = (start: string): string => {
      const idx = SOURCE.indexOf(start);
      if (idx < 0) return "";
      const after = SOURCE.slice(idx);
      const next = after.indexOf("\n// ---");
      return next < 0 ? after : after.slice(0, next);
    };
    const createFn = sliceBetween("export async function createServiceAccount");
    const rotateFn = sliceBetween("export async function rotateServiceAccount");
    expect(createFn).toContain("cinatra_a2a_");
    expect(rotateFn).toContain("cinatra_a2a_");
  });
});
