// Host-wiring matrix for `isConnectorInstalledForActor` (cinatra#657).
//
// The LOAD-BEARING CI guard is the pure-predicate test in
// `packages/extensions/src/__tests__/connector-installed-predicate.test.ts`
// (run by `packages/extensions` `test:invariants`). THIS host test documents the
// IO wiring: the bundled-fallback read + the canonical-store-outage fallback +
// the DI'd resolver. It is not executed by a CI job today (host `src/lib/__tests__`
// unit tests are not enumerated in any workflow), so it is a local/dev guard.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

// One bundled connector (openai) present; another (apollo) absent — the same
// partial manifest the legacy `isConnectorInstalled` test uses.
vi.mock("@/lib/generated/extensions.server", () => ({
  STATIC_EXTENSION_MANIFEST: {
    "@cinatra-ai/openai-connector": {
      packageName: "@cinatra-ai/openai-connector",
      uiSurface: "bundled-react",
      configSchema: null,
      requestedHostPorts: [],
      displayName: "OpenAI",
      logo: null,
      scope: "cinatra-ai",
    },
  },
}));

import { isConnectorInstalledForActor } from "@/lib/connectors-registry.server";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";
import type { InstallRowForPick } from "@/lib/extension-install-resolution";

const actor: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-1",
  organizationId: "org-1",
  teamIds: [],
  authSource: "ui",
  policyVersion: POLICY_VERSION,
};

// Org-scoped rows addressable by `actor` (organizationId === "org-1").
const liveRowRead = async (): Promise<InstallRowForPick[]> => [
  { id: "iext_live", status: "active", organizationId: "org-1", ownerId: null, ownerLevel: "organization" },
];
const archivedRowRead = async (): Promise<InstallRowForPick[]> => [
  { id: "iext_arch", status: "archived", organizationId: "org-1", ownerId: null, ownerLevel: "organization" },
];
const crossOrgRowRead = async (): Promise<InstallRowForPick[]> => [
  { id: "iext_other", status: "active", organizationId: "org-OTHER", ownerId: null, ownerLevel: "organization" },
];
const noRowsRead = async (): Promise<InstallRowForPick[]> => [];
const outageRead = async (): Promise<InstallRowForPick[]> => {
  throw new Error("canonical store unavailable");
};

describe("isConnectorInstalledForActor (runtime row || bundled fallback, archive-aware)", () => {
  it("live row + bundled → installed", async () => {
    expect(
      await isConnectorInstalledForActor("@cinatra-ai/openai-connector", actor, {
        readRows: liveRowRead,
      }),
    ).toBe(true);
  });

  it("live row + NOT bundled (runtime-only connector) → installed", async () => {
    expect(
      await isConnectorInstalledForActor("@cinatra-ai/some-runtime-connector", actor, {
        readRows: liveRowRead,
      }),
    ).toBe(true);
  });

  it("no rows + bundled (fresh instance, CG-1) → installed via bundled fallback", async () => {
    expect(
      await isConnectorInstalledForActor("@cinatra-ai/openai-connector", actor, {
        readRows: noRowsRead,
      }),
    ).toBe(true);
  });

  it("no rows + NOT bundled → NOT installed", async () => {
    expect(
      await isConnectorInstalledForActor("@cinatra-ai/apollo-connector", actor, {
        readRows: noRowsRead,
      }),
    ).toBe(false);
  });

  it("ARCHIVED bundled connector → NOT installed (explicit disable hides it)", async () => {
    // An operator archived a bundled connector — the bundled fallback must NOT
    // resurrect it. This is the load-bearing archive-vs-absent distinction.
    expect(
      await isConnectorInstalledForActor("@cinatra-ai/openai-connector", actor, {
        readRows: archivedRowRead,
      }),
    ).toBe(false);
  });

  it("ARCHIVED runtime-only connector → NOT installed", async () => {
    expect(
      await isConnectorInstalledForActor("@cinatra-ai/some-runtime-connector", actor, {
        readRows: archivedRowRead,
      }),
    ).toBe(false);
  });

  it("cross-org row + bundled → bundled fallback applies (the cross-org row is NOT addressable)", async () => {
    // A cross-org row is not addressable for this actor, so it counts as "no
    // addressable row" — the bundled fallback applies (the row belongs to another
    // tenant and must not leak its archive/disable state into this actor's view).
    expect(
      await isConnectorInstalledForActor("@cinatra-ai/openai-connector", actor, {
        readRows: crossOrgRowRead,
      }),
    ).toBe(true);
  });

  it("cross-org row + NOT bundled → NOT installed (no addressable row, no fallback)", async () => {
    expect(
      await isConnectorInstalledForActor("@cinatra-ai/some-runtime-connector", actor, {
        readRows: crossOrgRowRead,
      }),
    ).toBe(false);
  });

  it("store outage + bundled → installed (bundled fallback survives outage)", async () => {
    expect(
      await isConnectorInstalledForActor("@cinatra-ai/openai-connector", actor, {
        readRows: outageRead,
      }),
    ).toBe(true);
  });

  it("store outage + NOT bundled (runtime-only) → fail-closed (NOT installed)", async () => {
    expect(
      await isConnectorInstalledForActor("@cinatra-ai/some-runtime-connector", actor, {
        readRows: outageRead,
      }),
    ).toBe(false);
  });

  it("null actor → bundled fallback only (no scoped row addressable)", async () => {
    expect(
      await isConnectorInstalledForActor("@cinatra-ai/some-runtime-connector", null, {
        readRows: noRowsRead,
      }),
    ).toBe(false);
    expect(
      await isConnectorInstalledForActor("@cinatra-ai/openai-connector", null, {
        readRows: noRowsRead,
      }),
    ).toBe(true);
  });
});
