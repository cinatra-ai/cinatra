/**
 * cinatra#2597 — REAL-DATABASE proof that a scoped approve resolves the
 * published agent_template even when the author's proposed package scope does
 * NOT match the instance vendor namespace.
 *
 * This is the regression the live UAT on PR #2602 caught (https://github.com/cinatra-ai/cinatra/blob/ec30b7513c6541ec01af7dbef1d0a1979dc074f0/evidence/2597, check
 * 4): `agent_source_write_files` rewrites `package.json#name` UNCONDITIONALLY
 * to `@<instance-vendor>/<packageSlug>`, `agent_source_publish` reads the
 * canonical name back off that same package.json, and the agent_templates row
 * therefore lands under the INSTANCE-VENDOR name. Keying the post-publish
 * lookup on the AUTHOR's proposed `packageName` missed for every proposal whose
 * scope differed — so a valid approval published the agent and then silently
 * dropped the reviewer's access scope.
 *
 * WHAT IS REAL HERE: the database, `agent_templates` (created through the real
 * `createAgentTemplate`), `readAgentTemplateByPackageName` (a real exact-match
 * query, no alias resolution), the real `agent_creation_request` row and its
 * real CAS transition, and the real `handleAgentCreationRequestDecide` —
 * including the resolution under test.
 *
 * WHAT IS SUBSTITUTED, AND WHY: only the `agent_source_*` adapter
 * (`../mcp/handlers`), which publishes a tarball to Verdaccio from an on-disk
 * source package. That side needs the extension source tree and a registry, and
 * it is NOT the seam under test. The substitute reproduces the two behaviours
 * that MATTER: it rewrites the name to the instance vendor segment, and it
 * creates the real agent_templates row under THAT name — exactly as
 * `installAgentFromPackage` does inside the real publish.
 *
 * Skips without a real DB, like every other *.integration.test.ts here.
 */
import { describe, it, expect, beforeAll, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { isPlaceholderDbUrl } from "@/lib/test-support/placeholder-db-url";

const dbUrl = process.env.SUPABASE_DB_URL;
const hasDb =
  typeof dbUrl === "string"
  && dbUrl.length > 0
  && !isPlaceholderDbUrl(dbUrl);

// The instance's operator-vendor segment for this proof. The author proposes
// under `@uat2597`, which deliberately does NOT match it — the default case.
const INSTANCE_VENDOR = "uat2597-instance";
const PROPOSED_SCOPE = "@uat2597";

const ORG_ID = `org-2597-${randomUUID().slice(0, 8)}`;
const TEAM_ID = `team-2597-${randomUUID().slice(0, 8)}`;
const ADMIN_ID = `admin-2597-${randomUUID().slice(0, 8)}`;
const AUTHOR_ID = `author-2597-${randomUUID().slice(0, 8)}`;

/** Rows the mocked publish created, so the assertions can compare against the
 *  identity the DB actually holds rather than a guess. */
const publishedTemplateIdBySlug = new Map<string, string>();
/** The proposed package name for the approve currently in flight, so the
 *  `write_files` substitute can report `nameNormalized` exactly as the real one
 *  does — it emits the field ONLY when it actually changed the name. The
 *  post-normalization collision gate reads that field, so a fixture that always
 *  omits it would silently skip the gate. */
const proposedNameBySlug = new Map<string, string>();

// Substitute ONLY the Verdaccio/disk adapter. Everything else stays real.
vi.mock("../mcp/handlers", () => ({
  createAgentBuilderPrimitiveHandlers: () => ({
    agent_source_write: async () => ({ written: true }),
    agent_source_write_files: async (r: { input: { packageSlug: string } }) => {
      const slug = r.input.packageSlug;
      const canonical = `@${INSTANCE_VENDOR}/${slug}`;
      const proposed = proposedNameBySlug.get(slug);
      // Mirrors the real primitive: the field is emitted ONLY on an actual
      // rewrite. The collision gate depends on it to see the canonical name.
      return {
        written: true,
        ...(proposed && proposed !== canonical
          ? { nameNormalized: { from: proposed, to: canonical } }
          : {}),
      };
    },
    agent_source_compile: async () => ({ compiled: true }),
    agent_source_publish: async (r: { input: { packageSlug: string } }) => {
      const slug = r.input.packageSlug;
      // The rewrite, reproduced: the canonical name is instance-scoped.
      const packageName = `@${INSTANCE_VENDOR}/${slug}`;
      // The real publish CREATES the template row (installAgentFromPackage).
      // Use the REAL store so the row, and its package_name key, are genuine.
      const { createAgentTemplate } = await import("../store");
      const id = `t_${randomUUID()}`;
      await createAgentTemplate({
        id,
        name: slug,
        sourceNl: "cinatra#2597 integration fixture",
        compiledPlan: [],
        inputSchema: {},
        approvalPolicy: { steps: [] },
        packageName,
        orgId: ORG_ID,
      });
      publishedTemplateIdBySlug.set(slug, id);
      return { published: true, packageName, packageVersion: "0.1.0" };
    },
  }),
}));

async function pg<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new Client({ connectionString: dbUrl });
  await c.connect();
  try {
    return (await c.query(sql, params)).rows as T[];
  } finally {
    await c.end();
  }
}

beforeAll(async () => {
  if (!hasDb) return;
  await pg(
    `INSERT INTO public."organization" (id,name,slug,"createdAt") VALUES ($1,$2,$3,now())
     ON CONFLICT (id) DO NOTHING`,
    [ORG_ID, "UAT2597 Org", ORG_ID],
  );
  for (const [id, email, role] of [
    [ADMIN_ID, `${ADMIN_ID}@local.test`, "admin"],
    [AUTHOR_ID, `${AUTHOR_ID}@local.test`, "user"],
  ] as const) {
    await pg(
      `INSERT INTO public."user" (id,name,email,"emailVerified","createdAt","updatedAt",role)
       VALUES ($1,$2,$3,true,now(),now(),$4) ON CONFLICT (id) DO NOTHING`,
      [id, id, email, role],
    );
    await pg(
      `INSERT INTO public."member" (id,"userId","organizationId",role,"createdAt")
       VALUES ($1,$2,$3,$4,now()) ON CONFLICT (id) DO NOTHING`,
      [`mem-${id}`, id, ORG_ID, id === ADMIN_ID ? "owner" : "member"],
    );
  }
  await pg(
    `INSERT INTO public."team" (id,name,slug,"organizationId","createdAt")
     VALUES ($1,$2,$3,$4,now()) ON CONFLICT (id) DO NOTHING`,
    [TEAM_ID, "UAT2597 Reviewers", TEAM_ID, ORG_ID],
  );
  await pg(
    `INSERT INTO public."teamMember" (id,"teamId","userId","createdAt")
     VALUES ($1,$2,$3,now()) ON CONFLICT (id) DO NOTHING`,
    [`tm-${TEAM_ID}`, TEAM_ID, ADMIN_ID],
  );
});

/** Propose through the REAL request store, then approve through the REAL
 *  decide primitive with a team access scope. Returns the decide envelope. */
async function proposeThenApprove(proposedScope: string) {
  const slug = `uat2597-${randomUUID().slice(0, 8)}`;
  const packageName = `${proposedScope}/${slug}`;
  proposedNameBySlug.set(slug, packageName);
  const { createAgentCreationRequest } = await import("@/lib/agent-creation-requests-store");
  const row = createAgentCreationRequest({
    orgId: ORG_ID,
    authorId: AUTHOR_ID,
    packageSlug: slug,
    packageName,
    packageVersion: "0.1.0",
    proposalSnapshot: {
      packageSlug: slug,
      packageName,
      packageVersion: "0.1.0",
      oas: { agentspec_version: "26.1.0", component_type: "Flow", name: slug },
      packageJson: { name: packageName, version: "0.1.0" },
      skillMd: `# ${slug}\n`,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any,
  });

  const { handleAgentCreationRequestDecide } = await import(
    "../mcp/agent-creation-request-handlers"
  );
  const out = (await handleAgentCreationRequestDecide({
    primitiveName: "agent_creation_request_decide",
    input: {
      id: row.id,
      decision: "approve",
      expectedSnapshotHash: row.snapshotHash,
      accessTarget: { level: "team", id: TEAM_ID },
    },
    actor: {
      actorType: "human",
      source: "ui",
      userId: ADMIN_ID,
      organizationId: ORG_ID,
      platformRole: "platform_admin",
    },
    mode: "deterministic",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any)) as {
    error?: string;
    structuredContent?: { agentTemplateId?: string | null };
  };
  return { slug, packageName, out };
}

describe.skipIf(!hasDb)("cinatra#2597 — approve resolves the PUBLISHED template (real DB)", () => {
  it("a NON-matching proposed namespace still resolves the published template id", async () => {
    const { slug, packageName, out } = await proposeThenApprove(PROPOSED_SCOPE);
    expect(out.error).toBeUndefined();

    const canonical = `@${INSTANCE_VENDOR}/${slug}`;
    // Sanity: the proposal and the published identity really do differ. Without
    // this the test could pass for the wrong reason.
    expect(packageName).not.toBe(canonical);

    // The row the DB actually holds, read back through the REAL exact-match query.
    const { readAgentTemplateByPackageName } = await import("../store");
    const underCanonical = await readAgentTemplateByPackageName(canonical);
    const underProposed = await readAgentTemplateByPackageName(packageName);
    expect(underCanonical?.id).toBe(publishedTemplateIdBySlug.get(slug));
    // The heart of the defect: nothing is keyed under the proposed name.
    expect(underProposed).toBeNull();

    // …and the approve envelope nonetheless carries the right id.
    expect(out.structuredContent?.agentTemplateId).toBe(underCanonical?.id);
  });

  it("a MATCHING proposed namespace resolves too (the arm that passed by coincidence)", async () => {
    const { slug, out } = await proposeThenApprove(`@${INSTANCE_VENDOR}`);
    expect(out.error).toBeUndefined();
    expect(out.structuredContent?.agentTemplateId).toBe(publishedTemplateIdBySlug.get(slug));
  });

  it("REFUSES to publish when the canonical name is already owned by another org", async () => {
    // `agent_templates.package_name` carries a UNIQUE index, so a foreign row
    // under the canonical name would be ADOPTED by publish (upsert by package
    // name) and its id handed back — applying this reviewer's scope to another
    // organization's agent. The collision gate must reject before publishing.
    //
    // The gate must also not depend on paging: it used to call
    // `readAgentTemplates()` with a default limit of 50, so this is asserted
    // against a REAL table (35 seeded templates plus everything these tests
    // added) using a real UNIQUE-indexed row.
    const foreignOrgId = `org-2597-foreign-${randomUUID().slice(0, 8)}`;
    await pg(
      `INSERT INTO public."organization" (id,name,slug,"createdAt") VALUES ($1,$2,$3,now())
       ON CONFLICT (id) DO NOTHING`,
      [foreignOrgId, "UAT2597 Foreign Org", foreignOrgId],
    );
    const squattedSlug = `uat2597-squat-${randomUUID().slice(0, 8)}`;
    const canonical = `@${INSTANCE_VENDOR}/${squattedSlug}`;
    const { createAgentTemplate } = await import("../store");
    const foreignId = `t_${randomUUID()}`;
    await createAgentTemplate({
      id: foreignId,
      name: squattedSlug,
      sourceNl: "cinatra#2597 foreign-owner fixture",
      compiledPlan: [],
      inputSchema: {},
      approvalPolicy: { steps: [] },
      packageName: canonical,
      orgId: foreignOrgId,
    });

    // Now propose the SAME slug in OUR org, under a non-matching namespace, so
    // the rewrite lands on the canonical name the foreign org already owns.
    proposedNameBySlug.set(squattedSlug, `${PROPOSED_SCOPE}/${squattedSlug}`);
    const { createAgentCreationRequest } = await import("@/lib/agent-creation-requests-store");
    const row = createAgentCreationRequest({
      orgId: ORG_ID,
      authorId: AUTHOR_ID,
      packageSlug: squattedSlug,
      packageName: `${PROPOSED_SCOPE}/${squattedSlug}`,
      packageVersion: "0.1.0",
      proposalSnapshot: {
        packageSlug: squattedSlug,
        packageName: `${PROPOSED_SCOPE}/${squattedSlug}`,
        packageVersion: "0.1.0",
        oas: { agentspec_version: "26.1.0", component_type: "Flow", name: squattedSlug },
        packageJson: { name: `${PROPOSED_SCOPE}/${squattedSlug}`, version: "0.1.0" },
        skillMd: `# ${squattedSlug}\n`,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any,
    });

    const { handleAgentCreationRequestDecide } = await import(
      "../mcp/agent-creation-request-handlers"
    );
    const out = (await handleAgentCreationRequestDecide({
      primitiveName: "agent_creation_request_decide",
      input: {
        id: row.id,
        decision: "approve",
        expectedSnapshotHash: row.snapshotHash,
        accessTarget: { level: "team", id: TEAM_ID },
      },
      actor: {
        actorType: "human",
        source: "ui",
        userId: ADMIN_ID,
        organizationId: ORG_ID,
        platformRole: "platform_admin",
      },
      mode: "deterministic",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)) as { error?: string; structuredContent?: { agentTemplateId?: string | null } };

    expect(out.error).toMatch(/package-name collision/i);
    // Critically: the foreign row's id is never handed back for scoping.
    expect(out.structuredContent?.agentTemplateId ?? null).not.toBe(foreignId);

    // The foreign row is untouched and still owned by the foreign org.
    const [after] = await pg<{ org_id: string }>(
      `SELECT org_id FROM cinatra.agent_templates WHERE id = $1`,
      [foreignId],
    );
    expect(after.org_id).toBe(foreignOrgId);
  });
});
