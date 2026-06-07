/**
 * Org-scoped settings/secrets tenancy for the extension host context.
 *
 * Verifies the org-scoped settings/secrets contract against the real host
 * factory (`createExtensionHostContext`), with the three modules its
 * settings/secrets ports touch mocked by an in-memory KV + controllable actor
 * org + a fake GCM that enforces AAD binding:
 *   - cross-org isolation: org A cannot read org B's settings/secrets;
 *   - fail-closed: a no-org actor rejects BOTH read and write on BOTH surfaces;
 *   - tenant key derives ONLY from the actor org (never a caller field);
 *   - `delete` is a TRUE row delete (not a write of JSON "null").
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

// Shared mutable state — hoisted so the vi.mock factories below can close over it.
const { kv, orgRef } = vi.hoisted(() => ({
  kv: new Map<string, unknown>(),
  orgRef: { current: null as string | null },
}));

vi.mock("@/lib/database", () => ({
  readConnectorConfigFromDatabase: <T>(id: string, fallback: T): T =>
    kv.has(id) ? (kv.get(id) as T) : fallback,
  writeConnectorConfigToDatabase: (id: string, value: unknown): void => {
    kv.set(id, value);
  },
  deleteConnectorConfig: (id: string): void => {
    kv.delete(id);
  },
}));

vi.mock("@/lib/extension-host-actor", () => ({
  requireExtensionOrganizationId: async (pkg: string): Promise<string> => {
    if (!orgRef.current) {
      throw new Error(`[ExtensionHostContext] ${pkg}: no organizationId on the current actor`);
    }
    return orgRef.current;
  },
  resolveExtensionActorContext: async () => null,
  resolveExtensionActorSummary: async () => null,
}));

vi.mock("@/lib/instance-secrets", () => ({
  // Fake GCM: bind the AAD into the ciphertext so a row cannot be replayed under
  // a different org/package/key (mirrors the real full-store-key AAD binding).
  encryptSecret: (value: string, aad: string) => ({
    ciphertext: `${Buffer.from(value).toString("base64")}::${aad}`,
    iv: "iv",
  }),
  decryptSecret: (stored: { ciphertext: string; iv: string }, aad: string): string => {
    const [b64, boundAad] = stored.ciphertext.split("::");
    if (boundAad !== aad) throw new Error("GCM AAD mismatch — cross-tenant replay rejected");
    return Buffer.from(b64, "base64").toString("utf8");
  },
}));

import { createExtensionHostContext } from "@/lib/extension-host-context";

const PKG = "@cinatra-ai/test-ext";
const ctx = () => createExtensionHostContext(PKG, ["settings", "secrets"]);

describe("extension host context — org-scoped settings", () => {
  beforeEach(() => {
    kv.clear();
    orgRef.current = null;
  });

  it("isolates settings across orgs (A's value invisible to B)", async () => {
    const c = ctx();
    orgRef.current = "orgA";
    await c.settings.set("pref", "valueA");
    orgRef.current = "orgB";
    expect(await c.settings.get("pref")).toBeNull();
    orgRef.current = "orgA";
    expect(await c.settings.get("pref")).toBe("valueA");
  });

  it("derives the physical store key from the actor org, never a caller field", async () => {
    const c = ctx();
    orgRef.current = "orgA";
    await c.settings.set("pref", 1);
    orgRef.current = "orgB";
    await c.settings.set("pref", 2);
    expect(kv.has(`ext:${PKG}:orgA:pref`)).toBe(true);
    expect(kv.has(`ext:${PKG}:orgB:pref`)).toBe(true);
    expect(kv.get(`ext:${PKG}:orgA:pref`)).toBe(1);
    expect(kv.get(`ext:${PKG}:orgB:pref`)).toBe(2);
  });

  it("settings.delete physically removes the row (NOT a write of JSON null)", async () => {
    const c = ctx();
    orgRef.current = "orgA";
    await c.settings.set("pref", "x");
    expect(kv.has(`ext:${PKG}:orgA:pref`)).toBe(true);
    await c.settings.delete("pref");
    expect(kv.has(`ext:${PKG}:orgA:pref`)).toBe(false); // gone, not stored as null
  });

  it("fails closed on settings read AND write when there is no resolvable org", async () => {
    const c = ctx();
    orgRef.current = null;
    await expect(c.settings.get("pref")).rejects.toThrow(/organizationId/);
    await expect(c.settings.set("pref", "x")).rejects.toThrow(/organizationId/);
  });
});

describe("extension host context — org-scoped secrets", () => {
  beforeEach(() => {
    kv.clear();
    orgRef.current = null;
  });

  it("isolates secrets across orgs and round-trips within an org", async () => {
    const c = ctx();
    orgRef.current = "orgA";
    await c.secrets.set("token", "secretA");
    orgRef.current = "orgB";
    expect(await c.secrets.get("token")).toBeNull();
    orgRef.current = "orgA";
    expect(await c.secrets.get("token")).toBe("secretA");
  });

  it("binds the AAD to the full store key so a leaked row cannot be replayed cross-org", async () => {
    const c = ctx();
    orgRef.current = "orgA";
    await c.secrets.set("token", "secretA");
    const storedA = kv.get(`ext-secret:${PKG}:orgA:token`) as { ciphertext: string; iv: string };
    expect(storedA).toBeTruthy();
    // Simulate a row leaked into org B's slot: decryption under B's AAD must fail.
    const { decryptSecret } = await import("@/lib/instance-secrets");
    expect(() => decryptSecret(storedA, `ext-secret:${PKG}:orgB:token`)).toThrow(/AAD mismatch/);
  });

  it("secrets.delete physically removes the row", async () => {
    const c = ctx();
    orgRef.current = "orgA";
    await c.secrets.set("token", "x");
    expect(kv.has(`ext-secret:${PKG}:orgA:token`)).toBe(true);
    await c.secrets.delete("token");
    expect(kv.has(`ext-secret:${PKG}:orgA:token`)).toBe(false);
  });

  it("fails closed on secrets read AND write when there is no resolvable org", async () => {
    const c = ctx();
    orgRef.current = null;
    await expect(c.secrets.get("token")).rejects.toThrow(/organizationId/);
    await expect(c.secrets.set("token", "x")).rejects.toThrow(/organizationId/);
  });
});
