import { describe, expect, it, vi } from "vitest";
import {
  ConnectorInstanceToolPolicySurfaceError,
  createInstanceToolPolicySurfaceMembers,
  type InstanceToolPolicySurfaceDeps,
} from "@/lib/connector-instance-tool-policy-surface";

// cinatra#2022 S7 (the PR-λ companion seam) — the per-instance tool-policy
// settings surface: the S4/S5 consent-member gate mirrored (session +
// owning-org + connector.update, opaque refusals, no existence oracle), the
// honest absent-row default view (post-δ restricted+empty, never a stale
// "open"), shape-strict write validation (a record the pure evaluator would
// fail-closed on is refused at the seam, never persisted), and the
// store-backed, admin-attributed write.

type ReadFn = NonNullable<InstanceToolPolicySurfaceDeps["readPolicy"]>;
type WriteFn = NonNullable<InstanceToolPolicySurfaceDeps["writePolicy"]>;

function makeSurface(overrides: Partial<InstanceToolPolicySurfaceDeps> = {}) {
  const readPolicy = vi.fn<ReadFn>(async () => null);
  const writePolicy = vi.fn<WriteFn>(async () => {});
  const resolveOrgRole = vi.fn(async () => "org_admin" as const);
  const deps: InstanceToolPolicySurfaceDeps = {
    connectorKey: "wordpress",
    requireSession: async () => ({ user: { id: "admin-1" } }),
    resolveInstanceOrgId: () => "org1",
    resolveOrgRole,
    readPolicy,
    writePolicy,
    ...overrides,
  };
  return {
    surface: createInstanceToolPolicySurfaceMembers(deps),
    readPolicy,
    writePolicy,
    resolveOrgRole,
  };
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectorInstanceToolPolicySurfaceError);
  return (err as ConnectorInstanceToolPolicySurfaceError).reason;
}

describe("gate — session + owning org + connector.update, opaque fail-closed", () => {
  it("blank / non-string instanceId → invalid_input", async () => {
    const { surface } = makeSurface();
    expect(await reasonOf(surface.readInstanceToolPolicy({ instanceId: " " }))).toBe(
      "invalid_input",
    );
  });

  it.each([
    ["unknown/unbound instance", { resolveInstanceOrgId: () => null }],
    [
      "org lookup throws (uncertainty = refusal)",
      {
        resolveInstanceOrgId: () => {
          throw new Error("boom");
        },
      },
    ],
    ["non-member", { resolveOrgRole: vi.fn(async () => undefined) }],
    ["plain member (no connector.update)", { resolveOrgRole: vi.fn(async () => "member" as const) }],
    [
      "role lookup rejects",
      { resolveOrgRole: vi.fn(async () => Promise.reject(new Error("db"))) },
    ],
  ] as const)("%s → the SAME opaque refusal", async (_label, o) => {
    const { surface } = makeSurface(o as Partial<InstanceToolPolicySurfaceDeps>);
    expect(await reasonOf(surface.readInstanceToolPolicy({ instanceId: "inst-1" }))).toBe(
      "not_authorized_for_instance",
    );
  });

  it("org_admin passes; org_owner passes", async () => {
    for (const role of ["org_admin", "org_owner"] as const) {
      const { surface } = makeSurface({ resolveOrgRole: vi.fn(async () => role) });
      await expect(
        surface.readInstanceToolPolicy({ instanceId: "inst-1" }),
      ).resolves.toMatchObject({ instanceId: "inst-1" });
    }
  });
});

describe("read — the honest post-δ default + fail-safe mode", () => {
  it("absent row → restricted + empty allow/deny (the evaluator's deny-all default, never a stale 'open')", async () => {
    const { surface } = makeSurface();
    await expect(surface.readInstanceToolPolicy({ instanceId: "inst-1" })).resolves.toEqual({
      instanceId: "inst-1",
      mode: "restricted",
      allow: [],
      deny: [],
    });
  });

  it("an explicit row round-trips with provenance", async () => {
    const { surface } = makeSurface({
      readPolicy: vi.fn<ReadFn>(async () => ({
        connectorKey: "wordpress",
        instanceId: "inst-1",
        mode: "restricted",
        allow: [{ serverId: "mcp-adapter-default", name: "ewpa/update-post" }],
        deny: [{ serverId: "mcp-adapter-default", name: "ewpa/delete-post" }],
        updatedBy: "admin-0",
        updatedAt: "2026-07-30T00:00:00.000Z",
      })),
    });
    await expect(surface.readInstanceToolPolicy({ instanceId: "inst-1" })).resolves.toEqual({
      instanceId: "inst-1",
      mode: "restricted",
      allow: [{ serverId: "mcp-adapter-default", name: "ewpa/update-post" }],
      deny: [{ serverId: "mcp-adapter-default", name: "ewpa/delete-post" }],
      updatedBy: "admin-0",
      updatedAt: "2026-07-30T00:00:00.000Z",
    });
  });

  it("a garbled stored mode fail-SAFES to 'restricted' (the view never reads wider than what is enforced)", async () => {
    const { surface } = makeSurface({
      readPolicy: vi.fn<ReadFn>(async () => ({
        connectorKey: "wordpress",
        instanceId: "inst-1",
        mode: "totally-unknown" as never,
        updatedBy: "x",
        updatedAt: "2026-07-30T00:00:00.000Z",
      })),
    });
    await expect(
      surface.readInstanceToolPolicy({ instanceId: "inst-1" }),
    ).resolves.toMatchObject({ mode: "restricted" });
  });
});

describe("set — validated mode + refs, host-bound connector, admin provenance", () => {
  it("writes through the store with connectorKey host-bound + updatedBy from the session", async () => {
    const { surface, writePolicy } = makeSurface();
    const view = await surface.setInstanceToolPolicy({
      instanceId: "inst-1",
      mode: "restricted",
      allow: [{ serverId: "mcp-adapter-default", name: "ewpa/update-post" }],
    });
    expect(writePolicy).toHaveBeenCalledWith({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      mode: "restricted",
      allow: [{ serverId: "mcp-adapter-default", name: "ewpa/update-post" }],
      updatedBy: "admin-1",
    });
    expect(view.instanceId).toBe("inst-1");
  });

  it("trims + dedupes submitted refs; an emptied list normalises to absent (the NULL default-row form)", async () => {
    const { surface, writePolicy } = makeSurface();
    await surface.setInstanceToolPolicy({
      instanceId: "inst-1",
      mode: "restricted",
      allow: [
        { serverId: " mcp-adapter-default ", name: " ewpa/get-post " },
        { serverId: "mcp-adapter-default", name: "ewpa/get-post" },
      ],
      deny: [],
    });
    expect(writePolicy).toHaveBeenCalledWith({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      mode: "restricted",
      allow: [{ serverId: "mcp-adapter-default", name: "ewpa/get-post" }],
      // deny: [] normalised away — no `deny` key at all.
      updatedBy: "admin-1",
    });
  });

  it("an unknown mode → invalid_mode, nothing written", async () => {
    const { surface, writePolicy } = makeSurface();
    expect(
      await reasonOf(
        surface.setInstanceToolPolicy({
          instanceId: "inst-1",
          mode: "everything" as never,
        }),
      ),
    ).toBe("invalid_mode");
    expect(writePolicy).not.toHaveBeenCalled();
  });

  it.each([
    ["a non-array allow", { allow: "ewpa/get-post" as never }],
    ["a bare-string entry", { allow: ["ewpa/get-post"] as never }],
    ["a missing serverId", { allow: [{ name: "ewpa/get-post" }] as never }],
    ["a blank name", { allow: [{ serverId: "s1", name: "  " }] as never }],
    [
      "an over-cap list",
      {
        allow: Array.from({ length: 501 }, (_, i) => ({
          serverId: "s1",
          name: `tool-${i}`,
        })) as never,
      },
    ],
  ] as const)(
    "%s → invalid_refs, nothing written (a record the evaluator would fail-closed on is refused at the seam)",
    async (_label, o) => {
      const { surface, writePolicy } = makeSurface();
      expect(
        await reasonOf(
          surface.setInstanceToolPolicy({
            instanceId: "inst-1",
            mode: "restricted",
            ...(o as object),
          }),
        ),
      ).toBe("invalid_refs");
      expect(writePolicy).not.toHaveBeenCalled();
    },
  );

  it("the gate runs BEFORE validation side effects (non-admin cannot probe modes/refs)", async () => {
    const { surface, writePolicy } = makeSurface({
      resolveOrgRole: vi.fn(async () => "member" as const),
    });
    expect(
      await reasonOf(
        surface.setInstanceToolPolicy({ instanceId: "inst-1", mode: "restricted" }),
      ),
    ).toBe("not_authorized_for_instance");
    expect(writePolicy).not.toHaveBeenCalled();
  });

  it("returns the PERSISTED state re-read after the write, not an echo of the input", async () => {
    const readPolicy = vi.fn<ReadFn>(async () => ({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      mode: "restricted",
      allow: [{ serverId: "mcp-adapter-default", name: "ewpa/update-post" }],
      updatedBy: "admin-1",
      updatedAt: "2026-07-30T01:00:00.000Z",
    }));
    const { surface } = makeSurface({ readPolicy });
    const view = await surface.setInstanceToolPolicy({
      instanceId: "inst-1",
      mode: "restricted",
      allow: [{ serverId: "mcp-adapter-default", name: "ewpa/update-post" }],
    });
    expect(view.updatedAt).toBe("2026-07-30T01:00:00.000Z");
    // Both the gate-passing read path and the post-write read used the store.
    expect(readPolicy).toHaveBeenCalledWith("wordpress", "inst-1");
  });
});
