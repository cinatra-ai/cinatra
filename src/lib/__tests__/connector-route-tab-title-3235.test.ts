import { describe, expect, it } from "vitest";

import {
  agentInstanceTabLabel,
  buildBreadcrumbTrail,
  connectorRouteTabLabel,
  isConnectorDispatchPathname,
} from "@/lib/breadcrumb-trail";
import type { CrumbContribution } from "@/lib/breadcrumb-contributions";

// ---------------------------------------------------------------------------
// THE CONNECTOR ROUTE'S TAB TITLE MIRRORS THE TRAIL (cinatra#3235).
//
// The ratified drawing, Components/Breadcrumb: "The browser-tab title mirrors
// the resolved trail under the same rules: an id-bearing route never shows a
// raw id in the tab." The mirror recognised the agents area alone, so a
// connector setup page fell through to the humanized last path segment and
// every connector's tab read the same word — "Setup | Cinatra" — the name of a
// tab strip drawn inside the page, not the connector the reader opened.
//
// This file locks the shell's widened selection: the label is the connector's
// server-authorized display name, published as a REPLACEMENT contribution for
// the route's own four-segment path, read through the crumb-contributions bus
// the agents mirror reads, with the POSITION-targeted entries skipped.
// ---------------------------------------------------------------------------

const crumb = (prefix: string, label: string): CrumbContribution => ({ prefix, label });

describe("cinatra#3235 — the connector route's tab label", () => {
  it("reads the display name the route published for its own four-segment path", () => {
    expect(
      connectorRouteTabLabel("/connectors/cinatra-ai/openai-connector/setup", [
        crumb("/connectors/cinatra-ai", "Cinatra"),
        crumb("/connectors/cinatra-ai/openai-connector", "OpenAI"),
        crumb("/connectors/cinatra-ai/openai-connector/setup", "OpenAI"),
      ]),
    ).toBe("OpenAI");
    expect(
      connectorRouteTabLabel(
        "/connectors/cinatra-ai/google-appointment-schedules-connector/setup",
        [
          crumb(
            "/connectors/cinatra-ai/google-appointment-schedules-connector/setup",
            "Google Appointment Schedules",
          ),
        ],
      ),
    ).toBe("Google Appointment Schedules");
  });

  it("is the SAME string the resolved trail's leaf crumb reads", () => {
    const contributions = [
      crumb("/connectors/cinatra-ai", "Cinatra"),
      crumb("/connectors/cinatra-ai/openai-connector", "OpenAI"),
      crumb("/connectors/cinatra-ai/openai-connector/setup", "OpenAI"),
    ];
    const pathname = "/connectors/cinatra-ai/openai-connector/setup";
    const trail = buildBreadcrumbTrail(pathname, { contributions });
    expect(connectorRouteTabLabel(pathname, contributions)).toBe(
      trail[trail.length - 1].label,
    );
    // And it is never the page's own tab strip.
    expect(connectorRouteTabLabel(pathname, contributions)).not.toBe("Setup");
  });

  it("skips the position-targeted entries — they name a position, not this route", () => {
    const pathname = "/connectors/cinatra-ai/openai-connector/setup";
    expect(
      connectorRouteTabLabel(pathname, [
        {
          prefix: pathname,
          label: "Appended step",
          appendAfter: "/connectors/cinatra-ai/openai-connector",
        },
      ]),
    ).toBeNull();
    expect(
      connectorRouteTabLabel(pathname, [
        {
          prefix: pathname,
          label: "Synthesized ancestor",
          insertBefore: "/connectors/cinatra-ai/openai-connector",
        },
      ]),
    ).toBeNull();
    // A replacement entry beside them still wins — the position-targeted entry
    // is skipped, not the whole selection.
    expect(
      connectorRouteTabLabel(pathname, [
        crumb(pathname, "OpenAI"),
        { prefix: pathname, label: "Appended step", appendAfter: pathname },
      ]),
    ).toBe("OpenAI");
  });

  it("takes the LAST replacement for the prefix, as the bus does at publish", () => {
    const pathname = "/connectors/cinatra-ai/openai-connector/setup";
    expect(
      connectorRouteTabLabel(pathname, [crumb(pathname, "Stale"), crumb(pathname, "OpenAI")]),
    ).toBe("OpenAI");
  });

  it("returns null where nothing was published, so the tab is left alone", () => {
    expect(
      connectorRouteTabLabel("/connectors/cinatra-ai/openai-connector/setup", []),
    ).toBeNull();
  });

  it("returns null off a connector dispatch address", () => {
    expect(
      connectorRouteTabLabel("/connectors/cinatra-ai/openai-connector", [
        crumb("/connectors/cinatra-ai/openai-connector", "OpenAI"),
      ]),
    ).toBeNull();
    expect(connectorRouteTabLabel("/connectors", [])).toBeNull();
    expect(
      connectorRouteTabLabel("/connectors/cinatra-ai/openai-connector/setup/extra", [
        crumb("/connectors/cinatra-ai/openai-connector/setup/extra", "OpenAI"),
      ]),
    ).toBeNull();
    expect(
      connectorRouteTabLabel("/agents/acme/writer/r1", [crumb("/agents/acme/writer/r1", "Run")]),
    ).toBeNull();
  });

  it("answers the dispatch-address question the shell asks on its own", () => {
    // The shell needs this predicate to tell "not published YET" (no write,
    // the route's own metadata owns the tab) from "not this route" (the
    // ordinary fallback) — one gate, so the two cannot drift apart.
    expect(
      isConnectorDispatchPathname("/connectors/cinatra-ai/openai-connector/setup"),
    ).toBe(true);
    expect(
      isConnectorDispatchPathname("/connectors/cinatra-ai/openai-connector"),
    ).toBe(false);
    expect(
      isConnectorDispatchPathname("/connectors/cinatra-ai/openai-connector/setup/extra"),
    ).toBe(false);
    expect(isConnectorDispatchPathname("/connectors")).toBe(false);
    expect(isConnectorDispatchPathname("/agents/acme/writer/r1")).toBe(false);
  });

  it("leaves the agents mirror exactly as it was (cinatra#2809)", () => {
    const pathname = "/agents/acme/writer/r1";
    const contributions = [crumb(pathname, "Author Agent (6)")];
    expect(
      agentInstanceTabLabel(pathname, buildBreadcrumbTrail(pathname, { contributions })),
    ).toBe("Author Agent (6)");
  });
});
