"use client";

import { useState, type MouseEvent, type ReactNode } from "react";
import { AgentAllCard } from "@/components/extensions/agent-all-card";
import { RunStartRefusedPanel } from "../../../../packages/agents/src/run-start-refused-panel";
import type { MarketplaceDetailLoadResult } from "@/lib/marketplace-detail-view";
import {
  RUN_ELIGIBILITY_AGENT,
  RUN_ELIGIBILITY_MISSING,
  RUN_ELIGIBILITY_READERS,
  runEligibilityCardRow,
  type RunEligibilityReader,
} from "./agent-run-eligibility-fixture-data";

// The member-authorized modal's read transport is the only substitute. The
// actual card and actual modal stay mounted; these surfaces perform no writes.
const loadDetail = async (): Promise<MarketplaceDetailLoadResult> => ({ ok: false, reason: "not_found" });

/**
 * The existing static conformance navigation-port road: preserve the product
 * Link and its actual href/click, but consume the dispatch at the fixture
 * boundary. The anonymous harness does not fabricate a session or destination
 * page. Authenticated arrival is exercised on the actual host separately.
 * Settings and More details are not this port's actions and remain untouched.
 */
function NavigationPort({ reader, surface, children }: {
  reader: RunEligibilityReader;
  surface: "agent-card-cannot-run" | "agent-start-refused";
  children: ReactNode;
}) {
  const [navigation, setNavigation] = useState<{ outcome: string; destination: string } | null>(null);
  function dispatch(event: MouseEvent<HTMLDivElement>) {
    const target = event.target instanceof Element ? event.target.closest("a") : null;
    if (!target || !event.currentTarget.contains(target)) return;
    const href = target.getAttribute("href");
    let outcome: string | null = null;
    if (reader === "administrator" && href === RUN_ELIGIBILITY_AGENT.listingHref && (
      target.getAttribute("data-slot") === "agent-card-unavailable-action" ||
      target.getAttribute("data-action") === "view-requirements -> agent-listing-open"
    )) outcome = "agent-listing-open";
    if (surface === "agent-start-refused" && href === RUN_ELIGIBILITY_AGENT.agentsHref &&
      target.getAttribute("data-action") === "back-to-agents -> scope-agents-tab") outcome = "scope-agents-tab";
    if (!outcome || !href) return;
    event.preventDefault();
    event.stopPropagation();
    setNavigation({ outcome, destination: href });
  }
  return <div data-reader={reader} data-state={surface === "agent-start-refused" ? "error kind:agent" : "kind:agent"}
    data-outcome={navigation?.outcome ?? "idle"} data-destination={navigation?.destination ?? ""} onClickCapture={dispatch}>
    {children}
  </div>;
}

/** Extensions §IV.1–2 on the already required functional-acceptance harness. */
export function AgentRunEligibilityFixtures() {
  return (
    <>
      <section data-surface-id="agent-card-cannot-run" className="grid gap-6">
        {RUN_ELIGIBILITY_READERS.map((reader) => (
          <NavigationPort key={reader} reader={reader} surface="agent-card-cannot-run">
            <AgentAllCard row={runEligibilityCardRow(reader)} loadDetail={loadDetail} />
          </NavigationPort>
        ))}
      </section>
      <section data-surface-id="agent-start-refused" className="grid gap-6">
        {RUN_ELIGIBILITY_READERS.map((reader) => (
          <NavigationPort key={reader} reader={reader} surface="agent-start-refused">
            <RunStartRefusedPanel
              agentName={RUN_ELIGIBILITY_AGENT.name}
              missing={RUN_ELIGIBILITY_MISSING.slice(0, 1)}
              requirementsHref={reader === "administrator" ? RUN_ELIGIBILITY_AGENT.listingHref : null}
              agentsHref={RUN_ELIGIBILITY_AGENT.agentsHref}
              crumbEntries={[]}
            />
          </NavigationPort>
        ))}
      </section>
    </>
  );
}
