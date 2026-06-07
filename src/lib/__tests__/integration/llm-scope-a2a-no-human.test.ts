/**
 * A2A no-human path integration test.
 *
 * The injected dependencies match the resolver contract
 * (`buildActorContextFromRun` + `resolveDefaultOrgId`).
 * The core assertion is that the service-account JWT path resolves to a
 * ServiceAccount ctx and downstream MCP-equivalent reads scope to its org.
 *
 * Verifies that a `client_credentials` service-account JWT resolves to
 * an ActorContext whose `principalType` is `"ServiceAccount"` and that
 * downstream MCP-equivalent reads scope correctly to the service
 * account's organization. Uses the A2A resolver directly with an
 * injected authResult — the same shape `verifyA2AAccessToken` returns
 * when it recognises a `client_credentials` token.
 */

// Per-test fixture creates a fresh Postgres schema via `CREATE SCHEMA` and
// runs the full DDL chain (equivalent to `ensurePostgresSchema()` against
// the same name). See _fixture.ts createTestSchema().
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import type { Client } from "pg";

import { withActorContext, getActorContext } from "@cinatra-ai/llm";
import { buildOwnershipFilter } from "@/lib/derived-store-ownership";
import { resolveA2AActorContext } from "@/app/api/a2a/actor-context-resolver";
import type { ActorContext } from "@/lib/authz/actor-context";
import {
  connect,
  createTestSchema,
  dropSchema,
  insertObject,
  selectVisibleIds,
} from "./_fixture";

let client: Client;
let schema: string;

const serviceAccountOrg = "org-svc";
const serviceAccountPrincipalId = "service-account-abc";
const orgRowIds: string[] = [];

beforeAll(async () => {
  client = await connect();
  schema = await createTestSchema(client);

  for (let i = 0; i < 2; i++) {
    orgRowIds.push(
      await insertObject(client, schema, {
        orgId: serviceAccountOrg,
        ownerType: "organization",
        ownerId: serviceAccountOrg,
        visibility: "org",
      }),
    );
  }
  orgRowIds.sort();
}, 30_000);

afterAll(async () => {
  if (client && schema) await dropSchema(client, schema);
  if (client) await client.end();
});

/**
 * Build the ActorContext that `buildActorContextFromServiceAccountJwt`
 * produces for a `client_credentials` token.
 * Constructed directly to avoid a real signing-key round-trip.
 */
function makeServiceAccountActor(): ActorContext {
  return {
    principalType: "ServiceAccount",
    principalId: serviceAccountPrincipalId,
    organizationId: serviceAccountOrg,
    teamIds: [],
    projectIds: [],
    authSource: "a2a",
    tokenScopes: ["a2a:run"],
    policyVersion: "v2",
  };
}

describe("llm-scope-a2a-no-human (real Postgres)", () => {
  it("resolveA2AActorContext returns the service-account ctx when authResult carries it (client_credentials path)", async () => {
    const authResult = {
      ok: true as const,
      subject: serviceAccountPrincipalId,
      actorContext: makeServiceAccountActor(),
    };
    const outcome = await resolveA2AActorContext({
      authResult,
      body: {},
      env: {},
      deps: {
        readAgentRunByTaskId: vi.fn(async () => null),
        buildActorContextFromRun: vi.fn(),
        resolveDefaultOrgId: vi.fn(async () => null),
      },
    });
    expect(outcome.kind).toBe("ok");
    if (outcome.kind === "ok") {
      expect(outcome.actorContext.principalType).toBe("ServiceAccount");
      expect(outcome.actorContext.principalId).toBe(serviceAccountPrincipalId);
      expect(outcome.actorContext.organizationId).toBe(serviceAccountOrg);
    }
  });

  it("under the service-account frame, an MCP-equivalent objects read scopes to the service account's org", async () => {
    const actor = makeServiceAccountActor();
    expect(actor.principalType).toBe("ServiceAccount"); // sanity — service-account principalType
    const ids = await withActorContext(actor, async () => {
      const ctx = getActorContext();
      if (!ctx) throw new Error("ALS frame missing");
      // Confirm the resolved principalType propagates into the frame.
      expect(ctx.principalType).toBe("ServiceAccount");
      const frag = buildOwnershipFilter(ctx);
      return await selectVisibleIds(client, schema, frag);
    });
    const seen = ids.filter((id) => orgRowIds.includes(id)).sort();
    expect(seen).toEqual(orgRowIds);
  });
});
