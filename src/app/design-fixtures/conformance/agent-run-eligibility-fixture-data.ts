import type { AgentAllCardRow } from "@/components/extensions/agent-all-card";
import type { MissingAgentDependency } from "../../../../packages/agents/src/runtime-install-gate";
import type { ConnectorConfigurationRefusal } from "../../../../packages/agents/src/actionable-preflight-error";

/** Fictional catalog DATA; the production card and refusal panel own presentation. */
export const RUN_ELIGIBILITY_AGENT = {
  name: "List Curator",
  packageName: "@cinatra-fixtures/list-curator",
  description: "Curates useful lists from your team's sources.",
  listingHref: "/configuration/marketplace/cinatra-fixtures/list-curator",
  settingsHref: "/workspace/agents/cinatra-fixtures/list-curator/settings?tab=skills",
  runHref: "/workspace/agents/cinatra-fixtures/list-curator/new",
  agentsHref: "/workspace/agents",
} as const;

export const RUN_ELIGIBILITY_MISSING: readonly MissingAgentDependency[] = [
  { packageName: "@cinatra-fixtures/list-curation", displayName: "List Curation Skill", kind: "skill", reason: "not-installed" },
  { packageName: "@cinatra-fixtures/source-records", displayName: "Source Records", kind: "artifact", reason: "not-installed" },
];

export const RUN_ELIGIBILITY_READERS = ["administrator", "member"] as const;
export type RunEligibilityReader = (typeof RUN_ELIGIBILITY_READERS)[number];

export function runEligibilityCardRow(reader: RunEligibilityReader, missing: readonly MissingAgentDependency[] = RUN_ELIGIBILITY_MISSING.slice(0, 1)): AgentAllCardRow {
  const names = missing.map((dependency) => dependency.displayName ?? dependency.packageName).join(", ");
  const administrator = reader === "administrator";
  return {
    key: RUN_ELIGIBILITY_AGENT.packageName,
    name: RUN_ELIGIBILITY_AGENT.name,
    description: RUN_ELIGIBILITY_AGENT.description,
    host: "local",
    packageName: RUN_ELIGIBILITY_AGENT.packageName,
    runHref: RUN_ELIGIBILITY_AGENT.runHref,
    detailHref: administrator ? RUN_ELIGIBILITY_AGENT.listingHref : null,
    settingsHref: RUN_ELIGIBILITY_AGENT.settingsHref,
    unavailable: missing.length ? {
      reason: `This agent cannot run: ${names} ${missing.length === 1 ? "is" : "are"} not installed.`,
      ctaLabel: administrator ? "View requirements" : null,
      ctaHref: administrator ? RUN_ELIGIBILITY_AGENT.listingHref : null,
      ctaAriaLabel: `${RUN_ELIGIBILITY_AGENT.name} cannot run — ${names} not installed.${administrator ? " View requirements" : ""}`,
    } : null,
  };
}

/**
 * Fictional connection DATA for Extensions §IV.4 (a start a missing connection
 * refuses). The display name shares no token with the package identity, so a
 * field bound to the identity instead of the declared name reads differently.
 * `settingsHref` is the setup route connectorSetupRoute derives for this
 * identity (the fixture test pins the two equal).
 */
export const RUN_ELIGIBILITY_CONNECTOR = {
  packageId: "@cinatra-fixtures/tidewater-connector",
  displayName: "Harbor Records",
  settingsHref: "/connectors/cinatra-fixtures/tidewater-connector/setup",
} as const;

/** The reader who may set the connection up gets its setup route; a member gets none. */
export function runEligibilityConnectorRefusal(reader: RunEligibilityReader): ConnectorConfigurationRefusal {
  return {
    packageId: RUN_ELIGIBILITY_CONNECTOR.packageId,
    displayName: RUN_ELIGIBILITY_CONNECTOR.displayName,
    settingsHref: reader === "administrator" ? RUN_ELIGIBILITY_CONNECTOR.settingsHref : null,
  };
}
