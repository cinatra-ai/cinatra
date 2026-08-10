// REAL-POSTGRES proof for the unbound-thread /chat resolution + repair
// (cinatra#2642). Four things cannot be proven with a query double, and all
// four are acceptance criteria:
//
//   1. A thread created exactly as the AG-UI turn path creates it (id + owner +
//      org, nothing else) and left UNBOUND by a FAILED turn is addressable at
//      its own URL immediately — the same row that 404s before the fix.
//   2. A PRE-EXISTING field row (title set, `assistant_package = ''`,
//      `title_slug = ''` — the issue's row verbatim) resolves through the
//      repair path, and that access PERSISTS the binding: only a real UPDATE
//      against a real row proves the write landed, that `''` normalized out of
//      the partial unique index, and that `updated_at` did NOT move.
//   3. The container-security property: an actor who does not own an unbound
//      row can neither resolve nor claim it, and a BOUND thread still refuses
//      out-of-container lookups exactly as #2589 pinned.
//   4. The repair is idempotent and the second access takes the ordinary
//      exact-container path.
//
// Runner (the repo's standing DB-integration contract — the file tier is
// excluded from the default run):
//
//   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
//     pnpm exec vitest run src/lib/__tests__/chat-unbound-thread-repair.integration.test.ts
//
// The suite owns a lane-unique schema, dropped in `afterAll`.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { randomUUID } from "node:crypto";

import { assistantThreadSchemaQueries } from "@/lib/assistant-thread-schema";
import type { AssistantRegistryEntry } from "@/lib/assistant-registry-reader";
import type { ChatRouteResolution, ChatRouteResolverDeps } from "@/lib/chat-route-resolver";
import type { AssistantThread, UnboundThreadActor } from "@/lib/assistant-thread-store";

const CONNECTION = process.env.SUPABASE_DB_URL ?? "";
const RUN = process.env.CINATRA_DB_INTEGRATION_TESTS === "1" && CONNECTION.length > 0;

const SCHEMA = `t2642_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;

const DEFAULT_PACKAGE = "@cinatra-ai/cinatra-assistant";
const OTHER_PACKAGE = "@acme/helper-assistant";

const OWNER: UnboundThreadActor = { userId: `user-owner-${SCHEMA}`, orgId: `org-${SCHEMA}` };
const STRANGER: UnboundThreadActor = { userId: `user-stranger-${SCHEMA}`, orgId: OWNER.orgId };

type Store = typeof import("@/lib/assistant-thread-store");
type Resolver = typeof import("@/lib/chat-route-resolver");

let admin: Client;
let store: Store;
let resolver: Resolver;

function entry(over: Partial<AssistantRegistryEntry> & { packageName: string }): AssistantRegistryEntry {
  return {
    templateId: "t",
    assistantUserId: "au",
    handle: "h",
    displayName: "Name",
    origin: "extension",
    aliases: [],
    isBuiltin: false,
    delivery: "host-runtime",
    launch: { kind: "local", targetProvider: null },
    ...over,
  };
}

const REGISTRY = [
  entry({ packageName: DEFAULT_PACKAGE, isBuiltin: true }),
  entry({ packageName: OTHER_PACKAGE }),
];

/** The PRODUCTION resolver deps, with the ONE thing a test must inject — the
 *  actor identity (production derives it from the session) — bound to `actor`.
 *  Every thread lookup below is the REAL store function against the REAL
 *  database, so this exercises the shipped resolution + repair path. */
function depsFor(actor: UnboundThreadActor): ChatRouteResolverDeps {
  return {
    readVisibleRegistry: async () => REGISTRY,
    authorizeInstance: async () => true,
    resolveThreadIdBySlug: async (pkg, instanceId, titleSlug) =>
      store.getAssistantThreadBySlug(pkg, instanceId, titleSlug)?.id ?? null,
    resolveThreadIdById: async (pkg, instanceId, threadId) =>
      store.getAssistantThreadByIdInContainer(pkg, instanceId, threadId)?.id ?? null,
    resolveUnboundThreadIdById: async (threadId) => {
      const t = store.getOwnedUnboundAssistantThreadById(threadId, actor);
      if (!t) return null;
      store.repairImplicitDefaultThreadBinding(t.id, actor);
      return t.id;
    },
    resolveUnboundThreadIdBySlug: async (titleSlug) => {
      const t = store.getOwnedUnboundAssistantThreadBySlug(titleSlug, actor);
      if (!t) return null;
      store.repairImplicitDefaultThreadBinding(t.id, actor);
      return t.id;
    },
  };
}

/** The deps as they were BEFORE this fix (the two unbound lookups absent) —
 *  the in-suite "still 404s today" control. */
function preFixDeps(): ChatRouteResolverDeps {
  const d = depsFor(OWNER);
  return {
    readVisibleRegistry: d.readVisibleRegistry,
    authorizeInstance: d.authorizeInstance,
    resolveThreadIdBySlug: d.resolveThreadIdBySlug,
    resolveThreadIdById: d.resolveThreadIdById,
  };
}

async function row(threadId: string): Promise<Record<string, unknown>> {
  const res = await admin.query(
    `SELECT assistant_package, instance_id, title_slug, owner_user_id, updated_at
       FROM "${SCHEMA}"."assistant_threads" WHERE id = $1`,
    [threadId],
  );
  return res.rows[0] as Record<string, unknown>;
}

const describeDb = RUN ? describe : describe.skip;

beforeAll(async () => {
  if (!RUN) return;
  admin = new Client({ connectionString: CONNECTION, connectionTimeoutMillis: 5_000 });
  await admin.connect();
  await admin.query(`CREATE SCHEMA IF NOT EXISTS "${SCHEMA}"`);
  for (const q of assistantThreadSchemaQueries(SCHEMA)) {
    await admin.query(q.text);
  }

  // The store reads its schema at MODULE LOAD, so the env must be set before
  // the dynamic import below. The schema is already provisioned above, so the
  // (whole-store) bootstrap DDL is short-circuited rather than re-run here.
  process.env.SUPABASE_SCHEMA = SCHEMA;
  process.env.SUPABASE_DB_URL = CONNECTION;
  (globalThis as { __cinatraPostgresSchemaInitialized?: boolean }).__cinatraPostgresSchemaInitialized =
    true;

  store = await import("@/lib/assistant-thread-store");
  resolver = await import("@/lib/chat-route-resolver");
}, 60_000);

afterAll(async () => {
  if (!RUN || !admin) return;
  await admin.query(`DROP SCHEMA IF EXISTS "${SCHEMA}" CASCADE`);
  await admin.end();
});

describeDb("AC1 — a thread whose FIRST TURN FAILED is addressable at its own URL", () => {
  it("resolves by id immediately after the failed turn (404 before the fix)", async () => {
    // Exactly what the AG-UI turn path persists before the run starts: id,
    // owner, org — no title, no binding, no slug. The turn then errors, so
    // nothing ever binds the row.
    const id = randomUUID();
    const created: AssistantThread = store.createAssistantThread({
      id,
      ownerUserId: OWNER.userId,
      orgId: OWNER.orgId,
    });
    expect(created.assistantPackage).toBeNull();
    // The legacy mirror save titles the row (this is why the reported thread
    // has a title but no binding).
    await admin.query(`UPDATE "${SCHEMA}"."assistant_threads" SET title = $1 WHERE id = $2`, [
      "What connectors do you have and can you tell me my schedule",
      id,
    ]);

    const segments = ["cinatra-ai", "cinatra-assistant", id];
    const before: ChatRouteResolution = await resolver.resolveChatRoute(segments, preFixDeps());
    expect(before.kind).toBe("not-found"); // the reported 404

    const after: ChatRouteResolution = await resolver.resolveChatRoute(segments, depsFor(OWNER));
    expect(after.kind).toBe("resolved");
    if (after.kind === "resolved") expect(after.threadId).toBe(id);
  });
});

describeDb("AC2 — a PRE-EXISTING unbound row is repaired by the access", () => {
  it("resolves the issue's row (empty package + empty slug) and PERSISTS the binding", async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads"
         (id, owner_user_id, org_id, origin, title, assistant_package, instance_id, title_slug)
       VALUES ($1, $2, $3, 'assistant-native', $4, '', '', '')`,
      [id, OWNER.userId, OWNER.orgId, "What connectors do you have"],
    );
    const seeded = await row(id);
    expect(seeded.assistant_package).toBe("");
    expect(seeded.title_slug).toBe("");

    const r = await resolver.resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", id],
      depsFor(OWNER),
    );
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.threadId).toBe(id);

    const repaired = await row(id);
    expect(repaired.assistant_package).toBe(DEFAULT_PACKAGE);
    expect(repaired.instance_id).toBeNull();
    // '' normalized OUT of the `WHERE title_slug IS NOT NULL` container-unique
    // index, so a second such row can be repaired into the same container too.
    expect(repaired.title_slug).toBeNull();
    // A repair is not thread ACTIVITY: the sidebar order must not move.
    expect(new Date(repaired.updated_at as string).toISOString()).toBe(
      new Date(seeded.updated_at as string).toISOString(),
    );
  });

  it("a slug COLLISION refuses the repair WITHOUT stranding the thread", async () => {
    // An unbound row and an explicitly bound row may legally share a slug today
    // (the container index keys `COALESCE(assistant_package,'')`, so they sit in
    // different index namespaces). Binding the unbound one would collide — the
    // repair must refuse, and resolution must STILL succeed read-only.
    const boundId = randomUUID();
    const unboundId = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads"
         (id, owner_user_id, org_id, origin, title, assistant_package, instance_id, title_slug)
       VALUES ($1, $2, $3, 'assistant-native', 'Bound owner of the slug', $4, NULL, 'shared-slug')`,
      [boundId, OWNER.userId, OWNER.orgId, DEFAULT_PACKAGE],
    );
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads"
         (id, owner_user_id, org_id, origin, title, assistant_package, instance_id, title_slug)
       VALUES ($1, $2, $3, 'assistant-native', 'Unbound, same slug', '', '', 'shared-slug')`,
      [unboundId, OWNER.userId, OWNER.orgId],
    );

    // Addressed by ID, the unbound thread resolves...
    const r = await resolver.resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", unboundId],
      depsFor(OWNER),
    );
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.threadId).toBe(unboundId);
    // ...even though the repair could not land (the slug is taken in the
    // default container) — best-effort, and nothing is stranded.
    expect((await row(unboundId)).assistant_package).toBe("");
    // The slug URL still belongs to the EXPLICITLY bound thread.
    const bySlug = await resolver.resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", "shared-slug"],
      depsFor(OWNER),
    );
    expect(bySlug.kind).toBe("resolved");
    if (bySlug.kind === "resolved") expect(bySlug.threadId).toBe(boundId);
  });

  it("an unbound but SLUGGED thread resolves by its slug and is repaired", async () => {
    // createAssistantThread mints a slug when a title is supplied (the MCP
    // assistant_send path) — but nothing binds the package, so the slug URL
    // 404'd too.
    const t = store.createAssistantThread({
      ownerUserId: OWNER.userId,
      orgId: OWNER.orgId,
      title: "Unbound but slugged thread",
    });
    expect(t.titleSlug).toBeTruthy();
    expect(t.assistantPackage).toBeNull();

    const segments = ["cinatra-ai", "cinatra-assistant", t.titleSlug as string];
    expect((await resolver.resolveChatRoute(segments, preFixDeps())).kind).toBe("not-found");

    const r = await resolver.resolveChatRoute(segments, depsFor(OWNER));
    expect(r.kind).toBe("resolved");
    if (r.kind === "resolved") expect(r.threadId).toBe(t.id);

    const repaired = await row(t.id);
    expect(repaired.assistant_package).toBe(DEFAULT_PACKAGE);
    expect(repaired.title_slug).toBe(t.titleSlug); // a REAL slug is never touched
  });
});

describeDb("AC3 — the container-security property holds", () => {
  it("a STRANGER can neither resolve nor claim an unbound thread they do not own", async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads"
         (id, owner_user_id, org_id, origin, title, assistant_package, instance_id, title_slug)
       VALUES ($1, $2, $3, 'assistant-native', 'Owner private thread', '', '', NULL)`,
      [id, OWNER.userId, OWNER.orgId],
    );

    const r = await resolver.resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", id],
      depsFor(STRANGER),
    );
    expect(r.kind).toBe("not-found");
    // AND nothing was written on their behalf.
    expect((await row(id)).assistant_package).toBe("");

    // The direct store primitives refuse them too (not just the route).
    expect(store.getOwnedUnboundAssistantThreadById(id, STRANGER)).toBeNull();
    expect(store.repairImplicitDefaultThreadBinding(id, STRANGER)).toBe(false);
    expect((await row(id)).assistant_package).toBe("");
  });

  it("an OWNERLESS row is never adoptable", async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads"
         (id, owner_user_id, org_id, origin, title, assistant_package, instance_id, title_slug)
       VALUES ($1, NULL, $2, 'legacy-chat', 'Legacy ownerless', '', '', NULL)`,
      [id, OWNER.orgId],
    );
    const r = await resolver.resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", id],
      depsFor(OWNER),
    );
    expect(r.kind).toBe("not-found");
    expect((await row(id)).assistant_package).toBe("");
  });

  it("a TEAM-owned row is never adoptable", async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads"
         (id, owner_user_id, team_id, org_id, origin, title, assistant_package, instance_id, title_slug)
       VALUES ($1, $2, 'team-9', $3, 'legacy-chat', 'Team thread', '', '', NULL)`,
      [id, OWNER.userId, OWNER.orgId],
    );
    const r = await resolver.resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", id],
      depsFor(OWNER),
    );
    expect(r.kind).toBe("not-found");
    expect((await row(id)).assistant_package).toBe("");
  });

  it("a thread in ANOTHER org is never adoptable (cross-org seal)", async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads"
         (id, owner_user_id, org_id, origin, title, assistant_package, instance_id, title_slug)
       VALUES ($1, $2, 'org-elsewhere', 'assistant-native', 'Other org', '', '', NULL)`,
      [id, OWNER.userId],
    );
    const r = await resolver.resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", id],
      depsFor(OWNER),
    );
    expect(r.kind).toBe("not-found");
    expect((await row(id)).assistant_package).toBe("");
  });

  it("a NON-DEFAULT assistant's URL cannot claim the actor's own unbound thread", async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads"
         (id, owner_user_id, org_id, origin, title, assistant_package, instance_id, title_slug)
       VALUES ($1, $2, $3, 'assistant-native', 'Mine, unbound', '', '', NULL)`,
      [id, OWNER.userId, OWNER.orgId],
    );
    const r = await resolver.resolveChatRoute(["acme", "helper-assistant", id], depsFor(OWNER));
    expect(r.kind).toBe("not-found");
    expect((await row(id)).assistant_package).toBe(""); // NOT claimed into @acme/*
  });

  it("a BOUND thread still refuses an out-of-container lookup (#2589, unchanged)", async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads"
         (id, owner_user_id, org_id, origin, title, assistant_package, instance_id)
       VALUES ($1, $2, $3, 'assistant-native', 'Bound elsewhere', $4, NULL)`,
      [id, OWNER.userId, OWNER.orgId, OTHER_PACKAGE],
    );
    // In its OWN container it resolves (the #2589 id fallback).
    const own = await resolver.resolveChatRoute(["acme", "helper-assistant", id], depsFor(OWNER));
    expect(own.kind).toBe("resolved");
    // Out of container it is 404-hidden — the adoption path must not rescue a
    // BOUND thread into the default container.
    const other = await resolver.resolveChatRoute(
      ["cinatra-ai", "cinatra-assistant", id],
      depsFor(OWNER),
    );
    expect(other.kind).toBe("not-found");
    expect((await row(id)).assistant_package).toBe(OTHER_PACKAGE); // never repointed
  });
});

describeDb("AC3b — what the repair DELIBERATELY changes (codex round-1)", () => {
  it("after the OWNER repairs it, the row is exactly as exposed as any bound thread", async () => {
    // Before the repair the row resolved for NOBODY. After it, the row joins
    // the ordinary container-scoped namespace, where route RESOLUTION has never
    // been owner-scoped (#1878 W3) — so another audience member addressing that
    // URL gets a resolved route, exactly like every already-bound thread. This
    // is the platform's established contract, pinned here so the property is a
    // DECISION on the record rather than an accident: the thread's CONTENT
    // stays sealed by the tenant-scoped thread reads (assistant-thread-http),
    // which this route resolution does not touch.
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads"
         (id, owner_user_id, org_id, origin, title, assistant_package, instance_id, title_slug)
       VALUES ($1, $2, $3, 'assistant-native', 'Owner repairs then stranger asks', '', '', 'owner-repairs-then-stranger-asks')`,
      [id, OWNER.userId, OWNER.orgId],
    );
    const segments = ["cinatra-ai", "cinatra-assistant", "owner-repairs-then-stranger-asks"];

    // BEFORE the repair: the stranger 404s (and so would anyone but the owner).
    expect((await resolver.resolveChatRoute(segments, depsFor(STRANGER))).kind).toBe("not-found");

    // The OWNER's access repairs the row.
    expect((await resolver.resolveChatRoute(segments, depsFor(OWNER))).kind).toBe("resolved");
    expect((await row(id)).assistant_package).toBe(DEFAULT_PACKAGE);

    // AFTER the repair: the stranger resolves it through the pre-existing,
    // owner-blind exact-container lookup — the SAME exposure every bound thread
    // has had since #1878 W3, and the unbound alias is not what serves it (it
    // resolves with those deps removed entirely).
    const afterPreFix = await resolver.resolveChatRoute(segments, preFixDeps());
    expect(afterPreFix.kind).toBe("resolved");
    const afterStranger = await resolver.resolveChatRoute(segments, depsFor(STRANGER));
    expect(afterStranger.kind).toBe("resolved");
    if (afterStranger.kind === "resolved") expect(afterStranger.threadId).toBe(id);
    // The stranger still cannot CLAIM or re-point anything.
    expect(store.repairImplicitDefaultThreadBinding(id, STRANGER)).toBe(false);
    expect((await row(id)).assistant_package).toBe(DEFAULT_PACKAGE);
  });
});

describeDb("AC4 — the repair is idempotent and hands over to the ordinary path", () => {
  it("a second access resolves through the EXACT-CONTAINER lookup and rewrites nothing", async () => {
    const id = randomUUID();
    await admin.query(
      `INSERT INTO "${SCHEMA}"."assistant_threads"
         (id, owner_user_id, org_id, origin, title, assistant_package, instance_id, title_slug)
       VALUES ($1, $2, $3, 'assistant-native', 'Repaired once', '', '', NULL)`,
      [id, OWNER.userId, OWNER.orgId],
    );
    const segments = ["cinatra-ai", "cinatra-assistant", id];
    expect((await resolver.resolveChatRoute(segments, depsFor(OWNER))).kind).toBe("resolved");
    const first = await row(id);

    // The unbound lookups are now dead for this row — prove the second access
    // resolves with them REMOVED (the pre-fix deps).
    const second = await resolver.resolveChatRoute(segments, preFixDeps());
    expect(second.kind).toBe("resolved");
    if (second.kind === "resolved") expect(second.threadId).toBe(id);

    expect(store.repairImplicitDefaultThreadBinding(id, OWNER)).toBe(false); // no-op now
    expect(await row(id)).toEqual(first);
  });
});
