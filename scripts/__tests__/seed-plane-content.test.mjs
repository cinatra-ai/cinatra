import { describe, expect, it } from "vitest";

import { loadDevContentManifest } from "../fixtures/lib/dev-content-manifest.mjs";
import {
  buildWorkItemArgs,
  comparableChecksum,
  extractRecordId,
  extractRecordsArray,
  findWorkItemByName,
  parseToolJson,
  resolveProjectId,
  seedPlaneContent,
} from "../fixtures/seed-plane-content.mjs";

const textResult = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });
const PROJECT_ID = "proj-0000";

describe("plane seeder pure helpers", () => {
  it("parseToolJson reads structuredContent and text JSON", () => {
    expect(parseToolJson({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
    expect(parseToolJson(textResult({ b: 2 }))).toEqual({ b: 2 });
    expect(parseToolJson({ content: [{ type: "text", text: "not json" }] })).toBeNull();
  });

  it("extractRecordId finds ids across shapes", () => {
    expect(extractRecordId({ structuredContent: { id: "w1" } })).toBe("w1");
    expect(extractRecordId({ structuredContent: { work_item: { id: "w2" } } })).toBe("w2");
    expect(extractRecordId(textResult({ issue: { id: "w3" } }))).toBe("w3");
    expect(extractRecordId({ structuredContent: {} })).toBeNull();
  });

  it("extractRecordsArray normalizes Plane list payloads", () => {
    expect(extractRecordsArray({ projects: [{ id: "p" }] })).toHaveLength(1);
    expect(extractRecordsArray({ work_items: [{ id: "w" }] })).toHaveLength(1);
    expect(extractRecordsArray({ results: [{ id: "r" }] })).toEqual([{ id: "r" }]);
    expect(extractRecordsArray([{ id: "a" }])).toHaveLength(1);
    expect(extractRecordsArray(null)).toEqual([]);
  });

  it("resolveProjectId matches by identifier (case-insensitive) then name", () => {
    const projects = [
      { id: "p1", identifier: "OTHER", name: "Other" },
      { id: "p2", identifier: "DEMO", name: "Demo Delivery" },
    ];
    expect(resolveProjectId(projects, { identifier: "demo", name: "x" })).toBe("p2");
    // No identifier match → fall back to name.
    expect(resolveProjectId([{ id: "p3", name: "Demo Delivery" }], { identifier: "ZZZ", name: "Demo Delivery" })).toBe("p3");
    // Neither → null (caller fails closed).
    expect(resolveProjectId(projects, { identifier: "NOPE", name: "Nope" })).toBeNull();
  });

  it("findWorkItemByName is case-insensitive", () => {
    expect(findWorkItemByName([{ name: "Set up" }], "set up")).toBeTruthy();
    expect(findWorkItemByName([{ name: "Other" }], "Set up")).toBeNull();
  });

  it("buildWorkItemArgs tiers required/safe/risky correctly", () => {
    const a = buildWorkItemArgs({ name: "T", priority: "high", description: "D" }, PROJECT_ID);
    expect(a.required).toEqual({ project_id: PROJECT_ID, name: "T" });
    expect(a.safe).toEqual({ priority: "high" });
    expect(a.risky).toEqual({ description: "D" });
    // No description → no risky field.
    expect(buildWorkItemArgs({ name: "T" }, PROJECT_ID).risky).toEqual({});
  });
});

// A fake Plane MCP client. Records every DIRECT-NAMED tool call (there is NO
// execute_tool envelope) and returns canned results keyed by the tool name.
function makeFakeClient(handlers) {
  const calls = [];
  return {
    calls,
    async callTool(toolName, args) {
      calls.push({ toolName, args });
      const handler = handlers[toolName];
      if (!handler) throw new Error(`no fake handler for ${toolName}`);
      return handler(args);
    },
  };
}

describe("seedPlaneContent orchestrator (fake client)", () => {
  const manifest = loadDevContentManifest();
  const items = manifest.plane.workItems;
  const project = manifest.plane.project;

  const projectsResult = () =>
    textResult({ projects: [{ id: PROJECT_ID, identifier: project.identifier, name: project.name }] });

  it("fails CLOSED when the target project is absent (never creates a project or a work item)", async () => {
    const client = makeFakeClient({
      list_projects: () => textResult({ projects: [{ id: "p9", identifier: "UNRELATED", name: "Unrelated" }] }),
    });
    const summary = await seedPlaneContent({ client, manifest, provenance: {} });
    expect(summary.project.resolved).toBe(false);
    expect(summary.project.reason).toMatch(/not found/);
    expect(summary.workItems).toEqual({ created: 0, replaced: 0, skipped: 0, error: 0 });
    // Only list_projects was ever called — no list_work_items, no create_work_item.
    expect(client.calls.every((c) => c.toolName === "list_projects")).toBe(true);
  });

  it("creates absent work items and skips a present one (no provenance, first run)", async () => {
    const firstName = items[0].name;
    let created = 0;
    const client = makeFakeClient({
      list_projects: projectsResult,
      list_work_items: (args) => {
        expect(args).toEqual({ project_id: PROJECT_ID });
        return textResult({ work_items: [{ id: "w-existing", name: firstName }] });
      },
      create_work_item: (args) => {
        expect(args.project_id).toBe(PROJECT_ID);
        return { structuredContent: { id: `w-new-${created++}` } };
      },
    });

    const provenance = {};
    const summary = await seedPlaneContent({ client, manifest, provenance });
    expect(summary.project.resolved).toBe(true);
    expect(summary.workItems).toEqual({ created: items.length - 1, replaced: 0, skipped: 1, error: 0 });
    // Provenance populated for every fixture (created + name-matched).
    expect(Object.keys(provenance).length).toBe(items.length);
  });

  it("is idempotent — a second run with the same provenance writes nothing", async () => {
    const client = makeFakeClient({
      list_projects: projectsResult,
      // All fixtures already present, matched by the provenance id.
      list_work_items: () =>
        textResult({ work_items: items.map((it, i) => ({ id: `w${i}`, name: it.name, priority: it.priority, description: it.description })) }),
      create_work_item: () => {
        throw new Error("must not create on a converged run");
      },
    });
    const provenance = {};
    for (const [i, it] of items.entries()) {
      provenance[it.fixtureId] = { id: `w${i}`, rev: manifest.version, checksum: comparableChecksum(it) };
    }
    const summary = await seedPlaneContent({ client, manifest, provenance });
    expect(summary.workItems).toEqual({ created: 0, replaced: 0, skipped: items.length, error: 0 });
    expect(client.calls.some((c) => c.toolName === "create_work_item")).toBe(false);
  });

  it("replaces a still-fixture-owned row on a version bump, but SKIPS a user-edited one", async () => {
    // Live rows: item[0] is untouched (matches its checksum) → REPLACE on bump;
    // item[1] was renamed by the user (checksum diverges) → SKIP (never clobber).
    const live = items.map((it, i) => ({
      id: `w${i}`,
      name: i === 1 ? "User renamed this" : it.name,
      priority: it.priority,
      description: it.description,
    }));
    let replaced = 0;
    const client = makeFakeClient({
      list_projects: projectsResult,
      list_work_items: () => textResult({ work_items: live }),
      update_work_item: (args) => {
        expect(args.id).toBe("w0");
        replaced++;
        return { structuredContent: { id: "w0" } };
      },
    });
    const provenance = {};
    for (const [i, it] of items.entries()) {
      // Provenance recorded at the OLD manifest rev, checksum of the ORIGINAL content.
      provenance[it.fixtureId] = { id: `w${i}`, rev: manifest.version - 1, checksum: comparableChecksum(it) };
    }
    // Bump the manifest version AND mutate item[0]'s content so a real replace is warranted.
    const bumped = structuredClone(manifest);
    bumped.version = manifest.version + 1;
    bumped.plane.workItems[0].name = `${items[0].name} (updated)`;

    const summary = await seedPlaneContent({ client, manifest: bumped, provenance });
    expect(replaced).toBe(1);
    expect(summary.workItems.replaced).toBe(1);
    // item[1] user-edited → skipped, never updated.
    expect(client.calls.filter((c) => c.toolName === "update_work_item")).toHaveLength(1);
  });

  it("fail-closed on a list_work_items error — skips creates to avoid duplicates", async () => {
    const client = makeFakeClient({
      list_projects: projectsResult,
      list_work_items: () => ({ isError: true, content: [{ type: "text", text: "boom" }] }),
      create_work_item: () => {
        throw new Error("must not create when listing failed");
      },
    });
    const summary = await seedPlaneContent({ client, manifest, provenance: {} });
    expect(summary.project.resolved).toBe(true);
    expect(summary.listOk).toBe(false);
    expect(summary.workItems).toEqual({ created: 0, replaced: 0, skipped: items.length, error: 0 });
  });
});
