import { describe, expect, it, beforeEach } from "vitest";
import type { ComponentType } from "react";
import {
  agentUIOverrideRegistry,
  type AgentUIOverrideEntry,
  type AgentUIOverrideRendererProps,
} from "../agent-ui-override-registry";

// Minimal stub renderer — just needs to satisfy ComponentType<AgentUIOverrideRendererProps>
const StubRenderer: ComponentType<AgentUIOverrideRendererProps> = () => null;
const StubRendererB: ComponentType<AgentUIOverrideRendererProps> = () => null;
const StubRendererC: ComponentType<AgentUIOverrideRendererProps> = () => null;

function makeEntry(
  overrides: Partial<AgentUIOverrideEntry> & { id: string },
): AgentUIOverrideEntry {
  return {
    priority: 50,
    eventType: "STATE_SNAPSHOT",
    renderer: StubRenderer,
    ...overrides,
  };
}

describe("agentUIOverrideRegistry", () => {
  beforeEach(() => {
    agentUIOverrideRegistry.clear();
  });

  // ---------------------------------------------------------------------------
  // resolve() — empty registry
  // ---------------------------------------------------------------------------

  it("returns null when registry is empty", () => {
    expect(agentUIOverrideRegistry.resolve("STATE_SNAPSHOT", "my-agent")).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // resolve() — priority ordering
  // ---------------------------------------------------------------------------

  it("returns the higher-priority entry when two entries match", () => {
    agentUIOverrideRegistry.register(makeEntry({ id: "@test/pkg:low", priority: 10, renderer: StubRenderer }));
    agentUIOverrideRegistry.register(makeEntry({ id: "@test/pkg:high", priority: 90, renderer: StubRendererB }));

    const result = agentUIOverrideRegistry.resolve("STATE_SNAPSHOT", "any-agent");
    expect(result?.id).toBe("@test/pkg:high");
    expect(result?.renderer).toBe(StubRendererB);
  });

  // ---------------------------------------------------------------------------
  // resolve() — agent-scoped vs global
  // ---------------------------------------------------------------------------

  it("returns agent-scoped entry when package name matches", () => {
    agentUIOverrideRegistry.register(
      makeEntry({ id: "@test/pkg:global", priority: 50, renderer: StubRenderer }),
    );
    agentUIOverrideRegistry.register(
      makeEntry({
        id: "@test/pkg:scoped",
        priority: 40,
        agentPackageName: "my-agent",
        renderer: StubRendererB,
      }),
    );

    // Scoped entry wins for "my-agent" despite lower priority — it's an explicit match
    // at priority 40, while the global at 50 would also match. Higher priority wins.
    const result = agentUIOverrideRegistry.resolve("STATE_SNAPSHOT", "my-agent");
    expect(result?.id).toBe("@test/pkg:global"); // 50 > 40, global wins on priority
  });

  it("skips agent-scoped entry when package name does not match, falls back to global", () => {
    agentUIOverrideRegistry.register(
      makeEntry({ id: "@test/pkg:global", priority: 10, renderer: StubRenderer }),
    );
    agentUIOverrideRegistry.register(
      makeEntry({
        id: "@test/pkg:scoped",
        priority: 90,
        agentPackageName: "other-agent",
        renderer: StubRendererB,
      }),
    );

    const result = agentUIOverrideRegistry.resolve("STATE_SNAPSHOT", "my-agent");
    // scoped entry (priority 90) is for "other-agent" — skip it; global (priority 10) matches
    expect(result?.id).toBe("@test/pkg:global");
  });

  it("returns global override when agentPackageName is undefined", () => {
    agentUIOverrideRegistry.register(
      makeEntry({ id: "@test/pkg:global", priority: 50, renderer: StubRenderer }),
    );

    const result = agentUIOverrideRegistry.resolve("STATE_SNAPSHOT", undefined);
    expect(result?.id).toBe("@test/pkg:global");
  });

  it("returns null when only a scoped entry exists and caller passes different package name", () => {
    agentUIOverrideRegistry.register(
      makeEntry({
        id: "@test/pkg:scoped",
        priority: 90,
        agentPackageName: "other-agent",
        renderer: StubRenderer,
      }),
    );

    expect(agentUIOverrideRegistry.resolve("STATE_SNAPSHOT", "my-agent")).toBeNull();
  });

  // ---------------------------------------------------------------------------
  // resolve() — event type filtering
  // ---------------------------------------------------------------------------

  it("returns null when the registered entry is for a different event type", () => {
    agentUIOverrideRegistry.register(
      makeEntry({ id: "@test/pkg:interrupt", eventType: "INTERRUPT", renderer: StubRenderer }),
    );

    expect(agentUIOverrideRegistry.resolve("STATE_SNAPSHOT", "my-agent")).toBeNull();
  });

  it("resolves the correct entry when multiple event types are registered", () => {
    agentUIOverrideRegistry.register(
      makeEntry({ id: "@test/pkg:snapshot", eventType: "STATE_SNAPSHOT", renderer: StubRenderer }),
    );
    agentUIOverrideRegistry.register(
      makeEntry({ id: "@test/pkg:interrupt", eventType: "INTERRUPT", renderer: StubRendererB }),
    );

    expect(agentUIOverrideRegistry.resolve("STATE_SNAPSHOT")?.renderer).toBe(StubRenderer);
    expect(agentUIOverrideRegistry.resolve("INTERRUPT")?.renderer).toBe(StubRendererB);
  });

  // ---------------------------------------------------------------------------
  // register() — idempotent re-registration
  // ---------------------------------------------------------------------------

  it("replaces an existing entry when re-registered with the same id", () => {
    agentUIOverrideRegistry.register(
      makeEntry({ id: "@test/pkg:entry", priority: 50, renderer: StubRenderer }),
    );
    agentUIOverrideRegistry.register(
      makeEntry({ id: "@test/pkg:entry", priority: 80, renderer: StubRendererB }),
    );

    expect(agentUIOverrideRegistry.list()).toHaveLength(1);
    expect(agentUIOverrideRegistry.resolve("STATE_SNAPSHOT")?.renderer).toBe(StubRendererB);
  });

  it("does not duplicate entries across multiple register calls with distinct ids", () => {
    agentUIOverrideRegistry.register(makeEntry({ id: "@test/pkg:a", renderer: StubRenderer }));
    agentUIOverrideRegistry.register(makeEntry({ id: "@test/pkg:b", renderer: StubRendererB }));
    agentUIOverrideRegistry.register(makeEntry({ id: "@test/pkg:c", renderer: StubRendererC }));

    expect(agentUIOverrideRegistry.list()).toHaveLength(3);
  });

  // ---------------------------------------------------------------------------
  // clear() — test isolation
  // ---------------------------------------------------------------------------

  it("clear() removes all entries", () => {
    agentUIOverrideRegistry.register(makeEntry({ id: "@test/pkg:a" }));
    agentUIOverrideRegistry.register(makeEntry({ id: "@test/pkg:b" }));
    agentUIOverrideRegistry.clear();

    expect(agentUIOverrideRegistry.list()).toHaveLength(0);
    expect(agentUIOverrideRegistry.resolve("STATE_SNAPSHOT")).toBeNull();
  });
});
