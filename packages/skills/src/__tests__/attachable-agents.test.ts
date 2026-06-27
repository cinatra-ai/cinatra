/**
 * Unit tests for the personal-skill authoring agent filter.
 *
 * Pins the contract that the `/skills/new` + `/skills/:id/edit` "Agent"
 * dropdown (and the matching save validation) only offers user-facing,
 * currently-installed agents — never the internal `@cinatra/system-*` runtime
 * templates whose slug-derived `id` carries the `system-` prefix.
 */
import { describe, it, expect } from "vitest";

import {
  isSystemAgentId,
  selectAttachableAgents,
  SYSTEM_AGENT_ID_PREFIX,
} from "../attachable-agents";

describe("isSystemAgentId", () => {
  it("flags the seeded @cinatra/system-* runtime templates", () => {
    expect(isSystemAgentId("system-scrape")).toBe(true);
    expect(isSystemAgentId("system-research")).toBe(true);
    expect(isSystemAgentId("system-enrichment")).toBe(true);
  });

  it("does not flag ordinary user-facing agents", () => {
    expect(isSystemAgentId("email-outreach-agent")).toBe(false);
    expect(isSystemAgentId("web-scrape-agent")).toBe(false);
    // No false-positive on an agent that merely contains "system".
    expect(isSystemAgentId("crm-system-sync")).toBe(false);
  });

  it("uses the exported reserved prefix", () => {
    expect(SYSTEM_AGENT_ID_PREFIX).toBe("system-");
    expect(isSystemAgentId(`${SYSTEM_AGENT_ID_PREFIX}anything`)).toBe(true);
  });
});

describe("selectAttachableAgents", () => {
  it("drops system-* agents and keeps user-facing agents", () => {
    const agents = [
      { id: "email-outreach-agent", humanReadableName: "Email Outreach Agent" },
      { id: "system-scrape", humanReadableName: "Scrape Agent" },
      { id: "web-scrape-agent", humanReadableName: "Web Scrape Agent" },
      { id: "system-research", humanReadableName: "Research Agent" },
      { id: "system-enrichment", humanReadableName: "Enrichment Agent" },
    ];

    const result = selectAttachableAgents(agents);

    expect(result.map((a) => a.id)).toEqual([
      "email-outreach-agent",
      "web-scrape-agent",
    ]);
  });

  it("returns an empty list when every agent is a system agent", () => {
    const agents = [{ id: "system-scrape" }, { id: "system-research" }];
    expect(selectAttachableAgents(agents)).toEqual([]);
  });

  it("preserves input order and is a no-op when no system agents are present", () => {
    const agents = [{ id: "b-agent" }, { id: "a-agent" }];
    expect(selectAttachableAgents(agents)).toEqual([
      { id: "b-agent" },
      { id: "a-agent" },
    ]);
  });
});
