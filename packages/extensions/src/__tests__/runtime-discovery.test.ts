import { describe, it, expect, vi } from "vitest";
import type { ActiveExtensionManifest, ExtensionTypeHandler } from "@cinatra-ai/extension-types";
import {
  discoverActiveCapabilities,
  discoverArchivedCapabilities,
  isDiscoverableStatus,
} from "../runtime-discovery";

function manifest(over: Partial<ActiveExtensionManifest> & Pick<ActiveExtensionManifest, "id" | "kind">): ActiveExtensionManifest {
  return {
    packageName: `@cinatra-ai/${over.id}`,
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    status: "active",
    ...over,
  };
}

function readerHandler(typeId: string, descriptorsByPkg: Record<string, unknown>): ExtensionTypeHandler {
  return {
    typeId,
    install: vi.fn(), update: vi.fn(), uninstall: vi.fn(), archive: vi.fn(), restore: vi.fn(),
    async listActive({ manifests }) {
      return manifests.map((m) => descriptorsByPkg[m.packageName]).filter((d) => d !== undefined);
    },
  };
}

const actor = { source: "route" } as never;
const scope = { userId: "u1", organizationId: null, teamIds: [] } as never;

describe("discoverActiveCapabilities", () => {
  it("groups active manifests by kind and dispatches to each kind reader", async () => {
    const manifests = [
      manifest({ id: "a1", kind: "agent" }),
      manifest({ id: "a2", kind: "agent" }),
      manifest({ id: "s1", kind: "skill" }),
    ];
    const handlers: Record<string, ExtensionTypeHandler> = {
      agent: readerHandler("agent", { "@cinatra-ai/a1": { t: "A1" }, "@cinatra-ai/a2": { t: "A2" } }),
      skill: readerHandler("skill", { "@cinatra-ai/s1": { t: "S1" } }),
    };
    const res = await discoverActiveCapabilities(
      { actor, scope },
      {
        readActiveManifests: async () => manifests,
        resolveHandler: (k) => handlers[k] ?? null,
      },
    );
    expect(res.byKind.agent).toEqual([{ t: "A1" }, { t: "A2" }]);
    expect(res.byKind.skill).toEqual([{ t: "S1" }]);
    expect(res.all).toHaveLength(3);
    expect(res.unmigratedKinds).toEqual([]);
  });

  it("NEVER passes a non-discoverable (uninstalled/archived) manifest to a reader — the split-brain guard", async () => {
    const seen: string[] = [];
    const handler: ExtensionTypeHandler = {
      typeId: "agent", install: vi.fn(), update: vi.fn(), uninstall: vi.fn(), archive: vi.fn(), restore: vi.fn(),
      async listActive({ manifests }) { manifests.forEach((m) => seen.push(m.id)); return manifests; },
    };
    const res = await discoverActiveCapabilities(
      { actor, scope },
      {
        // A leaky reader returns an archived row alongside active ones; the
        // dispatcher must filter it so a stale row can never be exposed.
        readActiveManifests: async () => [
          manifest({ id: "active1", kind: "agent", status: "active" }),
          manifest({ id: "locked1", kind: "agent", status: "locked" }),
          manifest({ id: "archived1", kind: "agent", status: "archived" }),
          manifest({ id: "uninstalled1", kind: "agent", status: "uninstalled" }),
        ],
        resolveHandler: () => handler,
      },
    );
    expect(seen.sort()).toEqual(["active1", "locked1"]);
    expect(res.byKind.agent).toHaveLength(2);
  });

  it("records kinds whose handler lacks the reader facet as unmigrated (no crash)", async () => {
    const legacyHandler: ExtensionTypeHandler = {
      typeId: "connector", install: vi.fn(), update: vi.fn(), uninstall: vi.fn(), archive: vi.fn(), restore: vi.fn(),
      // no listActive
    };
    const res = await discoverActiveCapabilities(
      { actor, scope },
      {
        readActiveManifests: async () => [manifest({ id: "c1", kind: "connector" })],
        resolveHandler: () => legacyHandler,
      },
    );
    expect(res.unmigratedKinds).toEqual(["connector"]);
    expect(res.all).toEqual([]);
  });

  it("NEVER routes a wrong-kind manifest to a reader when a kind is requested (the other split-brain guard)", async () => {
    const seen: string[] = [];
    const agentHandler: ExtensionTypeHandler = {
      typeId: "agent", install: vi.fn(), update: vi.fn(), uninstall: vi.fn(), archive: vi.fn(), restore: vi.fn(),
      async listActive({ manifests }) { manifests.forEach((m) => seen.push(`${m.kind}:${m.id}`)); return manifests; },
    };
    const res = await discoverActiveCapabilities(
      { actor, scope, kind: "agent" },
      {
        // A leaky reader returns a skill row even though kind="agent" was asked.
        readActiveManifests: async () => [
          manifest({ id: "a1", kind: "agent" }),
          manifest({ id: "s1", kind: "skill" }),
        ],
        resolveHandler: () => agentHandler,
      },
    );
    expect(seen).toEqual(["agent:a1"]);
    expect(res.byKind.agent).toHaveLength(1);
    expect(res.byKind.skill).toBeUndefined();
  });

  it("records an unknown kind (no registered handler) as unmigrated, never fatal", async () => {
    const res = await discoverActiveCapabilities(
      { actor, scope },
      {
        readActiveManifests: async () => [manifest({ id: "x1", kind: "mystery" })],
        resolveHandler: () => null,
      },
    );
    expect(res.unmigratedKinds).toEqual(["mystery"]);
  });

  it("isolates a throwing reader to its own kind via onError", async () => {
    const onError = vi.fn();
    const boom: ExtensionTypeHandler = {
      typeId: "skill", install: vi.fn(), update: vi.fn(), uninstall: vi.fn(), archive: vi.fn(), restore: vi.fn(),
      async listActive() { throw new Error("native store down"); },
    };
    const ok = readerHandler("agent", { "@cinatra-ai/a1": { t: "A1" } });
    const res = await discoverActiveCapabilities(
      { actor, scope },
      {
        readActiveManifests: async () => [manifest({ id: "a1", kind: "agent" }), manifest({ id: "s1", kind: "skill" })],
        resolveHandler: (k) => (k === "skill" ? boom : ok),
      },
      { onError },
    );
    expect(res.byKind.agent).toEqual([{ t: "A1" }]);
    expect(res.byKind.skill).toEqual([]);
    expect(onError).toHaveBeenCalledWith("skill", expect.any(Error));
  });

  it("isDiscoverableStatus only accepts active|locked", () => {
    expect(isDiscoverableStatus("active")).toBe(true);
    expect(isDiscoverableStatus("locked")).toBe(true);
    expect(isDiscoverableStatus("archived")).toBe(false);
    expect(isDiscoverableStatus("uninstalled")).toBe(false);
  });
});

// The archived twin (cinatra#948) mirrors the active dispatcher's guarantees
// over the `listArchived` reader facet.
describe("discoverArchivedCapabilities", () => {
  function archivedReaderHandler(typeId: string): ExtensionTypeHandler {
    return {
      typeId,
      install: vi.fn(), update: vi.fn(), uninstall: vi.fn(), archive: vi.fn(), restore: vi.fn(),
      async listArchived({ manifests }) {
        return manifests.map((m) => ({ archived: m.packageName }));
      },
    };
  }

  it("groups archived manifests by kind and dispatches to each kind's listArchived facet", async () => {
    const handlers: Record<string, ExtensionTypeHandler> = {
      agent: archivedReaderHandler("agent"),
      skill: archivedReaderHandler("skill"),
    };
    const res = await discoverArchivedCapabilities(
      { actor, scope },
      {
        readArchivedManifests: async () => [
          manifest({ id: "a1", kind: "agent", status: "archived" }),
          manifest({ id: "s1", kind: "skill", status: "archived" }),
        ],
        resolveHandler: (k) => handlers[k] ?? null,
      },
    );
    expect(res.byKind.agent).toEqual([{ archived: "@cinatra-ai/a1" }]);
    expect(res.byKind.skill).toEqual([{ archived: "@cinatra-ai/s1" }]);
    expect(res.unmigratedKinds).toEqual([]);
  });

  it("NEVER passes a live (or uninstalled) manifest to an archived reader — the defensive re-filter", async () => {
    const seen: string[] = [];
    const handler: ExtensionTypeHandler = {
      typeId: "agent", install: vi.fn(), update: vi.fn(), uninstall: vi.fn(), archive: vi.fn(), restore: vi.fn(),
      async listArchived({ manifests }) { manifests.forEach((m) => seen.push(m.id)); return manifests; },
    };
    await discoverArchivedCapabilities(
      { actor, scope },
      {
        // A leaky provider returns live rows alongside archived ones; the
        // dispatcher must drop them so a live row can never render as archived.
        readArchivedManifests: async () => [
          manifest({ id: "archived1", kind: "agent", status: "archived" }),
          manifest({ id: "active1", kind: "agent", status: "active" }),
          manifest({ id: "locked1", kind: "agent", status: "locked" }),
          manifest({ id: "uninstalled1", kind: "agent", status: "uninstalled" }),
        ],
        resolveHandler: () => handler,
      },
    );
    expect(seen).toEqual(["archived1"]);
  });

  it("records a kind whose handler lacks listArchived as unmigrated (no crash, no silent drop)", async () => {
    const activeOnlyHandler: ExtensionTypeHandler = {
      typeId: "connector", install: vi.fn(), update: vi.fn(), uninstall: vi.fn(), archive: vi.fn(), restore: vi.fn(),
      async listActive({ manifests }) { return manifests; },
      // no listArchived
    };
    const res = await discoverArchivedCapabilities(
      { actor, scope },
      {
        readArchivedManifests: async () => [manifest({ id: "c1", kind: "connector", status: "archived" })],
        resolveHandler: () => activeOnlyHandler,
      },
    );
    expect(res.unmigratedKinds).toEqual(["connector"]);
    expect(res.all).toEqual([]);
  });

  it("NEVER routes a wrong-kind manifest to a reader when a kind is requested", async () => {
    const seen: string[] = [];
    const agentHandler: ExtensionTypeHandler = {
      typeId: "agent", install: vi.fn(), update: vi.fn(), uninstall: vi.fn(), archive: vi.fn(), restore: vi.fn(),
      async listArchived({ manifests }) { manifests.forEach((m) => seen.push(`${m.kind}:${m.id}`)); return manifests; },
    };
    const res = await discoverArchivedCapabilities(
      { actor, scope, kind: "agent" },
      {
        readArchivedManifests: async () => [
          manifest({ id: "a1", kind: "agent", status: "archived" }),
          manifest({ id: "s1", kind: "skill", status: "archived" }),
        ],
        resolveHandler: () => agentHandler,
      },
    );
    expect(seen).toEqual(["agent:a1"]);
    expect(res.byKind.skill).toBeUndefined();
  });

  it("isolates a throwing archived reader to its own kind via onError", async () => {
    const onError = vi.fn();
    const boom: ExtensionTypeHandler = {
      typeId: "skill", install: vi.fn(), update: vi.fn(), uninstall: vi.fn(), archive: vi.fn(), restore: vi.fn(),
      async listArchived() { throw new Error("native store down"); },
    };
    const ok = archivedReaderHandler("agent");
    const res = await discoverArchivedCapabilities(
      { actor, scope },
      {
        readArchivedManifests: async () => [
          manifest({ id: "a1", kind: "agent", status: "archived" }),
          manifest({ id: "s1", kind: "skill", status: "archived" }),
        ],
        resolveHandler: (k) => (k === "skill" ? boom : ok),
      },
      { onError },
    );
    expect(res.byKind.agent).toEqual([{ archived: "@cinatra-ai/a1" }]);
    expect(res.byKind.skill).toEqual([]);
    expect(onError).toHaveBeenCalledWith("skill", expect.any(Error));
  });
});
