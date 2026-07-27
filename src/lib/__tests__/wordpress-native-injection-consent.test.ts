import { describe, expect, it, vi } from "vitest";
import {
  createWordPressNativeInjectionConsentMembers,
  WordPressNativeInjectionConsentError,
  type WordPressNativeInjectionConsentDeps,
} from "@/lib/wordpress-native-injection-consent";
import {
  resolveShippedTrustedSiteConsent,
  TRUSTED_READ_DESCRIPTOR_SET,
  TRUSTED_SITE_DISCLOSURE_VERSION,
  computeTrustedReadDescriptorSetHash,
} from "@/lib/wordpress-trusted-read-descriptors";
import type { AuthzOrgRole } from "@/lib/auth-session";
import type { NativeInjectionPolicyView } from "@/lib/connector-instance-native-injection-store";

// cinatra#2019 S4 — the org-admin opt-in members. Pins the authorization gate
// (cookie session + `connector.update` in the instance's OWNING org, one
// opaque refusal for every failure mode, no platform-admin synthesis) and the
// HOST-STAMPED consent invariant (the caller chooses only the mode; stamp
// values on the input are ignored — the shipped constants are recorded).

vi.mock("server-only", () => ({}));

const OFF: NativeInjectionPolicyView = {
  mode: "off",
  disclosureVersion: null,
  descriptorSetVersion: null,
  descriptorSetHash: null,
  consentedOrgId: null,
  enabledBy: null,
  enabledAt: null,
  updatedBy: null,
  updatedAt: null,
};

function makeDeps(overrides?: Partial<WordPressNativeInjectionConsentDeps>): {
  deps: WordPressNativeInjectionConsentDeps;
  writeMode: ReturnType<typeof vi.fn>;
  readPolicy: ReturnType<typeof vi.fn>;
} {
  const writeMode = vi.fn(async () => {});
  const readPolicy = vi.fn(async () => OFF);
  const deps: WordPressNativeInjectionConsentDeps = {
    requireSession: async () => ({ user: { id: "admin-1" } }),
    resolveInstanceOrgId: (instanceId) => (instanceId === "i1" ? "org-1" : null),
    resolveOrgRole: async (orgId, userId) =>
      orgId === "org-1" && userId === "admin-1" ? ("org_admin" as AuthzOrgRole) : undefined,
    readPolicy: readPolicy as unknown as WordPressNativeInjectionConsentDeps["readPolicy"],
    writeMode: writeMode as unknown as WordPressNativeInjectionConsentDeps["writeMode"],
    ...overrides,
  };
  return { deps, writeMode, readPolicy };
}

async function expectRefusal(
  promise: Promise<unknown>,
  reason: WordPressNativeInjectionConsentError["reason"],
): Promise<void> {
  const error = await promise.then(
    () => null,
    (thrown: unknown) => thrown,
  );
  expect(error).toBeInstanceOf(WordPressNativeInjectionConsentError);
  expect((error as WordPressNativeInjectionConsentError).reason).toBe(reason);
}

describe("org-admin gate (both members, fail-closed, no oracle)", () => {
  it("refuses a non-admin member with the opaque reason and never touches the store", async () => {
    const { deps, writeMode, readPolicy } = makeDeps({
      resolveOrgRole: async () => "member" as AuthzOrgRole,
    });
    const members = createWordPressNativeInjectionConsentMembers(deps);
    await expectRefusal(
      members.setNativeInjectionMode({ instanceId: "i1", mode: "trusted_site" }),
      "not_authorized_for_instance",
    );
    await expectRefusal(
      members.readNativeInjectionPolicy({ instanceId: "i1" }),
      "not_authorized_for_instance",
    );
    expect(writeMode).not.toHaveBeenCalled();
    expect(readPolicy).not.toHaveBeenCalled();
  });

  it.each([
    ["non-member (role undefined)", { resolveOrgRole: async () => undefined }],
    ["unknown instance (org unresolvable)", { resolveInstanceOrgId: () => null }],
    [
      "instance/org lookup THROW (uncertainty, not an internal error to leak)",
      {
        resolveInstanceOrgId: () => {
          throw new Error("config store unreadable");
        },
      },
    ],
    [
      "membership lookup error",
      { resolveOrgRole: async () => Promise.reject(new Error("db down")) },
    ],
  ] as Array<[string, Partial<WordPressNativeInjectionConsentDeps>]>)(
    "refuses with the SAME opaque reason for %s",
    async (_label, override) => {
      const { deps, writeMode } = makeDeps(override);
      const members = createWordPressNativeInjectionConsentMembers(deps);
      await expectRefusal(
        members.setNativeInjectionMode({ instanceId: "i1", mode: "trusted_site" }),
        "not_authorized_for_instance",
      );
      expect(writeMode).not.toHaveBeenCalled();
    },
  );

  it("does NOT synthesize platform-admin access: a non-member stays refused regardless of session flags", async () => {
    const { deps, writeMode } = makeDeps({
      requireSession: async () =>
        ({ user: { id: "platform-admin-9", role: "user,admin" } }) as unknown as {
          user: { id: string };
        },
      resolveOrgRole: async () => undefined,
    });
    const members = createWordPressNativeInjectionConsentMembers(deps);
    await expectRefusal(
      members.setNativeInjectionMode({ instanceId: "i1", mode: "trusted_site" }),
      "not_authorized_for_instance",
    );
    expect(writeMode).not.toHaveBeenCalled();
  });

  it("propagates the session requirement (unauthenticated callers never reach the org read)", async () => {
    const resolveInstanceOrgId = vi.fn(() => "org-1");
    const { deps } = makeDeps({
      requireSession: async () => {
        throw new Error("redirect: sign-in");
      },
      resolveInstanceOrgId,
    });
    const members = createWordPressNativeInjectionConsentMembers(deps);
    await expect(members.readNativeInjectionPolicy({ instanceId: "i1" })).rejects.toThrow(
      /sign-in/,
    );
    expect(resolveInstanceOrgId).not.toHaveBeenCalled();
  });

  it("refuses structural garbage instance ids as invalid_input", async () => {
    const { deps } = makeDeps();
    const members = createWordPressNativeInjectionConsentMembers(deps);
    await expectRefusal(
      members.readNativeInjectionPolicy({ instanceId: "  " }),
      "invalid_input",
    );
    await expectRefusal(
      members.setNativeInjectionMode(
        { mode: "off" } as unknown as { instanceId: string; mode: "off" },
      ),
      "invalid_input",
    );
  });
});

describe("host-stamped consent (the caller chooses ONLY the mode)", () => {
  it("stamps EXACTLY the shipped constants + the gate-resolved owning org on enable (org_admin) and returns the fresh owner-scoped state", async () => {
    const { deps, writeMode, readPolicy } = makeDeps();
    const members = createWordPressNativeInjectionConsentMembers(deps);
    const result = await members.setNativeInjectionMode({ instanceId: "i1", mode: "trusted_site" });
    const shipped = resolveShippedTrustedSiteConsent();
    expect(writeMode).toHaveBeenCalledTimes(1);
    expect(writeMode.mock.calls[0][0]).toEqual({
      connectorKey: "wordpress",
      instanceId: "i1",
      mode: "trusted_site",
      actorUserId: "admin-1",
      actorOrgId: "org-1",
      disclosureVersion: shipped.disclosureVersion,
      descriptorSetVersion: shipped.descriptorSetVersion,
      descriptorSetHash: shipped.descriptorSetHash,
    });
    expect(readPolicy).toHaveBeenCalledWith("wordpress", "i1", "org-1");
    expect(result).toEqual(OFF);
  });

  it("read member returns the OWNER-SCOPED store view for an org admin", async () => {
    const { deps, readPolicy } = makeDeps();
    const members = createWordPressNativeInjectionConsentMembers(deps);
    const view = await members.readNativeInjectionPolicy({ instanceId: "i1" });
    expect(readPolicy).toHaveBeenCalledWith("wordpress", "i1", "org-1");
    expect(view).toEqual(OFF);
  });

  it("allows org_owner via permission inheritance", async () => {
    const { deps, writeMode } = makeDeps({
      resolveOrgRole: async () => "org_owner" as AuthzOrgRole,
    });
    const members = createWordPressNativeInjectionConsentMembers(deps);
    await members.setNativeInjectionMode({ instanceId: "i1", mode: "off" });
    expect(writeMode).toHaveBeenCalledTimes(1);
  });

  it("IGNORES caller-supplied stamp/actor/org-shaped fields (a skewed connector cannot forge acknowledged content or attribution)", async () => {
    const { deps, writeMode } = makeDeps();
    const members = createWordPressNativeInjectionConsentMembers(deps);
    await members.setNativeInjectionMode({
      instanceId: "i1",
      mode: "trusted_site",
      descriptorSetVersion: 999,
      descriptorSetHash: "forged",
      disclosureVersion: "v999",
      actorUserId: "someone-else",
      actorOrgId: "forged-org",
    } as unknown as { instanceId: string; mode: "trusted_site" });
    const shipped = resolveShippedTrustedSiteConsent();
    expect(writeMode.mock.calls[0][0]).toMatchObject({
      actorUserId: "admin-1",
      actorOrgId: "org-1",
      descriptorSetVersion: shipped.descriptorSetVersion,
      descriptorSetHash: shipped.descriptorSetHash,
      disclosureVersion: shipped.disclosureVersion,
    });
  });

  it("writes off without any stamp fields (org + actor still host-resolved)", async () => {
    const { deps, writeMode } = makeDeps();
    const members = createWordPressNativeInjectionConsentMembers(deps);
    await members.setNativeInjectionMode({ instanceId: "i1", mode: "off" });
    expect(writeMode.mock.calls[0][0]).toEqual({
      connectorKey: "wordpress",
      instanceId: "i1",
      mode: "off",
      actorUserId: "admin-1",
      actorOrgId: "org-1",
    });
  });

  it("refuses an unknown mode before touching the store", async () => {
    const { deps, writeMode } = makeDeps();
    const members = createWordPressNativeInjectionConsentMembers(deps);
    await expectRefusal(
      members.setNativeInjectionMode({
        instanceId: "i1",
        mode: "TRUSTED_SITE" as unknown as "trusted_site",
      }),
      "invalid_mode",
    );
    expect(writeMode).not.toHaveBeenCalled();
  });

  it("honors the TEST-ONLY shippedConsent override (staleness simulations for later slices)", async () => {
    const { deps, writeMode } = makeDeps({
      shippedConsent: { descriptorSetVersion: 7, descriptorSetHash: "h7", disclosureVersion: "v7" },
    });
    const members = createWordPressNativeInjectionConsentMembers(deps);
    await members.setNativeInjectionMode({ instanceId: "i1", mode: "trusted_site" });
    expect(writeMode.mock.calls[0][0]).toMatchObject({
      descriptorSetVersion: 7,
      descriptorSetHash: "h7",
      disclosureVersion: "v7",
    });
  });
});

describe("shipped consent constants (the stamp source)", () => {
  it("derives the shipped stamp from the descriptor module's own set + hash helper", () => {
    const shipped = resolveShippedTrustedSiteConsent();
    expect(shipped.descriptorSetVersion).toBe(TRUSTED_READ_DESCRIPTOR_SET.version);
    expect(shipped.disclosureVersion).toBe(TRUSTED_SITE_DISCLOSURE_VERSION);
    expect(shipped.descriptorSetHash).toBe(
      computeTrustedReadDescriptorSetHash(TRUSTED_READ_DESCRIPTOR_SET.entries),
    );
  });
});
