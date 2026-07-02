// @vitest-environment jsdom
//
// PortletHost chrome-policy coverage for the keystone analytics kind
// (cinatra#325 §2b). PortletHost is the app-dir client renderer; it CANNOT
// import drizzle-cube/client, so it lazy-loads the analytics view through the
// app-local re-export with `next/dynamic`. Here both `next/dynamic` and the
// re-export module are mocked so the assertion is deterministic and free of the
// DC client bundle — what is under test is PortletHost's OWN behavior:
//
//   - an `analytics` portlet renders BARE: no surrounding `<Card>` / no
//     `CardHeader` showing `instanceId` + `kind@version`, full-width, and the
//     embedded `config.dashboard` is handed to the analytics view;
//   - the existing card kinds keep their titled `<Card>` stack (no regression);
//   - the `cube-dashboard` alias is treated identically (bare).

import * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

// `next/dynamic(loader)` where the host's loader is
// `() => import(...).then(m => m.EmbeddedDrizzleCubeDashboardGrid)` — i.e. the loader
// resolves DIRECTLY to the component (the `.then` already unwraps the named
// export). The mock mirrors that: await the loader, treat its resolved value as
// the component, render it once available (deterministic in jsdom; no Suspense).
vi.mock("next/dynamic", () => ({
  default: (loader: () => Promise<React.ComponentType<unknown>>) => {
    const Lazy: React.FC<Record<string, unknown>> = (props) => {
      const [Comp, setComp] = React.useState<React.ComponentType<unknown> | null>(null);
      React.useEffect(() => {
        let alive = true;
        void loader().then((resolved) => {
          if (alive) setComp(() => resolved);
        });
        return () => {
          alive = false;
        };
      }, []);
      return Comp ? React.createElement(Comp, props) : null;
    };
    return Lazy;
  },
}));

// The app-local analytics re-export → a probe that records the props it received
// (so we can assert the embedded dashboard config is threaded through).
const analyticsProbeProps: Array<Record<string, unknown>> = [];
vi.mock("@/components/dashboards/embedded-drizzle-cube-dashboard-grid", () => ({
  default: (props: Record<string, unknown>) => {
    analyticsProbeProps.push(props);
    return React.createElement("div", { "data-testid": "analytics-view" });
  },
  EmbeddedDrizzleCubeDashboardGrid: (props: Record<string, unknown>) => {
    analyticsProbeProps.push(props);
    return React.createElement("div", { "data-testid": "analytics-view" });
  },
}));

// The 9 card-kind portlet components pull in server-only data loaders/actions
// (objects-store, artifact-service, the generated extensions registry, …) that
// don't resolve under vitest and are irrelevant to PortletHost's chrome policy.
// Stub each to a marker so PortletHost's OWN card-vs-bare branching is what's
// exercised. A card kind only needs to render *something* inside its Card.
vi.mock("../portlets/object-list-portlet", () => ({ ObjectListPortlet: () => React.createElement("div", { "data-testid": "object-list" }) }));
vi.mock("../portlets/object-detail-portlet", () => ({ ObjectDetailPortlet: () => React.createElement("div", { "data-testid": "object-detail" }) }));
vi.mock("../portlets/artifact-list-portlet", () => ({ ArtifactListPortlet: () => React.createElement("div", { "data-testid": "artifact-list" }) }));
vi.mock("../portlets/object-version-history-portlet", () => ({ ObjectVersionHistoryPortlet: () => React.createElement("div", { "data-testid": "object-version-history" }) }));
vi.mock("../portlets/artifact-edit-text-portlet", () => ({ ArtifactEditTextPortlet: () => React.createElement("div", { "data-testid": "artifact-edit-text" }) }));
vi.mock("../portlets/artifact-edit-binary-prompt-portlet", () => ({ ArtifactEditBinaryPromptPortlet: () => React.createElement("div", { "data-testid": "artifact-edit-binary-prompt" }) }));
vi.mock("../portlets/workflow-launcher-portlet", () => ({ WorkflowLauncherPortlet: () => React.createElement("div", { "data-testid": "workflow-launcher" }) }));
vi.mock("../portlets/agent-launcher-portlet", () => ({ AgentLauncherPortlet: () => React.createElement("div", { "data-testid": "agent-launcher" }) }));
vi.mock("../portlets/workflow-status-portlet", () => ({ WorkflowStatusPortlet: () => React.createElement("div", { "data-testid": "workflow-status" }) }));

import { PortletHost, type PortletInstanceProp } from "../portlet-host";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mountedRoots: Root[] = [];

afterEach(() => {
  for (const root of mountedRoots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
  analyticsProbeProps.length = 0;
});

async function mount(portlets: PortletInstanceProp[]) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);
  await act(async () => {
    root.render(<PortletHost portlets={portlets} rowContext={{}} />);
  });
  // flush the dynamic loader microtask + its effect.
  await act(async () => {
    await Promise.resolve();
  });
  return container;
}

const EMBEDDED_DASHBOARD = {
  portlets: [
    {
      id: "p",
      title: "P",
      w: 6,
      h: 8,
      x: 0,
      y: 0,
      analysisConfig: { version: 1, analysisType: "query", query: { measures: ["agent_runs.count"] } },
    },
  ],
  layoutMode: "grid",
  grid: { cols: 12, rowHeight: 50, minW: 3, minH: 4 },
};

function analyticsPortlet(kind = "analytics"): PortletInstanceProp {
  return {
    instanceId: "analytics",
    kind,
    version: "1.0.0",
    slot: "fixed",
    config: { dashboard: EMBEDDED_DASHBOARD },
  };
}

describe("PortletHost — analytics bare-chrome policy (cinatra#325 §2b)", () => {
  it("renders an analytics portlet BARE: no Card chrome, no instanceId/kind header", async () => {
    const c = await mount([analyticsPortlet()]);

    // The analytics view mounted...
    expect(c.querySelector("[data-testid='analytics-view']")).not.toBeNull();
    // ...with NO surrounding titled Card (the card kinds use border-line + a
    // CardHeader showing instanceId; analytics must have neither).
    expect(c.querySelector(".border-line")).toBeNull();
    expect(c.textContent).not.toContain("analytics@1.0.0");
  });

  it("hands the embedded config.dashboard to the analytics view", async () => {
    await mount([analyticsPortlet()]);
    expect(analyticsProbeProps.length).toBeGreaterThan(0);
    expect(analyticsProbeProps[0]!.dashboard).toEqual(EMBEDDED_DASHBOARD);
  });

  it("treats the `cube-dashboard` alias identically (bare)", async () => {
    const c = await mount([analyticsPortlet("cube-dashboard")]);
    expect(c.querySelector("[data-testid='analytics-view']")).not.toBeNull();
    expect(c.querySelector(".border-line")).toBeNull();
  });

  it("keeps non-analytics kinds in their titled Card (no regression)", async () => {
    const c = await mount([
      { instanceId: "ol", kind: "object-list", version: "1.0.0", slot: "fixed", config: { typeId: "x" } },
    ]);
    // A card kind renders inside the bordered Card with its instanceId header.
    expect(c.querySelector(".border-line")).not.toBeNull();
    expect(c.textContent).toContain("object-list@1.0.0");
    expect(c.querySelector("[data-testid='analytics-view']")).toBeNull();
  });

  it("degrades gracefully when an analytics portlet is missing its embedded dashboard", async () => {
    const c = await mount([
      { instanceId: "analytics", kind: "analytics", version: "1.0.0", slot: "fixed", config: {} },
    ]);
    expect(c.querySelector("[data-testid='analytics-view']")).toBeNull();
    expect(c.textContent).toContain("missing its");
  });
});
