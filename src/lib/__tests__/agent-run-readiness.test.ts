// cinatra #1057 ruling (b) — the shared agent RUN-READINESS gate.
//
// Proves the enforcement predicate every dispatch surface routes through:
//   - PURE `evaluateAgentRunReadiness`: fail-closed structured error naming each
//     unconfigured connector when in scope + not ready; null when out of scope or
//     fully configured (the error-shape test),
//   - `assertAgentRunReadyByPackage` with INJECTED deps (no DB / no probe chain):
//     no package / no agent-kind row → out of scope (never blocked); agent with an
//     unconfigured required connector → blocked; agent fully configured → allowed;
//     the caller's readiness ctx (userId) is threaded to the derivation.
//
// `server-only` is aliased to a stub by vitest.config; the derivation +
// canonical-store readers are INJECTED, so this test never loads the probe chain.
import { describe, expect, it, vi } from "vitest";

import {
  AGENT_RUN_CONNECTIONS_UNCONFIGURED,
  assertAgentRunReadyByPackage,
  evaluateAgentRunReadiness,
} from "@/lib/agent-run-readiness";
import type { ConfigurationNeedsSummary } from "@/lib/extension-dependency-ux";
import type {
  ExtensionDependency,
  ExtensionKind,
} from "@cinatra-ai/extensions/canonical-types";

const need = (displayName: string, packageName: string, slug: string) => ({
  displayName,
  packageName,
  slug,
  settingsHref: `/connectors/cinatra-ai/${slug}/setup`,
});

const summary = (over: Partial<ConfigurationNeedsSummary>): ConfigurationNeedsSummary => ({
  needs: [],
  hasConnectors: false,
  allConfigured: true,
  ...over,
});

describe("evaluateAgentRunReadiness (pure)", () => {
  it("returns null when the agent is out of scope (no connectors)", () => {
    expect(
      evaluateAgentRunReadiness({
        agentIdentifier: "@cinatra-ai/some-agent",
        summary: summary({ hasConnectors: false, allConfigured: true, needs: [] }),
      }),
    ).toBeNull();
  });

  it("returns null when every required connector is configured", () => {
    expect(
      evaluateAgentRunReadiness({
        agentIdentifier: "@cinatra-ai/some-agent",
        summary: summary({ hasConnectors: true, allConfigured: true, needs: [] }),
      }),
    ).toBeNull();
  });

  it("fails closed with a structured error NAMING each unconfigured connector", () => {
    const result = evaluateAgentRunReadiness({
      agentIdentifier: "@cinatra-ai/social-agent",
      summary: summary({
        hasConnectors: true,
        allConfigured: false,
        needs: [
          need("LinkedIn", "@cinatra-ai/linkedin-connector", "linkedin-connector"),
          need("Apollo", "@cinatra-ai/apollo-connector", "apollo-connector"),
        ],
      }),
    });
    expect(result).not.toBeNull();
    expect(result!.code).toBe(AGENT_RUN_CONNECTIONS_UNCONFIGURED);
    expect(result!.agent).toBe("@cinatra-ai/social-agent");
    // displayNames + package ids are carried structurally...
    expect(result!.unconfiguredConnectors).toEqual([
      {
        displayName: "LinkedIn",
        packageName: "@cinatra-ai/linkedin-connector",
        settingsHref: "/connectors/cinatra-ai/linkedin-connector/setup",
      },
      {
        displayName: "Apollo",
        packageName: "@cinatra-ai/apollo-connector",
        settingsHref: "/connectors/cinatra-ai/apollo-connector/setup",
      },
    ]);
    // ...and the human string names both displayNames.
    expect(result!.error).toContain("LinkedIn");
    expect(result!.error).toContain("Apollo");
    expect(result!.error).toContain("@cinatra-ai/social-agent");
  });
});

describe("assertAgentRunReadyByPackage (injected deps — no DB / no probes)", () => {
  const agentRow = {
    kind: "agent" as ExtensionKind,
    packageName: "@cinatra-ai/social-agent",
    dependencies: [] as ExtensionDependency[],
  };

  it("returns null (never blocked) when no packageName is given", async () => {
    const readInstalled = vi.fn();
    const resolveNeeds = vi.fn();
    expect(
      await assertAgentRunReadyByPackage(null, "x", { userId: "u1" }, {
        readInstalled,
        resolveNeeds,
      }),
    ).toBeNull();
    expect(readInstalled).not.toHaveBeenCalled();
    expect(resolveNeeds).not.toHaveBeenCalled();
  });

  it("returns null when there is no agent-kind canonical row (out of scope)", async () => {
    const readInstalled = vi.fn(async () => [
      {
        kind: "connector" as ExtensionKind,
        packageName: "@cinatra-ai/linkedin-connector",
        dependencies: [] as ExtensionDependency[],
      },
    ]);
    const resolveNeeds = vi.fn();
    expect(
      await assertAgentRunReadyByPackage(
        "@cinatra-ai/linkedin-connector",
        "@cinatra-ai/linkedin-connector",
        { userId: "u1" },
        { readInstalled, resolveNeeds },
      ),
    ).toBeNull();
    expect(resolveNeeds).not.toHaveBeenCalled();
  });

  it("BLOCKS (fail-closed) when the agent has an unconfigured required connector", async () => {
    const readInstalled = vi.fn(async () => [agentRow]);
    const resolveNeeds = vi.fn(async () =>
      summary({
        hasConnectors: true,
        allConfigured: false,
        needs: [need("LinkedIn", "@cinatra-ai/linkedin-connector", "linkedin-connector")],
      }),
    );
    const result = await assertAgentRunReadyByPackage(
      "@cinatra-ai/social-agent",
      "@cinatra-ai/social-agent",
      { userId: "u-owner" },
      { readInstalled, resolveNeeds },
    );
    expect(result).not.toBeNull();
    expect(result!.code).toBe(AGENT_RUN_CONNECTIONS_UNCONFIGURED);
    expect(result!.unconfiguredConnectors.map((c) => c.displayName)).toEqual(["LinkedIn"]);
    // the readiness ctx (owner userId) is threaded into the derivation.
    expect(resolveNeeds).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "agent", packageName: "@cinatra-ai/social-agent" }),
      { userId: "u-owner" },
    );
  });

  it("ALLOWS (null) when the agent's required connectors are all configured", async () => {
    const readInstalled = vi.fn(async () => [agentRow]);
    const resolveNeeds = vi.fn(async () =>
      summary({ hasConnectors: true, allConfigured: true, needs: [] }),
    );
    expect(
      await assertAgentRunReadyByPackage(
        "@cinatra-ai/social-agent",
        "@cinatra-ai/social-agent",
        { userId: "u-owner" },
        { readInstalled, resolveNeeds },
      ),
    ).toBeNull();
  });
});
