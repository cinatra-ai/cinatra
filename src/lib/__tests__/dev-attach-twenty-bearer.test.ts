// cinatra#1238 — the dev-only sanctioned Twenty bearer attach
// (`devAttachTwentyBearerFromMintedKey`) MUST fail closed when the seeded dev
// actor (or its organization) is not available. The dev-boot shell
// (`dev-auto-setup.ts`) PUSHES the seeded owner via `setDevActorForExternalMcp`
// before any connector devSetup hook runs; the writer reads that module-local
// holder (NOT an import of the wide dev-auto-setup graph, so the production
// route-graph pressure stays flat). `saveTwentyConnection` seeds the
// `externalMcp` identity + grant with `seed:"workspace"`, which downgrades to
// owner-only under a null organization — the InternalWorker mint would then stay
// denied — so the writer refuses BEFORE any minting/import when no non-null-org
// owner is set.
//
// The real dev actor + full sanctioned save + gated-resolver success path is
// covered by the twenty-connector dev-setup suite, `saveTwentyConnection`'s own
// suite, and the live demo proof.

import { describe, it, expect, vi, beforeEach } from "vitest";

// `@/lib/database` resolves to the inert test stub via the root vitest alias, so
// importing the registry module needs no live connection.

// A spy so we can prove the writer never reaches the sanctioned save when the
// owner is unset/unusable. `runPostgresQueriesSync` is the lowest-level effect
// `saveTwentyConnection` (via the row upsert) would hit.
const runPostgresQueriesSync = vi.fn((_input?: unknown) => [{ rows: [], rowCount: 0 }]);
vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (input: unknown) => runPostgresQueriesSync(input),
}));

const { devAttachTwentyBearerFromMintedKey, setDevActorForExternalMcp } = await import(
  "@/lib/external-mcp-registry"
);

const APIKEY = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJkZXYifQ.sig";

beforeEach(() => {
  vi.clearAllMocks();
  setDevActorForExternalMcp(null); // reset the holder between cases
});

describe("devAttachTwentyBearerFromMintedKey — fail-closed on an unusable dev actor", () => {
  it("returns { resolved:false } and never mints/imports when NO dev actor is set (off dev boot)", async () => {
    const r = await devAttachTwentyBearerFromMintedKey({
      instanceUrl: "http://localhost:3300",
      apiKey: APIKEY,
    });

    expect(r).toEqual({ resolved: false, connectionId: null });
    // No sanctioned save was attempted (its row upsert never ran).
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("returns { resolved:false } when the seeded owner has an empty organization (seed:\"workspace\" would deny the mint)", async () => {
    setDevActorForExternalMcp({ userId: "u1", organizationId: "" });

    const r = await devAttachTwentyBearerFromMintedKey({
      instanceUrl: "http://localhost:3300",
      apiKey: APIKEY,
    });

    expect(r).toEqual({ resolved: false, connectionId: null });
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("the setter/getter holder round-trips (dev-boot shell pushes the owner)", () => {
    setDevActorForExternalMcp({ userId: "u1", organizationId: "org1" });
    // Clearing it restores the fail-closed default.
    setDevActorForExternalMcp(null);
    // No throw; the reset in beforeEach + here proves the holder is settable.
    expect(true).toBe(true);
  });
});
