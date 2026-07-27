// The per-agent execution-config editor renders honestly (exec-plane S3 slice B,
// cinatra#1708).
//
// Static render (the project's renderToStaticMarkup convention — the root vitest
// env is node, so no interaction is simulated here; the interactive rules live
// in the pure model suites). What this locks is what a human actually SEES:
//
//   - the dormancy banner is present whenever the plane is off, so the surface
//     never implies a stored declaration is executing;
//   - a manifest-owned environment renders read-only, with the review path named
//     and no save button / starter templates;
//   - the promotion affordance renders its honest empty state rather than an
//     invented suggestion.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { AgentExecutionConfigClient } from "@/components/execution/agent-execution-config-client";
import { buildAgentExecutionConfigView } from "@/lib/execution/agent-execution-config-view";

const base = {
  packageName: "@cinatra-ai/some-agent",
  displayName: "Some Agent",
  templateId: "t_1",
};

const noopSave = async () => ({ ok: true }) as const;

describe("inert-plane rendering (today's default)", () => {
  const html = renderToStaticMarkup(
    <AgentExecutionConfigClient
      view={buildAgentExecutionConfigView({
        ...base,
        serviceState: "disabled",
        templateEnvironment: { pip: ["pandas"] },
      })}
      save={noopSave}
    />,
  );

  it("states the plane is OFF instead of implying the declaration is running", () => {
    expect(html).toContain("execution-dormancy-headline");
    expect(html).toMatch(/off on this instance/i);
    expect(html).toMatch(/refused rather than quietly running/i);
  });

  it("still shows the declared packages — dormancy hides nothing", () => {
    expect(html).toContain("pandas");
    expect(html).toContain("execution-env-pip");
  });

  it("offers the editing affordances (a dormant plane is configurable, not frozen)", () => {
    expect(html).toContain("execution-config-save");
    expect(html).toContain("execution-starter-template");
  });

  it("blames the dormant plane for having nothing to promote", () => {
    expect(html).toContain("execution-promotion-empty");
    expect(html).toMatch(/execution plane is off/i);
  });
});

describe("manifest-owned environment renders read-only", () => {
  const html = renderToStaticMarkup(
    <AgentExecutionConfigClient
      view={buildAgentExecutionConfigView({
        ...base,
        serviceState: "disabled",
        manifestEnvironment: { os: ["pandoc"] },
      })}
    />,
  );

  it("names the extension review path", () => {
    expect(html).toContain("execution-readonly-reason");
    expect(html).toMatch(/review and lock choreography/i);
  });

  it("renders NO save button and NO starter templates", () => {
    expect(html).not.toContain("execution-config-save");
    expect(html).not.toContain("execution-starter-template");
  });

  it("still shows the declared packages", () => {
    expect(html).toContain("pandoc");
  });
});

describe("promotion candidates", () => {
  const html = renderToStaticMarkup(
    <AgentExecutionConfigClient
      view={buildAgentExecutionConfigView({
        ...base,
        serviceState: "ready",
        promotionCandidates: [
          { manager: "os", packageName: "pandoc", runCount: 6, windowRuns: 10 },
        ],
      })}
      save={noopSave}
    />,
  );

  it("states the observation that motivates the suggestion", () => {
    expect(html).toContain("execution-promotion-list");
    expect(html).toMatch(/6 of the last 10/);
  });

  it("offers an ADD affordance that prefills the editor (never a silent mutation)", () => {
    expect(html).toContain("execution-promote");
    // The change is not applied until the human saves.
    expect(html).toContain("execution-config-save");
  });
});

describe("invalid declaration", () => {
  it("surfaces the parser errors instead of a salvaged recipe", () => {
    const html = renderToStaticMarkup(
      <AgentExecutionConfigClient
        view={buildAgentExecutionConfigView({
          ...base,
          serviceState: "disabled",
          templateEnvironment: { pip: ["pandas"], typo: [] },
        })}
        save={noopSave}
      />,
    );
    // Declaration problems get their own heading — they are not a save failure.
    expect(html).toContain("execution-declaration-errors");
    expect(html).toMatch(/unknown key/i);
    expect(html).not.toMatch(/was not saved/i);
  });
});

describe("an unreadable manifest", () => {
  const html = renderToStaticMarkup(
    <AgentExecutionConfigClient
      view={buildAgentExecutionConfigView({
        ...base,
        serviceState: "disabled",
        packaged: true,
        manifestReadFailed: true,
      })}
    />,
  );

  it("says the declaration is UNKNOWN under its own heading (not 'not saved')", () => {
    expect(html).toContain("execution-declaration-errors");
    expect(html).toMatch(/not usable/i);
    expect(html).toMatch(/UNKNOWN/);
    expect(html).not.toMatch(/was not saved/i);
  });

  it("is read-only", () => {
    expect(html).not.toContain("execution-config-save");
  });
});
