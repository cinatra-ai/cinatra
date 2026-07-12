// cinatra#1196 slice 2 — ConnectorNotConfiguredError deep-links to the
// connector's OWN vendor route (`/connectors/<vendor>/<name>/setup`), derived
// from the packageId via the canonical splitter, so an operator/third-party
// connector no longer deep-links to the literal `cinatra-ai` segment.
import { describe, it, expect, vi } from "vitest";

// Keep the module's heavy deps inert — only the pure error class is exercised.
vi.mock("@/lib/background-jobs", () => ({
  BACKGROUND_JOB_NAMES: { AGENT_BUILDER_EXECUTION: "AGENT_BUILDER_EXECUTION" },
  enqueueBackgroundJob: vi.fn(async () => "job-1"),
}));
vi.mock("@/lib/connector-policy", () => ({
  enforceConnectorPolicy: vi.fn(() => ({ allowed: true })),
}));

import { ConnectorNotConfiguredError } from "@/lib/agent-run-enqueue";

describe("ConnectorNotConfiguredError.settingsHref (multi-vendor, cinatra#1196)", () => {
  it("first-party connector keeps the cinatra-ai vendor route (no regression)", () => {
    const err = new ConnectorNotConfiguredError("@cinatra-ai/apollo-connector");
    expect(err.settingsHref).toBe("/connectors/cinatra-ai/apollo-connector/setup");
  });

  it("operator/third-party connector deep-links to its OWN vendor route", () => {
    const err = new ConnectorNotConfiguredError("@marcushorndt-local/pipedrive-connector");
    expect(err.settingsHref).toBe(
      "/connectors/marcushorndt-local/pipedrive-connector/setup",
    );
  });

  it("does not fold a hyphenated scope into the name (canonical splitter)", () => {
    const err = new ConnectorNotConfiguredError("@acme-corp/crm-connector");
    expect(err.settingsHref).toBe("/connectors/acme-corp/crm-connector/setup");
  });

  it("falls back to the cinatra-ai vendor for an unscoped id", () => {
    const err = new ConnectorNotConfiguredError("legacy-connector");
    expect(err.settingsHref).toBe("/connectors/cinatra-ai/legacy-connector/setup");
  });

  it("never leaks EXTRA path segments from a malformed multi-slash id", () => {
    // `@v/a/b` is not a canonical `@vendor/name`; the href must stay a single
    // well-formed segment, not `/connectors/cinatra-ai/@v/a/b/setup`.
    const err = new ConnectorNotConfiguredError("@some-vendor/a/b");
    expect(err.settingsHref).toBe("/connectors/cinatra-ai/a/setup");
    expect(err.settingsHref.split("/").length).toBe(5); // "", connectors, vendor, name, setup
  });

  it("strips query/fragment characters from the deep-link segment", () => {
    const err = new ConnectorNotConfiguredError("weird-connector?x=1#frag");
    expect(err.settingsHref).toBe("/connectors/cinatra-ai/weird-connector/setup");
  });

  it("never emits a traversal/unsafe fallback segment", () => {
    // `..` / empty-after-strip must collapse to a safe placeholder, never a
    // `/connectors/cinatra-ai/../setup` traversal.
    expect(new ConnectorNotConfiguredError("../evil").settingsHref).toBe(
      "/connectors/cinatra-ai/unknown/setup",
    );
    expect(new ConnectorNotConfiguredError("@scope/?x").settingsHref).toBe(
      "/connectors/cinatra-ai/unknown/setup",
    );
  });

  it("carries the packageId and optional reason through unchanged", () => {
    const err = new ConnectorNotConfiguredError("@vendor/x-connector", "no_grant");
    expect(err.packageId).toBe("@vendor/x-connector");
    expect(err.reason).toBe("no_grant");
    expect(err.code).toBe("CONNECTOR_NOT_CONFIGURED");
    expect(err.settingsHref).toBe("/connectors/vendor/x-connector/setup");
  });
});
