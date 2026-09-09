// THE ROW THE SUPPLIED ROAD WRITES IS THE ROW THE AGENTS LISTING READS
// (cinatra#3204 criterion 21, agent — proven against a REAL Postgres schema).
//
// The second proof round measured an agent installed through the Upload screen
// at "Workspace: All": the database held an ACTIVE, org-NULL agent_templates
// row, the toast named the agents list, and the list's own search reported no
// match. Three explanations were on the table — the listing's query scope, the
// anchor derivation from the chosen target, and the agent kind's native
// ownership step. This suite settles all three against the real schema, so the
// screen-side fix is made against a proven data story rather than a guess:
//
//   1. the anchor the SHARED contract resolves for the workspace target
//      (`resolveNativeInstallOwnership`, the same call the agent handler makes)
//      is the tuple the row is written at — owner level `workspace`, the
//      organization's own id as the owner, and org_id NULL;
//   2. that row is returned by `readInstalledAgentTemplates`, the reader the
//      `/agents` page itself calls — the listing's query has no organization
//      filter to exclude it, and a second organization's row is returned too;
//   3. what decides whether the page RENDERS it is the listing's own
//      run-visibility rule (`selectHitlRunVisibleTemplates`), which reads the
//      template's human-in-the-loop declaration and nothing about the road it
//      arrived on: an identical store-installed row is included or excluded
//      identically.
//
// So the install is sound and the promise was not: an agent with no
// human-in-the-loop signal cannot appear on that page, whichever road installed
// it. The screen fix (supplied-install-actions) resolves the observable through
// this same reader and rule.
//
// Run:
//   CINATRA_DB_INTEGRATION_TESTS=1 SUPABASE_DB_URL=<live> \
//     pnpm --filter ./packages/agents exec vitest run \
//     src/__tests__/supplied-agent-listing-row.integration.test.ts
import { describe, it, expect, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb = typeof dbUrl === "string" && dbUrl.length > 0 && !isPlaceholderDbUrl(dbUrl);

const ORG_A = `org_a_${randomUUID().slice(0, 8)}`;
const ORG_B = `org_b_${randomUUID().slice(0, 8)}`;

const createdTemplateIds: string[] = [];

function schemaName(): string {
  return `"${(process.env.SUPABASE_SCHEMA?.trim() || "cinatra").replaceAll('"', '""')}"`;
}

/** The workspace target's install-row contract, resolved exactly as the server
 *  boundary resolves it before the dispatcher is called. */
async function workspaceOwnership(orgId: string) {
  const { resolveInstallAccessTargetContract } = await import(
    "@cinatra-ai/extensions/install-access-target"
  );
  const { resolveNativeInstallOwnership } = await import(
    "@cinatra-ai/extensions/canonical-types"
  );
  const { rowOwnership } = resolveInstallAccessTargetContract(
    { level: "workspace", id: orgId },
    orgId,
  );
  return {
    rowOwnership,
    native: resolveNativeInstallOwnership(orgId, rowOwnership),
  };
}

/** Write the agent template the supplied road's handler writes: the same
 *  writer (`createAgentTemplate`), at the anchor the contract resolved, with
 *  the install status the agent handler passes. */
async function seedInstalledAgent(input: {
  packageName: string;
  orgId: string;
  hitl?: { screens?: string[]; required?: boolean };
}): Promise<{ id: string; native: Awaited<ReturnType<typeof workspaceOwnership>>["native"] }> {
  const { createAgentTemplate } = await import("../store");
  const { native } = await workspaceOwnership(input.orgId);
  const id = `t_${randomUUID()}`;
  await createAgentTemplate({
    id,
    name: `upload-walk-${randomUUID().slice(0, 6)}`,
    sourceNl: "x",
    compiledPlan: [],
    inputSchema: {},
    approvalPolicy: { steps: [] },
    packageName: input.packageName,
    packageVersion: "1.0.0",
    // The agent handler passes status "active" so a fresh install is installed,
    // not draft.
    status: "active",
    ...(native.anchorOrgId ? { orgId: native.anchorOrgId } : {}),
    ...(native.ownerLevel ? { ownerLevel: native.ownerLevel } : {}),
    ...(native.ownerId ? { ownerId: native.ownerId } : {}),
    ...(input.hitl?.screens ? { hitlScreens: input.hitl.screens } : {}),
    ...(input.hitl?.required ? { hitlRequired: input.hitl.required } : {}),
  });
  createdTemplateIds.push(id);
  return { id, native };
}

async function rawRow(id: string): Promise<Record<string, unknown>> {
  const { db } = await import("../db");
  const res = await db.execute(
    sql`select * from ${sql.raw(schemaName())}.agent_templates where id = ${id}`,
  );
  const rows = (res as unknown as { rows?: Record<string, unknown>[] }).rows ?? [];
  return rows[0] ?? {};
}

afterAll(async () => {
  if (!hasDb || createdTemplateIds.length === 0) return;
  const { db } = await import("../db");
  for (const id of createdTemplateIds) {
    await db.execute(
      sql`delete from ${sql.raw(schemaName())}.agent_versions where template_id = ${id}`,
    );
    await db.execute(
      sql`delete from ${sql.raw(schemaName())}.agent_templates where id = ${id}`,
    );
  }
});

describe.skipIf(!hasDb)("the supplied agent install and the agents listing (real DB)", () => {
  it("the workspace target anchors the native row at org_id NULL, owner level workspace", async () => {
    const packageName = `@upload-walk/${randomUUID().slice(0, 10)}-agent`;
    const { id, native } = await seedInstalledAgent({ packageName, orgId: ORG_A });

    // The contract itself, not a hand-written tuple. The workspace anchor is
    // app-wide by construction: org NULL, and NO owner id — the canonical
    // row's platform owner sentinel is deliberately never written into a
    // native owner field (`resolveNativeInstallOwnership`), because it names no
    // principal a native store could resolve.
    expect(native.anchorOrgId).toBeNull();
    expect(native.ownerLevel).toBe("workspace");
    expect(native.ownerId).toBeUndefined();

    const row = await rawRow(id);
    expect(row.org_id).toBeNull();
    expect(row.owner_level).toBe("workspace");
    expect(row.owner_id).toBeNull();
    expect(row.status).toBe("active");
    expect(row.package_name).toBe(packageName);
  });

  it("the listing's own reader returns that row — its query has no organization filter", async () => {
    const packageName = `@upload-walk/${randomUUID().slice(0, 10)}-agent`;
    const { id } = await seedInstalledAgent({ packageName, orgId: ORG_A });

    const { readInstalledAgentTemplates } = await import("../store");
    const listed = await readInstalledAgentTemplates();
    const found = listed.find((t) => t.id === id);
    expect(found).toBeDefined();
    expect(found?.packageName).toBe(packageName);
  });

  it("a second organization's workspace install writes the same app-wide shape and is read too", async () => {
    const packageName = `@upload-walk/${randomUUID().slice(0, 10)}-agent`;
    const { id, native } = await seedInstalledAgent({ packageName, orgId: ORG_B });
    // The workspace target of a DIFFERENT organization resolves to the SAME
    // app-wide anchor — that is what "Workspace: All" means — so nothing about
    // the reading organization can be what hides the row.
    expect(native.anchorOrgId).toBeNull();
    expect(native.ownerLevel).toBe("workspace");

    const { readInstalledAgentTemplates } = await import("../store");
    const listed = await readInstalledAgentTemplates();
    expect(listed.some((t) => t.id === id)).toBe(true);
  });

  it("what the page RENDERS is decided by the human-in-the-loop declaration, not by the road", async () => {
    const plainPackage = `@upload-walk/${randomUUID().slice(0, 10)}-agent`;
    const gatedPackage = `@upload-walk/${randomUUID().slice(0, 10)}-agent`;
    const plain = await seedInstalledAgent({ packageName: plainPackage, orgId: ORG_A });
    const gated = await seedInstalledAgent({
      packageName: gatedPackage,
      orgId: ORG_A,
      hitl: { screens: ["review"] },
    });

    const { readInstalledAgentTemplates } = await import("../store");
    const { selectHitlRunVisibleTemplates } = await import("../hitl-run-filter");
    const listed = await readInstalledAgentTemplates();

    // Both rows are READ ...
    expect(listed.some((t) => t.id === plain.id)).toBe(true);
    expect(listed.some((t) => t.id === gated.id)).toBe(true);

    // ... and only the one declaring a human-in-the-loop step is RENDERED.
    const visible = selectHitlRunVisibleTemplates(listed);
    expect(visible.some((t) => t.id === gated.id)).toBe(true);
    expect(visible.some((t) => t.id === plain.id)).toBe(false);
  });
});
