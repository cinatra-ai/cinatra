import { describe, expect, it } from "vitest";

import { loadDevContentManifest } from "../fixtures/lib/dev-content-manifest.mjs";
import {
  buildCompanyArgs,
  buildPersonArgs,
  comparableChecksum,
  extractRecordId,
  extractRecordsArray,
  findByCinatraObjectId,
  findViewByName,
  parseToolJson,
  seedTwentyContent,
} from "../fixtures/seed-twenty-content.mjs";

const uuid = (n) => `1111111${n}-1111-4111-8111-111111111111`;
const textResult = (obj) => ({ content: [{ type: "text", text: JSON.stringify(obj) }] });

describe("twenty seeder pure helpers", () => {
  it("parseToolJson reads structuredContent and text JSON", () => {
    expect(parseToolJson({ structuredContent: { a: 1 } })).toEqual({ a: 1 });
    expect(parseToolJson(textResult({ b: 2 }))).toEqual({ b: 2 });
    expect(parseToolJson({ content: [{ type: "text", text: "not json" }] })).toBeNull();
  });

  it("extractRecordId finds ids across shapes", () => {
    expect(extractRecordId({ structuredContent: { id: uuid(1) } })).toBe(uuid(1));
    expect(extractRecordId({ structuredContent: { company: { id: uuid(2) } } })).toBe(uuid(2));
    expect(extractRecordId(textResult({ id: uuid(3) }))).toBe(uuid(3));
  });

  it("extractRecordsArray normalizes find payloads", () => {
    expect(extractRecordsArray({ companies: [{ id: "x" }] })).toHaveLength(1);
    expect(extractRecordsArray([{ id: "y" }])).toHaveLength(1);
    expect(extractRecordsArray({ records: { edges: [{ node: { id: "z" } }] } })).toEqual([{ id: "z" }]);
    expect(extractRecordsArray(null)).toEqual([]);
  });

  it("findByCinatraObjectId matches top-level and nested markers", () => {
    expect(findByCinatraObjectId([{ cinatraObjectId: "fx-1" }], "fx-1")).toBeTruthy();
    expect(findByCinatraObjectId([{ deep: { cinatraObjectId: "fx-2" } }], "fx-2")).toBeTruthy();
    expect(findByCinatraObjectId([{ cinatraObjectId: "other" }], "fx-3")).toBeNull();
  });

  it("findViewByName is case-insensitive", () => {
    expect(findViewByName([{ name: "Demo Companies" }], "demo companies")).toBeTruthy();
    expect(findViewByName([{ name: "Other" }], "Demo companies")).toBeNull();
  });

  it("buildCompanyArgs/buildPersonArgs tier required/safe/risky correctly", () => {
    const c = buildCompanyArgs({ fixtureId: "fx-co", name: "Acme", employees: 10, domainName: "acme.example" });
    expect(c.required).toEqual({ name: "Acme", cinatraObjectId: "fx-co" });
    expect(c.safe).toEqual({ employees: 10 });
    expect(c.risky.domainName.primaryLinkUrl).toBe("https://acme.example");

    const p = buildPersonArgs({ fixtureId: "fx-pe", firstName: "A", lastName: "B", jobTitle: "Lead", email: "a@x.example" }, uuid(9));
    expect(p.required.cinatraObjectId).toBe("fx-pe");
    expect(p.required.name).toEqual({ firstName: "A", lastName: "B" });
    expect(p.safe).toEqual({ jobTitle: "Lead", companyId: uuid(9) });
    expect(p.risky.emails.primaryEmail).toBe("a@x.example");
  });
});

// A fake Twenty MCP client. Records every execute_tool call and returns canned
// results keyed by the inner toolName.
function makeFakeClient(handlers) {
  const calls = [];
  return {
    calls,
    async mcpToolsCall(name, args) {
      if (name !== "execute_tool") throw new Error(`unexpected MCP method ${name}`);
      const { toolName, arguments: toolArgs } = args;
      calls.push({ toolName, args: toolArgs });
      const handler = handlers[toolName];
      if (!handler) throw new Error(`no fake handler for ${toolName}`);
      return handler(toolArgs);
    },
  };
}

const META = new Map([
  ["company", "mc"],
  ["person", "mp"],
  ["opportunity", "mo"],
]);
const CATALOG = [
  "create_company",
  "update_company",
  "create_person",
  "update_person",
  "find_companies",
  "find_people",
  "get_views",
  "create_view",
  "update_view",
];

describe("seedTwentyContent orchestrator (fake client)", () => {
  const manifest = loadDevContentManifest();

  it("creates absent records/views and skips present ones (no provenance, first run)", async () => {
    const firstCompanyId = manifest.twenty.companies[0].fixtureId;
    const firstPersonId = manifest.twenty.people[0].fixtureId;
    const firstViewName = manifest.twenty.views[0].name;

    const client = makeFakeClient({
      find_companies: () => textResult({ companies: [{ id: uuid(1), cinatraObjectId: firstCompanyId }] }),
      find_people: () => textResult({ people: [{ id: uuid(2), cinatraObjectId: firstPersonId }] }),
      get_views: (args) => {
        expect(args).toEqual({}); // proven shape — never { limit }
        return textResult({ views: [{ id: uuid(3), name: firstViewName }] });
      },
      create_company: () => ({ structuredContent: { id: uuid(4) } }),
      create_person: () => ({ structuredContent: { id: uuid(5) } }),
      create_view: () => ({ structuredContent: { id: uuid(6) } }),
    });

    const provenance = {};
    const summary = await seedTwentyContent({ client, manifest, catalogToolNames: CATALOG, objectMetadataIds: META, provenance });

    expect(summary.companies).toEqual({ created: manifest.twenty.companies.length - 1, replaced: 0, skipped: 1, error: 0 });
    expect(summary.people).toEqual({ created: manifest.twenty.people.length - 1, replaced: 0, skipped: 1, error: 0 });
    expect(summary.views).toEqual({ created: manifest.twenty.views.length - 1, replaced: 0, skipped: 1, error: 0 });

    // Provenance is populated for every fixture (created + matched).
    expect(Object.keys(provenance).length).toBe(
      manifest.twenty.companies.length + manifest.twenty.people.length + manifest.twenty.views.length,
    );
    const created = client.calls.find((c) => c.toolName === "create_company");
    expect(created.args.cinatraObjectId).toBeTruthy();
    const createdView = client.calls.find((c) => c.toolName === "create_view");
    expect(["mc", "mp", "mo"]).toContain(createdView.args.objectMetadataId);
    expect(createdView.args.type).toBe("table");
  });

  it("is idempotent on re-run with provenance at the current rev (skip-all, no writes)", async () => {
    const calls = [];
    // Provenance for every fixture at the manifest rev; existing lists echo them.
    const provenance = {};
    const companies = [];
    const people = [];
    const views = [];
    manifest.twenty.companies.forEach((c, i) => { provenance[c.fixtureId] = { id: uuid(1), rev: manifest.version }; companies.push({ id: uuid(1) }); });
    manifest.twenty.people.forEach((p) => { provenance[p.fixtureId] = { id: uuid(2), rev: manifest.version }; people.push({ id: uuid(2) }); });
    manifest.twenty.views.forEach((v) => { provenance[v.fixtureId] = { id: uuid(3), rev: manifest.version }; views.push({ id: uuid(3), name: "renamed-by-user" }); });

    const client = makeFakeClient({
      find_companies: () => textResult({ companies }),
      find_people: () => textResult({ people }),
      get_views: () => textResult({ views }),
      // any create/update would be a bug:
      create_company: () => { throw new Error("must not create"); },
      update_company: () => { throw new Error("must not update"); },
      create_view: () => { throw new Error("must not create view"); },
      update_view: () => { throw new Error("must not update view"); },
    });

    const summary = await seedTwentyContent({ client, manifest, catalogToolNames: CATALOG, objectMetadataIds: META, provenance });
    expect(summary.companies).toEqual({ created: 0, replaced: 0, skipped: manifest.twenty.companies.length, error: 0 });
    expect(summary.people).toEqual({ created: 0, replaced: 0, skipped: manifest.twenty.people.length, error: 0 });
    // A view the user RENAMED is matched by stored id, not name → still skipped, not duplicated.
    expect(summary.views).toEqual({ created: 0, replaced: 0, skipped: manifest.twenty.views.length, error: 0 });
  });

  it("respects a user delete (provenance id, record gone) — never recreates", async () => {
    const company = manifest.twenty.companies[0];
    const provenance = { [company.fixtureId]: { id: uuid(7), rev: manifest.version } };
    const client = makeFakeClient({
      find_companies: () => textResult({ companies: [] }), // the seeded record is gone
      find_people: () => textResult({ people: [] }),
      get_views: () => textResult({ views: [] }),
      create_company: () => { throw new Error("must not recreate a user-deleted fixture"); },
    });
    const single = { version: manifest.version, twenty: { companies: [company], people: [], views: [] } };
    const summary = await seedTwentyContent({ client, manifest: single, catalogToolNames: CATALOG, objectMetadataIds: META, provenance });
    expect(summary.companies).toEqual({ created: 0, replaced: 0, skipped: 1, error: 0 });
  });

  it("replaces a still-fixture-owned record when the manifest rev advances", async () => {
    const company = manifest.twenty.companies[0];
    // Last applied an OLD name; live row still has it (untouched by the user).
    const provenance = {
      [company.fixtureId]: { id: uuid(7), rev: 1, checksum: comparableChecksum("company", { name: "Old Seeded Name" }) },
    };
    let updated = null;
    const client = makeFakeClient({
      find_companies: () => textResult({ companies: [{ id: uuid(7), name: "Old Seeded Name", cinatraObjectId: company.fixtureId }] }),
      find_people: () => textResult({ people: [] }),
      get_views: () => textResult({ views: [] }),
      update_company: (args) => { updated = args; return { structuredContent: { id: uuid(7) } }; },
      create_company: () => { throw new Error("must update, not create"); },
    });
    const bumped = { version: 2, twenty: { companies: [company], people: [], views: [] } };
    const summary = await seedTwentyContent({ client, manifest: bumped, catalogToolNames: CATALOG, objectMetadataIds: META, provenance });
    expect(summary.companies).toEqual({ created: 0, replaced: 1, skipped: 0, error: 0 });
    expect(updated.id).toBe(uuid(7));
    expect(provenance[company.fixtureId].rev).toBe(2);
    expect(provenance[company.fixtureId].checksum).toBe(comparableChecksum("company", company));
  });

  it("fails CLOSED on a legacy {id,rev} sidecar (no checksum) — never updates", async () => {
    // r1-era provenance had no checksum; on a rev bump it must not clobber the row.
    const company = manifest.twenty.companies[0];
    const view = manifest.twenty.views[0];
    const provenance = {
      [company.fixtureId]: { id: uuid(7), rev: 1 },
      [view.fixtureId]: { id: uuid(8), rev: 1 },
    };
    const client = makeFakeClient({
      find_companies: () => textResult({ companies: [{ id: uuid(7), name: "Whatever", cinatraObjectId: company.fixtureId }] }),
      find_people: () => textResult({ people: [] }),
      get_views: () => textResult({ views: [{ id: uuid(8), name: "Whatever View" }] }),
      update_company: () => { throw new Error("must NOT update a legacy (unverifiable) row"); },
      update_view: () => { throw new Error("must NOT update a legacy (unverifiable) view"); },
      create_company: () => { throw new Error("must NOT create"); },
      create_view: () => { throw new Error("must NOT create"); },
    });
    const bumped = { version: 2, twenty: { companies: [company], people: [], views: [view] } };
    const summary = await seedTwentyContent({ client, manifest: bumped, catalogToolNames: CATALOG, objectMetadataIds: META, provenance });
    expect(summary.companies).toEqual({ created: 0, replaced: 0, skipped: 1, error: 0 });
    expect(summary.views).toEqual({ created: 0, replaced: 0, skipped: 1, error: 0 });
  });

  it("PRESERVES a user edit on a version bump (does not clobber)", async () => {
    const company = manifest.twenty.companies[0];
    // We last seeded one name; the user has since renamed the row.
    const provenance = {
      [company.fixtureId]: { id: uuid(7), rev: 1, checksum: comparableChecksum("company", { name: "Seeded Name" }) },
    };
    const client = makeFakeClient({
      find_companies: () => textResult({ companies: [{ id: uuid(7), name: "User Renamed Co", cinatraObjectId: company.fixtureId }] }),
      find_people: () => textResult({ people: [] }),
      get_views: () => textResult({ views: [] }),
      update_company: () => { throw new Error("must NOT clobber a user edit"); },
      create_company: () => { throw new Error("must NOT create"); },
    });
    const bumped = { version: 2, twenty: { companies: [company], people: [], views: [] } };
    const summary = await seedTwentyContent({ client, manifest: bumped, catalogToolNames: CATALOG, objectMetadataIds: META, provenance });
    expect(summary.companies).toEqual({ created: 0, replaced: 0, skipped: 1, error: 0 });
  });

  it("fails CLOSED — skips creation when the existing-records lookup errors", async () => {
    const company = manifest.twenty.companies[0];
    const client = makeFakeClient({
      find_companies: () => { throw new Error("upstream 500"); },
      find_people: () => textResult({ people: [] }),
      get_views: () => textResult({ views: [] }),
      create_company: () => { throw new Error("must not create when existence is unknown"); },
    });
    const single = { version: manifest.version, twenty: { companies: [company], people: [], views: [] } };
    const summary = await seedTwentyContent({ client, manifest: single, catalogToolNames: CATALOG, objectMetadataIds: META, provenance: {} });
    expect(summary.companies).toEqual({ created: 0, replaced: 0, skipped: 1, error: 0 });
    // The lookup failure is surfaced so the caller knows the surface is unverified.
    expect(summary.listOk.companies).toBe(false);
  });

  it("surfaces listOk.views=false when get_views fails (so the run is not reported as ensured)", async () => {
    const view = manifest.twenty.views[0];
    const client = makeFakeClient({
      find_companies: () => textResult({ companies: [] }),
      find_people: () => textResult({ people: [] }),
      get_views: () => { throw new Error("get_views upstream 500"); },
      create_view: () => { throw new Error("must not create when existence is unknown"); },
    });
    const single = { version: manifest.version, twenty: { companies: [], people: [], views: [view] } };
    const summary = await seedTwentyContent({ client, manifest: single, catalogToolNames: CATALOG, objectMetadataIds: META, provenance: {} });
    expect(summary.views).toEqual({ created: 0, replaced: 0, skipped: 1, error: 0 });
    expect(summary.listOk.views).toBe(false);
  });

  it("retries company create without composite fields when the tool rejects them", async () => {
    let attempts = 0;
    const client = makeFakeClient({
      find_companies: () => textResult({ companies: [] }),
      find_people: () => textResult({ people: [] }),
      get_views: () => textResult({ views: [] }),
      create_company: (args) => {
        attempts++;
        if ("domainName" in args) throw new Error("Unknown field domainName");
        return { structuredContent: { id: uuid(4) } };
      },
    });
    const oneCompany = { version: 1, twenty: { companies: [manifest.twenty.companies[0]], people: [], views: [] } };
    const summary = await seedTwentyContent({ client, manifest: oneCompany, catalogToolNames: CATALOG, objectMetadataIds: META, provenance: {} });
    expect(summary.companies).toEqual({ created: 1, replaced: 0, skipped: 0, error: 0 });
    expect(attempts).toBe(2);
    const retried = client.calls.filter((c) => c.toolName === "create_company").pop();
    expect("domainName" in retried.args).toBe(false);
    expect(retried.args.cinatraObjectId).toBe(manifest.twenty.companies[0].fixtureId);
  });
});
