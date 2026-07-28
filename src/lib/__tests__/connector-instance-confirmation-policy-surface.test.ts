import { describe, expect, it, vi } from "vitest";
import {
  ConnectorInstanceConfirmationPolicyError,
  createConfirmationPolicySurfaceMembers,
  type ConfirmationPolicySurfaceDeps,
} from "@/lib/connector-instance-confirmation-policy-surface";

// cinatra#2020 S5 PR-4 — the org-disable surface: the S4 consent-member gate
// mirrored (session + owning-org + connector.update, opaque refusals, no
// existence oracle), the fail-safe mode read, and the store-backed write.

type ReadFn = NonNullable<ConfirmationPolicySurfaceDeps["readPolicy"]>;
type WriteFn = NonNullable<ConfirmationPolicySurfaceDeps["writePolicy"]>;

function makeSurface(overrides: Partial<ConfirmationPolicySurfaceDeps> = {}) {
  const readPolicy = vi.fn<ReadFn>(async () => null);
  const writePolicy = vi.fn<WriteFn>(async () => {});
  const resolveOrgRole = vi.fn(async () => "org_admin" as const);
  const deps: ConfirmationPolicySurfaceDeps = {
    connectorKey: "wordpress",
    requireSession: async () => ({ user: { id: "admin-1" } }),
    resolveInstanceOrgId: () => "org1",
    resolveOrgRole,
    readPolicy,
    writePolicy,
    ...overrides,
  };
  return { surface: createConfirmationPolicySurfaceMembers(deps), readPolicy, writePolicy, resolveOrgRole };
}

async function reasonOf(p: Promise<unknown>): Promise<string> {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ConnectorInstanceConfirmationPolicyError);
  return (err as ConnectorInstanceConfirmationPolicyError).reason;
}

describe("gate — session + owning org + connector.update, opaque fail-closed", () => {
  it("blank / non-string instanceId → invalid_input", async () => {
    const { surface } = makeSurface();
    expect(await reasonOf(surface.readInstanceConfirmationPolicy({ instanceId: " " }))).toBe(
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
    const { surface } = makeSurface(o as Partial<ConfirmationPolicySurfaceDeps>);
    expect(await reasonOf(surface.readInstanceConfirmationPolicy({ instanceId: "inst-1" }))).toBe(
      "not_authorized_for_instance",
    );
  });

  it("org_admin passes; org_owner passes", async () => {
    for (const role of ["org_admin", "org_owner"] as const) {
      const { surface } = makeSurface({ resolveOrgRole: vi.fn(async () => role) });
      await expect(
        surface.readInstanceConfirmationPolicy({ instanceId: "inst-1" }),
      ).resolves.toMatchObject({ instanceId: "inst-1" });
    }
  });
});

describe("read — defaults + fail-safe mode", () => {
  it("absent row → mode 'default' (surface defaults apply)", async () => {
    const { surface } = makeSurface();
    await expect(
      surface.readInstanceConfirmationPolicy({ instanceId: "inst-1" }),
    ).resolves.toEqual({ instanceId: "inst-1", mode: "default" });
  });

  it("explicit disabled row → disabled with provenance", async () => {
    const { surface } = makeSurface({
      readPolicy: vi.fn<ReadFn>(async () => ({
        connectorKey: "wordpress",
        instanceId: "inst-1",
        mode: "disabled",
        updatedBy: "admin-0",
        updatedAt: "2026-07-28T00:00:00.000Z",
      })),
    });
    await expect(
      surface.readInstanceConfirmationPolicy({ instanceId: "inst-1" }),
    ).resolves.toMatchObject({ mode: "disabled", updatedBy: "admin-0" });
  });

  it("a garbled stored mode fail-SAFES to 'default' (require stays on)", async () => {
    const { surface } = makeSurface({
      readPolicy: vi.fn<ReadFn>(async () => ({
        connectorKey: "wordpress",
        instanceId: "inst-1",
        mode: "totally-unknown",
        updatedBy: "x",
        updatedAt: "2026-07-28T00:00:00.000Z",
      })),
    });
    await expect(
      surface.readInstanceConfirmationPolicy({ instanceId: "inst-1" }),
    ).resolves.toMatchObject({ mode: "default" });
  });
});

describe("set — validated mode, host-bound connector, admin provenance", () => {
  it("writes through the store with connectorKey host-bound + updatedBy from the session", async () => {
    const { surface, writePolicy } = makeSurface();
    const view = await surface.setInstanceConfirmationPolicy({
      instanceId: "inst-1",
      mode: "disabled",
    });
    expect(writePolicy).toHaveBeenCalledWith({
      connectorKey: "wordpress",
      instanceId: "inst-1",
      mode: "disabled",
      updatedBy: "admin-1",
    });
    expect(view.instanceId).toBe("inst-1");
  });

  it("an unknown mode → invalid_mode, nothing written", async () => {
    const { surface, writePolicy } = makeSurface();
    expect(
      await reasonOf(
        surface.setInstanceConfirmationPolicy({
          instanceId: "inst-1",
          mode: "off" as never,
        }),
      ),
    ).toBe("invalid_mode");
    expect(writePolicy).not.toHaveBeenCalled();
  });

  it("the gate runs BEFORE validation side effects (non-admin cannot probe modes)", async () => {
    const { surface, writePolicy } = makeSurface({
      resolveOrgRole: vi.fn(async () => "member" as const),
    });
    expect(
      await reasonOf(
        surface.setInstanceConfirmationPolicy({ instanceId: "inst-1", mode: "disabled" }),
      ),
    ).toBe("not_authorized_for_instance");
    expect(writePolicy).not.toHaveBeenCalled();
  });
});
