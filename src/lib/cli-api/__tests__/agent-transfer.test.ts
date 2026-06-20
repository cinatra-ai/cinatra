import { beforeEach, describe, expect, it, vi } from "vitest";

// We exercise the REAL document<->DB mapping; only the pg pool's `query` is
// mocked so no live DB is needed. The assertions pin the CLI-compatible
// `agent.json` shape (formatVersion 1) and the import INSERT parameter shaping.

const queryMock = vi.fn();

vi.mock("@/lib/better-auth-db", () => ({
  betterAuthPool: { query: (...args: unknown[]) => queryMock(...args) },
}));

import {
  exportAgentTemplate,
  importAgentTemplate,
} from "../agent-transfer";

const ORIGINAL_ENV = { ...process.env };

describe("agent-transfer", () => {
  beforeEach(() => {
    queryMock.mockReset();
    process.env = { ...ORIGINAL_ENV };
    delete process.env.SUPABASE_SCHEMA;
  });

  describe("exportAgentTemplate", () => {
    it("returns null when no template matches", async () => {
      queryMock.mockResolvedValue({ rows: [] });
      const result = await exportAgentTemplate("missing");
      expect(result).toBeNull();
      // Tried by id, then by name.
      expect(queryMock).toHaveBeenCalledTimes(2);
    });

    it("maps a row into the formatVersion-1 document, parsing JSON-string columns", async () => {
      queryMock.mockResolvedValueOnce({
        rows: [
          {
            id: "agent-1",
            name: "My Agent",
            description: "desc",
            source_nl: "do a thing",
            execution_mode: "deterministic",
            compiled_plan: JSON.stringify([{ step: 1 }]),
            input_schema: JSON.stringify({ type: "object" }),
            output_schema: null,
            approval_policy: JSON.stringify({ steps: [] }),
            task_spec: "spec",
            status: "draft",
          },
        ],
      });

      const result = await exportAgentTemplate("agent-1");
      expect(result).not.toBeNull();
      const { document, manifest } = result!;
      expect(document.formatVersion).toBe(1);
      expect(document.id).toBe("agent-1");
      expect(document.name).toBe("My Agent");
      // JSON-string columns are parsed into structured values, never double-encoded.
      expect(document.compiledPlan).toEqual([{ step: 1 }]);
      expect(document.inputSchema).toEqual({ type: "object" });
      expect(document.outputSchema).toBeNull();
      expect(typeof document.exportedAt).toBe("string");
      expect(manifest).toEqual({
        version: 1,
        exportedAt: document.exportedAt,
        cinatra: "agent-builder-v1",
      });
    });

    it("falls back to a case-insensitive name match", async () => {
      queryMock
        .mockResolvedValueOnce({ rows: [] }) // by id: miss
        .mockResolvedValueOnce({
          rows: [
            {
              id: "agent-2",
              name: "Named",
              description: null,
              source_nl: null,
              execution_mode: null,
              compiled_plan: "[]",
              input_schema: "{}",
              output_schema: null,
              approval_policy: "{}",
              task_spec: null,
              status: null,
            },
          ],
        });
      const result = await exportAgentTemplate("named");
      expect(result?.document.id).toBe("agent-2");
      // Defaults applied for null columns.
      expect(result?.document.sourceNl).toBe("");
      expect(result?.document.executionMode).toBe("deterministic");
      expect(result?.document.status).toBe("draft");
    });
  });

  describe("importAgentTemplate", () => {
    it("rejects a non-formatVersion-1 document", async () => {
      await expect(importAgentTemplate({ formatVersion: 2 })).rejects.toThrow(
        /Unsupported agent.json formatVersion: 2/,
      );
      await expect(importAgentTemplate(null)).rejects.toThrow(
        /Unsupported agent.json formatVersion/,
      );
      expect(queryMock).not.toHaveBeenCalled();
    });

    it("inserts a new draft template + version row matching the current schema", async () => {
      queryMock.mockResolvedValue({ rows: [] });
      const doc = {
        formatVersion: 1,
        name: "Imported",
        description: "d",
        sourceNl: "nl",
        executionMode: "deterministic", // vestigial archive field — must NOT be written
        compiledPlan: [{ a: 1 }],
        inputSchema: { x: true },
        outputSchema: null,
        approvalPolicy: { steps: [] },
        taskSpec: "t",
        status: "draft",
      };
      const result = await importAgentTemplate(doc);
      expect(result.name).toBe("Imported");
      expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
      // A routeable, unique package_name is generated (NOT NULL col). Must
      // match the strict @vendor/slug regex the runtime enforces.
      expect(result.packageName).toMatch(/^@cli-import\/imported-[0-9a-f-]{36}$/);
      expect(result.packageName).toMatch(
        /^@([a-z0-9][a-z0-9-]*)\/([a-z0-9][a-z0-9-]*)$/,
      );

      // First call inserts the template; second inserts the version.
      expect(queryMock).toHaveBeenCalledTimes(2);
      const insertTemplate = queryMock.mock.calls[0];
      const sql = String(insertTemplate[0]);
      expect(sql).toMatch(/INSERT INTO .*agent_templates/);
      // execution_mode column was DROPPED — it must not appear in the INSERT.
      expect(sql).not.toMatch(/execution_mode/);
      // package_name is supplied (NOT NULL).
      expect(sql).toMatch(/package_name/);

      const params = insertTemplate[1] as unknown[];
      expect(params[1]).toBe("Imported"); // name
      // compiledPlan / inputSchema serialized to stored string form.
      expect(params[4]).toBe(JSON.stringify([{ a: 1 }]));
      expect(params[5]).toBe(JSON.stringify({ x: true }));
      // package_name param equals the returned identity.
      expect(params).toContain(result.packageName);

      const insertVersion = queryMock.mock.calls[1];
      expect(String(insertVersion[0])).toMatch(/INSERT INTO .*agent_versions/);
    });

    it("applies a name override", async () => {
      queryMock.mockResolvedValue({ rows: [] });
      const result = await importAgentTemplate(
        { formatVersion: 1, name: "Original" },
        { nameOverride: "Override" },
      );
      expect(result.name).toBe("Override");
    });

    it("never updates or deletes — only INSERTs", async () => {
      queryMock.mockResolvedValue({ rows: [] });
      await importAgentTemplate({ formatVersion: 1, name: "X" });
      for (const call of queryMock.mock.calls) {
        const sql = String(call[0]).toUpperCase();
        expect(sql).not.toMatch(/\bUPDATE\b/);
        expect(sql).not.toMatch(/\bDELETE\b/);
      }
    });
  });
});
