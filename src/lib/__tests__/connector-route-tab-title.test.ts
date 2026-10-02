import { describe, expect, it } from "vitest";
import { buildBreadcrumbTrail, connectorRouteTabLabel, isConnectorDispatchPathname } from "../breadcrumb-trail";
import type { CrumbContribution } from "../breadcrumb-contributions";

const route = "/connectors/cinatra-ai/openai-connector/setup";
const label = (entries: CrumbContribution[]) => connectorRouteTabLabel(route, entries);
describe("connector route title from authorized crumb replacements", () => {
  it("uses the same connector name as the resolved trail leaf", () => {
    const contributions = [
      { prefix: "/connectors/cinatra-ai", label: "Cinatra" },
      { prefix: "/connectors/cinatra-ai/openai-connector", label: "OpenAI" },
      { prefix: route, label: "OpenAI" },
    ];
    expect(label(contributions)).toBe("OpenAI");
    expect(buildBreadcrumbTrail(route, { contributions }).at(-1)?.label).toBe(label(contributions));
  });
  it("ignores position-targeted entries even when their prefix matches", () => {
    expect(label([
      { prefix: route, label: "OpenAI" },
      { prefix: route, label: "Before", insertBefore: route },
      { prefix: route, label: "After", appendAfter: route },
    ])).toBe("OpenAI");
  });
  it("matches the publisher's last replacement wins rule", () => {
    expect(label([{ prefix: route, label: "Older" }, { prefix: route, label: "OpenAI" }])).toBe("OpenAI");
    expect(label([{ prefix: route, label: "OpenAI" }, { prefix: route, label: "" }])).toBeNull();
  });
  it("never borrows another connector's or an ancestor's label", () => {
    expect(label([{ prefix: "/connectors/cinatra-ai/other/setup", label: "Other" }])).toBeNull();
    expect(label([{ prefix: "/connectors/cinatra-ai/openai-connector", label: "OpenAI" }])).toBeNull();
    expect(label([])).toBeNull();
  });
  it.each(["/connectors", "/connectors/cinatra-ai/openai-connector", route + "/extra", "/agents/acme/writer/instance"])("does not select %s", (path) => {
    expect(isConnectorDispatchPathname(path)).toBe(false);
    expect(connectorRouteTabLabel(path, [{ prefix: path, label: "Unrelated" }])).toBeNull();
  });
  it("recognizes the dispatch path with a trailing slash", () => {
    expect(isConnectorDispatchPathname(route + "/")).toBe(true);
    expect(connectorRouteTabLabel(route + "/", [{ prefix: route, label: "OpenAI" }])).toBe("OpenAI");
  });
});
