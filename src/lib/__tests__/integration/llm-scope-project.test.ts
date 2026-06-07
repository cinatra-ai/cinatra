/**
 * Project-scope integration test using real Postgres.
 *
 * `visibility="project:<id>"` rows are visible to actors whose
 * `projectIds` include `<id>`. Multi-project membership unions visibility.
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
const P1 = "project-P1";
const P2 = "project-P2";
const p1Ids: string[] = [];
let p2Id = "";
let orgRowId = "";

beforeAll(async () => {
  client = await connect();
  schema = await createTestSchema(client);

  for (let i = 0; i < 2; i++) {
    p1Ids.push(
      await insertObject(client, schema, {
        orgId: orgA,
        ownerType: "project",
        ownerId: P1,
        visibility: `project:${P1}`,
      }),
    );
  }
  p2Id = await insertObject(client, schema, {
    orgId: orgA,
    ownerType: "project",
    ownerId: P2,
    visibility: `project:${P2}`,
  });
  orgRowId = await insertObject(client, schema, {
    orgId: orgA,
    ownerType: "organization",
    ownerId: orgA,
    visibility: "org",
  });
  p1Ids.sort();
}, 30_000);

afterAll(async () => {
  if (client && schema) await dropSchema(client, schema);
  if (client) await client.end();
});

function makeActor(opts: {
  organizationId?: string;
  projectIds?: string[];
  principalId?: string;
}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: opts.principalId ?? "user-test",
    organizationId: opts.organizationId,
    teamIds: [],
    projectIds: opts.projectIds ?? [],
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

describe("llm-scope-project (real Postgres)", () => {
  it("actor with projectIds=['P1'] sees 3 rows: 2 project:P1 + 1 org", async () => {
    const actor = makeActor({ organizationId: orgA, projectIds: [P1] });
    const ids = await runUnderActor(actor);
    const seenP1 = ids.filter((id) => p1Ids.includes(id)).sort();
    expect(seenP1).toEqual(p1Ids);
    expect(ids.includes(orgRowId)).toBe(true);
    expect(ids.includes(p2Id)).toBe(false);
  });

  it("actor with projectIds=['P2'] sees 2 rows: 1 project:P2 + 1 org", async () => {
    const actor = makeActor({ organizationId: orgA, projectIds: [P2] });
    const ids = await runUnderActor(actor);
    expect(ids.includes(p2Id)).toBe(true);
    expect(ids.includes(orgRowId)).toBe(true);
    const seenP1 = ids.filter((id) => p1Ids.includes(id));
    expect(seenP1).toEqual([]);
  });

  it("actor with projectIds=[] sees 1 row: org only", async () => {
    const actor = makeActor({ organizationId: orgA, projectIds: [] });
    const ids = await runUnderActor(actor);
    expect(ids.includes(orgRowId)).toBe(true);
    expect(ids.includes(p2Id)).toBe(false);
    const seenP1 = ids.filter((id) => p1Ids.includes(id));
    expect(seenP1).toEqual([]);
  });

  it("actor with projectIds=['P1','P2'] sees all 4 seeded rows", async () => {
    const actor = makeActor({ organizationId: orgA, projectIds: [P1, P2] });
    const ids = await runUnderActor(actor);
    const seenP1 = ids.filter((id) => p1Ids.includes(id)).sort();
    expect(seenP1).toEqual(p1Ids);
    expect(ids.includes(p2Id)).toBe(true);
    expect(ids.includes(orgRowId)).toBe(true);
  });
});
