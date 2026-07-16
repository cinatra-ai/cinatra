// Unit tests for the built-in assistant-agent template store helpers
// (cinatra#1037 P1.3): upsertBuiltInAssistantAgentTemplate +
// readAssistantConfigByPrincipalId. The `./db` drizzle handle is mocked; the
// tests pin the emitted SQL shape (the interaction-axis columns, the 1:1 link,
// the deliberately-NULL package identity, ON CONFLICT idempotency) and the
// read's principal + kind filter — the live DDL behaviour is covered by the
// DB-guarded schema suite + the migration contract test.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const mocks = vi.hoisted(() => ({
  execute: vi.fn(),
  select: vi.fn(),
}));

vi.mock("../db", () => ({
  db: { execute: mocks.execute, select: mocks.select },
  agentBuilderPool: {},
}));

import {
  upsertBuiltInAssistantAgentTemplate,
  readAssistantConfigByPrincipalId,
  BUILT_IN_CINATRA_ASSISTANT_TEMPLATE_ID,
} from "../store";

const dialect = new PgDialect();

beforeEach(() => vi.clearAllMocks());

describe("upsertBuiltInAssistantAgentTemplate", () => {
  it("emits an assistant-kind, principal-linked, PRIVATE-origin draft upsert idempotent on id", async () => {
    mocks.execute.mockResolvedValue({ rows: [] });
    const id = await upsertBuiltInAssistantAgentTemplate({
      assistantUserId: "principal-9",
      name: "Cinatra",
      assistantConfigJson: '{"persona":"p","skillBundle":["chat-assistant-core"]}',
    });
    expect(id).toBe(BUILT_IN_CINATRA_ASSISTANT_TEMPLATE_ID);
    expect(mocks.execute).toHaveBeenCalledTimes(1);

    const { sql, params } = dialect.sqlToQuery(mocks.execute.mock.calls[0][0] as SQL);
    const lower = sql.toLowerCase();
    expect(lower).toContain('insert into');
    expect(lower).toContain('agent_templates');
    // interaction axis + link columns set.
    expect(sql).toContain("agent_kind");
    expect(sql).toContain("assistant_config");
    expect(sql).toContain("assistant_user_id");
    expect(sql).toContain("'assistant'");
    // package_name is NOT NULL on the table — a reserved identity IS written, but
    // with a PRIVATE origin + 'draft' status so it never surfaces as a marketplace
    // or published extension (kept out of the origin grandfather backfill too).
    expect(sql).toContain("package_name");
    expect(params).toContain("@cinatra-ai/cinatra-assistant");
    expect(sql).toContain("'draft'");
    expect(params.some((p) => typeof p === "string" && p.includes('"visibility":"private"'))).toBe(true);
    // idempotent on the fixed id; re-links principal + config on conflict.
    expect(lower).toContain("on conflict (id) do update");
    expect(lower).toContain("assistant_user_id = excluded.assistant_user_id");
    // the principal + config ride as bound params (never interpolated).
    expect(params).toContain("principal-9");
    expect(params).toContain('{"persona":"p","skillBundle":["chat-assistant-core"]}');
  });
});

describe("readAssistantConfigByPrincipalId", () => {
  function chain(rows: Array<{ assistantConfig: string | null }>) {
    const whereCall = vi.fn();
    const limit = vi.fn().mockResolvedValue(rows);
    const where = vi.fn((clause: unknown) => {
      whereCall(clause);
      return { limit };
    });
    const from = vi.fn(() => ({ where }));
    mocks.select.mockReturnValue({ from });
    return { where, limit };
  }

  it("returns the linked assistant sidecar for a principal", async () => {
    chain([{ assistantConfig: '{"persona":"p","skillBundle":["x"]}' }]);
    const out = await readAssistantConfigByPrincipalId("principal-9");
    expect(out).toBe('{"persona":"p","skillBundle":["x"]}');
  });

  it("returns null when no assistant template is linked to the principal", async () => {
    chain([]);
    const out = await readAssistantConfigByPrincipalId("nobody");
    expect(out).toBeNull();
  });

  it("filters on the principal link (the where clause renders both the id + kind predicates)", async () => {
    const { where } = chain([{ assistantConfig: null }]);
    await readAssistantConfigByPrincipalId("principal-9");
    const rendered = dialect.sqlToQuery(where.mock.calls[0][0] as SQL);
    const lower = rendered.sql.toLowerCase();
    expect(lower).toContain("assistant_user_id");
    expect(lower).toContain("agent_kind");
    expect(rendered.params).toContain("principal-9");
    expect(rendered.params).toContain("assistant");
  });
});
