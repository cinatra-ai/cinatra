import { describe, it, expect, beforeAll } from "vitest";
import { Client } from "pg";
import { buildCreateStoreSchemaQueries } from "@/lib/drizzle-store";
import { createWorkflowPrimitiveHandlers } from "../mcp/handlers";
import { createWorkflowTemplate } from "../store";
import type { WorkflowSpec } from "../spec/schema";

const SCHEMA = process.env.SUPABASE_SCHEMA ?? "cinatra";
const ORG = "test-org-tmplget";
const OTHER_ORG = "test-org-tmplget-other";
const USER = "user-tmplget";

const handlers = createWorkflowPrimitiveHandlers({ approverResolvable: () => true });
const req = (input: unknown, orgId: string) => ({
  primitiveName: "workflow_template_get",
  input: input as Record<string, unknown>,
  actor: { orgId, userId: USER },
  mode: "agentic" as const,
});

const definition: WorkflowSpec = {
  name: "Blog Publish",
  placeholders: { wordpressInstanceId: { type: "string", required: true } },
  metadata: { placeholderHints: { wordpressInstanceId: { kind: "wordpress-instance" } } },
  tasks: [{ key: "a", type: "checkpoint", title: "Review" }],
};

let templateId: string;

beforeAll(async () => {
  const c = new Client({ connectionString: process.env.SUPABASE_DB_URL });
  await c.connect();
  for (const q of buildCreateStoreSchemaQueries(SCHEMA)) await c.query(q.text);
  await c.query(`DROP INDEX IF EXISTS "${SCHEMA}"."workflow_template_key_version_uniq"`);
  await c.query(`DELETE FROM "${SCHEMA}"."workflow_template" WHERE org_id IN ($1,$2)`, [ORG, OTHER_ORG]);
  await c.end();
  const row = await createWorkflowTemplate({
    key: "blog-publish", version: 1, name: "Blog Publish", definition,
    orgId: ORG, ownerLevel: "organization", ownerId: ORG, createdBy: USER,
  });
  templateId = row.id;
}, 60_000);

describe("workflow_template_get (PORT-08 / BCW)", () => {
  it("returns placeholders + metadata for a readable template", async () => {
    const res = (await handlers.workflow_template_get(req({ templateId }, ORG))) as Record<string, unknown>;
    expect(res.error).toBeUndefined();
    expect(res.id).toBe(templateId);
    expect(res.key).toBe("blog-publish");
    expect(res.placeholders).toEqual({ wordpressInstanceId: { type: "string", required: true } });
    expect(res.metadata).toEqual({ placeholderHints: { wordpressInstanceId: { kind: "wordpress-instance" } } });
  });

  it("DENY: an actor in another org gets the hidden NOT_FOUND envelope (no payload leak)", async () => {
    const res = (await handlers.workflow_template_get(req({ templateId }, OTHER_ORG))) as Record<string, unknown>;
    expect(res.code).toBe("NOT_FOUND");
    expect(res.id).toBeUndefined();
    expect(res.placeholders).toBeUndefined();
  });

  it("missing templateId errors; truly-missing id returns the same NOT_FOUND", async () => {
    expect((await handlers.workflow_template_get(req({}, ORG)) as Record<string, unknown>).error).toBeTruthy();
    const missing = (await handlers.workflow_template_get(req({ templateId: "wft_absent" }, ORG))) as Record<string, unknown>;
    expect(missing.code).toBe("NOT_FOUND");
  });
});
