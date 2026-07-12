/**
 * Public-visibility integration test (real Postgres) — canonical vocabulary
 * (cinatra#1428; the retired 'workspace'/'admin' composites map to 'public'
 * and 'private').
 *
 * `visibility="public"` rows are scoped to their owning organization —
 * visible to any non-admin actor whose `organizationId` matches the row's
 * `org_id`, NOT cross-org. Platform admins (`platformRole="platform_admin"`)
 * read public rows across orgs.
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
let workspaceId = "";
const orgARowIds: string[] = [];
let adminRowId = "";

beforeAll(async () => {
  client = await connect();
  schema = await createTestSchema(client);

  // Public-visibility rows must carry the owning org_id.
  // A public row with org_id=NULL is not visible to any non-admin actor.
  workspaceId = await insertObject(client, schema, {
    orgId: orgA,
    ownerLevel: "workspace",
    ownerId: "workspace",
    visibility: "public",
  });

  for (let i = 0; i < 2; i++) {
    orgARowIds.push(
      await insertObject(client, schema, {
        orgId: orgA,
        ownerLevel: "organization",
        ownerId: orgA,
        visibility: "organization",
      }),
    );
  }

  // Cross-org public row (owned by orgB): platform admins see it, orgA
  // members do NOT (public is owning-org scoped for non-admins).
  adminRowId = await insertObject(client, schema, {
    orgId: orgB,
    ownerLevel: "workspace",
    ownerId: "workspace",
    visibility: "public",
  });
  orgARowIds.sort();
}, 30_000);

afterAll(async () => {
  if (client && schema) await dropSchema(client, schema);
  if (client) await client.end();
});

function makeActor(opts: {
  organizationId?: string;
  platformRole?: "platform_admin" | "member";
}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "user-test",
    organizationId: opts.organizationId,
    teamIds: [],
    projectIds: [],
    platformRole: opts.platformRole,
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

describe("llm-scope-workspace (real Postgres)", () => {
  it("actor in orgA sees 3 rows (public + 2 org)", async () => {
    const actor = makeActor({ organizationId: orgA });
    const ids = (await runUnderActor(actor)).sort();
    const expected = [...orgARowIds, workspaceId].sort();
    // Filter to the rows we seeded — assert exact membership.
    const seeded = ids.filter((id) => expected.includes(id));
    expect(seeded).toEqual(expected);
    // orgB's public row excluded for a non-admin orgA actor.
    expect(ids.includes(adminRowId)).toBe(false);
  });

  it("actor in orgA does not see orgB rows (public is owning-org scoped, not cross-org)", async () => {
    const actor = makeActor({ organizationId: orgB });
    const ids = await runUnderActor(actor);
    const seenOrgA = ids.filter((id) => orgARowIds.includes(id));
    expect(seenOrgA).toEqual([]);
    // orgA's public row is NOT visible to an orgB actor — public
    // visibility means "visible within the owning org" (multi-tenant safe).
    expect(ids.includes(workspaceId)).toBe(false);
    // orgB's own public row IS visible to the orgB actor.
    expect(ids.includes(adminRowId)).toBe(true);
  });

  it("actor with platformRole='platform_admin' sees public rows across orgs", async () => {
    const actor = makeActor({ organizationId: orgA, platformRole: "platform_admin" });
    const ids = await runUnderActor(actor);
    expect(ids.includes(adminRowId)).toBe(true);
    expect(ids.includes(workspaceId)).toBe(true);
    // Org rows still visible.
    const seenOrgA = ids.filter((id) => orgARowIds.includes(id));
    expect(seenOrgA.sort()).toEqual(orgARowIds);
  });

  it("non-admin actor cannot see another org's public rows", async () => {
    const actor = makeActor({ organizationId: orgA, platformRole: "member" });
    // Direct withActorContext call — explicit ALS frame check.
    const ids = await withActorContext(actor, async () => {
      const ctx = getActorContext();
      if (!ctx) throw new Error("ALS frame missing");
      const frag = buildOwnershipFilter(ctx);
      return await selectVisibleIds(client, schema, frag);
    });
    expect(ids.includes(adminRowId)).toBe(false);
  });
});
