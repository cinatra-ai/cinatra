// cinatra #1057 ruling (c) — agent post-install "needs configuration" BELL
// FLYOUT entry lifecycle. PURE: drives the builder + the reconciler; no DB, no
// notifications host, no React. The reconciler is the single source of truth
// for "entry appears / entry clears" so the lifecycle contract is pinned here.
import { describe, expect, it } from "vitest";

import type { AppNotification } from "@cinatra-ai/notifications/types";
import {
  AGENT_CONFIGURATION_NEEDS_CATEGORY,
  getConfigurationNeedsMetadata,
} from "@cinatra-ai/notifications/flyout-state";

import {
  buildConfigurationNeedsNotificationInput,
  configurationNeedsDedupeKey,
  reconcileConfigurationNeedsNotifications,
  type GatedAgent,
} from "@/lib/agent-configuration-needs-notifications";

function connector(name: string) {
  return {
    displayName: name.replace(/^@[^/]+\//, "").replace(/-connector$/, ""),
    packageName: name,
    settingsHref: `/connectors/cinatra-ai/${name
      .replace(/^@[^/]+\//, "")
      .replace(/-connector$/, "")}/setup`,
  };
}

function gated(pkg: string, display: string, connectors: string[]): GatedAgent {
  return {
    agentPackageName: pkg,
    agentDisplayName: display,
    connectors: connectors.map(connector),
  };
}

/**
 * Wrap a gated agent into the AppNotification shape the reconciler reads as an
 * EXISTING entry — exactly what `createNotificationForRecipient` would persist
 * from `buildConfigurationNeedsNotificationInput`.
 */
function existingEntry(agent: GatedAgent, id = agent.agentPackageName): AppNotification {
  const input = buildConfigurationNeedsNotificationInput(agent);
  return {
    id,
    title: input.title,
    body: input.body ?? "",
    kind: "warning",
    createdAt: "2026-07-10T00:00:00.000Z",
    dedupeKey: input.dedupeKey,
    metadata: input.metadata,
  };
}

describe("buildConfigurationNeedsNotificationInput — ruling (c) copy + links", () => {
  it('titles the entry `Set up connections for "<displayName>":`', () => {
    const input = buildConfigurationNeedsNotificationInput(
      gated("@cinatra-ai/sales-agent", "Sales Agent", ["@cinatra-ai/apollo-connector"]),
    );
    expect(input.title).toBe('Set up connections for "Sales Agent":');
    expect(input.kind).toBe("warning");
  });

  it("carries each required connector's displayName + setup link in metadata", () => {
    const input = buildConfigurationNeedsNotificationInput(
      gated("@cinatra-ai/sales-agent", "Sales Agent", [
        "@cinatra-ai/apollo-connector",
        "@cinatra-ai/linkedin-connector",
      ]),
    );
    const meta = (input.metadata as { configurationNeeds: unknown })
      .configurationNeeds as {
      agentDisplayName: string;
      connectors: { displayName: string; settingsHref: string | null }[];
    };
    expect(meta.agentDisplayName).toBe("Sales Agent");
    expect(meta.connectors.map((c) => c.displayName)).toEqual(["apollo", "linkedin"]);
    expect(meta.connectors.map((c) => c.settingsHref)).toEqual([
      "/connectors/cinatra-ai/apollo/setup",
      "/connectors/cinatra-ai/linkedin/setup",
    ]);
    // The metadata round-trips through the shared browser-safe extractor.
    const extracted = getConfigurationNeedsMetadata({
      id: "n",
      title: input.title,
      body: "",
      kind: "warning",
      createdAt: "2026-07-10T00:00:00.000Z",
      metadata: input.metadata,
    });
    expect(extracted?.agentDisplayName).toBe("Sales Agent");
    expect(extracted?.connectors).toHaveLength(2);
    expect(
      (input.metadata as { category: string }).category,
    ).toBe(AGENT_CONFIGURATION_NEEDS_CATEGORY);
  });

  it("keys the entry on a stable per-agent dedupeKey", () => {
    expect(configurationNeedsDedupeKey("@cinatra-ai/sales-agent")).toBe(
      "agent-config-needs:@cinatra-ai/sales-agent",
    );
    const input = buildConfigurationNeedsNotificationInput(
      gated("@cinatra-ai/sales-agent", "Sales Agent", ["@cinatra-ai/apollo-connector"]),
    );
    expect(input.dedupeKey).toBe("agent-config-needs:@cinatra-ai/sales-agent");
  });
});

describe("reconcileConfigurationNeedsNotifications — entry lifecycle", () => {
  it("APPEARS: a newly-gated agent with no existing entry → one create, no clear", () => {
    const { toCreateInputs, toClearDedupeKeys } =
      reconcileConfigurationNeedsNotifications({
        gatedAgents: [gated("@cinatra-ai/sales-agent", "Sales Agent", ["@cinatra-ai/apollo-connector"])],
        existing: [],
      });
    expect(toClearDedupeKeys).toEqual([]);
    expect(toCreateInputs).toHaveLength(1);
    expect(toCreateInputs[0]!.title).toBe('Set up connections for "Sales Agent":');
  });

  it("STAYS: a gated agent that already has a matching entry → no-op", () => {
    const agent = gated("@cinatra-ai/sales-agent", "Sales Agent", ["@cinatra-ai/apollo-connector"]);
    const { toCreateInputs, toClearDedupeKeys } =
      reconcileConfigurationNeedsNotifications({
        gatedAgents: [agent],
        existing: [existingEntry(agent)],
      });
    expect(toCreateInputs).toEqual([]);
    expect(toClearDedupeKeys).toEqual([]);
  });

  it("CLEARS: an agent that became runnable (no longer gated) → clear its entry, no create", () => {
    const agent = gated("@cinatra-ai/sales-agent", "Sales Agent", ["@cinatra-ai/apollo-connector"]);
    const { toCreateInputs, toClearDedupeKeys } =
      reconcileConfigurationNeedsNotifications({
        gatedAgents: [], // every required connection now configured
        existing: [existingEntry(agent)],
      });
    expect(toCreateInputs).toEqual([]);
    expect(toClearDedupeKeys).toEqual(["agent-config-needs:@cinatra-ai/sales-agent"]);
  });

  it("RECREATES on content change: one of two connectors configured → clear stale + create accurate", () => {
    const before = gated("@cinatra-ai/sales-agent", "Sales Agent", [
      "@cinatra-ai/apollo-connector",
      "@cinatra-ai/linkedin-connector",
    ]);
    const after = gated("@cinatra-ai/sales-agent", "Sales Agent", ["@cinatra-ai/linkedin-connector"]);
    const { toCreateInputs, toClearDedupeKeys } =
      reconcileConfigurationNeedsNotifications({
        gatedAgents: [after],
        existing: [existingEntry(before)],
      });
    expect(toClearDedupeKeys).toEqual(["agent-config-needs:@cinatra-ai/sales-agent"]);
    expect(toCreateInputs).toHaveLength(1);
    const meta = (toCreateInputs[0]!.metadata as { configurationNeeds: { connectors: unknown[] } })
      .configurationNeeds;
    expect(meta.connectors).toHaveLength(1);
  });

  it("MULTIPLE affected agents → one create each, one entry per agent", () => {
    const a = gated("@cinatra-ai/sales-agent", "Sales Agent", ["@cinatra-ai/apollo-connector"]);
    const b = gated("@cinatra-ai/support-agent", "Support Agent", ["@cinatra-ai/zendesk-connector"]);
    const { toCreateInputs, toClearDedupeKeys } =
      reconcileConfigurationNeedsNotifications({
        gatedAgents: [a, b],
        existing: [],
      });
    expect(toClearDedupeKeys).toEqual([]);
    expect(toCreateInputs.map((i) => i.dedupeKey).sort()).toEqual([
      "agent-config-needs:@cinatra-ai/sales-agent",
      "agent-config-needs:@cinatra-ai/support-agent",
    ]);
  });

  it("mixed transition: one agent still gated (stays), one runnable (clears), one new (creates)", () => {
    const stays = gated("@cinatra-ai/a-agent", "A", ["@cinatra-ai/x-connector"]);
    const cleared = gated("@cinatra-ai/b-agent", "B", ["@cinatra-ai/y-connector"]);
    const created = gated("@cinatra-ai/c-agent", "C", ["@cinatra-ai/z-connector"]);
    const { toCreateInputs, toClearDedupeKeys } =
      reconcileConfigurationNeedsNotifications({
        gatedAgents: [stays, created],
        existing: [existingEntry(stays), existingEntry(cleared)],
      });
    expect(toClearDedupeKeys).toEqual(["agent-config-needs:@cinatra-ai/b-agent"]);
    expect(toCreateInputs.map((i) => i.dedupeKey)).toEqual([
      "agent-config-needs:@cinatra-ai/c-agent",
    ]);
  });

  it("NO ENTRY for a non-agent install / non-gated set → no create, no clear", () => {
    // A non-agent (or an agent with all required connectors configured) never
    // reaches the gated set — the caller derives an empty `gatedAgents`.
    const { toCreateInputs, toClearDedupeKeys } =
      reconcileConfigurationNeedsNotifications({ gatedAgents: [], existing: [] });
    expect(toCreateInputs).toEqual([]);
    expect(toClearDedupeKeys).toEqual([]);
  });

  it("ignores unrelated existing notifications (job/progress rows are never touched)", () => {
    const jobRow: AppNotification = {
      id: "job-1",
      title: "Blog post generated",
      body: "done",
      kind: "success",
      createdAt: "2026-07-10T00:00:00.000Z",
      sourceJobId: "job-1",
      metadata: { category: "background_process" },
    };
    const agent = gated("@cinatra-ai/sales-agent", "Sales Agent", ["@cinatra-ai/apollo-connector"]);
    const { toCreateInputs, toClearDedupeKeys } =
      reconcileConfigurationNeedsNotifications({
        gatedAgents: [agent],
        existing: [jobRow],
      });
    // The job row is neither cleared nor counted as an existing config entry.
    expect(toClearDedupeKeys).toEqual([]);
    expect(toCreateInputs).toHaveLength(1);
  });
});
