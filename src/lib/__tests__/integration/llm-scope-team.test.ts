/**
 * Team-scope integration test (real Postgres).
 *
 * `visibility="team:<id>"` rows are visible to actors whose `teamIds`
 * include `<id>`. Also verifies that the team clause does not bleed into
 * other teams.
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
const T1 = "team-T1";
const T2 = "team-T2";
const t1Ids: string[] = [];
let t2Id = "";
let orgRowId = "";

beforeAll(async () => {
  client = await connect();
  schema = await createTestSchema(client);

  // 2 objects visibility="team:T1"
  for (let i = 0; i < 2; i++) {
    t1Ids.push(
      await insertObject(client, schema, {
        orgId: orgA,
        ownerType: "team",
        ownerId: T1,
        visibility: `team:${T1}`,
      }),
    );
  }
  // 1 object visibility="team:T2"
  t2Id = await insertObject(client, schema, {
    orgId: orgA,
    ownerType: "team",
    ownerId: T2,
    visibility: `team:${T2}`,
  });
  // 1 object visibility="org" in orgA
  orgRowId = await insertObject(client, schema, {
    orgId: orgA,
    ownerType: "organization",
    ownerId: orgA,
    visibility: "org",
  });
  t1Ids.sort();
}, 30_000);

afterAll(async () => {
  if (client && schema) await dropSchema(client, schema);
  if (client) await client.end();
});

function makeActor(opts: {
  organizationId?: string;
  teamIds?: string[];
  principalId?: string;
}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: opts.principalId ?? "user-test",
    organizationId: opts.organizationId,
    teamIds: opts.teamIds ?? [],
    projectIds: [],
    authSource: "ui",
    policyVersion: "v2",
  };
}

async function runUnderActor(actor: ActorContext): Promise<string[]> {
  return await withActorContext(actor, async () => {
    const ctx = getActorContext();
    if (!ctx) throw new Error("ALS frame missing");
    const frag = buildOwnershipFilter(ctx);
    return await selectVisibleIds(client, schema, frag);
  });
}

describe("llm-scope-team (real Postgres)", () => {
  it("U1 with teamIds=['T1'] sees 3 rows: 2 team:T1 + 1 org", async () => {
    const actor = makeActor({
      organizationId: orgA,
      teamIds: [T1],
      principalId: "user-U1",
    });
    const ids = await runUnderActor(actor);
    const seenT1 = ids.filter((id) => t1Ids.includes(id)).sort();
    expect(seenT1).toEqual(t1Ids);
    expect(ids.includes(orgRowId)).toBe(true);
    expect(ids.includes(t2Id)).toBe(false);
  });

  it("U2 with teamIds=['T2'] sees 2 rows: 1 team:T2 + 1 org", async () => {
    const actor = makeActor({
      organizationId: orgA,
      teamIds: [T2],
      principalId: "user-U2",
    });
    const ids = await runUnderActor(actor);
    expect(ids.includes(t2Id)).toBe(true);
    expect(ids.includes(orgRowId)).toBe(true);
    const seenT1 = ids.filter((id) => t1Ids.includes(id));
    expect(seenT1).toEqual([]);
  });

  it("U3 with teamIds=[] sees 1 row: org only", async () => {
    const actor = makeActor({
      organizationId: orgA,
      teamIds: [],
      principalId: "user-U3",
    });
    const ids = await runUnderActor(actor);
    expect(ids.includes(orgRowId)).toBe(true);
    expect(ids.includes(t2Id)).toBe(false);
    const seenT1 = ids.filter((id) => t1Ids.includes(id));
    expect(seenT1).toEqual([]);
  });

  it("U4 with teamIds=['T1','T2'] sees all team-scoped rows + org row", async () => {
    const actor = makeActor({
      organizationId: orgA,
      teamIds: [T1, T2],
      principalId: "user-U4",
    });
    const ids = await runUnderActor(actor);
    expect(ids.includes(t2Id)).toBe(true);
    expect(ids.includes(orgRowId)).toBe(true);
    const seenT1 = ids.filter((id) => t1Ids.includes(id)).sort();
    expect(seenT1).toEqual(t1Ids);
  });
});
