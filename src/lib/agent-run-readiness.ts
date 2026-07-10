import "server-only";

// Agent RUN-READINESS gate (cinatra #1057 ruling (b)).
//
// SCOPE — the run-gate half of the post-install configuration-needs behaviour.
// The Extensions-page card (the greyed archived treatment + the needs-review
// strip) is the VISIBLE half; this module is the ENFORCEMENT half: an agent
// whose REQUIRED connector dependencies are not yet configured must NOT be
// runnable. Install is NEVER blocked — only RUNNING is gated (ruling (b)).
//
// This is the shared predicate every real dispatch surface routes through so
// the rule lives in ONE place and the surfaces cannot drift:
//   - the MCP `agent_run` primitive (execution) — packages/agents/mcp/handlers,
//   - the chat explicit-dispatch server surface (which also flows through the
//     `agent_run` primitive, gated with a clean terminal SSE before it),
//   - the widget stream dispatch route,
//   - the scheduling/trigger FIRE path (trigger-release-job), re-checked at
//     fire time so a trigger armed earlier does not fire once a connection is
//     later removed.
//
// It CONSUMES the stage-1 derivation (`resolveAgentConfigurationNeeds` +
// `summarizeConfigurationNeeds`): narrowed to AGENT-kind roots and their DIRECT
// REQUIRED connector dependencies only, per-connector-authoritative. A non-agent
// package, an agent with no required connector dependency, or an untracked /
// no-canonical-row package is OUT OF SCOPE and is never blocked here (the same
// bundled/ungoverned floor the runtime-lifecycle gate uses).
//
// FAIL-CLOSED on a DETERMINATE unconfigured result: the derivation is itself
// fail-soft at the probe boundary (a throwing/absent probe degrades to
// not-connected → surfaced as a still-needed connector → blocks), so an
// unconfigured connector reliably gates the run. The structured refusal NAMES
// each unconfigured connector (human-readable displayName + package id) so the
// caller can deep-link the operator to each setup page.
//
// This is a PLAIN lib module (NOT under **/permissions/** or
// **/capability-registry/**) — deliberately off the gate-suite highRiskPaths, so
// adding the run gate is a normal-risk change.

import type { ConnectorReadinessContext } from "@/lib/connectors-registry.server";
import type { ConfigurationNeedsSummary } from "@/lib/extension-dependency-ux";
import type {
  ExtensionDependency,
  ExtensionKind,
} from "@cinatra-ai/extensions/canonical-types";

/** Structured refusal code — stable, machine-readable, surfaced to callers. */
export const AGENT_RUN_CONNECTIONS_UNCONFIGURED =
  "AGENT_REQUIRED_CONNECTORS_UNCONFIGURED" as const;

/** One still-unconfigured required connector, named for the operator. */
export type UnconfiguredConnector = {
  /** Human-readable manifest displayName — the primary rendered label. */
  displayName: string;
  /** The connector's canonical package id (muted secondary text). */
  packageName: string;
  /** Deep-link to the connector's setup surface, or null when unresolved. */
  settingsHref: string | null;
};

/**
 * The fail-closed refusal returned when an agent's required connections are not
 * yet configured. `error` is the human string every dispatch primitive already
 * surfaces via its `{ error }` contract; the extra fields carry the STRUCTURED
 * naming (code + each unconfigured connector) for richer UIs / audit.
 */
export type AgentRunNotReadyError = {
  error: string;
  code: typeof AGENT_RUN_CONNECTIONS_UNCONFIGURED;
  /**
   * The agent identifier (packageName or template id) the caller passed. Kept
   * STABLE as the machine-readable secondary id so existing structured / JSON
   * consumers (409 body, SSE payload) that read `agent` as an identifier do not
   * break (cinatra #1234).
   */
  agent: string;
  /**
   * The agent's HUMAN-READABLE manifest displayName (cinatra #1234) — the label
   * the refusal `error` string and every user-facing surface render, resolved
   * via a descriptor lookup the canonical install row cannot supply. Falls back
   * to `agent` when no descriptor name resolves.
   */
  agentDisplayName: string;
  /** Each required connector still needing configuration (ordered). */
  unconfiguredConnectors: UnconfiguredConnector[];
};

/**
 * PURE decision: given the stage-1 configuration-needs summary for an agent,
 * return the fail-closed refusal (naming each unconfigured connector) or `null`
 * when the agent is runnable.
 *
 * Runnable (→ null) when the agent is out of scope (`hasConnectors: false` — a
 * non-agent root or an agent with no required connector dependency) OR every
 * required connector is configured (`allConfigured` / empty `needs`). No I/O.
 */
export function evaluateAgentRunReadiness(input: {
  agentIdentifier: string;
  /**
   * The agent's manifest displayName, when resolved (cinatra #1234). When absent
   * or blank the human label falls back to `agentIdentifier`, so the pure
   * function stays usable without a descriptor lookup.
   */
  agentDisplayName?: string | null;
  summary: ConfigurationNeedsSummary;
}): AgentRunNotReadyError | null {
  const { summary } = input;
  if (isAgentRunnable(summary)) {
    return null;
  }
  const unconfiguredConnectors: UnconfiguredConnector[] = summary.needs.map((n) => ({
    displayName: n.displayName,
    packageName: n.packageName,
    settingsHref: n.settingsHref,
  }));
  const names = unconfiguredConnectors.map((c) => c.displayName).join(", ");
  // Human name first (cinatra #1234): the refusal names the agent by its
  // manifest displayName; the raw identifier is only the fallback. `agent`
  // keeps the stable identifier for machine consumers.
  const agentDisplayName = input.agentDisplayName?.trim() || input.agentIdentifier;
  return {
    code: AGENT_RUN_CONNECTIONS_UNCONFIGURED,
    agent: input.agentIdentifier,
    agentDisplayName,
    unconfiguredConnectors,
    error: `Agent "${agentDisplayName}" cannot run until its required connections are configured: ${names}.`,
  };
}

/**
 * The runnable (→ `null`) predicate over a stage-1 summary. Shared so the async
 * resolver can short-circuit the extra displayName descriptor lookup on the
 * runnable fast path (out of scope, or every required connector configured).
 */
function isAgentRunnable(summary: ConfigurationNeedsSummary): boolean {
  return !summary.hasConnectors || summary.allConfigured || summary.needs.length === 0;
}

/** The minimal canonical-row shape the gate reads (kind + package + edges). */
type CanonicalAgentRow = {
  kind: ExtensionKind;
  packageName: string;
  dependencies: ExtensionDependency[];
};

/**
 * Test/isolation seams. Both default to the real readers via a FAIL-SOFT dynamic
 * import (the established `@cinatra-ai/agents` → `@cinatra-ai/extensions` /
 * `@/lib` boundary break — the call sites in packages/agents dynamic-import THIS
 * module the same way, avoiding a static build cycle). Injecting them lets the
 * unit test exercise the gate without a DB or the connector probe chain.
 */
export type AgentRunReadinessDeps = {
  readInstalled?: (packageName: string) => Promise<CanonicalAgentRow[]>;
  resolveNeeds?: (
    target: {
      kind: ExtensionKind;
      packageName: string;
      dependencies: readonly ExtensionDependency[];
    },
    ctx: ConnectorReadinessContext,
  ) => Promise<ConfigurationNeedsSummary>;
  /**
   * Resolve an agent package's human-readable manifest displayName (cinatra
   * #1234). Defaults to a FAIL-SOFT read of the agent template record's `name`
   * — the SAME manifest-derived name the Extensions card renders, a value the
   * canonical install row does not carry. Injected in tests to stay off the DB.
   */
  resolveAgentDisplayName?: (packageName: string) => Promise<string | null>;
};

/**
 * Resolve + evaluate the run-readiness gate for one agent package.
 *
 * @returns `null` when the package MAY run — no package (untracked/legacy), no
 *   agent-kind canonical row (out of scope / bundled floor), or every required
 *   connector configured; a {@link AgentRunNotReadyError} naming each
 *   unconfigured connector when the agent is in scope and NOT ready (fail-closed).
 *
 * Keys on the SAME canonical-row dependency source the Extensions-page card uses
 * (`readInstalledExtensionsByPackageName` → the agent row's `kind` +
 * `dependencies`), so the strip on the card and this gate always agree.
 */
export async function assertAgentRunReadyByPackage(
  packageName: string | null | undefined,
  agentIdentifier: string,
  ctx: ConnectorReadinessContext,
  deps: AgentRunReadinessDeps = {},
): Promise<AgentRunNotReadyError | null> {
  if (!packageName) return null; // no package → untracked/legacy → never blocked

  const readInstalled =
    deps.readInstalled ??
    (await import("@cinatra-ai/extensions/canonical-store"))
      .readInstalledExtensionsByPackageName;
  const rows = await readInstalled(packageName);
  const agentRow = rows.find((r) => r.kind === "agent");
  if (!agentRow) return null; // no agent-kind canonical row → out of scope

  const resolveNeeds =
    deps.resolveNeeds ??
    (await import("@/lib/configuration-needs.server")).resolveAgentConfigurationNeeds;
  const summary = await resolveNeeds(
    {
      kind: agentRow.kind,
      packageName: agentRow.packageName,
      dependencies: agentRow.dependencies,
    },
    ctx,
  );
  // Fast path: runnable → no refusal, so skip the extra descriptor lookup below.
  if (isAgentRunnable(summary)) return null;

  // Extra descriptor lookup (cinatra #1234): the canonical install row carries
  // no displayName, so resolve the agent's HUMAN name here — only now that we
  // are about to REFUSE, so the runnable fast path pays nothing for it. Reads
  // the agent template record's `name` (the same manifest-derived name the
  // Extensions card renders); FAIL-SOFT — an unresolved name falls back to the
  // package-id label inside `evaluateAgentRunReadiness`.
  const resolveAgentDisplayName =
    deps.resolveAgentDisplayName ??
    (async (pkg: string): Promise<string | null> => {
      try {
        const { readAgentTemplateByPackageName } = await import(
          "@cinatra-ai/agents/store"
        );
        return (await readAgentTemplateByPackageName(pkg))?.name ?? null;
      } catch {
        return null;
      }
    });
  const agentDisplayName = await resolveAgentDisplayName(agentRow.packageName);

  return evaluateAgentRunReadiness({
    agentIdentifier,
    agentDisplayName,
    summary,
  });
}
