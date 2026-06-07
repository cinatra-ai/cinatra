/**
 * Org-scope integration test (real Postgres).
 *
 * Verifies that for visibility='org' rows, an actor in orgA sees ONLY
 * orgA rows, an actor in orgB sees ONLY orgB rows, and an actor with no
 * organizationId sees ZERO org-visible rows. Exercises the full path:
 * `withActorContext` frame -> `getActorContext()` -> `buildOwnershipFilter`
 * -> raw SQL splice against a per-test Postgres schema.
 */

// Per-test fixture creates a fresh Postgres schema via `CREATE SCHEMA` and
// runs the full DDL chain (equivalent to `ensurePostgresSchema()` against
// the same name). See _fixture.ts createTestSchema().
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";

import { withActorContext, getActorContext } from "@cinatra-ai/llm";
import { buildOwnershipFilter } from "@/lib/derived-store-ownership";
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

const orgA = "org-A";
const orgB = "org-B";
const orgAIds: string[] = [];
const orgBIds: string[] = [];

beforeAll(async () => {
  client = await connect();
  schema = await createTestSchema(client);

  // 3 objects in orgA (visibility="org")
  for (let i = 0; i < 3; i++) {
    orgAIds.push(
      await insertObject(client, schema, {
        orgId: orgA,
        ownerType: "organization",
        ownerId: orgA,
        visibility: "org",
      }),
    );
  }
  // 2 objects in orgB (visibility="org")
  for (let i = 0; i < 2; i++) {
    orgBIds.push(
      await insertObject(client, schema, {
        orgId: orgB,
        ownerType: "organization",
        ownerId: orgB,
        visibility: "org",
      }),
    );
  }
  orgAIds.sort();
  orgBIds.sort();
}, 30_000);

afterAll(async () => {
  if (client && schema) {
    await dropSchema(client, schema);
  }
  if (client) {
    await client.end();
  }
});

function makeActor(opts: { organizationId?: string; principalId?: string }): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: opts.principalId ?? "user-test",
    organizationId: opts.organizationId,
    teamIds: [],
    projectIds: [],
    authSource: "ui",
    policyVersion: "v2",
  };
}

async function runUnderActor(actor: ActorContext): Promise<string[]> {
  return await withActorContext(actor, async () => {
    // Confirm the ALS frame propagates — handler-equivalent code path.
    const ctx = getActorContext();
    if (!ctx) throw new Error("ALS frame missing");
    const frag = buildOwnershipFilter(ctx);
    return await selectVisibleIds(client, schema, frag);
  });
}

describe("llm-scope-org (real Postgres)", () => {
  it("actor in orgA sees exactly the 3 orgA rows (visibility='org')", async () => {
    const actor = makeActor({ organizationId: orgA, principalId: "user-A" });
    const ids = (await runUnderActor(actor)).sort();
    // Should match the 3 orgA rows; orgB rows excluded.
    const orgAOnly = ids.filter((id) => orgAIds.includes(id));
    const orgBLeak = ids.filter((id) => orgBIds.includes(id));
    expect(orgAOnly).toEqual(orgAIds);
    expect(orgBLeak).toEqual([]);
  });

  it("actor in orgB sees exactly the 2 orgB rows", async () => {
    const actor = makeActor({ organizationId: orgB, principalId: "user-B" });
    const ids = (await runUnderActor(actor)).sort();
    const orgBOnly = ids.filter((id) => orgBIds.includes(id));
    const orgALeak = ids.filter((id) => orgAIds.includes(id));
    expect(orgBOnly).toEqual(orgBIds);
    expect(orgALeak).toEqual([]);
  });

  it("actor with no organizationId sees 0 org-visible rows", async () => {
    const actor = makeActor({ organizationId: undefined, principalId: "user-X" });
    const ids = await withActorContext(actor, async () => {
      const ctx = getActorContext();
      if (!ctx) throw new Error("ALS frame missing");
      const frag = buildOwnershipFilter(ctx);
      return await selectVisibleIds(client, schema, frag);
    });
    // Owner clause: owner_id = 'user-X' (no match — owner_id is org-A/org-B).
    // Org clause: visibility='org' AND organization_id = NULL — never matches.
    // Workspace clause: visibility='workspace' — none seeded.
    const orgLeak = ids.filter((id) => orgAIds.includes(id) || orgBIds.includes(id));
    expect(orgLeak).toEqual([]);
  });
});
