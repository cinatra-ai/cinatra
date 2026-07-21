/**
 * Scope-vantage LOCKSTEP conformance (real Postgres) — cinatra#1886 C2 / D11.
 *
 * The canonical ownership predicate has ONE source of truth
 * (`OWNERSHIP_VISIBILITY_CLAUSES`) and TWO projections: the SQL fragment
 * `buildOwnershipFilter` compiles, and the pure row predicate
 * `evaluateOwnershipVisibility` (behind `actorMaySeeRow` / `scopeMaySeeRow`).
 * This test PINS that the two stay in lockstep by running the SAME (vantage,
 * row) corpus through BOTH paths and asserting identical verdicts:
 *
 *   - ACTOR projection: for a set of actors (member, platform-admin, null-org,
 *     OBO-ceilinged), the ids the compiled SQL SELECTs against a live schema
 *     equal the ids the row predicate admits.
 *   - SCOPE projection: for each scope kind, `scopeMaySeeRow` over the corpus
 *     equals what the compiled SQL SELECTs for an actor whose ownership axes
 *     mirror the scope's vantage — so the scope guard is verified against real
 *     SQL, not merely against its own evaluator.
 *
 * Gated by CINATRA_DB_INTEGRATION_TESTS=1 + a live SUPABASE_DB_URL (the same
 * contract as the other integration/** suites; excluded from the default run).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { Client } from "pg";

import {
  buildOwnershipFilter,
  evaluateOwnershipVisibility,
  scopeMaySeeRow,
  vantageFromActor,
  vantageFromScope,
  type OwnershipEvalRow,
  type CollectionScope,
} from "@/lib/derived-store-ownership";
import type { ActorContext } from "@/lib/authz/actor-context";
import { connect, createTestSchema, dropSchema, insertObject, selectVisibleIds } from "./_fixture";

const ORG = "org-A";
const ORG2 = "org-B";

// A corpus row: its id + its canonical ownership tuple. The tuple is BOTH
// inserted into Postgres (for the SQL path) and fed to the row predicate.
type CorpusRow = { id: string; tuple: OwnershipEvalRow };

let client: Client;
let schema: string;
const corpus: CorpusRow[] = [];

async function seed(t: Omit<OwnershipEvalRow, "orgId"> & { orgId: string }): Promise<void> {
  const id = await insertObject(client, schema, {
    orgId: t.orgId,
    ownerLevel: t.ownerLevel ?? "organization",
    ownerId: t.ownerId ?? t.orgId,
    visibility: t.visibility ?? "private",
    projectId: t.projectId ?? null,
  });
  corpus.push({ id, tuple: { ...t } });
}

beforeAll(async () => {
  client = await connect();
  schema = await createTestSchema(client);

  // Cover every axis + tenancy boundary + project refinement.
  await seed({ ownerLevel: "user", ownerId: "user-1", visibility: "private", projectId: null, orgId: ORG });
  await seed({ ownerLevel: "user", ownerId: "user-2", visibility: "private", projectId: null, orgId: ORG });
  await seed({ ownerLevel: "team", ownerId: "team-a", visibility: "team", projectId: null, orgId: ORG });
  await seed({ ownerLevel: "team", ownerId: "team-b", visibility: "team", projectId: null, orgId: ORG });
  await seed({ ownerLevel: "organization", ownerId: ORG, visibility: "organization", projectId: null, orgId: ORG });
  await seed({ ownerLevel: "workspace", ownerId: ORG, visibility: "public", projectId: null, orgId: ORG });
  await seed({ ownerLevel: "organization", ownerId: ORG, visibility: "private", projectId: "proj-x", orgId: ORG });
  await seed({ ownerLevel: "organization", ownerId: ORG, visibility: "private", projectId: "proj-y", orgId: ORG });
  await seed({ ownerLevel: "user", ownerId: "user-1", visibility: "private", projectId: "proj-x", orgId: ORG });
  // Foreign-org rows — the tenancy floor must exclude these from ORG vantages.
  await seed({ ownerLevel: "organization", ownerId: ORG2, visibility: "organization", projectId: null, orgId: ORG2 });
  await seed({ ownerLevel: "workspace", ownerId: ORG2, visibility: "public", projectId: null, orgId: ORG2 });
}, 60_000);

afterAll(async () => {
  if (client && schema) await dropSchema(client, schema);
  if (client) await client.end();
});

function predicateSet(vantage: ReturnType<typeof vantageFromActor>, ceiling?: ActorContext["oboCeiling"]): string[] {
  return corpus
    .filter((c) => evaluateOwnershipVisibility(vantage, c.tuple, ceiling))
    .map((c) => c.id)
    .sort();
}

async function sqlSet(actor: ActorContext): Promise<string[]> {
  const ids = await selectVisibleIds(client, schema, buildOwnershipFilter(actor));
  return [...ids].sort();
}

const baseActor = (overrides: Partial<ActorContext>): ActorContext => ({
  principalType: "HumanUser",
  principalId: "user-1",
  organizationId: ORG,
  teamIds: [],
  projectIds: [],
  platformRole: "member",
  authSource: "ui",
  policyVersion: "v2",
  ...overrides,
});

describe("actor projection — SQL vs row predicate agree on the same corpus", () => {
  const actors: Array<[string, ActorContext]> = [
    ["member user-1 / team-a / proj-x", baseActor({ principalId: "user-1", teamIds: ["team-a"], projectIds: ["proj-x"] })],
    ["member user-2 / team-b / proj-y", baseActor({ principalId: "user-2", teamIds: ["team-b"], projectIds: ["proj-y"] })],
    ["member no teams/projects", baseActor({ principalId: "user-3" })],
    ["null-org member", baseActor({ principalId: "user-3", organizationId: undefined })],
    ["platform admin", baseActor({ principalId: "admin-1", platformRole: "platform_admin" })],
    ["ORG2 member", baseActor({ principalId: "user-9", organizationId: ORG2 })],
  ];

  for (const [name, actor] of actors) {
    it(`agrees for: ${name}`, async () => {
      const fromSql = await sqlSet(actor);
      const fromPredicate = predicateSet(vantageFromActor(actor), actor.oboCeiling);
      expect(fromPredicate).toEqual(fromSql);
    });
  }

  it("agrees under an OBO project ceiling (satisfy-all narrowing)", async () => {
    const actor = baseActor({
      principalId: "user-1",
      teamIds: ["team-a"],
      projectIds: ["proj-x"],
      oboCeiling: [{ tier: "project", id: "proj-x" }],
    });
    const fromSql = await sqlSet(actor);
    const fromPredicate = predicateSet(vantageFromActor(actor), actor.oboCeiling);
    expect(fromPredicate).toEqual(fromSql);
  });
});

describe("scope projection — scopeMaySeeRow vs the compiled SQL of the mirrored vantage", () => {
  // An actor whose ownership axes exactly mirror a scope's vantage — no admin,
  // no ceiling — so the SQL SELECT reproduces the scope's visibility set.
  function actorMirroringScope(scope: CollectionScope): ActorContext {
    const v = vantageFromScope(scope);
    if (!v) throw new Error("scope produced no vantage");
    return baseActor({
      // A sentinel principal for scopes with no user axis — matches no seeded
      // owner_id, mirroring `vantageFromScope` leaving principalId undefined.
      principalId: v.principalId ?? "__no_user_axis__",
      teamIds: v.teamIds,
      organizationId: v.organizationId ?? undefined,
      projectIds: v.projectIds,
      platformRole: "member",
    });
  }

  const scopes: Array<[string, CollectionScope]> = [
    ["user-1", { kind: "user", userId: "user-1", orgId: ORG }],
    ["team-a", { kind: "team", teamId: "team-a", orgId: ORG }],
    ["organization ORG", { kind: "organization", orgId: ORG }],
    ["workspace ORG", { kind: "workspace", orgId: ORG }],
    ["project proj-x", { kind: "project", projectId: "proj-x", orgId: ORG }],
  ];

  for (const [name, scope] of scopes) {
    it(`scope ${name}: guard verdict matches the SQL-selected set`, async () => {
      const fromSql = await sqlSet(actorMirroringScope(scope));
      const fromGuard = corpus
        .filter((c) => scopeMaySeeRow(scope, c.tuple))
        .map((c) => c.id)
        .sort();
      expect(fromGuard).toEqual(fromSql);
    });
  }
});
