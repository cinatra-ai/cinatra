// @vitest-environment jsdom
//
// ProjectOverviewDashboard (cinatra#706 Overview via the #702 portlet model).
// End-to-end at the render seam: the FRESH project-summary config built by
// `buildProjectOverviewConfig` flows through the REAL `<PortletHost>` dispatch
// and the REAL render-only entity-metadata / entity-count portlets, proving the
// project's current metadata + sealed-room counts surface as portlets (the AC's
// Overview content). No drizzle-cube is involved (the summary portlets are pure
// presentation). The OTHER portlet kinds `<PortletHost>` statically imports are
// stubbed — they never render for the Overview config and only their heavy
// transitive module graphs would otherwise load in the node test env.

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";

vi.mock("@/components/dashboards/portlets/object-list-portlet", () => ({
  ObjectListPortlet: () => null,
}));
vi.mock("@/components/dashboards/portlets/object-detail-portlet", () => ({
  ObjectDetailPortlet: () => null,
}));
vi.mock("@/components/dashboards/portlets/artifact-list-portlet", () => ({
  ArtifactListPortlet: () => null,
}));
vi.mock("@/components/dashboards/portlets/object-version-history-portlet", () => ({
  ObjectVersionHistoryPortlet: () => null,
}));
vi.mock("@/components/dashboards/portlets/artifact-edit-text-portlet", () => ({
  ArtifactEditTextPortlet: () => null,
}));
vi.mock("@/components/dashboards/portlets/artifact-edit-binary-prompt-portlet", () => ({
  ArtifactEditBinaryPromptPortlet: () => null,
}));
vi.mock("@/components/dashboards/portlets/agent-launcher-portlet", () => ({
  AgentLauncherPortlet: () => null,
}));

import { buildProjectOverviewConfig } from "@cinatra-ai/dashboards/overview-config";
import type { PortletInstanceProp } from "@/components/dashboards/portlet-host";
import { ProjectOverviewDashboard } from "../project-overview-dashboard";

afterEach(cleanup);

function overviewPortlets(): PortletInstanceProp[] {
  return buildProjectOverviewConfig({
    name: "Apollo",
    slug: "apollo",
    id: "proj_1",
    owner: "Jane Doe",
    organizationName: "Acme",
    visibility: "Private",
    createdAt: "Jul 15, 2026",
    description: "Launch pad.",
    counts: [
      { label: "Objects", value: 4 },
      { label: "Agent runs", value: 2 },
      { label: "Chat threads", value: 1 },
    ],
  }).portlets.map((p) => ({
    instanceId: p.instanceId,
    kind: p.kind,
    version: p.version,
    slot: p.slot,
    config: p.config as Record<string, unknown>,
  }));
}

describe("ProjectOverviewDashboard (#706)", () => {
  it("renders the project metadata as an entity-metadata portlet", () => {
    render(<ProjectOverviewDashboard portlets={overviewPortlets()} />);
    for (const value of [
      "Apollo",
      "apollo",
      "proj_1",
      "Jane Doe",
      "Acme",
      "Private",
      "Jul 15, 2026",
      "Launch pad.",
    ]) {
      expect(screen.getByText(value), `expected metadata value "${value}"`).toBeTruthy();
    }
  });

  it("renders the sealed-room counts as an entity-count portlet", () => {
    render(<ProjectOverviewDashboard portlets={overviewPortlets()} />);
    for (const label of ["Objects", "Agent runs", "Chat threads"]) {
      expect(screen.getByText(label), `expected count label "${label}"`).toBeTruthy();
    }
    // The count VALUES render as big stat numbers.
    expect(screen.getByText("4")).toBeTruthy();
    expect(screen.getByText("2")).toBeTruthy();
    expect(screen.getByText("1")).toBeTruthy();
  });
});
